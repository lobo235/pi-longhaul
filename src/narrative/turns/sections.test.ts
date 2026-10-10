import test from "node:test";
import assert from "node:assert/strict";

import { buildMessageIndex } from "../../intent.ts";
import { DEFAULT_CAPS } from "../../store/events.ts";
import { emptyState } from "../../store/project.ts";
import type { VerifyContext } from "../../store/verify.ts";
import { chain, userEntry } from "../../test-support.ts";
import { judgeAnswer, repairNote, type Facts } from "./section.ts";
import { narrativeSection, nowSection, objectiveSection, recordsSection, SECTIONS } from "./sections.ts";

const entries = chain([
  userEntry("m1", "Build the state compactor's section turns mode"),
  userEntry("m2", "Change of plan: make the replay scorer compare both modes; done when npm run score passes"),
]);
const index = buildMessageIndex(entries, { commandIds: new Set(["C1", "C2"]), errorIds: new Set(["E1", "E2"]) });
const ctx: VerifyContext = { resolver: index, state: emptyState(), provenance: { source: "diff", span: 2, at: "2026-10-04T10:00:00.000Z" }, caps: DEFAULT_CAPS, nearDuplicateThreshold: 0.8, acceptedThisSpan: 0, rememberCap: 0 };

function facts(overrides: Partial<Facts> = {}): Facts {
  return { spanOrdinals: ["u2"], seedOrdinals: [], textOf: (ordinal) => index.textOf(ordinal), objective: { ordinal: "u1", text: "Build the state compactor's section turns mode" }, activeCorrections: [], openErrorIds: [], unresolvedSpanErrorIds: [], spanModifiedFiles: [], ...overrides };
}

const now = (overrides: Record<string, unknown> = {}) => JSON.stringify({ now: { inProgress: ["wiring the runner"], next: [], blocked: [], resume: "run npm test", ...overrides } });

test("SECTIONS: code asks in a fixed order, narrative first and Now last", () => {
  assert.deepEqual(SECTIONS.map((section) => section.id), ["narrative", "objective", "labels", "records", "now"]);
});

test("narrative: an answer that names a modified file passes; one that names none raises an excusable expectation", () => {
  const f = facts({ spanModifiedFiles: ["src/turns/run.ts"] });
  assert.deepEqual(judgeAnswer(narrativeSection, '{"narrative": "Wrote run.ts and ran C1."}', f, ctx).complaints, []);
  const vague = judgeAnswer(narrativeSection, '{"narrative": "Did some work."}', f, ctx);
  assert.equal(vague.complaints[0].check, "narrative.names-modified-file");
  assert.equal(vague.complaints[0].excusable, true);
  const excused = judgeAnswer(narrativeSection, JSON.stringify({ narrative: "Did some work.", notApplicable: [{ check: "narrative.names-modified-file", reason: "the only edit was a generated lockfile" }] }), f, ctx);
  assert.deepEqual(excused.complaints, []);
  assert.deepEqual(excused.excused, [{ check: "narrative.names-modified-file", reason: "the only edit was a generated lockfile" }]);
});

test("narrative: an answer that is not JSON is a parse complaint, never excusable", () => {
  const judged = judgeAnswer(narrativeSection, "I think the span was about tests.", facts(), ctx);
  assert.equal(judged.complaints[0].check, "narrative.parse");
  assert.equal(judged.complaints[0].excusable, false);
  assert.equal(judged.answer, undefined);
});

test("objective: keep adds nothing; naming a message sets it from the user's whole words; doneWhen quotes the exact words", () => {
  assert.deepEqual(judgeAnswer(objectiveSection, '{"objective": "keep"}', facts(), ctx).events, []);
  const changed = judgeAnswer(objectiveSection, JSON.stringify({ objective: { messageRef: "u2" }, doneWhen: { messageRef: "u2", text: "npm run score passes" } }), facts(), ctx);
  assert.deepEqual(changed.complaints, []);
  const event = changed.events[0] as { kind: string; quote: { text: string }; doneWhen?: { text: string } };
  assert.equal(event.kind, "objective.set");
  assert.match(event.quote.text, /^Change of plan/);
  assert.equal(event.doneWhen?.text, "npm run score passes");
  const unknown = judgeAnswer(objectiveSection, '{"objective": {"messageRef": "u9"}}', facts(), ctx);
  assert.equal(unknown.complaints[0].check, "objective.ref");
  assert.equal(unknown.events.length, 0);
});

test("records: every item must cite an id; an unknown id is a verify complaint; the item that fails is the only one held back", () => {
  const judged = judgeAnswer(recordsSection, JSON.stringify({ decisions: [{ text: "Kept the single call as the default mode.", evidence: "u2" }, { text: "Picked turns." }], deadEnds: [{ text: "A free agent loop looped on 'Let me do it'.", evidence: "E9" }] }), facts(), ctx);
  assert.deepEqual(judged.complaints.map((complaint) => [complaint.check, complaint.path]), [["records.evidence", "decisions[1]"], ["records.verify", "deadEnds[0]"]]);
  assert.deepEqual(judged.events.map((event) => event.kind), ["decision.add"]);
});

test("records: an unresolved error that is not an open error and no dead end cites raises an expectation", () => {
  const f = facts({ unresolvedSpanErrorIds: ["E1", "E2"], openErrorIds: ["E2"] });
  const silent = judgeAnswer(recordsSection, '{"decisions": [], "deadEnds": []}', f, ctx);
  assert.deepEqual(silent.complaints.map((complaint) => complaint.check), ["records.unfixed-failure"]);
  assert.match(silent.complaints[0].message, /errors E1 /);
  const cited = judgeAnswer(recordsSection, JSON.stringify({ decisions: [], deadEnds: [{ text: "Tried the e2e suite; it needs a display.", evidence: "E1" }] }), f, ctx);
  assert.deepEqual(cited.complaints, []);
});

test("now: replaces Now; open errors with nothing in progress, and an empty resume, raise expectations", () => {
  assert.deepEqual(judgeAnswer(nowSection, now(), facts(), ctx).events.map((event) => event.kind), ["now.set"]);
  const idle = judgeAnswer(nowSection, now({ inProgress: [], resume: "" }), facts({ openErrorIds: ["E1"] }), ctx);
  assert.deepEqual(idle.complaints.map((complaint) => complaint.check), ["now.open-errors", "now.resume"]);
  const malformed = judgeAnswer(nowSection, '{"now": {"inProgress": "x"}}', facts(), ctx);
  assert.equal(malformed.complaints[0].check, "now.parse");
});

test("repairNote: integrity failures are to be fixed; expectations may be excused with notApplicable", () => {
  const note = repairNote([{ check: "labels.unlabelled", message: "missing: u3", excusable: false }, { check: "now.resume", message: "resume is empty", excusable: true }]);
  assert.match(note, /Fix these:\n- labels.unlabelled: missing: u3/);
  assert.match(note, /notApplicable[\s\S]*- now.resume: resume is empty/);
});

test("records: the instruction names the unresolved errors that must become dead ends, before the model answers", () => {
  const text = recordsSection.instruction(facts({ unresolvedSpanErrorIds: ["E1", "E2", "E3"], openErrorIds: ["E2"] }));
  assert.match(text, /E1, E3/);
  assert.doesNotMatch(text, /E1, E2/);
  assert.doesNotMatch(recordsSection.instruction(facts()), /never resolved/);
});

test("records: citing a transcript id T<n> is an integrity complaint that says what to cite instead", () => {
  const judged = judgeAnswer(recordsSection, JSON.stringify({ decisions: [{ text: "Ran the suite.", evidence: "T4" }], deadEnds: [] }), facts(), ctx);
  assert.deepEqual(judged.complaints.map((complaint) => [complaint.check, complaint.path]), [["records.evidence", "decisions[0]"]]);
  assert.match(judged.complaints[0].message, /T4 is a transcript id/);
});

test("records: a verify complaint carries the rejection code and the kind of id, never the id's text", () => {
  const judged = judgeAnswer(recordsSection, JSON.stringify({ decisions: [{ text: "Ran it.", evidence: "C99" }], deadEnds: [] }), facts(), ctx);
  assert.equal(judged.complaints[0].code, "unknown-evidence:C");
});

test("records: the instruction states the store's item length cap, so items are not rejected as too long after the fact", () => {
  assert.match(recordsSection.instruction(facts({ itemChars: 250 })), /at most 250 characters/);
  assert.match(recordsSection.instruction(facts()), new RegExp(`at most ${DEFAULT_CAPS.itemChars} characters`));
});
