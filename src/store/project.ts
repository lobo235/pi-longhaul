/**
 * Hot memory is `project(log, caps)`: a pure reducer over accepted events. Per-kind caps retire
 * the oldest decision or dead end on add. A correction does not retire by count unless `caps.corrections` asks
 * for it (0, the default, never), since an old rule binds as much as a new one: a lift marks it, and a correction lifted in an earlier
 * span is retired, so it renders as lifted exactly once; a span close appends the work-log line,
 * carries World, and consolidates work-log lines past the cap into one code-written line.
 * Retirement is a projection rule: the log never deletes, and recall reads the log.
 */
import type { Caps, ForeignCompactor, Now, Quote, Source, StateEvent, StateLog, World } from "./events.ts";
import { CORRECTIONS_CEILING } from "./events.ts";
import { DEFAULT_NEAR_DUPLICATE_THRESHOLD, overlap, tokenize } from "./near-duplicate.ts";
import { oneLine } from "../one-line.ts";
import { scrubCredentials } from "../credential-scrub.ts";

export interface CorrectionItem {
  id: string;
  quote: Quote;
  span: number;
  source: Source;
  evidence?: string;
  seq: number;
  liftedBy?: { messageId: string; ordinal: string; span: number };
  retired: boolean;
  /** Set by the cap fit alone (capfit.ts): rendered as an excerpt naming its recall, never projected. */
  condensed?: boolean;
  /** Ids this rule held before being recorded again from its message (addCorrection); see liftTarget. */
  formerIds?: Set<string>;
  /** `span:seq` of the earlier correction.add events folded into this rule, for recall (addCorrection). */
  copyKeys?: string[];
}

export interface TextItem {
  id: string;
  text: string;
  span: number;
  source: Source;
  evidence?: string;
  seq: number;
  retired: boolean;
}

export interface WorkLogLine {
  span: number;
  fromRef: string;
  toRef: string;
  text: string;
  narrativeLess: boolean;
  foreign?: ForeignCompactor;
  missingChunks?: number[];
  /** A consolidated line standing for spans a..b. */
  retiredSpans?: [number, number];
}

export interface SessionState {
  span: number;
  /** The Goal: the active /goal, set by code alone. */
  goal?: { quote: Quote; setSpan: number };
  /** The Request (the Objective outside a /goal); `movedFrom` feeds Earlier requests. */
  objective?: { quote: Quote; doneWhen?: Quote; setSpan: number; movedFrom: Array<{ quote: Quote; span: number }> };
  corrections: CorrectionItem[];
  decisions: TextItem[];
  deadEnds: TextItem[];
  workLog: WorkLogLine[];
  now?: Now & { span: number; carried: boolean };
  world?: World;
  retired: { corrections: number; decisions: number; deadEnds: number; workLog: number };
  cursor: { R: number; D: number; X: number };
  seq: number;
}

export function emptyState(): SessionState {
  return { span: 1, corrections: [], decisions: [], deadEnds: [], workLog: [], retired: { corrections: 0, decisions: 0, deadEnds: 0, workLog: 0 }, cursor: { R: 0, D: 0, X: 0 }, seq: 0 };
}

const idNumber = (id: string) => Number(/^[RDX](\d+)$/.exec(id)?.[1] ?? 0);

/**
 * Model-written text as the state shows it: with its credential values redacted (credential-scrub.ts). A pass scrubs
 * what it writes against the span's own credentials; this catches what a record written before that carries, by
 * shape and by what the text itself names, wherever the state is read (render, prompt, recall, the state CLI).
 */
const clean = (text: string) => scrubCredentials(text).text;
const cleanNow = (now: Now): Now => ({ inProgress: now.inProgress.map(clean), next: now.next.map(clean), blocked: now.blocked.map(clean), resume: clean(now.resume) });

/** Retire the oldest active items of a kind past the cap; returns how many retired. */
function retireOverCap<T extends { retired: boolean; seq: number }>(items: T[], cap: number): number {
  let excess = items.filter((item) => !item.retired).length - cap;
  let retired = 0;
  for (const item of items) {
    if (excess <= 0) break;
    if (!item.retired) {
      item.retired = true;
      retired++;
      excess--;
    }
  }
  return retired;
}

function workLogText(event: Extract<StateEvent, { kind: "span.close" }>): string {
  if (event.foreign) return `compacted by ${event.foreign === "pi" ? "pi's own summarizer" : "another extension's compactor"}; no state diff for this span`;
  const missing = event.missingChunks?.length ? ` (chunk ${event.missingChunks.join(", ")} of this span did not verify)` : "";
  if (event.narrativeLess || !event.narrative) return `narrative unavailable for this span (narrative-less pass)${missing}`;
  return `${clean(event.narrative)}${missing}`;
}

/** Fold the two oldest work-log lines into one consolidated line until the active count fits the cap. */
function consolidateWorkLog(state: SessionState, caps: Caps): void {
  while (state.workLog.length > caps.workLogLines && state.workLog.length >= 2) {
    const [first, second, ...rest] = state.workLog;
    const from = first.retiredSpans?.[0] ?? first.span;
    const to = second.span;
    state.retired.workLog += first.retiredSpans ? 1 : 2;
    state.workLog = [{ span: to, fromRef: first.fromRef, toRef: second.toRef, text: `Spans ${from}–${to} retired (recall span N for one of them)`, narrativeLess: false, retiredSpans: [from, to] }, ...rest];
  }
}

function applyClose(state: SessionState, event: Extract<StateEvent, { kind: "span.close" }>, caps: Caps): void {
  state.workLog.push({ span: event.span, fromRef: event.fromRef, toRef: event.toRef, text: workLogText(event), narrativeLess: event.narrativeLess, foreign: event.foreign, missingChunks: event.missingChunks });
  state.world = event.world;
  state.span = event.span + 1;
  // Lifted in an EARLIER span than the one closing (CONTEXT.md *Correction*): the summary
  // rendered at the lift's own close showed it once as lifted; this close retires it.
  for (const correction of state.corrections) if (correction.liftedBy && correction.liftedBy.span < event.span && !correction.retired) { correction.retired = true; state.retired.corrections++; }
  if (state.now && state.now.span !== event.span) state.now = { ...state.now, carried: true };
  consolidateWorkLog(state, caps);
}

/**
 * A rule recorded again from the message that gave it is the same rule: passes that lost their fold's span records
 * were shown the message again and recorded it again under a new id, sometimes in other words, so a restored log
 * holds one copy per such span. The rule takes the newest copy's id, span and place, and keeps its older ids for a lift
 * naming one; a lifted rule stays lifted, as verify.ts keeps it for a new pass.
 */
/**
 * The newest standing or lifted rule `quote` repeats: one from the same message whose words are a near-duplicate
 * (near-duplicate.ts, at verify's default threshold; two rules one message gave passed that check against each
 * other when recorded). A rule retired by the cap is not matched, so a later copy brings it back.
 */
function sameRuleIndex(corrections: CorrectionItem[], quote: Quote): number {
  for (let index = corrections.length - 1; index >= 0; index--) {
    const item = corrections[index];
    if (item.retired && !item.liftedBy) continue;
    if (isSameRule(item.quote, quote)) return index;
  }
  return -1;
}

/** Whether two recorded rules are one: the same message, in the same or near-duplicate words. */
export function isSameRule(a: Quote, b: Quote): boolean {
  if (a.messageId !== b.messageId) return false;
  return a.text === b.text || overlap(tokenize(a.text), tokenize(b.text)) >= DEFAULT_NEAR_DUPLICATE_THRESHOLD;
}

/** An event's key in the log: its seq is unique within its span (log.ts seqKey). */
export const eventKey = (event: { span: number; seq: number }): string => `${event.span}:${event.seq}`;

/**
 * The rule a lift naming `target` lands on, for verify.ts, which judges the lift against it, and for the
 * projection, which applies it, so the two never differ: the newest holder of the id (an old transcript can carry
 * a reminted one, security.md T1), and only when no rule holds it now, the newest that held it before being
 * recorded again. A former id another rule holds now names that rule: the lifting pass saw only that one.
 */
export function liftTarget(corrections: CorrectionItem[], target: string): CorrectionItem | undefined {
  return newestWhere(corrections, (item) => item.id === target) ?? newestWhere(corrections, (item) => item.formerIds?.has(target) ?? false);
}

function newestWhere(corrections: CorrectionItem[], match: (item: CorrectionItem) => boolean): CorrectionItem | undefined {
  for (let index = corrections.length - 1; index >= 0; index--) if (match(corrections[index])) return corrections[index];
  return undefined;
}

function addCorrection(state: SessionState, event: Extract<StateEvent, { kind: "correction.add" }>, caps: Caps): void {
  state.cursor.R = Math.max(state.cursor.R, idNumber(event.id));
  const index = sameRuleIndex(state.corrections, event.quote);
  const earlier = index < 0 ? undefined : state.corrections[index];
  if (earlier?.liftedBy) {
    (earlier.copyKeys ??= []).push(eventKey(event));
    return;
  }
  // The new item takes over the earlier one's lists, grown in place: copying them per copy would make N copies of
  // one rule cost N² (security.md T4).
  if (earlier) state.corrections.splice(index, 1);
  const formerIds = earlier?.formerIds ?? new Set<string>();
  if (earlier) formerIds.add(earlier.id);
  formerIds.delete(event.id);
  const copyKeys = earlier?.copyKeys ?? [];
  if (earlier) copyKeys.push(eventKey(earlier));
  state.corrections.push({ id: event.id, quote: event.quote, span: event.span, source: event.source, evidence: event.evidence, seq: event.seq, retired: false, ...(formerIds.size ? { formerIds } : {}), ...(copyKeys.length ? { copyKeys } : {}) });
  state.retired.corrections += retireOverCap(state.corrections, caps.corrections > 0 ? caps.corrections : CORRECTIONS_CEILING);
}

export function applyEvent(previous: SessionState, event: StateEvent, caps: Caps): SessionState {
  const state: SessionState = structuredClone(previous);
  applyInPlace(state, event, caps);
  return state;
}

/** Fold one event into `state`, mutating it. The new state can share objects with the event. */
function applyInPlace(state: SessionState, event: StateEvent, caps: Caps): void {
  state.seq = Math.max(state.seq, event.seq);
  switch (event.kind) {
    case "goal.set":
      state.goal = { quote: event.quote, setSpan: event.span };
      break;
    case "goal.clear":
      delete state.goal;
      break;
    case "objective.set":
      state.objective = { quote: event.quote, doneWhen: event.doneWhen, setSpan: event.span, movedFrom: state.objective ? [...state.objective.movedFrom, { quote: state.objective.quote, span: state.objective.setSpan }] : [] };
      break;
    case "objective.doneWhen":
      if (state.objective) state.objective.doneWhen = event.quote;
      break;
    case "correction.add":
      addCorrection(state, event, caps);
      break;
    case "correction.lift": {
      // Older transcripts can hold two corrections with one id (a foreign close dropped the first, the cursor fell
      // back and reminted it; the fold keeps both): liftTarget picks the one the lifting pass saw.
      const target = liftTarget(state.corrections, event.target);
      if (target) target.liftedBy = { ...event.by, span: event.span };
      break;
    }
    case "decision.add":
      state.decisions.push({ id: event.id, text: clean(event.text), span: event.span, source: event.source, evidence: event.evidence, seq: event.seq, retired: false });
      state.cursor.D = Math.max(state.cursor.D, idNumber(event.id));
      state.retired.decisions += retireOverCap(state.decisions, caps.decisions);
      break;
    case "deadEnd.add":
      state.deadEnds.push({ id: event.id, text: clean(event.text), span: event.span, source: event.source, evidence: event.evidence, seq: event.seq, retired: false });
      state.cursor.X = Math.max(state.cursor.X, idNumber(event.id));
      state.retired.deadEnds += retireOverCap(state.deadEnds, caps.deadEnds);
      break;
    case "now.set":
      state.now = { ...cleanNow(event.now), span: event.span, carried: false };
      break;
    case "span.close":
      applyClose(state, event, caps);
      break;
  }
}

/** One working state folded in place, cloned once so the result shares nothing with the log's events. */
export function project(log: StateLog, caps: Caps): SessionState {
  const state = emptyState();
  for (const event of log.events) applyInPlace(state, event, caps);
  return structuredClone(state);
}

/** The projection as of the close of `span`: events of later spans are not folded. */
export function projectAt(log: StateLog, span: number, caps: Caps): SessionState {
  return project({ ...log, events: log.events.filter((event) => event.span <= span) }, caps);
}

export const activeCorrections = (state: SessionState): CorrectionItem[] => state.corrections.filter((item) => !item.retired);
export const activeDecisions = (state: SessionState): TextItem[] => state.decisions.filter((item) => !item.retired);
export const activeDeadEnds = (state: SessionState): TextItem[] => state.deadEnds.filter((item) => !item.retired);
export const activeWorkLog = (state: SessionState): WorkLogLine[] => state.workLog;

/** The remember events accepted in `span` (the diff prompt lists them; the cap counts them). */
export function acceptedRemembers(log: StateLog, span: number): StateEvent[] {
  return log.events.filter((event) => event.source === "remember" && event.span === span);
}

export type GoalSource = "goal" | "opening";

/** How the Goal line names where it came from, in the rendered state and in the summarizer's prompts. */
export const GOAL_SOURCE_LABEL: Record<GoalSource, string> = { goal: "the active /goal", opening: "the session's opening request" };

/**
 * The Goal line: the active /goal, else the session's Opening request once the Request has moved away from it.
 * Derived, never recorded: the opening request is the first quote `objective.movedFrom` already keeps, so every
 * transcript gets the line without a new event, and the summarizer cannot move or drop it. (A `goal.set` written by
 * the pass was the alternative; it would change the log format and leave existing transcripts without the line.)
 * Undefined when the Request is still the opening request, or is back on it: the Request line already shows it.
 */
export function goalLine(state: SessionState): { quote: Quote; source: GoalSource } | undefined {
  if (state.goal) return { quote: state.goal.quote, source: "goal" };
  const opening = state.objective?.movedFrom[0]?.quote;
  if (!opening || oneLine(opening.text) === oneLine(state.objective!.quote.text)) return undefined;
  return { quote: opening, source: "opening" };
}
