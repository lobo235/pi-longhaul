/**
 * The dry Segment-pass schedule (segments.ts) over every recorded transcript, per growth threshold. No model call;
 * prints counts and percentiles only, never a path or text.
 *
 *   npm run segments                                  # ~/.pi/agent/sessions, growth 15k,22k,30k, 60 s passes
 *   SEGMENT_SESSIONS=DIR SEGMENT_GROWTH=20000,25000 SEGMENT_PASS_MS=90000 npm run segments
 */
import os from "node:os";
import path from "node:path";

import { listTranscripts, pathTo, readTranscript } from "./candidates.ts";
import { positiveIntEnv } from "./env.ts";
import { percentile } from "./measures.ts";
import { simulateSegments, timelineOf, type SpanSegments } from "./segments.ts";

export function summarizeSpans(spans: SpanSegments[], growthTokens: number) {
  const lags = spans.map((span) => span.lagTokens);
  return {
    spans: spans.length,
    passesP50: percentile(spans.map((span) => span.passes), 50),
    passesP90: percentile(spans.map((span) => span.passes), 90),
    spanTokensP50: percentile(spans.map((span) => span.spanTokens), 50),
    lagP50: percentile(lags, 50),
    lagP90: percentile(lags, 90),
    /** Compactions whose remaining work is at most one Segment's worth: a cheap compaction pass. */
    lagWithinGrowth: spans.length ? spans.filter((span) => span.lagTokens <= growthTokens).length / spans.length : null,
    noPass: spans.filter((span) => span.passes === 0).length,
  };
}

function growthList(): number[] {
  const raw = process.env.SEGMENT_GROWTH ?? "15000,22000,30000";
  const values = raw.split(",").map((part) => positiveIntEnv("SEGMENT_GROWTH", 1, { SEGMENT_GROWTH: part.trim() }));
  return [...new Set(values)];
}

function main(): void {
  const dir = process.env.SEGMENT_SESSIONS ?? path.join(os.homedir(), ".pi", "agent", "sessions");
  const passMs = positiveIntEnv("SEGMENT_PASS_MS", 60_000);
  const timelines = listTranscripts(dir).flatMap((file) => {
    const entries = readTranscript(file);
    const leaf = entries.at(-1);
    return leaf && entries.some((entry) => entry.type === "compaction") ? [timelineOf(pathTo(entries, leaf.id))] : [];
  });
  for (const growthTokens of growthList()) {
    const spans = timelines.flatMap((timeline) => simulateSegments(timeline, { growthTokens, passMs }));
    console.log(JSON.stringify({ growthTokens, passMs, transcripts: timelines.length, ...summarizeSpans(spans, growthTokens) }));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) main();
