import test from "node:test";
import assert from "node:assert/strict";

import { fitToHardCap } from "./capfit.ts";
import { DEFAULT_CAPS } from "./events.ts";
import { activeCorrections, activeDeadEnds, activeDecisions, activeWorkLog, project } from "./project.ts";
import { closeEvent, ev, logOf, quote, resetSeq } from "./test-support.ts";

test.beforeEach(() => resetSeq());

/** A state with 3 work-log lines, 3 decisions, 2 dead ends, 2 corrections; every item counts 100 chars, the fixed sections 500. */
function fullState() {
  return project(logOf(
    ev({ kind: "objective.set", quote: quote("u1", "build the state compactor please") }),
    ev({ kind: "correction.add", id: "R1", quote: quote("u2", "never use mocks anywhere") }),
    ev({ kind: "correction.add", id: "R2", quote: quote("u3", "keep files under 400 lines") }),
    ev({ kind: "decision.add", id: "D1", text: "copy the ledger" }),
    ev({ kind: "decision.add", id: "D2", text: "typebox for the schema" }),
    ev({ kind: "decision.add", id: "D3", text: "fenced json" }),
    ev({ kind: "deadEnd.add", id: "X1", text: "structured outputs on the example provider" }),
    ev({ kind: "deadEnd.add", id: "X2", text: "roleplay fallback" }),
    closeEvent(1), closeEvent(2), closeEvent(3),
  ), DEFAULT_CAPS);
}
const measure = (state: ReturnType<typeof fullState>) => 500 + 100 * (activeWorkLog(state).length + activeDecisions(state).length + activeDeadEnds(state).length + activeCorrections(state).length);

test("fitToHardCap: under the cap nothing changes", () => {
  const state = fullState();
  const result = fitToHardCap(state, { ...DEFAULT_CAPS, hardChars: 2000 }, measure);
  assert.deepEqual(result.retired, { workLog: 0, decisions: 0, deadEnds: 0, corrections: 0 });
  assert.equal(result.exhausted, false);
  assert.deepEqual(result.state, state);
});

test("fitToHardCap: retires in the order work log, decisions, dead ends, corrections, one at a time, oldest first", () => {
  const result = fitToHardCap(fullState(), { ...DEFAULT_CAPS, hardChars: 900 }, measure);
  // 500 + 100*10 = 1500 → need to drop 6 items: 3 work-log lines, then 3 decisions
  assert.deepEqual(result.retired, { workLog: 3, decisions: 3, deadEnds: 0, corrections: 0 });
  assert.equal(measure(result.state), 900);
  assert.equal(activeWorkLog(result.state).length, 0);
  assert.deepEqual(activeDecisions(result.state).map((d) => d.id), []);
  assert.equal(result.state.retired.workLog, 3);
  assert.equal(result.state.retired.decisions, 3);
  assert.equal(result.exhausted, false);
  const partial = fitToHardCap(fullState(), { ...DEFAULT_CAPS, hardChars: 1300 }, measure);
  assert.deepEqual(partial.retired, { workLog: 2, decisions: 0, deadEnds: 0, corrections: 0 });
  assert.deepEqual(activeWorkLog(partial.state).map((line) => line.span), [3]);
});

test("fitToHardCap: hard cap terminates — with every section already at its cap and long quotes it retires everything retirable and reports exhausted, keeping Objective and Now", () => {
  const state = { ...fullState(), now: { inProgress: ["x"], next: [], blocked: [], resume: "y", span: 3, carried: false } };
  const result = fitToHardCap(state, { ...DEFAULT_CAPS, hardChars: 100 }, measure);
  assert.equal(result.exhausted, true);
  assert.deepEqual(result.retired, { workLog: 3, decisions: 3, deadEnds: 2, corrections: 2 });
  assert.equal(measure(result.state), 500);
  assert.equal(result.state.objective?.quote.ordinal, "u1");
  assert.equal(result.state.now?.resume, "y");
});
