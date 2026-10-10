/**
 * The dry replay over recorded transcripts: each one converted (replay-steps.ts) and run leniently
 * through a real pi session with this extension and a fake summarizer (replay.ts). It asks whether the
 * state compactor holds up on real sessions -- does every compaction stay the state compactor's, does
 * any handler throw -- and, once Segment passes exist, when they fire. Output is counts per transcript
 * and a total, never text: a recorded transcript names the user's own projects and files, so even a
 * path is printed only as a hash.
 *
 *   npm run replay                         # the newest 5 transcripts with a compaction
 *   REPLAY_N=20 npm run replay
 *   npm run replay -- FILE.jsonl ...       # exactly these
 *
 * REPLAY_SESSIONS (default ~/.pi/agent/sessions), REPLAY_MAX_ENTRIES (default 5000: larger ones are skipped).
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import { listTranscripts, pathTo, readTranscript } from "./candidates.ts";
import { positiveIntEnv } from "./env.ts";
import { replay, type ReplayResult } from "./replay.ts";
import { stepsOf } from "./replay-steps.ts";

export interface ReplayRow {
  transcript: string;
  steps: number;
  recordedCompactions: number;
  compactions: number;
  byState: number;
  fallbacks: number;
  requests: number;
  summarizerRequests: number;
  missingTurns: number;
  leftoverTurns: number;
  refusedCompactions: number;
  extensionErrors: number;
  skipped: Record<string, number>;
  medianSummaryChars: number;
  ms: number;
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : 0;
};

/** One transcript's counts. Only numbers and the skipped kinds (entry types, roles, custom types) leave this function. */
export function replayRow(file: string, recorded: { steps: number; recordedCompactions: number; skipped: Record<string, number> }, result: ReplayResult, ms: number): ReplayRow {
  const byState = result.compactions.filter((compaction) => compaction.byState).length;
  return {
    transcript: transcriptHash(file),
    ...recorded,
    compactions: result.compactions.length,
    byState,
    fallbacks: result.compactions.length - byState,
    requests: result.requests,
    summarizerRequests: result.summarizerRequests,
    missingTurns: result.missingTurns,
    leftoverTurns: result.leftoverTurns,
    refusedCompactions: result.refusedCompactions,
    extensionErrors: result.errors.length,
    medianSummaryChars: median(result.compactions.map((compaction) => compaction.summary.length)),
    ms,
  };
}

/** A transcript is named only by a hash of its path. */
const transcriptHash = (file: string): string => createHash("sha256").update(path.resolve(file)).digest("hex").slice(0, 12);

const MAX_ENTRIES = positiveIntEnv("REPLAY_MAX_ENTRIES", 5000);

/** The newest `count` transcripts that recorded a compaction and fit the entry cap. */
function newestWithCompaction(dir: string, count: number): string[] {
  const files = listTranscripts(dir).map((file) => ({ file, mtime: fs.statSync(file).mtimeMs })).sort((a, b) => b.mtime - a.mtime);
  const picked: string[] = [];
  for (const { file } of files) {
    if (picked.length >= count) break;
    const entries = readTranscript(file);
    if (entries.length <= MAX_ENTRIES && entries.some((entry) => entry.type === "compaction")) picked.push(file);
  }
  return picked;
}

function branchOf(entries: SessionEntry[]): SessionEntry[] {
  const leaf = entries.at(-1);
  return leaf ? pathTo(entries, leaf.id) : [];
}

async function replayFile(file: string): Promise<ReplayRow | undefined> {
  const entries = readTranscript(file);
  if (entries.length > MAX_ENTRIES) return undefined;
  const branch = branchOf(entries);
  const { steps, skipped } = stepsOf(branch);
  const started = Date.now();
  const result = await replay(steps, { lenient: true });
  return replayRow(file, { steps: steps.length, recordedCompactions: steps.filter((step) => step.kind === "compact").length, skipped }, result, Date.now() - started);
}

async function main(): Promise<void> {
  const named = process.argv.slice(2);
  const files = named.length ? named : newestWithCompaction(process.env.REPLAY_SESSIONS ?? path.join(os.homedir(), ".pi", "agent", "sessions"), positiveIntEnv("REPLAY_N", 5));
  const rows: ReplayRow[] = [];
  for (const file of files) {
    const row = await replayFile(file);
    if (!row) {
      console.log(JSON.stringify({ transcript: transcriptHash(file), skipped: `over REPLAY_MAX_ENTRIES (${MAX_ENTRIES})` }));
      continue;
    }
    rows.push(row);
    console.log(JSON.stringify(row));
  }
  const sum = (key: keyof ReplayRow) => rows.reduce((total, row) => total + (row[key] as number), 0);
  console.log(JSON.stringify({ total: { transcripts: rows.length, compactions: sum("compactions"), byState: sum("byState"), fallbacks: sum("fallbacks"), extensionErrors: sum("extensionErrors"), missingTurns: sum("missingTurns"), leftoverTurns: sum("leftoverTurns"), refusedCompactions: sum("refusedCompactions") } }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) await main();
