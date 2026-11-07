/**
 * The hard cap on the rendered state: over it, sections retire oldest-first in the
 * order work log, decisions, dead ends, until under it; then corrections are condensed, oldest first, to an
 * excerpt that names the rule's recall (render.ts). A correction is never retired here: only a lift retires one,
 * since an old rule binds as much as a new one. Objective, Now and World are never touched. The size function is
 * injected so this stays a pure step over the projection and the loop provably terminates: every step retires or
 * condenses one item or stops.
 *
 * The work log retires first because its lines are the reconstructible ones -- each names its span refs, so `recall`
 * returns the detail -- but it never retires to EMPTY: the rendered preamble tells the reader to trust the work log for
 * progress and not to redo what it shows done, and a section that reads "(none)" while 12 lines have just been retired
 * tells it nothing. Real sessions sat at 98% of the hard cap and lost every line on 57% of compactions (381 of 668 in
 * one week), so the last WORKLOG_FLOOR lines stay and the loop moves on to decisions.
 */
import type { Caps } from "./events.ts";
import type { SessionState } from "./project.ts";

export interface CapFitResult {
  state: SessionState;
  retired: { workLog: number; decisions: number; deadEnds: number };
  /** Corrections rendered as an excerpt to fit; each is still in the state, whole in recall. */
  condensed: number;
  /** Nothing retirable or condensable was left and the state is still over the cap. */
  exhausted: boolean;
}

type Section = keyof CapFitResult["retired"];
const ORDER: Section[] = ["workLog", "decisions", "deadEnds"];
/**
 * The work log never retires below this many lines, whatever the cap pressure: the newest few spans are what
 * "do not redo steps they show done" is read from, and they cost ~100 characters each. Retirement then moves on to
 * decisions, which are recallable by id with their evidence, and to dead ends.
 */
export const WORKLOG_FLOOR = 3;

/** Retire the oldest active item of `section`; false when there is none (or the work log is at its floor). */
function retireOne(state: SessionState, section: Section): boolean {
  if (section === "workLog") {
    // Every line counts, the consolidated "spans X–Y retired" line too: the floor is about the section not reading empty.
    if (state.workLog.length <= WORKLOG_FLOOR) return false;
    state.workLog.shift();
    state.retired.workLog++;
    return true;
  }
  const items = state[section];
  const oldest = items.find((item) => !item.retired);
  if (!oldest) return false;
  oldest.retired = true;
  state.retired[section]++;
  return true;
}

/** Condense the oldest active correction not condensed yet; false when there is none. */
function condenseOne(state: SessionState): boolean {
  const oldest = state.corrections.find((item) => !item.retired && !item.condensed);
  if (!oldest) return false;
  oldest.condensed = true;
  return true;
}

export function fitToHardCap(input: SessionState, caps: Caps, measure: (state: SessionState) => number): CapFitResult {
  const state = structuredClone(input);
  const retired = { workLog: 0, decisions: 0, deadEnds: 0 };
  let condensed = 0;
  while (measure(state) > caps.hardChars) {
    const section = ORDER.find((candidate) => retireOne(state, candidate));
    if (section) retired[section]++;
    else if (condenseOne(state)) condensed++;
    else return { state, retired, condensed, exhausted: true };
  }
  return { state, retired, condensed, exhausted: false };
}
