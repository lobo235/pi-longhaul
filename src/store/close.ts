/**
 * The pass writer: append the verified diff events and the span.close, project, fit the hard cap.
 * The returned `state` is the checkpoint the pass renders and records in the entry's details; the
 * pinned invariant is checkpoint == projectAt(log, span) BEFORE the cap fit, which doors.test.ts
 * asserts, so a reducer change under a recorded log is caught.
 */
import { fitToHardCap, type CapFitResult } from "./capfit.ts";
import type { Caps, EventBody, StateEvent, StateLog } from "./events.ts";
import { project, type SessionState } from "./project.ts";

export interface CloseSpanInput {
  log: StateLog;
  caps: Caps;
  /** Already verified in order by applyProposals (verify.ts) with provenance source "diff". */
  diffEvents: StateEvent[];
  close: Omit<Extract<EventBody, { kind: "span.close" }>, "kind">;
  at: string;
  measure: (state: SessionState) => number;
}

export interface ClosedSpan {
  /** The events appended by this close: the diff's, then the span.close. */
  events: StateEvent[];
  log: StateLog;
  /** The checkpoint after the cap fit (what is rendered and recorded). */
  state: SessionState;
  capFit: CapFitResult;
  closeEvent: StateEvent;
}

export function closeSpan({ log, caps, diffEvents, close, at, measure }: CloseSpanInput): ClosedSpan {
  const span = log.openSpan;
  const lastSeq = Math.max(log.nextSeq - 1, ...diffEvents.map((event) => event.seq));
  const closeEvent: StateEvent = { source: "pass", span, at, seq: lastSeq + 1, kind: "span.close", ...close };
  const events = [...diffEvents, closeEvent];
  const nextLog: StateLog = { ...log, events: [...log.events, ...events], spans: [...log.spans, { span }], openSpan: span + 1, nextSeq: closeEvent.seq + 1 };
  const capFit = fitToHardCap(project(nextLog, caps), caps, measure);
  return { events, log: nextLog, state: capFit.state, capFit, closeEvent };
}
