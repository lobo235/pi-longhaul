/**
 * What one pass carries from the previous state entry: the details shape every state compaction
 * entry writes (the checkpoint, caps, ledger slice, snapshot, narrative trace, file lists), and the
 * file-ops carry that pi skips for hook compactions (pi seeds file ops from a previous entry only
 * when it was pi's own). The lists are carried from the latest compaction WHICHEVER compactor wrote
 * it (previousFileLists), so a switchover from another compactor keeps its files, and render.ts
 * shows them as `## Files`.
 */
import type { FileOperations, SessionEntry } from "@earendil-works/pi-coding-agent";

import { sanitizeLearnedValues, type LearnedValue } from "./learned.ts";
import type { CommandRecord, ErrorRecord, WorkspaceSnapshot } from "./ledger/handoff.ts";
import type { NarrativeOutcome } from "./narrative/types.ts";
import { pruneCarriedPaths, type PruneRemoval } from "./prune.ts";
import { newerStateFormat, type Caps } from "./store/events.ts";
import { compactorOfEntry } from "./store/log.ts";
import type { SessionState } from "./store/project.ts";

export interface NarrativeTrace {
  kind: NarrativeOutcome["kind"];
  reason?: NarrativeOutcome["reason"];
  model?: string;
  calls: number;
  accepted: number;
  dropped: number;
  rescued: number;
  missingChunks: number[];
  usage: NarrativeOutcome["usage"];
  timings: NarrativeOutcome["timings"];
  /** Turns mode only (narrative/turns/run.ts): one trace per section, with its not-applicable reasons for the audit. */
  sections?: NarrativeOutcome["sections"];
  /** Switchover seed ordinals the model called one-offs (ids only): the earlier rules this pass did not record. */
  oneOffs?: string[];
  /** The level asked for when the model cannot turn reasoning off (narrative/reasoning.ts); absent = reasoning off. */
  reasoning?: string;
}

export interface StateDetails {
  compactor: "state";
  /** STATE_FORMAT when written; absent on details written before formats existed (format 1). */
  stateFormat?: number;
  promptRevision: string;
  /** The checkpoint: equals projectAt(log, span) after cap fit. */
  state: SessionState;
  caps: Caps;
  ledger: { commands: CommandRecord[]; errors: ErrorRecord[] };
  snapshot?: WorkspaceSnapshot;
  narrative: NarrativeTrace;
  readFiles: string[];
  modifiedFiles: string[];
  /** The carried Learned values (learned.ts), newest use first; absent on entries written before them. */
  learnedValues?: LearnedValue[];
}

/** The previous state entry's Learned values, sanitized (learned.ts); none after another compactor. */
export function previousLearnedValues(branchEntries: SessionEntry[]): LearnedValue[] {
  const carried = latestStateDetails(branchEntries)?.learnedValues;
  if (!Array.isArray(carried)) return [];
  return sanitizeLearnedValues(carried);
}

export const FILE_LIST_CAP = 200;

export function isStateDetails(value: unknown): value is StateDetails {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<StateDetails>;
  return candidate.compactor === "state" && newerStateFormat(candidate) === undefined && typeof candidate.state === "object" && candidate.state !== null && typeof candidate.ledger === "object" && candidate.ledger !== null && Array.isArray(candidate.readFiles) && Array.isArray(candidate.modifiedFiles);
}

export function latestStateDetails(branchEntries: SessionEntry[]): StateDetails | undefined {
  for (let index = branchEntries.length - 1; index >= 0; index--) {
    const entry = branchEntries[index];
    if (entry.type !== "compaction") continue;
    return compactorOfEntry(entry) === "state" && isStateDetails(entry.details) ? entry.details : undefined;
  }
  return undefined;
}

/** The file lists every compactor writes to its entry's details, read loosely (only strings survive). */
export interface FileLists { readFiles: string[]; modifiedFiles: string[] }

/**
 * The latest compaction entry's file lists, whichever compactor wrote it: pi and other compactors write the
 * same `readFiles` / `modifiedFiles` details state does. Undefined when the branch has no compaction.
 */
export function previousFileLists(branchEntries: SessionEntry[]): FileLists | undefined {
  for (let index = branchEntries.length - 1; index >= 0; index--) {
    const entry = branchEntries[index];
    if (entry.type !== "compaction") continue;
    const details = (entry.details ?? {}) as { readFiles?: unknown; modifiedFiles?: unknown };
    return { readFiles: stringList(details.readFiles), modifiedFiles: stringList(details.modifiedFiles) };
  }
  return undefined;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function unionCapped(carried: string[], current: string[], cap: number): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const file of [...carried, ...current]) {
    if (seen.has(file)) continue;
    seen.add(file);
    merged.push(file);
  }
  return merged.slice(-cap);
}

export function carryFileOps(previous: FileLists | undefined, fileOps: FileOperations, cap = FILE_LIST_CAP): { readFiles: string[]; modifiedFiles: string[]; removed: PruneRemoval[] } {
  const modifiedNow = [...new Set([...fileOps.written, ...fileOps.edited])];
  const readNow = [...fileOps.read].filter((file) => !modifiedNow.includes(file));
  const read = pruneCarriedPaths(stringList(previous?.readFiles), readNow);
  const modified = pruneCarriedPaths(stringList(previous?.modifiedFiles), modifiedNow);
  const modifiedFiles = unionCapped(modified.kept, modifiedNow, cap);
  const readFiles = unionCapped(read.kept, readNow, cap).filter((file) => !modifiedFiles.includes(file));
  return { readFiles, modifiedFiles, removed: [...read.removed, ...modified.removed] };
}

export function narrativeTraceOf(outcome: NarrativeOutcome): NarrativeTrace {
  return {
    kind: outcome.kind,
    reason: outcome.reason,
    model: outcome.model,
    calls: outcome.calls.length,
    accepted: outcome.events.length,
    dropped: outcome.rejected.filter((item) => item.final).length,
    rescued: outcome.calls.reduce((n, call) => n + call.rescued, 0),
    missingChunks: outcome.missingChunks,
    usage: outcome.usage,
    timings: outcome.timings,
    ...(outcome.sections ? { sections: outcome.sections } : {}),
    ...(outcome.oneOffs?.length ? { oneOffs: outcome.oneOffs } : {}),
    ...reasoningOf(outcome.calls),
  };
}

function reasoningOf(calls: NarrativeOutcome["calls"]): { reasoning?: string } {
  const level = calls.find((call) => call.reasoning !== undefined)?.reasoning;
  return level === undefined ? {} : { reasoning: level };
}
