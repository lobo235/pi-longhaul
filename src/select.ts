/**
 * Whether Longhaul compacts this session, read from PI_COMPACTOR at hook time (README, *Environment variables*).
 *
 * Unset, empty or `state`: Longhaul compacts. Any other value (`pi`, another compactor's name, a misspelling)
 * stands it down for the session, so pi's own compaction, or another installed compactor, answers instead.
 *
 * While loaded, Longhaul sets PI_COMPACTOR_STATE_LOADED to its process's pid, so a compactor that defers to it
 * can tell it is present in this process. A child pi inherits the variable, so only the matching pid counts: a
 * constant marker would let a nested pi without Longhaul silence the other compactor and leave the compaction
 * to nobody that was asked.
 */
export const COMPACTOR_ENV = "PI_COMPACTOR";
export const STATE_LOADED_ENV = "PI_COMPACTOR_STATE_LOADED";

export interface CompactorSelection {
  /** Longhaul is the selected compactor for this session. */
  longhaul: boolean;
  /** True when PI_COMPACTOR was unset or empty, so no one asked for Longhaul by name. */
  defaulted?: true;
  /** True when Longhaul set its marker in this process (not inherited from a parent). */
  stateLoaded: boolean;
}

/** The marker value that means "Longhaul loaded in the process with this pid". */
export function stateLoadedMarker(pid: number = process.pid): string {
  return String(pid);
}

export function selectCompactor(env: NodeJS.ProcessEnv): CompactorSelection {
  const raw = (env[COMPACTOR_ENV] ?? "").trim();
  const stateLoaded = env[STATE_LOADED_ENV] === stateLoadedMarker();
  if (raw === "") return { longhaul: true, defaulted: true, stateLoaded };
  return { longhaul: raw === "state", stateLoaded };
}

/** Longhaul answers nothing for this pass: it is not the selected compactor. */
export function stateStandsDown(selection: CompactorSelection): boolean {
  return !selection.longhaul;
}
