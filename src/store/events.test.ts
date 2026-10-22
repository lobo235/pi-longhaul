import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_CAPS, describeRejection, isStateEvent, MIN_QUOTE_CHARS, type Rejection, type StateEvent } from "./events.ts";

test("DEFAULT_CAPS are the documented defaults", () => {
  assert.deepEqual(DEFAULT_CAPS, { hardChars: 13500, objectiveQuoteChars: 600, corrections: 8, correctionChars: 300, decisions: 10, deadEnds: 10, itemChars: 300, workLogLines: 12, openErrors: 5, worldChars: 1200, filesChars: 2500, learnedChars: 1500 });
  assert.equal(MIN_QUOTE_CHARS, 12);
});

test("describeRejection: one model-facing sentence per code, naming the fix (table)", () => {
  const cases: Array<[Rejection, RegExp]> = [
    [{ code: "unknown-ref", ref: "u99", known: ["u1", "u2"] }, /u99 is not a user message on this branch.*u1, u2/],
    [{ code: "not-user-message", ref: "a3" }, /a3 is not a user message/],
    [{ code: "not-substring", ref: "u2", excerpt: "please use fakes", closest: "use fakes not", recent: [{ ordinal: "u2", excerpt: "please use fakes not mocks" }] }, /not a verbatim substring of u2.*closest window.*"use fakes not".*u2: "please use fakes not mocks"/s],
    [{ code: "too-long", max: 300, actual: 412 }, /412 characters.*at most 300/],
    [{ code: "empty" }, /at least 12 characters/],
    [{ code: "near-duplicate", earlierId: "R2", overlap: 0.9 }, /duplicates R2 \(90% token overlap\).*do not retry/],
    [{ code: "unknown-target", target: "R9", known: ["R1", "R2"] }, /R9 is not a correction.*R1, R2/],
    [{ code: "already-lifted", target: "R1", by: "u7" }, /R1 was already lifted by u7/],
    [{ code: "lift-not-later", target: "R1", targetOrdinal: "u5", ordinal: "u3" }, /u3 is not later than u5/],
    [{ code: "no-objective" }, /no objective is set/i],
    [{ code: "unknown-evidence", evidence: "C77" }, /C77 is not a command, error or message/],
    [{ code: "remember-cap", cap: 10 }, /10 accepted writes this span.*do not retry/],
    [{ code: "schema", detail: "kind must be one of ..." }, /kind must be one of/],
    [{ code: "carried-shape", detail: "span record v2" }, /span record v2/],
    [{ code: "internal", detail: "boom" }, /internal error: boom.*do not retry/i],
  ];
  for (const [rejection, expected] of cases) assert.match(describeRejection(rejection), expected, rejection.code);
});

test("isStateEvent: shape check used by the fold (table)", () => {
  const base = { source: "remember", span: 1, at: "2026-09-28T10:00:00.000Z", seq: 1 };
  const good: StateEvent[] = [
    { ...base, kind: "correction.add", id: "R1", quote: { messageId: "m1", ordinal: "u1", text: "never use mocks" } },
    { ...base, kind: "correction.lift", target: "R1", by: { messageId: "m9", ordinal: "u9" } },
    { ...base, kind: "decision.add", id: "D1", text: "use fakes" },
    { ...base, kind: "now.set", now: { inProgress: [], next: [], blocked: [], resume: "x" } },
    { ...base, source: "pass", kind: "span.close", fromRef: "u1", toRef: "u4", narrativeLess: false, narrative: "did x", world: { claims: [], openErrorIds: [] } },
  ] as StateEvent[];
  for (const event of good) assert.ok(isStateEvent(event), event.kind);
  for (const bad of [null, "x", {}, { ...base, kind: "nope" }, { ...base, kind: "correction.add", id: 3 }, { ...base, kind: "correction.add", id: "R1", quote: { text: "no ids" } }, { ...base, seq: "1", kind: "decision.add", id: "D1", text: "t" }]) {
    assert.equal(isStateEvent(bad), false, JSON.stringify(bad));
  }
});

test("isStateEvent: seq and span are whole numbers a fold can count from (a replayed 1e999 parses as Infinity)", () => {
  const body = { source: "remember", at: "2026-09-28T10:00:00.000Z", kind: "decision.add", id: "D1", text: "use fakes" };
  assert.ok(isStateEvent({ ...body, span: 1, seq: 1 }));
  for (const [name, provenance] of [["seq Infinity", { span: 1, seq: JSON.parse("1e999") }], ["seq fractional", { span: 1, seq: 1.5 }], ["seq NaN", { span: 1, seq: Number.NaN }], ["seq negative", { span: 1, seq: -1 }], ["seq past safe integers", { span: 1, seq: 2 ** 53 }], ["span Infinity", { span: JSON.parse("1e999"), seq: 1 }], ["span zero", { span: 0, seq: 1 }]] as const) {
    assert.equal(isStateEvent({ ...body, ...provenance }), false, name);
  }
});
