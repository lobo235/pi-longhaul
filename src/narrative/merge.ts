/** Merge the per-chunk diffs of a split span into one diff, in chunk order. */
import type { NarrativeDiff } from "./types.ts";

export function mergeChunkDiffs(diffs: Array<NarrativeDiff | undefined>): { diff: NarrativeDiff; missingChunks: number[] } | undefined {
  const present = diffs.filter((diff): diff is NarrativeDiff => diff !== undefined);
  if (present.length === 0) return undefined;
  const missingChunks = diffs.flatMap((diff, i) => (diff === undefined ? [i + 1] : []));
  const last = present[present.length - 1];
  const withObjective = [...present].reverse().find((diff) => diff.objective !== undefined);
  const diff: NarrativeDiff = {
    narrative: present.map((chunk) => chunk.narrative.trim()).filter(Boolean).join(" "),
    ...(withObjective?.objective ? { objective: withObjective.objective } : {}),
    corrections: present.flatMap((chunk) => chunk.corrections),
    lifts: present.flatMap((chunk) => chunk.lifts),
    decisions: present.flatMap((chunk) => chunk.decisions),
    deadEnds: present.flatMap((chunk) => chunk.deadEnds),
    now: last.now,
  };
  return { diff, missingChunks };
}
