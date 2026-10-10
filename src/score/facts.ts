/**
 * The learned-facts probe: does a compaction keep what the session LEARNED from tool output and goes on
 * to use? A fact is a value -- a path, a commit or other hash, a uuid, a version, a long number, a
 * compound identifier -- first seen in the compacted span's tool output (not named by the span's own
 * calls or user messages), not still visible in the kept window, and used again in the next assistant
 * messages. It is kept when the rendered state carries it. Deterministic: no model judge. Facts are
 * transcript text; only their counts leave here.
 */
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import { basename, factMatches, type FactKind } from "../fact-shapes.ts";
import { isRec, type Rec } from "../message-text.ts";

export type { FactKind } from "../fact-shapes.ts";

export interface Fact {
  value: string;
  kind: FactKind;
}

/** The fact-shaped values in `text`, each once; a path is compared by its basename. */
export function factTokens(text: string): Fact[] {
  const facts = new Map<string, Fact>();
  for (const { raw, kind } of factMatches(text)) {
    const value = kind === "path" ? basename(raw) : raw;
    if (!facts.has(value)) facts.set(value, { value, kind });
  }
  return [...facts.values()];
}

const textOf = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.filter(isRec).map((part) => (part.type === "text" ? String(part.text ?? "") : "")).join("\n") : "";

/** Per tool output: pi keeps ~50 KB of a bash or read result, so this cuts only a tool that does not truncate (security.md T4). */
export const OUTPUT_CHARS = 64 * 1024;

/** One entry's text by origin: tool output, or what the session itself said (user words, assistant text and call arguments). */
function partsOf(entry: SessionEntry): { output: string; said: string } {
  if (entry.type !== "message") return { output: "", said: "" };
  const message = entry.message as unknown as Rec;
  if (message.role === "toolResult") return { output: textOf(message.content).slice(0, OUTPUT_CHARS), said: "" };
  if (message.role === "bashExecution") return { output: String(message.output ?? "").slice(0, OUTPUT_CHARS), said: String(message.command ?? "") };
  const calls = Array.isArray(message.content) ? message.content.filter((part): part is Rec => isRec(part) && part.type === "toolCall").map((part) => JSON.stringify(part.arguments ?? {})) : [];
  return { output: "", said: [textOf(message.content), ...calls].join("\n") };
}

const allText = (entries: SessionEntry[]) => entries.map((entry) => { const parts = partsOf(entry); return `${parts.output}\n${parts.said}`; }).join("\n");
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** `value` as a whole token of `text` (8081 is not inside 80810). */
export const mentions = (text: string, value: string) => new RegExp(`(?<![A-Za-z0-9_])${escape(value)}(?![A-Za-z0-9_])`).test(text);

/** File extensions a reused-values measure counts as files: a dotted name with any other suffix reads as code (process.exit). */
const FILE_EXTENSION = /\.(?:[cm]?[jt]sx?|py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|swift|php|sh|bash|zsh|json|jsonl|ya?ml|toml|ini|cfg|conf|env|xml|html?|css|scss|md|txt|csv|tsv|log|sql|db|sqlite|lock|gz|tgz|zip|tar|bz2|xz|zst|png|jpe?g|gif|svg|pdf|wasm)$/i;

/** A code name: an identifier, or a dotted name that is no file and no <placeholder> name format. */
export const isCodeNameFact = (fact: Fact): boolean => fact.kind === "identifier" || (fact.kind === "path" && !/<[\w-]{1,30}>/.test(fact.value) && !FILE_EXTENSION.test(fact.value));

/** The next `k` assistant messages' text and call arguments: where a later use shows. */
function useWindow(after: SessionEntry[], k: number): string {
  const assistants = after.filter((entry) => entry.type === "message" && entry.message.role === "assistant").slice(0, k);
  return assistants.map((entry) => partsOf(entry).said).join("\n");
}

/**
 * Values first seen in the span's tool output, not visible after the cut, and used again in the next `k` assistant
 * messages. Facts also exclude a value the session said in the span; `includeSaid` keeps it: a reused value, what
 * the Learned values section is for (a value the span itself went on to use).
 */
export function factNeeds(input: { span: SessionEntry[]; kept: SessionEntry[]; after: SessionEntry[]; k?: number; includeSaid?: boolean }): Fact[] {
  const output = input.span.map((entry) => partsOf(entry).output).join("\n");
  const said = input.includeSaid ? "" : input.span.map((entry) => partsOf(entry).said).join("\n");
  const kept = allText(input.kept);
  const used = useWindow(input.after, input.k ?? 10);
  return factTokens(output).filter((fact) => !mentions(said, fact.value) && !mentions(kept, fact.value) && mentions(used, fact.value));
}

export interface FactCoverage {
  /** Kept in the rendered text alone. */
  kept: number;
  /** Kept in the text or found by longhaul_recall, the tool the resumed session has (0 recall for an arm without it); absent in rows written before it existed. */
  keptWithRecall?: number;
  total: number;
  share: number | null;
  byKind: Partial<Record<FactKind, { kept: number; total: number }>>;
}

export function factCoverage(facts: Fact[], rendered: string, recallable: (needle: string) => boolean = () => false): FactCoverage {
  const byKind: FactCoverage["byKind"] = {};
  let kept = 0;
  let keptWithRecall = 0;
  for (const fact of facts) {
    const hit = mentions(rendered, fact.value);
    if (hit || recallable(fact.value)) keptWithRecall += 1;
    const slot = (byKind[fact.kind] ??= { kept: 0, total: 0 });
    slot.total += 1;
    if (hit) {
      slot.kept += 1;
      kept += 1;
    }
  }
  return { kept, keptWithRecall, total: facts.length, share: facts.length ? kept / facts.length : null, byKind };
}

/** Which compactor wrote a recorded compaction, by the rule store/log.ts compactorOfEntry uses: not from a hook is pi's; a hook's is state when stamped so, else another extension's. */
const compactorOf = (entry: Extract<SessionEntry, { type: "compaction" }>): string => {
  if (!entry.fromHook) return "pi";
  return isRec(entry.details) && entry.details.compactor === "state" ? "state" : "extension";
};

/**
 * Every compaction on `branch`, scored against the summary it recorded. Its span is what pi summarized:
 * from the previous compaction's first kept entry (pi re-summarizes that kept window) to this one's.
 */
export function recordedFacts(branch: SessionEntry[], k = 10): Array<{ compactor: string; coverage: FactCoverage }> {
  return branch.flatMap((entry, index) => {
    if (entry.type !== "compaction") return [];
    const facts = factsAt(branch.slice(0, index), entry.firstKeptEntryId, branch.slice(index + 1), k);
    return [{ compactor: compactorOf(entry), coverage: factCoverage(facts, entry.summary) }];
  });
}

/**
 * The facts a compaction of `path` keeping from `firstKeptEntryId` is due: its span runs from the
 * previous compaction's first kept entry (pi re-summarizes that kept window) to this one's.
 */
export function factsAt(path: SessionEntry[], firstKeptEntryId: string, after: SessionEntry[], k = 10, includeSaid = false): Fact[] {
  const indexOf = new Map(path.map((entry, index) => [entry.id, index]));
  const previous = [...path].reverse().find((entry): entry is Extract<SessionEntry, { type: "compaction" }> => entry.type === "compaction");
  const spanStart = previous ? (indexOf.get(previous.firstKeptEntryId) ?? 0) : 0;
  const keptAt = indexOf.get(firstKeptEntryId) ?? path.length;
  return factNeeds({ span: path.slice(spanStart, keptAt), kept: path.slice(keptAt), after, k, includeSaid });
}
