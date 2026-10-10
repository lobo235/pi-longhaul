import test from "node:test";
import assert from "node:assert/strict";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import type { Candidate } from "./candidates.ts";
import { formatLabeledLine, labeledMeasures, parseLabels, summarizeLabeled, type SessionLabels } from "./labels.ts";

const user = (id: string, text: string) => ({ type: "message", id, parentId: null, timestamp: "t", message: { role: "user", content: text, timestamp: 1 } });
const said = (id: string, text: string) => ({ type: "message", id, parentId: null, timestamp: "t", message: { role: "assistant", content: [{ type: "text", text }], timestamp: 1 } });
const compaction = (id: string, firstKeptEntryId: string) => ({ type: "compaction", id, parentId: null, timestamp: "t", summary: "s", firstKeptEntryId, tokensBefore: 1 });

/**
 * u1 rule (npm), u2 value 166 ms, u3 rule (regex), u4 lifts u1, | cut at a5 | u5 kept window, compaction, u6 uses the value.
 */
const branch = [
  user("m1", "Never add npm dependencies."), said("a1", "ok"),
  user("m2", "Time it."), said("a2", "It took 166 ms."),
  user("m3", "Don't use regular expressions in the parser."), said("a3", "ok"),
  user("m4", "The npm rule is lifted."), said("a4", "noted"),
  user("m5", "Add a README."), said("a5", "done"),
] as unknown as SessionEntry[];
const after = [user("m6", "Compare with the first time."), said("a6", "same")] as unknown as SessionEntry[];

const labels: SessionLabels = {
  rules: [
    { at: "u1", quote: "Never add npm dependencies.", marker: "npm", liftedAt: "u4" },
    { at: "u3", quote: "Don't use regular expressions", marker: "regular expression|regex" },
  ],
  values: [{ name: "first time", value: ["166 ms", "166ms"], learnedAt: "u2", usedAt: "u6", history: true }],
};

const candidate = (pathEntries = branch, rest = after): Candidate => ({ file: "/s/x.jsonl", session: "x", at: "t", index: pathEntries.length, entryId: "c9", pathEntries, after: rest, spanUserTexts: [], pathUserTexts: [] });

test("labeledMeasures: a rule in force at the cut is kept only when a rules-section line matches its marker", () => {
  const kept = labeledMeasures(labels, candidate(), "m5", "## Constraints & corrections\n- R1 [u3] \"Don't use regular expressions\"\n## Now\n");
  assert.deepEqual([kept.rules.kept, kept.rules.total], [1, 1]);
  const elsewhere = labeledMeasures(labels, candidate(), "m5", "## Constraints & corrections\n(none)\n## Now\navoid regex in the parser\n");
  assert.deepEqual([elsewhere.rules.kept, elsewhere.rules.total], [0, 1]);
  assert.deepEqual(elsewhere.rules.missed, ["u3"]);
});

test("labeledMeasures: a lifted rule is honoured when no rules-section line shows it in force", () => {
  const shownLifted = labeledMeasures(labels, candidate(), "m5", "## Constraints\n- R1 [u1] \"Never add npm dependencies.\" (lifted by u4)\n");
  assert.deepEqual([shownLifted.lifts.honoured, shownLifted.lifts.total], [1, 1]);
  const dropped = labeledMeasures(labels, candidate(), "m5", "## Constraints\n(none)\n");
  assert.equal(dropped.lifts.honoured, 1);
  const stillInForce = labeledMeasures(labels, candidate(), "m5", "## Constraints & Preferences\n- No npm dependencies\n");
  assert.deepEqual([stillInForce.lifts.honoured, stillInForce.lifts.total], [0, 1]);
  assert.deepEqual(stillInForce.lifts.shownInForce, ["u1"]);
});

test("labeledMeasures: a lift word inside the rule's own quoted words does not mark it lifted", () => {
  const narrowing = labeledMeasures(labels, candidate(), "m5", "## Constraints\n- R1 [u1] \"The npm rule doesn't apply to tests; no npm dependencies elsewhere.\"\n");
  assert.deepEqual(narrowing.lifts.shownInForce, ["u1"]);
  const curly = labeledMeasures(labels, candidate(), "m5", "## Constraints\n- \u201cnpm packages are no longer welcome\u201d\n");
  assert.deepEqual(curly.lifts.shownInForce, ["u1"]);
  const marked = labeledMeasures(labels, candidate(), "m5", "## Constraints\n- R1 [u1] \"The npm rule doesn't apply to tests.\" (lifted by u4)\n");
  assert.deepEqual(marked.lifts.shownInForce, []);
});

test("labeledMeasures: a rule or lift still in the kept window is not due, since the message itself is still there", () => {
  const early = labeledMeasures(labels, candidate(), "m4", "");
  assert.deepEqual([early.rules.total, early.lifts.total], [1, 0], "u3 is due; u1's lift is in the kept window, so neither keeping nor dropping u1 is judged");
  assert.deepEqual(labeledMeasures(labels, candidate(), "m3", "").rules.total, 0, "u3 itself is still in view");
});

test("labeledMeasures: span rules are those given since the previous compaction's cut, earlier rules before it", () => {
  const withPrevious = [...branch.slice(0, 4), compaction("c1", "m3"), ...branch.slice(4)] as unknown as SessionEntry[];
  const measured = labeledMeasures(labels, candidate(withPrevious), "m5", "## Constraints\n- R2 [u3] regular expressions\n");
  assert.deepEqual([measured.spanRules.kept, measured.spanRules.total], [1, 1]);
  assert.deepEqual([measured.earlierRules.kept, measured.earlierRules.total], [0, 0], "u1 is lifted, so nothing earlier is due");
});

test("labeledMeasures: a value is due at the last compaction before the turn that uses it, once its turn is summarized and not still in view", () => {
  const kept = labeledMeasures(labels, candidate(), "m5", "## Now\nbaseline 166 ms\n");
  assert.deepEqual([kept.values.kept, kept.values.total, kept.historyValues.total], [1, 1, 1]);
  assert.deepEqual(labeledMeasures(labels, candidate(), "m5", "baseline 1166 ms").values.missed, ["first time"], "a whole-token match");
  const laterCompaction = [compaction("c2", "a6"), ...after] as unknown as SessionEntry[];
  assert.equal(labeledMeasures(labels, candidate(branch, laterCompaction), "m5", "").values.total, 0, "a later compaction stands between this one and the use");
  assert.equal(labeledMeasures(labels, candidate(), "m2", "").values.total, 0, "the value's turn is still in the kept window");
});

test("labeledMeasures: stray rules are the state's rule lines bound to a message no rule was labeled at", () => {
  const measured = labeledMeasures(labels, candidate(), "m5", "## Constraints & corrections\n- R1 [u3] \"Don't use regular expressions\"\n- R2 [u5] \"Add a README.\"\n");
  assert.deepEqual(measured.strayRules, ["u5"]);
  assert.equal(labeledMeasures(labels, candidate(), "m5", "## Constraints & Preferences\n- keep it small\n").strayRules, undefined, "only a state's bound rule lines can be judged");
});

test("parseLabels: a malformed label file is refused, naming what is wrong", () => {
  assert.throws(() => parseLabels("{"), /labels/);
  assert.throws(() => parseLabels(JSON.stringify({ sessions: { x: { rules: [{ at: "2", quote: "q", marker: "m" }], values: [] } } })), /x.*at/);
  assert.throws(() => parseLabels(JSON.stringify({ sessions: { x: { rules: [{ at: "u2", quote: "q", marker: "(" }], values: [] } } })), /x.*marker/);
  assert.equal(Object.keys(parseLabels(JSON.stringify({ sessions: { x: { rules: [], values: [] } } }))).length, 1);
});

test("summarizeLabeled: counts summed over an arm's rows, so every number in the report is a whole count a reader can check", () => {
  const one = labeledMeasures(labels, candidate(), "m5", "## Constraints & corrections\n- R1 [u3] \"Don't use regular expressions\"\n- R2 [u5] \"Add a README.\"\n## Now\n166 ms\n");
  const two = labeledMeasures(labels, candidate(), "m5", "## Constraints\n- no npm dependencies\n");
  const summary = summarizeLabeled([{ labeled: one }, { labeled: two }, {}]);
  assert.deepEqual(summary, { rows: 2, rules: { kept: 1, total: 2 }, spanRules: { kept: 1, total: 2 }, earlierRules: { kept: 0, total: 0 }, lifts: { honoured: 1, total: 2 }, values: { kept: 1, total: 2 }, historyValues: { kept: 1, total: 2 }, strayRules: 1 });
  assert.equal(summarizeLabeled([{}]), null, "no labeled rows, no summary");
  assert.equal(formatLabeledLine("state", summary!), "state           labeled n=2 rules=1/2 span=1/2 earlier=0/0 lifts=1/2 values=1/2 history=1/2 stray=1");
});
