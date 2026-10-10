/**
 * The lift gate's own patterns stay linear on hostile text (security.md T4): a user-role message is untrusted,
 * and the gate runs synchronously on pi's main thread, so one slow pattern freezes the session.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { liftNamesRule } from "./lift-words.ts";

test("liftNamesRule: a run of hyphens or apostrophes after a withdrawal and a command word stays linear (security.md T4)", () => {
  const runs = { hyphens: "-".repeat(80), apostrophes: "'".repeat(80), pairs: "'-".repeat(40), spaced: "- ".repeat(40) };
  for (const [name, run] of Object.entries(runs)) {
    for (const message of [`the force-push rule is lifted never${run}`, `you can ignore the lint rule now never${run}`]) {
      const started = performance.now();
      liftNamesRule(message, "never force-push to main");
      const elapsed = performance.now() - started;
      assert.ok(elapsed < 250, `${name}: ${elapsed.toFixed(0)} ms for ${message.length} characters`);
    }
  }
});

test("every exported lift and secret pattern stays linear on runs of the characters a word and a gap share (security.md T4)", async () => {
  // `'` and `-` count as both word characters and `\W`; a pattern that lets either side take them can blow up
  // exponentially on a run of them, which a per-pattern test with ordinary text never reaches.
  const modules = ["./lift-vocabulary.ts", "./lift-words.ts", "./lift-replacement.ts", "../narrative/message-labels.ts", "../learned-secrets.ts"];
  const units = ["-", "'", "'-", "- ", "' ", "a-", "a'", "a ", "a- ", "x' ", "rule ", "never ", "is ", ", ", "-.", "--a ", "a.", "/a", "=a.", " pass ", "op ", "vault kv "];
  let checked = 0;
  for (const path of modules) {
    for (const [name, value] of Object.entries(await import(path) as Record<string, unknown>)) {
      if (!(value instanceof RegExp)) continue;
      const pattern = new RegExp(value.source, value.flags.replace(/[gy]/g, ""));
      checked++;
      for (const unit of units) for (const prefix of ["", "never ", "no ", "the "]) for (const tail of ["", "!", "\u0000", " rule"]) {
        const text = prefix + unit.repeat(Math.ceil(160 / unit.length)) + tail;
        const started = performance.now();
        pattern.test(text);
        const elapsed = performance.now() - started;
        assert.ok(elapsed < 50, `${path} ${name}: ${elapsed.toFixed(0)} ms on ${JSON.stringify(prefix + unit)}…${JSON.stringify(tail)}`);
      }
    }
  }
  assert.ok(checked > 20, `only ${checked} patterns were found to check`);
});
