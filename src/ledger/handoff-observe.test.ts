/**
 * errorSignature on its own: which lines a signature keeps, and that trailing whitespace is dropped in linear time.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { errorSignature } from "./handoff-observe.ts";

test("errorSignature: the error line and the lines after it, else a failed run's last lines; trailing blanks never count (table)", () => {
  const cases: Array<[string, string, number | null, string | undefined]> = [
    ["an error line and three following", "ok\nError: boom\n  at a\n  at b\n  at c\n  at d\n", 1, "Error: boom\n  at a\n  at b\n  at c"],
    ["trailing blank lines are not following lines", "Error: boom\n  at a\n \t\n\n", 1, "Error: boom\n  at a"],
    ["a failed run without an error line keeps its last lines", "one\ntwo\nthree\nfour\nfive\n   \n\n", 2, "two\nthree\nfour\nfive"],
    ["a clean run with no error line has none", "all good\n", 0, undefined],
    ["whitespace only", " \n\t\n", 1, undefined],
  ];
  for (const [name, output, exitCode, expected] of cases) assert.equal(errorSignature(output, exitCode), expected, name);
});

test("errorSignature: a long whitespace run that does not end the output stays linear (security.md T4)", () => {
  for (const output of [`a${" ".repeat(200_000)}x`, `Error: x${" ".repeat(200_000)}\ny`, `${" \n".repeat(100_000)}z`]) {
    const started = performance.now();
    errorSignature(output, 1);
    const elapsedMs = performance.now() - started;
    assert.ok(elapsedMs < 500, `took ${Math.round(elapsedMs)} ms on ${output.length} chars`);
  }
});
