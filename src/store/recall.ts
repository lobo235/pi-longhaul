/**
 * recall: Cold memory reads over the log and the span records. Returns structured hits; the tool
 * formats them. Text is the session's own transcript content, sanitised to one line. Retired and
 * lifted items stay reachable: the projection retires, the log never deletes.
 */
import type { CommandRecord, ErrorRecord } from "../ledger/handoff.ts";
import type { Caps, StateEvent, StateLog } from "./events.ts";
import { orderedFiles } from "../files-render.ts";
import { oneLine } from "../one-line.ts";
import { scrubCredentials } from "../credential-scrub.ts";
import { eventKey, project } from "./project.ts";

/**
 * A hit's text: one line, with its credential values redacted (credential-scrub.ts). Span records written before the
 * scrub still carry what the summarizer copied, and an error line from such a record may carry one too.
 */
const sanitize = (text: string) => oneLine(scrubCredentials(text).text);

export type RecallWhat = "span" | "commands" | "errors" | "decisions" | "dead-ends" | "corrections" | "message" | "files" | "all";

export interface RecallQuery {
  what?: RecallWhat;
  /** A span number for `span`, an ordinal for `message`, a substring (case-insensitive) otherwise. */
  query?: string;
  limit?: number;
}

export interface RecallDeps {
  log: StateLog;
  /** The live ledger (this span's), for commands and errors not yet in a span record. */
  ledger: { commands: CommandRecord[]; errors: ErrorRecord[] };
  messageText: (ordinal: string) => string | undefined;
  caps: Caps;
  /** The latest compaction's carried file lists (carry.ts previousFileLists): the paths `## Files` may have cut. */
  files?: { readFiles: string[]; modifiedFiles: string[] };
}

export interface RecallHit {
  kind: RecallWhat;
  ref: string;
  span?: number;
  text: string;
  retired?: boolean;
  lifted?: boolean;
}

export const RECALL_DEFAULT_LIMIT = 20;


/** One projection per recall call, however many kinds it lists (`all`). */
const liftedKeysCache = new WeakMap<RecallDeps, Set<string>>();

/**
 * `span:seq` of every correction.add the projection lifted, the copies folded into a lifted rule included, so recall
 * shows a correction as lifted exactly when the state does (project.ts liftTarget, addCorrection).
 */
function liftedKeys(deps: RecallDeps): Set<string> {
  const cached = liftedKeysCache.get(deps);
  if (cached) return cached;
  const keys = new Set<string>();
  liftedKeysCache.set(deps, keys);
  for (const item of project(deps.log, deps.caps).corrections) {
    if (!item.liftedBy) continue;
    keys.add(eventKey(item));
    for (const key of item.copyKeys ?? []) keys.add(key);
  }
  return keys;
}

function itemHits(events: StateEvent[], kind: "decisions" | "dead-ends" | "corrections", lifted: Set<string>): RecallHit[] {
  return events.flatMap((event): RecallHit[] => {
    if (kind === "decisions" && event.kind === "decision.add") return [{ kind, ref: event.id, span: event.span, text: `${event.id} ${sanitize(event.text)}${event.evidence ? ` (${event.evidence})` : ""}` }];
    if (kind === "dead-ends" && event.kind === "deadEnd.add") return [{ kind, ref: event.id, span: event.span, text: `${event.id} ${sanitize(event.text)}${event.evidence ? ` (${event.evidence})` : ""}` }];
    if (kind === "corrections" && event.kind === "correction.add") return [{ kind, ref: event.id, span: event.span, text: `${event.id} [${event.quote.ordinal}] ${sanitize(event.quote.text)}`, lifted: lifted.has(eventKey(event)) }];
    return [];
  });
}

/** Every ledger record ever seen: span records' slices first, then the live ledger, deduplicated by id (latest wins). */
function allCommands(deps: RecallDeps): Array<CommandRecord & { span: number }> {
  const byId = new Map<string, CommandRecord & { span: number }>();
  for (const span of deps.log.spans) for (const record of span.record?.ledger.commands ?? []) byId.set(record.id, { ...record, span: span.span });
  for (const record of deps.ledger.commands) byId.set(record.id, { ...record, span: byId.get(record.id)?.span ?? deps.log.openSpan });
  return [...byId.values()];
}

function allErrors(deps: RecallDeps): Array<ErrorRecord & { span: number }> {
  const byId = new Map<string, ErrorRecord & { span: number }>();
  for (const span of deps.log.spans) for (const record of span.record?.ledger.errors ?? []) byId.set(record.id, { ...record, span: span.span });
  for (const record of deps.ledger.errors) byId.set(record.id, { ...record, span: byId.get(record.id)?.span ?? deps.log.openSpan });
  return [...byId.values()];
}

const commandHit = (record: CommandRecord & { span: number }): RecallHit => ({ kind: "commands", ref: record.id, span: record.span, text: `${record.id} ${sanitize(record.command)} (exit ${record.lastExitCode ?? "-"}, ${record.runs} run${record.runs === 1 ? "" : "s"}, span ${record.span})` });
const errorHit = (record: ErrorRecord & { span: number }): RecallHit => ({ kind: "errors", ref: record.id, span: record.span, text: `${record.id} ${sanitize(record.signature.split("\n")[0])} (${record.resolved ? "resolved" : "open"}, span ${record.span})` });

/** Modified first, then read, each newest first: the `## Files` order, so the first hits are what the section showed. */
function fileHits(deps: RecallDeps): RecallHit[] {
  const { modified, read } = orderedFiles({ modifiedFiles: deps.files?.modifiedFiles ?? [], readFiles: deps.files?.readFiles ?? [] });
  return [...modified.map((file) => ({ kind: "files" as const, ref: file, text: `modified ${file}` })), ...read.map((file) => ({ kind: "files" as const, ref: file, text: `read ${file}` }))];
}

type SpanClose = Extract<StateEvent, { kind: "span.close" }>;

/** A span's first line: its message range and narrative, or "(open)" before it closes. */
function spanHead(close: SpanClose | undefined, span: number): RecallHit {
  return { kind: "span", ref: `span ${span}`, span, text: close ? `span ${span} [${close.fromRef}–${close.toRef}] ${sanitize(close.narrative ?? "(narrative-less)")}` : `span ${span} (open)` };
}

function spanHits(deps: RecallDeps, span: number): RecallHit[] {
  const events = deps.log.events.filter((event) => event.span === span);
  const head = spanHead(events.find((event): event is SpanClose => event.kind === "span.close"), span);
  const record = deps.log.spans.find((summary) => summary.span === span)?.record;
  const commands = (record ? record.ledger.commands.map((c) => ({ ...c, span })) : allCommands(deps).filter((c) => c.span === span)).map(commandHit);
  const errors = (record ? record.ledger.errors.map((e) => ({ ...e, span })) : allErrors(deps).filter((e) => e.span === span)).map(errorHit);
  const lifted = liftedKeys(deps);
  return [head, ...commands, ...errors, ...itemHits(events, "corrections", lifted), ...itemHits(events, "decisions", lifted), ...itemHits(events, "dead-ends", lifted)];
}

function spanHeads(deps: RecallDeps): RecallHit[] {
  const closes = new Map<number, SpanClose>();
  for (const event of deps.log.events) if (event.kind === "span.close" && !closes.has(event.span)) closes.set(event.span, event);
  return deps.log.spans.map((summary) => spanHead(closes.get(summary.span), summary.span));
}

function hitsFor(what: RecallWhat, deps: RecallDeps, query: string | undefined): RecallHit[] {
  switch (what) {
    case "span": return query && /^\d+$/.test(query) ? spanHits(deps, Number(query)) : spanHeads(deps);
    case "commands": return allCommands(deps).map(commandHit);
    case "errors": return allErrors(deps).map(errorHit);
    case "decisions": case "dead-ends": case "corrections": return itemHits(deps.log.events, what, liftedKeys(deps));
    case "message": {
      const text = query ? deps.messageText(query) : undefined;
      return text === undefined ? [] : [{ kind: "message", ref: query!, text: sanitize(text) }];
    }
    case "files": return fileHits(deps);
    case "all": return (["span", "commands", "errors", "corrections", "decisions", "dead-ends", "files"] as const).flatMap((kind) => hitsFor(kind, deps, undefined));
  }
}

export function recall(query: RecallQuery, deps: RecallDeps): { hits: RecallHit[]; total: number } {
  const what = query.what ?? "all";
  const raw = hitsFor(what, deps, query.query);
  const needle = query.query?.toLowerCase();
  const filtered = needle && what !== "span" && what !== "message" ? raw.filter((hit) => hit.text.toLowerCase().includes(needle)) : raw;
  const limit = Math.max(1, Math.min(query.limit ?? RECALL_DEFAULT_LIMIT, 200));
  return { hits: filtered.slice(0, limit), total: filtered.length };
}
