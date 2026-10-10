/** The scorer's console summary: one line per arm. */
import type { ArmSummary } from "./measures.ts";

const fixed = (value: number | null) => value?.toFixed(2) ?? "-";
const seconds = (ms: number | null) => (ms === null ? "-" : `${Math.round(ms / 1000)}s`);
const whole = (value: number | null) => (value === null ? "-" : String(Math.round(value)));

export function formatSummaryLine(arm: string, s: ArmSummary, probe: boolean): string {
  const warm = s.warmShare === null ? "" : ` warm=${fixed(s.warmShare)} cached=${fixed(s.warmCached)}`;
  const probed = probe ? ` probe=${fixed(s.probeShare)} precision=${fixed(s.probePrecision)} planned=${fixed(s.probePlanned)}` : "";
  return `${arm.padEnd(15)} n=${s.n} p50=${seconds(s.durationP50Ms)} p90=${seconds(s.durationP90Ms)} chars=${s.renderedChars} in=${whole(s.inputTokens)} out=${whole(s.outputTokens)} need=${fixed(s.needShare)} files=${fixed(s.fileShare)} artifacts=${fixed(s.artifactShare)} corrections=${fixed(s.correctionShare)} earlierCorrections=${fixed(s.earlierCorrectionShare)} distinctCorrections=${fixed(s.earlierCorrectionsDistinct.share)}/${s.earlierCorrectionsDistinct.n} objectiveMoved=${s.objectiveMoved} claimWrong=${s.claimWrong} facts=${fixed(s.factShare)} factsWithRecall=${fixed(s.factRecallShare)} reused=${fixed(s.reusedShare)}${warm}${probed}`;
}

/** A compaction or arm run the scorer could not score, as written to rows.jsonl. */
export interface NotScored { arm?: string; session: string; at: string; error: string }

/** One line naming what was left out, or undefined when everything was scored. */
export function formatNotScored(failures: readonly NotScored[], compactions: number): string | undefined {
  if (failures.length === 0) return undefined;
  const skipped = failures.filter((failure) => failure.arm === undefined);
  const armFailures = failures.filter((failure) => failure.arm !== undefined);
  const parts: string[] = [];
  if (skipped.length) parts.push(`${skipped.length} of ${compactions} compactions (${skipped[0].error})`);
  if (armFailures.length) parts.push(`${armFailures.length} arm run${armFailures.length === 1 ? "" : "s"} failed (${armFailures[0].arm}: ${armFailures[0].error})`);
  return `not scored: ${parts.join("; ")}; see rows.jsonl`;
}
