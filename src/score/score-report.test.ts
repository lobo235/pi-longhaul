import assert from "node:assert/strict";
import { test } from "node:test";

import { summarize } from "./measures.ts";
import { formatNotScored, formatSummaryLine } from "./score-report.ts";

test("formatSummaryLine: one line per arm with its count, time, size, tokens and shares; a measure with no data reads '-'", () => {
  const row = { arm: "state", at: "x", session: "s", renderedChars: 9000, durationMs: 42_000, tokens: { input: 20_000, output: 900 }, need: { covered: 3, total: 4, share: 0.75, missed: [] }, corrections: { retained: 1, total: 1, share: 1, missed: [] }, objective: null, claims: null };
  const line = formatSummaryLine("state", summarize([row]).state, false);
  assert.match(line, /^state\s+n=1 p50=42s p90=42s chars=9000 in=20000 out=900 need=0\.75 /);
  assert.match(line, /files=- /);
  assert.ok(!line.includes("probe="), "no probe columns unless the probe ran");
  assert.match(formatSummaryLine("state", summarize([row]).state, true), / probe=- precision=- planned=-$/);
});

test("formatNotScored: a run that left compactions or arms unscored says how many and why, so a partial run cannot pass for a whole one", () => {
  assert.equal(formatNotScored([], 56), undefined);
  const line = formatNotScored([
    { session: "a", at: "1", error: "nothing to summarize at keepRecentTokens 20000" },
    { session: "b", at: "2", error: "nothing to summarize at keepRecentTokens 20000" },
    { arm: "state-turns", session: "a", at: "3", error: "timeout" },
  ], 56);
  assert.equal(line, "not scored: 2 of 56 compactions (nothing to summarize at keepRecentTokens 20000); 1 arm run failed (state-turns: timeout); see rows.jsonl");
});
