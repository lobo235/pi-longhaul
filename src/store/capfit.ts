/**
 * The hard cap on the rendered state: over it, sections retire oldest-first in the
 * order work log, decisions, dead ends, until under it; then corrections are condensed, oldest first, to an
 * excerpt that names the rule's recall (render.ts). A correction is never retired here: only a lift retires one,
 * since an old rule binds as much as a new one. Objective, Now and World are never touched. The size function is
 * injected so this stays a pure step over the projection and the loop provably terminates: every step retires or
 * condenses one item or stops.
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

/** Retire the oldest active item of `section`; false when there is none. */
function retireOne(state: SessionState, section: Section): boolean {
  if (section === "workLog") {
    if (state.workLog.length === 0) return false;
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
