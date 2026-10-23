import test from "node:test";
import assert from "node:assert/strict";

import { buildMessageIndex } from "../../intent.ts";
import { DEFAULT_CAPS } from "../../store/events.ts";
import { emptyState, type SessionState } from "../../store/project.ts";
import type { VerifyContext } from "../../store/verify.ts";
import { chain, userEntry } from "../../test-support.ts";
import { labelsSection, RULE_WHOLE_CHARS } from "./labels.ts";
import { EARLIER_REQUEST, NOT_A_RULE, RULE_DEFINITION } from "../message-labels.ts";
import { judgeAnswer, type Facts } from "./section.ts";

const long = `Here is the log you asked for.\n${"line of output\n".repeat(60)}And from now on never run the e2e suite locally.`;
const entries = chain([
  userEntry("m1", "always run make check before you commit anything"),
  userEntry("m2", "please fix the flaky test in src/a.test.ts"),
  userEntry("m3", "never use mocks in these tests, fakes only"),
  userEntry("m4", "ok you can drop the make check rule now, it is too slow"),
  userEntry("m5", long),
]);
const index = buildMessageIndex(entries, { commandIds: new Set(), errorIds: new Set() });

function ctx(state: SessionState = emptyState()): VerifyContext {
  return { resolver: index, state, provenance: { source: "diff", span: 2, at: "2026-10-04T10:00:00.000Z" }, caps: DEFAULT_CAPS, nearDuplicateThreshold: 0.8, acceptedThisSpan: 0, rememberCap: 0 };
}

function facts(overrides: Partial<Facts> = {}): Facts {
  return { spanOrdinals: ["u2", "u3", "u4"], seedOrdinals: [], textOf: (ordinal) => index.textOf(ordinal), activeCorrections: [], openErrorIds: [], unresolvedSpanErrorIds: [], spanModifiedFiles: [], ...overrides };
}

const answer = (labels: Record<string, unknown>) => JSON.stringify({ labels });

test("labels: a message labelled rule becomes a correction quoting the user's whole message, copied by code", () => {
  const judged = judgeAnswer(labelsSection, answer({ u2: "not a rule", u3: "rule", u4: "not a rule" }), facts(), ctx());
  assert.deepEqual(judged.complaints, []);
  const added = judged.events.filter((event) => event.kind === "correction.add");
  assert.equal(added.length, 1);
  assert.equal((added[0] as { quote: { text: string; ordinal: string } }).quote.text, "never use mocks in these tests, fakes only");
});

test("labels: an unlabelled message is an integrity complaint naming it; it cannot be excused", () => {
  const judged = judgeAnswer(labelsSection, JSON.stringify({ labels: { u2: "not a rule" }, notApplicable: [{ check: "labels.unlabelled", reason: "no" }] }), facts(), ctx());
  const complaint = judged.complaints.find((item) => item.check === "labels.unlabelled");
  assert.ok(complaint && !complaint.excusable);
  assert.match(complaint.message, /missing: u3, u4/);
  assert.deepEqual(judged.excused, []);
});

test("labels: lifts R<n> withdraws a standing rule; a lift of an unknown rule is a verify complaint", () => {
  const ruled = judgeAnswer(labelsSection, answer({ u1: "rule" }), facts({ spanOrdinals: ["u1"] }), ctx()).state;
  const judged = judgeAnswer(labelsSection, answer({ u2: "not a rule", u3: "not a rule", u4: "lifts R1" }), facts({ activeCorrections: [{ id: "R1", ordinal: "u1", text: "always run make check" }] }), ctx(ruled));
  assert.deepEqual(judged.events.map((event) => event.kind), ["correction.lift"]);
  const bad = judgeAnswer(labelsSection, answer({ u2: "not a rule", u3: "not a rule", u4: "lifts R7" }), facts(), ctx());
  assert.equal(bad.complaints[0].check, "labels.verify");
  assert.equal(bad.complaints[0].path, "labels.u4");
});

test("labels: a long message labelled rule must carry the exact words; the words are verified, then recorded", () => {
  const f = facts({ spanOrdinals: ["u5"] });
  assert.ok(long.length > RULE_WHOLE_CHARS);
  const bare = judgeAnswer(labelsSection, answer({ u5: "rule" }), f, ctx());
  assert.equal(bare.complaints[0].check, "labels.rule-words");
  assert.equal(bare.events.length, 0);
  const worded = judgeAnswer(labelsSection, answer({ u5: { rule: "never run the e2e suite locally" } }), f, ctx());
  assert.deepEqual(worded.complaints, []);
  assert.equal((worded.events[0] as { quote: { text: string } }).quote.text, "never run the e2e suite locally");
  const misquoted = judgeAnswer(labelsSection, answer({ u5: { rule: "never run e2e tests" } }), f, ctx());
  assert.equal(misquoted.complaints[0].check, "labels.verify");
});

test("labels: on a switchover the earlier rules are kept unless listed in oneOffs, the single call's contract", () => {
  const f = facts({ spanOrdinals: ["u4"], seedOrdinals: ["u1", "u3"] });
  const kept = judgeAnswer(labelsSection, answer({ u4: "not a rule" }), f, ctx());
  assert.deepEqual(kept.complaints, [], "an earlier message needs no label");
  assert.deepEqual(labelsSection.oneOffs!(kept.answer!, f), []);
  const dropped = judgeAnswer(labelsSection, JSON.stringify({ labels: { u4: "not a rule" }, oneOffs: ["u1", "u4", "u9"] }), f, ctx());
  assert.deepEqual(dropped.complaints, []);
  assert.deepEqual(labelsSection.oneOffs!(dropped.answer!, f), ["u1"], "only earlier messages can be one-offs");
  assert.equal(dropped.events.length, 0, "earlier rules are recorded by the pass, not by the turn");
});

test("labels: an earlier message labelled not a rule in labels is still kept; only oneOffs drops one", () => {
  const f = facts({ spanOrdinals: ["u4"], seedOrdinals: ["u1", "u3"] });
  const judged = judgeAnswer(labelsSection, answer({ u1: "not a rule", u3: "rule", u4: "not a rule" }), f, ctx());
  assert.deepEqual(judged.complaints, []);
  assert.deepEqual(labelsSection.oneOffs!(judged.answer!, f), []);
});

test("labels: a label that is none of the three is a complaint naming the message", () => {
  const judged = judgeAnswer(labelsSection, answer({ u2: "maybe", u3: "rule", u4: "not a rule" }), facts(), ctx());
  assert.equal(judged.complaints[0].check, "labels.value");
  assert.match(judged.complaints[0].message, /^u2: /);
});

test("labels: on a switchover the user's other earlier messages are listed and must be labeled; one labeled a rule is recorded", () => {
  const f = facts({ spanOrdinals: ["u4"], contextOrdinals: ["u2"] });
  assert.match(labelsSection.instruction(f), /Label every one of these too[^]*u2: please fix the flaky test/);
  assert.ok(labelsSection.instruction(f).includes(EARLIER_REQUEST), "an earlier request is not a rule, in turns mode too");
  const unlabeled = judgeAnswer(labelsSection, answer({ u4: "not a rule" }), f, ctx());
  assert.deepEqual(unlabeled.complaints.map((complaint) => [complaint.check, complaint.message]), [["labels.unlabelled", "label every listed message; missing: u2"]]);
  const labeled = judgeAnswer(labelsSection, answer({ u2: "rule", u4: "not a rule" }), f, ctx());
  assert.deepEqual(labeled.complaints, []);
  assert.deepEqual(labeled.events.flatMap((event) => (event.kind === "correction.add" ? [event.quote.ordinal] : [])), ["u2"]);
});

test("labels: an earlier message listed cut to its start needs the rule's exact words once it is longer than the list shows", () => {
  const pasted = `please fix the flaky test in src/a.test.ts ${"and here is the CI note I was sent, pasted whole for reference ".repeat(4)}`;
  const f = facts({ spanOrdinals: ["u4"], contextOrdinals: ["u2"], textOf: (ordinal) => (ordinal === "u2" ? pasted : index.textOf(ordinal)) });
  assert.ok(pasted.length > 240 && pasted.length < RULE_WHOLE_CHARS);
  const judged = judgeAnswer(labelsSection, answer({ u2: "rule", u4: "not a rule" }), f, ctx());
  assert.deepEqual(judged.complaints.map((complaint) => complaint.check), ["labels.rule-words"]);
  assert.match(judged.complaints[0].message, /u2 was shown cut to its first 240 characters/);
});

test("labelsSection: the turns prompt says what a rule is and is not in the single call's own words", () => {
  const text = labelsSection.instruction(facts());
  assert.ok(text.includes(RULE_DEFINITION) && text.includes(NOT_A_RULE));
  assert.match(NOT_A_RULE, /a request for the work at hand, however firmly it is worded/);
  assert.match(RULE_DEFINITION, /still binds once the work asked for now is done/);
});

test("labels: a skill invocation is listed by the skill's name and the user's own words, never by the skill's text", () => {
  const invoked = '<skill name="release" location="/skills/release/SKILL.md">\nReferences are relative to /skills/release.\n\n# Release\n\nNever push the tag first.\n</skill>\n\nrelease the widget app';
  const text = labelsSection.instruction(facts({ spanOrdinals: ["u2"], textOf: (ordinal) => (ordinal === "u2" ? invoked : index.textOf(ordinal)) }));
  assert.ok(text.includes("u2: [/skill:release] release the widget app"));
  assert.ok(!text.includes("Never push the tag first"));
});
