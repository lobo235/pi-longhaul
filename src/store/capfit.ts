/**
 * The hard cap on the rendered state: over it, sections retire oldest-first in the
 * order work log, decisions, dead ends, corrections, until under it. Objective, Now and World are
 * never touched. The size function is injected so this stays a pure step over the projection and
 * the loop provably terminates: every step retires one item or stops.
 */
import type { Caps } from "./events.ts";
import type { SessionState } from "./project.ts";

export interface CapFitResult {
  state: SessionState;
  retired: { workLog: number; decisions: number; deadEnds: number; corrections: number };
  /** Nothing retirable was left and the state is still over the cap. */
  exhausted: boolean;
}

type Section = keyof CapFitResult["retired"];
const ORDER: Section[] = ["workLog", "decisions", "deadEnds", "corrections"];

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

export function fitToHardCap(input: SessionState, caps: Caps, measure: (state: SessionState) => number): CapFitResult {
  const state = structuredClone(input);
  const retired = { workLog: 0, decisions: 0, deadEnds: 0, corrections: 0 };
  while (measure(state) > caps.hardChars) {
    const section = ORDER.find((candidate) => retireOne(state, candidate));
    if (!section) return { state, retired, exhausted: true };
    retired[section]++;
  }
  return { state, retired, exhausted: false };
}
