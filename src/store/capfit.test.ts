import test from "node:test";
import assert from "node:assert/strict";

import { fitToHardCap, WORKLOG_FLOOR } from "./capfit.ts";
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
/** The same state with `n` work-log lines (spans 1..n). */
function withWorkLog(state: ReturnType<typeof fullState>, n: number) {
  const cloned = structuredClone(state);
  cloned.workLog = Array.from({ length: n }, (_, index) => ({ span: index + 1, fromRef: `u${index + 1}`, toRef: `u${index + 2}`, text: `did the thing in span ${index + 1}`, narrativeLess: false }));
  return cloned;
}

/** A condensed correction counts 30 chars, a whole one 100. */
const measure = (state: ReturnType<typeof fullState>) => {
  const corrections = activeCorrections(state);
  const condensed = corrections.filter((item) => item.condensed).length;
  return 500 + 100 * (activeWorkLog(state).length + activeDecisions(state).length + activeDeadEnds(state).length + corrections.length - condensed) + 30 * condensed;
};

test("fitToHardCap: under the cap nothing changes", () => {
  const state = fullState();
  const result = fitToHardCap(state, { ...DEFAULT_CAPS, hardChars: 2000 }, measure);
  assert.deepEqual(result.retired, { workLog: 0, decisions: 0, deadEnds: 0 });
  assert.equal(result.condensed, 0);
  assert.equal(result.exhausted, false);
  assert.deepEqual(result.state, state);
});

test("fitToHardCap: retires in the order work log, decisions, dead ends, one at a time, oldest first", () => {
  // 6 work-log lines, 3 decisions, 2 dead ends, 2 rules: 500 + 100*13 = 1800. Down to 1500 drops exactly the 3 oldest
  // lines, never the 3 newest (the floor: see the next test).
  const state = withWorkLog(fullState(), 6);
  const result = fitToHardCap(state, { ...DEFAULT_CAPS, hardChars: 1500 }, measure);
  assert.deepEqual(result.retired, { workLog: 3, decisions: 0, deadEnds: 0 });
  assert.equal(measure(result.state), 1500);
  assert.deepEqual(activeWorkLog(result.state).map((line) => line.span), [4, 5, 6]);
  assert.equal(result.state.retired.workLog, 3);
  assert.equal(result.exhausted, false);
  // Further down, decisions go before dead ends.
  const deeper = fitToHardCap(state, { ...DEFAULT_CAPS, hardChars: 1200 }, measure);
  assert.deepEqual(deeper.retired, { workLog: 3, decisions: 3, deadEnds: 0 });
});

test("fitToHardCap: the work log never retires to empty — the newest WORKLOG_FLOOR lines stay and decisions retire instead", () => {
  // The state real sessions sat in: at the cap with a 3-line work log. Dropping all 3 used to be the whole fix.
  const result = fitToHardCap(fullState(), { ...DEFAULT_CAPS, hardChars: 900 }, measure);
  assert.equal(result.retired.workLog, 0, "the 3 newest spans stay: 'do not redo what it shows done' is read from them");
  assert.equal(activeWorkLog(result.state).length, WORKLOG_FLOOR);
  assert.deepEqual(result.retired, { workLog: 0, decisions: 3, deadEnds: 2 });
  assert.ok(result.condensed >= 1, "then corrections condense, as before");
  assert.equal(measure(result.state) <= 900, true);
});

test("fitToHardCap: a work log above the floor still retires down to it, oldest first, and stops there", () => {
  const state = withWorkLog(fullState(), 8);
  const partial = fitToHardCap(state, { ...DEFAULT_CAPS, hardChars: 1700 }, measure);
  // 500 + 100*15 = 2000 -> 1700 drops the 3 oldest lines and stops, still above the floor.
  assert.deepEqual(partial.retired, { workLog: 3, decisions: 0, deadEnds: 0 });
  assert.deepEqual(activeWorkLog(partial.state).map((line) => line.span), [4, 5, 6, 7, 8]);
  // Further down the lines go to the floor, then decisions: 5 lines + 3 decisions = 8 items dropped.
  const deep = fitToHardCap(state, { ...DEFAULT_CAPS, hardChars: 1200 }, measure);
  assert.deepEqual(deep.retired, { workLog: 5, decisions: 3, deadEnds: 0 });
  assert.deepEqual(activeWorkLog(deep.state).map((line) => line.span), [6, 7, 8]);
});

test("fitToHardCap: corrections are condensed, oldest first, after everything retirable is gone, and never retired", () => {
  // 500 + 100*13 = 1800 with a 6-line work log; 3 lines and 3 decisions go, then 2 dead ends: 1000, condensing R1 leaves 930.
  const result = fitToHardCap(withWorkLog(fullState(), 6), { ...DEFAULT_CAPS, hardChars: 940 }, measure);
  assert.deepEqual(result.retired, { workLog: 3, decisions: 3, deadEnds: 2 });
  assert.equal(result.condensed, 1);
  assert.deepEqual(activeCorrections(result.state).map((item) => [item.id, item.condensed ?? false]), [["R1", true], ["R2", false]]);
  assert.equal(result.state.retired.corrections, 0);
  assert.equal(result.exhausted, false);
});

test("fitToHardCap: hard cap terminates — with every section already at its cap and long quotes it retires everything retirable, condenses every correction and reports exhausted, keeping Objective, Now and every rule", () => {
  const state = { ...fullState(), now: { inProgress: ["x"], next: [], blocked: [], resume: "y", span: 3, carried: false } };
  const result = fitToHardCap(state, { ...DEFAULT_CAPS, hardChars: 100 }, measure);
  assert.equal(result.exhausted, true);
  // The work-log floor is the one thing left standing when nothing else is retirable.
  assert.deepEqual(result.retired, { workLog: 0, decisions: 3, deadEnds: 2 });
  assert.equal(result.condensed, 2);
  assert.equal(measure(result.state), 860);
  assert.deepEqual(activeCorrections(result.state).map((item) => item.id), ["R1", "R2"]);
  assert.equal(result.state.objective?.quote.ordinal, "u1");
  assert.equal(result.state.now?.resume, "y");
});
