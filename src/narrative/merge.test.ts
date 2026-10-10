import test from "node:test";
import assert from "node:assert/strict";

import { mergeChunkDiffs } from "./merge.ts";
import type { NarrativeDiff } from "./types.ts";

const base = (narrative: string, extra: Partial<NarrativeDiff> = {}): NarrativeDiff => ({ narrative, corrections: [], lifts: [], decisions: [], deadEnds: [], now: { inProgress: [], next: [], blocked: [], resume: narrative }, ...extra });

test("mergeChunkDiffs: narratives join in order, lists concatenate, objective and now come from the last chunk that has them, missing chunks are named", () => {
  const merged = mergeChunkDiffs([
    base("first.", { objective: { messageRef: "u1", text: "goal" }, decisions: [{ text: "d1" }] }),
    undefined,
    base("third.", { decisions: [{ text: "d3" }], corrections: [{ messageRef: "u5", text: "rule" }] }),
  ]);
  assert.ok(merged);
  assert.equal(merged.diff.narrative, "first. third.");
  assert.deepEqual(merged.diff.decisions.map((d) => d.text), ["d1", "d3"]);
  assert.deepEqual(merged.diff.objective, { messageRef: "u1", text: "goal" });
  assert.equal(merged.diff.now.resume, "third.");
  assert.deepEqual(merged.missingChunks, [2]);
});

test("mergeChunkDiffs: all chunks missing is undefined; a single chunk passes through", () => {
  assert.equal(mergeChunkDiffs([undefined, undefined]), undefined);
  const one = base("only");
  assert.deepEqual(mergeChunkDiffs([one]), { diff: one, missingChunks: [] });
});
