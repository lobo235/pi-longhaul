/**
 * The chained replay: each arm continues from its OWN earlier compactions, not from the ones the recording made.
 * A recorded session was compacted by whatever compactor ran while it was recorded, so replaying compaction 5 on its
 * recorded path would hand the State compactor another compactor's summary every time: it would only ever measure a
 * switchover. Chained, the arm's compaction 4 replaces the recorded one on the path to compaction 5, at the same
 * position and cut, so the measures describe a session that ran on that compactor throughout. The conversation after
 * each compaction stays as recorded: that is the counterfactual the replay accepts.
 */
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import type { Candidate } from "./candidates.ts";

/** What an arm wrote at one compaction, enough to stand in for the recorded entry. */
export interface ArmCompaction {
  summary: string;
  details?: unknown;
  fromHook: boolean;
  /** Custom entries the compactor appends right after its compaction live (the State compactor's span record). */
  follow?: Array<{ customType: string; data: unknown }>;
}

type CompactionEntry = Extract<SessionEntry, { type: "compaction" }>;

/** `candidate` with each earlier compaction on its path replaced by the arm's own (keyed by the recorded entry's id). */
export function asChained(candidate: Candidate, own: ReadonlyMap<string, ArmCompaction>): { candidate: Candidate } | { error: string } {
  const pathEntries: SessionEntry[] = [];
  for (const entry of candidate.pathEntries) {
    if (entry.type !== "compaction") {
      pathEntries.push(entry);
      continue;
    }
    const mine = own.get(entry.id);
    if (!mine) return { error: `chain broken: the arm has no compaction of its own for the earlier compaction ${entry.id}, so this one cannot continue from it` };
    const { details: _recorded, ...kept } = entry as CompactionEntry & { details?: unknown };
    pathEntries.push({ ...kept, summary: mine.summary, fromHook: mine.fromHook, ...(mine.details !== undefined ? { details: mine.details } : {}) } as CompactionEntry);
    (mine.follow ?? []).forEach((custom, index) => {
      pathEntries.push({ type: "custom", id: `${entry.id}.follow${index + 1}`, parentId: index === 0 ? entry.id : `${entry.id}.follow${index}`, timestamp: entry.timestamp, customType: custom.customType, data: custom.data } as SessionEntry);
    });
  }
  return { candidate: { ...candidate, pathEntries } };
}

/** Each session's compactions oldest first, one session after another: the order a chained replay must run them in. */
export function chainOrder(candidates: readonly Candidate[]): Candidate[] {
  return [...candidates].sort((a, b) => a.file.localeCompare(b.file) || a.index - b.index);
}

export interface ChainReport<S> {
  scored(arm: string, candidate: Candidate, result: S): void;
  failed(arm: string, candidate: Candidate, error: string): void;
}

/**
 * Every compaction of every session, oldest first, through every arm, each arm on a path carrying its own earlier
 * compactions. An arm that fails once cannot continue that session: each later compaction of it is reported as a
 * broken chain rather than scored on a path the arm never wrote.
 */
export async function runChained<S extends { compaction: ArmCompaction }>(candidates: readonly Candidate[], arms: readonly string[], score: (arm: string, candidate: Candidate) => Promise<S>, report: ChainReport<S>): Promise<void> {
  const own = new Map(arms.map((arm) => [arm, new Map<string, ArmCompaction>()]));
  for (const candidate of chainOrder(candidates)) {
    for (const arm of arms) {
      const mine = own.get(arm)!;
      const chained = asChained(candidate, mine);
      if ("error" in chained) {
        report.failed(arm, candidate, chained.error);
        continue;
      }
      try {
        const result = await score(arm, chained.candidate);
        mine.set(candidate.entryId, result.compaction);
        report.scored(arm, chained.candidate, result);
      } catch (error) {
        report.failed(arm, candidate, error instanceof Error ? error.message : String(error));
      }
    }
  }
}
