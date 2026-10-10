/**
 * Hot memory is `project(log, caps)`: a pure reducer over accepted events. Per-kind caps retire
 * the oldest of a kind on add; a lift marks a correction, and a correction lifted in an earlier
 * span is retired, so it renders as lifted exactly once; a span close appends the work-log line,
 * carries World, and consolidates work-log lines past the cap into one code-written line.
 * Retirement is a projection rule: the log never deletes, and recall reads the log.
 */
import type { Caps, ForeignCompactor, Now, Quote, Source, StateEvent, StateLog, World } from "./events.ts";

export interface CorrectionItem {
  id: string;
  quote: Quote;
  span: number;
  source: Source;
  evidence?: string;
  seq: number;
  liftedBy?: { messageId: string; ordinal: string; span: number };
  retired: boolean;
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
  return `${event.narrative}${missing}`;
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

export function applyEvent(previous: SessionState, event: StateEvent, caps: Caps): SessionState {
  const state: SessionState = structuredClone(previous);
  applyInPlace(state, event, caps);
  return state;
}

/** Fold one event into `state`, mutating it. The new state can share objects with the event. */
function applyInPlace(state: SessionState, event: StateEvent, caps: Caps): void {
  state.seq = event.seq;
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
      state.corrections.push({ id: event.id, quote: event.quote, span: event.span, source: event.source, evidence: event.evidence, seq: event.seq, retired: false });
      state.cursor.R = Math.max(state.cursor.R, idNumber(event.id));
      state.retired.corrections += retireOverCap(state.corrections, caps.corrections);
      break;
    case "correction.lift": {
      // Newest first: older transcripts can hold two corrections with one id (a foreign close dropped
      // the first, the cursor fell back and reminted it; the fold now keeps both). A lift recorded then could only
      // see the newer one, so the newest holder is the target (security.md T1).
      const target = [...state.corrections].reverse().find((item) => item.id === event.target);
      if (target) target.liftedBy = { ...event.by, span: event.span };
      break;
    }
    case "decision.add":
      state.decisions.push({ id: event.id, text: event.text, span: event.span, source: event.source, evidence: event.evidence, seq: event.seq, retired: false });
      state.cursor.D = Math.max(state.cursor.D, idNumber(event.id));
      state.retired.decisions += retireOverCap(state.decisions, caps.decisions);
      break;
    case "deadEnd.add":
      state.deadEnds.push({ id: event.id, text: event.text, span: event.span, source: event.source, evidence: event.evidence, seq: event.seq, retired: false });
      state.cursor.X = Math.max(state.cursor.X, idNumber(event.id));
      state.retired.deadEnds += retireOverCap(state.deadEnds, caps.deadEnds);
      break;
    case "now.set":
      state.now = { ...event.now, span: event.span, carried: false };
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
