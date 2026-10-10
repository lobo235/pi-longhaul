import test from "node:test";
import assert from "node:assert/strict";

import { summarizeSpans } from "./segments-cli.ts";
import { simulateSegments, timelineOf, type TimelineEvent } from "./segments.ts";
import { assistantEntry, chain, compactionEntry, userEntry } from "../test-support.ts";

const turn = (atSeconds: number, tokens: number): TimelineEvent => ({ kind: "turn", at: atSeconds * 1000, tokens });
const compaction = (atSeconds: number): TimelineEvent => ({ kind: "compaction", at: atSeconds * 1000 });
const policy = { growthTokens: 20_000, passMs: 60_000 };

test("simulateSegments: a pass starts each time context grew by growthTokens since the last start, one in flight; at compaction the lag is what no finished pass covers", () => {
  const spans = simulateSegments([turn(0, 30_000), turn(30, 52_000), turn(60, 60_000), turn(120, 75_000), turn(200, 95_000), turn(210, 100_000), compaction(220)], policy);
  // 52k starts pass 1 (ends at 90 s, covers to 52k); 75k is 23k past 52k, starts pass 2 at 120 s (ends 180 s, covers to 75k);
  // 95k is 20k past 75k, starts pass 3 at 200 s, still running at the compaction: the lag is 100k - 75k.
  assert.deepEqual(spans, [{ passes: 3, spanTokens: 70_000, lagTokens: 25_000 }]);
});

test("simulateSegments: a pass in flight blocks the next trigger, and a compaction abandons it; the next span starts from its own first turn", () => {
  const spans = simulateSegments([turn(0, 10_000), turn(10, 40_000), turn(20, 70_000), compaction(30), turn(40, 25_000), turn(50, 30_000), compaction(60)], policy);
  assert.deepEqual(spans, [
    { passes: 1, spanTokens: 60_000, lagTokens: 60_000 },
    { passes: 0, spanTokens: 5_000, lagTokens: 5_000 },
  ]);
});

test("timelineOf: assistant requests with a valid usage are turns sized by it, compactions are marked; other entries and bad usage are skipped", () => {
  const good = assistantEntry("a1", "x");
  const bad = assistantEntry("a2", "y");
  (bad as { message: { usage: unknown } }).message.usage = { input: -1, output: 0 };
  const timeline = timelineOf(chain([userEntry("u1", "go"), good, bad, compactionEntry("c1", undefined)]));
  assert.deepEqual(timeline.map((event) => event.kind), ["turn", "compaction"]);
  assert.ok(timeline[0].kind === "turn" && timeline[0].tokens > 0);
});

test("summarizeSpans: percentiles of passes and lag, and the share of compactions left with at most one Segment's worth", () => {
  const summary = summarizeSpans([{ passes: 0, spanTokens: 5_000, lagTokens: 5_000 }, { passes: 3, spanTokens: 70_000, lagTokens: 25_000 }, { passes: 4, spanTokens: 90_000, lagTokens: 10_000 }], 20_000);
  assert.deepEqual(summary, { spans: 3, passesP50: 3, passesP90: 4, spanTokensP50: 70_000, lagP50: 10_000, lagP90: 25_000, lagWithinGrowth: 2 / 3, noPass: 1 });
});
