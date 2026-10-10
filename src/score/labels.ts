/**
 * The labeled measures: what a compaction kept of the rules and values a person marked in each session, not what a
 * word list guesses. The label file (eval/sessions/labels.json) is written by hand from the scenarios and their
 * recordings, so neither compactor's own detector can define what counts. Turn ordinals are the session's user
 * messages counted from 1, as the scenarios number them.
 *
 * Due, at one compaction:
 * - a rule, when its message was summarized (before the cut) and its lift, if any, has not been given yet;
 * - a lift, when both the rule and the lift were summarized: the rule must then not be shown in force;
 * - a value, at the last compaction before the turn that uses it, when its turn was summarized and the kept window
 *   does not show it again.
 * Anything still in the kept window is not judged: the message itself is still in front of the model.
 */
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import type { Candidate } from "./candidates.ts";
import { mentions } from "./facts.ts";
import { ruleSections } from "./measures.ts";

export interface RuleLabel { at: string; quote: string; marker: string; liftedAt?: string }
export interface ValueLabel { name: string; value: string[]; learnedAt: string; usedAt: string; history: boolean }
export interface SessionLabels { rules: RuleLabel[]; values: ValueLabel[] }

export interface Count { kept: number; total: number }
export interface LabeledMeasures {
  rules: Count & { missed: string[] };
  /** Rules given since the previous compaction's cut: the span this compaction closes. */
  spanRules: Count;
  /** Rules given before the previous compaction's cut: only a carried state or summary still holds them. */
  earlierRules: Count;
  lifts: { honoured: number; total: number; shownInForce: string[] };
  values: Count & { missed: string[] };
  /** The values only the conversation holds (`history`): the workspace cannot give them back. */
  historyValues: Count;
  /** A state's rule lines bound to a message no rule was labeled at; absent for a text with no bound rule lines. */
  strayRules?: string[];
}

const ORDINAL = /^u[1-9]\d*$/;

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`labels: ${message}`);
}

function checkSession(name: string, value: unknown): SessionLabels {
  const labels = value as SessionLabels;
  check(Array.isArray(labels?.rules) && Array.isArray(labels?.values), `${name} needs rules and values arrays`);
  for (const rule of labels.rules) {
    check(ORDINAL.test(rule.at) && (rule.liftedAt === undefined || ORDINAL.test(rule.liftedAt)), `${name}: a rule's at/liftedAt must be an ordinal like u3`);
    check(typeof rule.quote === "string" && rule.quote.length > 0, `${name}: rule ${rule.at} has no quote`);
    try {
      new RegExp(rule.marker, "i");
    } catch {
      check(false, `${name}: rule ${rule.at} has a marker that is not a regular expression`);
    }
  }
  for (const item of labels.values) {
    check(ORDINAL.test(item.learnedAt) && ORDINAL.test(item.usedAt), `${name}: value ${item.name} needs learnedAt/usedAt ordinals`);
    check(Array.isArray(item.value) && item.value.length > 0 && item.value.every((spelling) => typeof spelling === "string" && spelling.length > 0), `${name}: value ${item.name} needs at least one spelling`);
  }
  return labels;
}

export function parseLabels(text: string): Record<string, SessionLabels> {
  let parsed: { sessions?: Record<string, unknown> };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch (error) {
    throw new Error(`labels: not JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  check(typeof parsed?.sessions === "object" && parsed.sessions !== null, "no sessions object");
  return Object.fromEntries(Object.entries(parsed.sessions!).map(([name, value]) => [name, checkSession(name, value)]));
}

const isUser = (entry: SessionEntry) => entry.type === "message" && entry.message.role === "user";

/** Each user ordinal's position: in `pathEntries` (index), or after the compaction (afterIndex). */
function ordinalsOf(candidate: Candidate): { at: Map<string, number>; after: Map<string, number> } {
  const at = new Map<string, number>();
  const after = new Map<string, number>();
  let count = 0;
  candidate.pathEntries.forEach((entry, index) => isUser(entry) && at.set(`u${++count}`, index));
  candidate.after.forEach((entry, index) => isUser(entry) && after.set(`u${++count}`, index));
  return { at, after };
}

const LIFTED = /\b(lifted|withdrawn|no longer|revoked|replaced|superseded|dropped|does not apply|doesn't apply)\b/i;
/** A rule's own quoted words ("the tab rule doesn't apply to JSON; keep tabs in TypeScript") say nothing of its status. */
const QUOTED = /"[^"\n]*"|\u201c[^\u201d\n]*\u201d/g;
const showsLifted = (line: string): boolean => LIFTED.test(line.replace(QUOTED, '""'));
const BOUND_RULE = /^- R\d+ \[(u\d+)\]/;

const textOf = (entry: SessionEntry): string => {
  if (entry.type !== "message") return "";
  const content = (entry.message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.map((block) => (block?.type === "text" ? block.text : block?.type === "toolCall" ? JSON.stringify(block.arguments ?? {}) : "")).join("\n") : String((entry.message as { output?: unknown }).output ?? "");
};

function previousCut(candidate: Candidate): number {
  const previous = [...candidate.pathEntries].reverse().find((entry): entry is Extract<SessionEntry, { type: "compaction" }> => entry.type === "compaction");
  if (!previous) return 0;
  const index = candidate.pathEntries.findIndex((entry) => entry.id === previous.firstKeptEntryId);
  return index < 0 ? 0 : index;
}

function measureRules(labels: SessionLabels, ordinals: ReturnType<typeof ordinalsOf>, cut: number, since: number, ruleLines: string[]) {
  const before = (ordinal: string | undefined) => ordinal !== undefined && (ordinals.at.get(ordinal) ?? Number.POSITIVE_INFINITY) < cut;
  const given = (ordinal: string | undefined) => ordinal !== undefined && ordinals.at.has(ordinal);
  const holds = (rule: RuleLabel) => ruleLines.some((line) => new RegExp(rule.marker, "i").test(line));
  const due = labels.rules.filter((rule) => before(rule.at) && !given(rule.liftedAt));
  const kept = due.filter(holds);
  const inSpan = (rule: RuleLabel) => (ordinals.at.get(rule.at) ?? 0) >= since;
  const liftsDue = labels.rules.filter((rule) => before(rule.at) && before(rule.liftedAt));
  const shownInForce = liftsDue.filter((rule) => ruleLines.some((line) => new RegExp(rule.marker, "i").test(line) && !showsLifted(line))).map((rule) => rule.at);
  return {
    rules: { kept: kept.length, total: due.length, missed: due.filter((rule) => !kept.includes(rule)).map((rule) => rule.at) },
    spanRules: { kept: kept.filter(inSpan).length, total: due.filter(inSpan).length },
    earlierRules: { kept: kept.filter((rule) => !inSpan(rule)).length, total: due.filter((rule) => !inSpan(rule)).length },
    lifts: { honoured: liftsDue.length - shownInForce.length, total: liftsDue.length, shownInForce },
  };
}

function measureValues(labels: SessionLabels, candidate: Candidate, ordinals: ReturnType<typeof ordinalsOf>, cut: number, rendered: string) {
  const nextCompaction = candidate.after.findIndex((entry) => entry.type === "compaction");
  const keptWindow = candidate.pathEntries.slice(cut).map(textOf).join("\n");
  const due = labels.values.filter((item) => {
    const next = `u${Number(item.learnedAt.slice(1)) + 1}`;
    const learnedDone = (ordinals.at.get(next) ?? Number.POSITIVE_INFINITY) < cut;
    const useAt = ordinals.after.get(item.usedAt);
    const usedNext = useAt !== undefined && (nextCompaction < 0 || useAt < nextCompaction);
    return learnedDone && usedNext && !item.value.some((spelling) => mentions(keptWindow, spelling));
  });
  const kept = due.filter((item) => item.value.some((spelling) => mentions(rendered, spelling)));
  const history = due.filter((item) => item.history);
  return {
    values: { kept: kept.length, total: due.length, missed: due.filter((item) => !kept.includes(item)).map((item) => item.name) },
    historyValues: { kept: history.filter((item) => kept.includes(item)).length, total: history.length },
  };
}

function strayRulesOf(labels: SessionLabels, ruleLines: string[]): string[] | undefined {
  const bound = ruleLines.flatMap((line) => BOUND_RULE.exec(line)?.[1] ?? []);
  if (bound.length === 0) return undefined;
  const labeled = new Set(labels.rules.map((rule) => rule.at));
  return bound.filter((ordinal) => !labeled.has(ordinal));
}

export function labeledMeasures(labels: SessionLabels, candidate: Candidate, firstKeptEntryId: string, rendered: string): LabeledMeasures {
  const ordinals = ordinalsOf(candidate);
  const found = candidate.pathEntries.findIndex((entry) => entry.id === firstKeptEntryId);
  const cut = found < 0 ? candidate.pathEntries.length : found;
  const ruleLines = ruleSections(rendered).split("\n").filter((line) => line.trim() && !line.startsWith("## "));
  const strayRules = strayRulesOf(labels, ruleLines);
  return {
    ...measureRules(labels, ordinals, cut, previousCut(candidate), ruleLines),
    ...measureValues(labels, candidate, ordinals, cut, rendered),
    ...(strayRules ? { strayRules } : {}),
  };
}

export interface LabeledSummary {
  rows: number;
  rules: Count;
  spanRules: Count;
  earlierRules: Count;
  lifts: { honoured: number; total: number };
  values: Count;
  historyValues: Count;
  strayRules: number;
}

const add = (a: Count, b: Count): Count => ({ kept: a.kept + b.kept, total: a.total + b.total });

/** The labeled measures summed over an arm's rows; null when none carried them (no label file, or no labeled session). */
export function summarizeLabeled(rows: ReadonlyArray<{ labeled?: LabeledMeasures }>): LabeledSummary | null {
  const labeled = rows.flatMap((row) => (row.labeled ? [row.labeled] : []));
  if (labeled.length === 0) return null;
  const zero = { kept: 0, total: 0 };
  return labeled.reduce<LabeledSummary>((sum, row) => ({
    rows: sum.rows + 1,
    rules: add(sum.rules, row.rules),
    spanRules: add(sum.spanRules, row.spanRules),
    earlierRules: add(sum.earlierRules, row.earlierRules),
    lifts: { honoured: sum.lifts.honoured + row.lifts.honoured, total: sum.lifts.total + row.lifts.total },
    values: add(sum.values, row.values),
    historyValues: add(sum.historyValues, row.historyValues),
    strayRules: sum.strayRules + (row.strayRules?.length ?? 0),
  }), { rows: 0, rules: zero, spanRules: zero, earlierRules: zero, lifts: { honoured: 0, total: 0 }, values: zero, historyValues: zero, strayRules: 0 });
}

const ratio = (count: Count) => `${count.kept}/${count.total}`;

export function formatLabeledLine(arm: string, s: LabeledSummary): string {
  return `${arm.padEnd(15)} labeled n=${s.rows} rules=${ratio(s.rules)} span=${ratio(s.spanRules)} earlier=${ratio(s.earlierRules)} lifts=${s.lifts.honoured}/${s.lifts.total} values=${ratio(s.values)} history=${ratio(s.historyValues)} stray=${s.strayRules}`;
}
