import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_NEAR_DUPLICATE_THRESHOLD, findNearDuplicate, overlap, tokenize } from "./near-duplicate.ts";

test("tokenize: lower-cases, strips punctuation and code ticks, drops stop words and one-char tokens", () => {
  assert.deepEqual([...tokenize("Never use `mocks`, use fakes -- the store's tests!")], ["never", "use", "mocks", "fakes", "store", "tests"]);
  assert.deepEqual([...tokenize("a I to")], []);
});

test("overlap: shared tokens over the smaller set; empty sets never overlap", () => {
  // Measured 1, not 0.75: "not" is a stop word and the left set is the smaller one, so it is fully shared.
  assert.equal(overlap(tokenize("use fakes not mocks"), tokenize("use fakes, never mocks")), 1);
  assert.equal(overlap(tokenize("use fakes"), tokenize("use fakes for the store tests")), 1);
  assert.equal(overlap(new Set(), tokenize("x y")), 0);
});

test("findNearDuplicate: the highest overlap at or above the threshold wins; below it nothing (table)", () => {
  const candidates = [
    { id: "R1", text: "never hand-edit the lockfile" },
    { id: "R2", text: "use fakes, never mocks, in every test" },
  ];
  const cases: Array<[string, { id: string; overlap: number } | undefined]> = [
    ["use fakes never mocks in every test", { id: "R2", overlap: 1 }],
    // Measured 0.667 against R2 (4 shared of 6): "today" keeps the row below the threshold, which is what it asserts.
    ["never mocks: use fakes in tests today", undefined],
    // Measured 1: R1's four tokens are all present in the five-token restatement, and min is 4.
    ["never hand-edit the lockfile ever", { id: "R1", overlap: 1 }],
    ["something entirely different", undefined],
  ];
  for (const [text, expected] of cases) assert.deepEqual(findNearDuplicate(text, candidates, DEFAULT_NEAR_DUPLICATE_THRESHOLD), expected, text);
  assert.equal(DEFAULT_NEAR_DUPLICATE_THRESHOLD, 0.8);
});
