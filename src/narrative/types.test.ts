import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_NARRATIVE_POLICY, resolveNarrativePolicy } from "./policy.ts";
import { checkNarrativeDiff, LIST_ITEMS } from "./types.ts";

const good = { narrative: "did x", corrections: [{ messageRef: "u2", text: "never use mocks in these tests" }], lifts: [], decisions: [{ text: "copy the ledger", evidence: "C1" }], deadEnds: [], now: { inProgress: ["a"], next: [], blocked: [], resume: "run npm test" } };

test("checkNarrativeDiff: the fenced-JSON shape, with objective and doneWhen optional", () => {
  assert.deepEqual(checkNarrativeDiff(good), { ok: true, diff: good });
  const withObjective = { ...good, objective: { messageRef: "u1", text: "build it all the way", doneWhen: { messageRef: "u1", text: "done when npm test passes" } } };
  assert.equal(checkNarrativeDiff(withObjective).ok, true);
});

test("checkNarrativeDiff: schema failures name the path (table)", () => {
  const cases: Array<[unknown, RegExp]> = [
    [{ ...good, narrative: 3 }, /\/narrative/],
    [{ ...good, corrections: [{ text: "no ref" }] }, /\/corrections\/0.*messageRef/],
    [{ ...good, now: { inProgress: "x", next: [], blocked: [], resume: "" } }, /\/now\/inProgress/],
    [{ ...good, lifts: [{ target: "R1", messageRef: "u3" }] }, /\/lifts\/0.*text/],
    [{ narrative: "only" }, /^\/: .*(corrections|now)/],
  ];
  for (const [value, expected] of cases) {
    const result = checkNarrativeDiff(value);
    assert.ok(!result.ok, JSON.stringify(value));
    assert.match(result.errors.join("; "), expected);
  }
});

test("resolveNarrativePolicy: defaults, bounded overrides, junk ignored per key", () => {
  assert.deepEqual(resolveNarrativePolicy(undefined), DEFAULT_NARRATIVE_POLICY);
  assert.deepEqual(resolveNarrativePolicy({ fixableRetries: 2, maxChunks: 99, retryNoteChars: "x", outputTokens: 1500 }), { ...DEFAULT_NARRATIVE_POLICY, fixableRetries: 2, outputTokens: 1500 });
  assert.equal(DEFAULT_NARRATIVE_POLICY.fixableRetries, 1);
  assert.equal(DEFAULT_NARRATIVE_POLICY.maxChunks, 4);
});

test("checkNarrativeDiff: the Now arrays and items are bounded at the schema (security.md T2)", () => {
  const at = (n: number) => Array.from({ length: n }, (_, i) => `item ${i}`);
  const withNow = (inProgress: string[], resume = "x") => ({
    ...good,
    now: { inProgress, next: [], blocked: [], resume },
  });

  // The bounds must be REACHABLE, or they are not bounds but blanket rejections.
  assert.equal(checkNarrativeDiff(withNow(at(24))).ok, true, "24 items is the cap, not a violation");
  assert.equal(checkNarrativeDiff(withNow(["a".repeat(400)])).ok, true, "400 chars is the cap for one item");

  const overCount = checkNarrativeDiff(withNow(at(40)));
  assert.ok(!overCount.ok, "41 items must not validate");
  assert.match(overCount.errors.join("; "), /\/now\/inProgress/);

  const overItem = checkNarrativeDiff(withNow(["a".repeat(401)]));
  assert.ok(!overItem.ok, "a 401-char item must not validate");
  assert.match(overItem.errors.join("; "), /\/now\/inProgress\/0/);

  const overResume = checkNarrativeDiff(withNow([], "a".repeat(401)));
  assert.ok(!overResume.ok, "a 401-char resume must not validate");
  assert.match(overResume.errors.join("; "), /\/now\/resume/);

  // Every array in the block carries the bound, not just the first one.
  for (const key of ["inProgress", "next", "blocked"] as const) {
    const value = checkNarrativeDiff({ ...good, now: { ...good.now, [key]: at(40) } });
    assert.ok(!value.ok, key);
    assert.match(value.errors.join("; "), new RegExp(`/now/${key}`));
  }
});

test("checkNarrativeDiff: the rule, lift, decision and dead-end lists are bounded at the schema (security.md T2)", () => {
  const many = <T>(n: number, item: (i: number) => T) => Array.from({ length: n }, (_, i) => item(i));
  const lists = {
    corrections: (i: number) => ({ messageRef: `u${i + 1}`, text: `never do thing ${i}` }),
    lifts: (i: number) => ({ target: `R${i + 1}`, messageRef: "u40", text: "forget that" }),
    decisions: (i: number) => ({ text: `decided ${i}` }),
    deadEnds: (i: number) => ({ text: `tried ${i}` }),
  };
  for (const [key, item] of Object.entries(lists)) {
    assert.equal(checkNarrativeDiff({ ...good, [key]: many(LIST_ITEMS, item) }).ok, true, `${key}: ${LIST_ITEMS} fit`);
    const over = checkNarrativeDiff({ ...good, [key]: many(LIST_ITEMS + 1, item) });
    assert.ok(!over.ok && over.errors.some((error) => error.startsWith(`/${key}`)), `${key}: one more is refused`);
  }
});
