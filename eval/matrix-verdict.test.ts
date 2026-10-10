/**
 * The model matrix's verdict on one cell (matrix-verdict.ts): did a real model's compaction go through Longhaul,
 * and did the session still know what it was told before it.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { matrixVerdict, type MatrixRecord } from "./matrix-verdict.ts";

const usage = { input: 12_000, output: 900, reasoning: 300, cacheRead: 0, cacheWrite: 0 };
const accepted: MatrixRecord = { event: "compaction", durationMs: 4200, narrative: { kind: "diff", calls: 1, usage } };
const loaded: MatrixRecord = { event: "extension-loaded" };
const expect = { value: "8192", rule: /src\/narrative/, ruleQuote: "never suggest edits" };
const recall = "You said never to suggest edits under src/narrative/, and the constant is 8192.";
const summary = "## Constraints & corrections (verbatim, newest last)\n- K1 [u2] From now on, never suggest edits to anything";

for (const [name, input, failure] of [
  ["pi refused the compact command", { compact: { success: false, error: "no model" }, summary: "", records: [loaded], recall, expect }, "pi did not compact: no model"],
  // A login with no quota left fails every turn; pi then has nothing to compact, which named the wrong cause.
  ["the model's turns failed before the compaction", { compact: { success: false, error: "Nothing to compact (session too small)" }, summary: "",
    records: [loaded], recall, expect, turnErrors: ["400 out of extra usage", "400 out of extra usage"] },
    "2 of the session's turns failed at the provider before the compaction: 400 out of extra usage"],
  ["Longhaul fell back to pi's compaction", { compact: { success: true }, summary, records: [loaded, { event: "fallback", reason: "diff-rejected" }], recall, expect }, "Longhaul fell back to pi's own compaction: diff-rejected"],
  ["no compaction record was written", { compact: { success: true }, summary, records: [loaded], recall, expect }, "no compaction record in the log (events: extension-loaded)"],
  ["the diff was not accepted", { compact: { success: true }, summary, records: [{ ...accepted, narrative: { ...accepted.narrative, kind: "carried" } }], recall, expect }, "the diff was not accepted (narrative kind carried)"],
] as const) test(`matrixVerdict: fails when ${name}`, () => {
  const cell = matrixVerdict(input);
  assert.equal(cell.verdict, "fail");
  assert.equal(cell.failure, failure);
});

test("matrixVerdict: a cell that compacted through Longhaul passes, with what the pass cost and what it carried", () => {
  assert.deepEqual(matrixVerdict({ compact: { success: true }, summary, records: [loaded, accepted], recall, expect }), {
    verdict: "pass", reasoning: "off", calls: 1, inputTokens: 12_000, outputTokens: 900, reasoningTokens: 300, passMs: 4200,
    carriedRule: true, recalledValue: true, recalledRule: true,
  });
});

test("matrixVerdict: the reasoning level asked for is reported", () => {
  const lowest = { ...accepted, narrative: { ...accepted.narrative, reasoning: "low" } };
  assert.equal(matrixVerdict({ compact: { success: true }, summary, records: [lowest], recall, expect }).reasoning, "low");
});

test("matrixVerdict: what the state and the session lost is reported, not failed: a cell judges whether Longhaul ran", () => {
  const cell = matrixVerdict({ compact: { success: true }, summary: "## Constraints & corrections\n(none)", records: [accepted], recall: "I do not remember.", expect });
  assert.equal(cell.verdict, "pass");
  assert.deepEqual([cell.carriedRule, cell.recalledValue, cell.recalledRule], [false, false, false]);
});

test("matrixVerdict: records another model wrote to the same log are not this cell's", () => {
  const other = { ...accepted, narrative: { ...accepted.narrative, model: "other/model", kind: "carried" } };
  const mine = { ...accepted, narrative: { ...accepted.narrative, model: "p/m" } };
  assert.equal(matrixVerdict({ compact: { success: true }, summary, records: [mine, other], recall, expect, model: "p/m" }).verdict, "pass");
});

test("matrixVerdict: the newest compaction record is the one judged", () => {
  const older = { ...accepted, narrative: { ...accepted.narrative, kind: "carried" } };
  assert.equal(matrixVerdict({ compact: { success: true }, summary, records: [older, accepted], recall, expect }).verdict, "pass");
});
