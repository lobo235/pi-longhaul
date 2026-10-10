import assert from "node:assert/strict";
import { test } from "node:test";

import type { Candidate } from "./candidates.ts";
import { scorePiDefault, type PiDefaultDeps } from "./arms.ts";
import { modelWith } from "../test-support.ts";

const candidate: Candidate = {
  file: "/sessions/s.jsonl", session: "s", at: "2026-01-01T00:00:00.000Z", index: 3, entryId: "c3", pathEntries: [], after: [],
  spanUserTexts: ["no, never commit the generated files to the repository"], pathUserTexts: ["no, never commit the generated files to the repository"],
};
const prep = { firstKeptEntryId: "k1", tokensBefore: 90_000, messagesToSummarize: [], turnPrefixMessages: [], isSplitTurn: false, fileOps: { read: new Set(), written: new Set(), edited: new Set() }, settings: { reserveTokens: 16384 } };

test("pi-default arm: pi's own compact() over the same preparation with the session's model, auth and thinking level, scored on the same measures", async () => {
  const seen: unknown[][] = [];
  const deps: PiDefaultDeps = {
    compact: (async (...args: unknown[]) => {
      seen.push(args);
      return { summary: "## Goal\nship it\n\n## Constraints & Preferences\n- never commit the generated files to the repository\n", firstKeptEntryId: "k1", tokensBefore: 90_000, usage: { input: 1200, output: 300 }, details: { readFiles: [], modifiedFiles: [] } };
    }) as never,
    auth: async () => ({ ok: true, apiKey: "test-key", headers: { "x-test": "1" } }),
    thinkingLevel: "medium",
  };
  const model = modelWith();
  const scored = await scorePiDefault(candidate, prep, model, deps);
  assert.equal(seen.length, 1);
  const [prepArg, modelArg, apiKey, headers, customInstructions, , thinkingLevel] = seen[0];
  assert.equal(prepArg, prep);
  assert.equal(modelArg, model);
  assert.equal(apiKey, "test-key");
  assert.deepEqual(headers, { "x-test": "1" });
  assert.equal(customInstructions, undefined, "pi's default prompt, no instructions of ours");
  assert.equal(thinkingLevel, "medium", "the level pi's own compaction would use: the session's");
  assert.equal(scored.row.arm, "pi-default");
  assert.equal(scored.row.renderedChars, scored.rendered.length);
  assert.equal(scored.row.corrections.retained, 1, "pi's Constraints & Preferences section counts as a rules section");
  assert.equal(scored.row.objective, null);
  assert.equal(scored.row.claims, null);
  assert.deepEqual(scored.row.tokens, { input: 1200, output: 300 });
});

test("pi-default arm: a provider whose auth does not resolve fails the arm, naming the provider, before any call", async () => {
  let called = false;
  const deps: PiDefaultDeps = { compact: (async () => { called = true; }) as never, auth: async () => ({ ok: false, error: "no key" }), thinkingLevel: "off" };
  await assert.rejects(scorePiDefault(candidate, prep, modelWith({ provider: "example" }), deps), /example.*no key/);
  assert.equal(called, false);
});
