/** The aggregate row the dry-replay CLI prints per transcript (score/replay-cli.ts). */
import assert from "node:assert/strict";
import test from "node:test";

import { positiveIntEnv } from "./env.ts";
import { replayRow } from "./replay-cli.ts";
import type { ReplayResult } from "./replay.ts";

const SECRET_TEXT = "the user's private words";

test("replayRow: counts only -- compactions, fallbacks, turn mismatches, skipped kinds -- and never a transcript's text", () => {
  const result = {
    compactions: [
      { summary: `# Session state\n> ${SECRET_TEXT}`, byState: true, details: { compactor: "state" } },
      { summary: SECRET_TEXT, byState: false, details: undefined },
      { summary: "x".repeat(300), byState: true, details: { compactor: "state" } },
    ],
    requests: 40, summarizerRequests: 2, missingTurns: 1, leftoverTurns: 3, refusedCompactions: 1, errors: [`session_compact: ${SECRET_TEXT}`], entries: [],
  } as unknown as ReplayResult;
  const row = replayRow("/home/someone/.pi/agent/sessions/agents/x/--home-someone-dev-secret-project--/2026.jsonl", { steps: 12, recordedCompactions: 3, skipped: { bashExecution: 2 } }, result, 1500);
  assert.deepEqual({ ...row, transcript: "<hash>" }, {
    transcript: "<hash>", steps: 12, recordedCompactions: 3, compactions: 3, byState: 2, fallbacks: 1,
    requests: 40, summarizerRequests: 2, missingTurns: 1, leftoverTurns: 3, refusedCompactions: 1, extensionErrors: 1, skipped: { bashExecution: 2 },
    medianSummaryChars: SECRET_TEXT.length + 18, ms: 1500,
  });
  assert.match(row.transcript, /^[0-9a-f]{12}$/);
  const printed = JSON.stringify(row);
  for (const leak of [SECRET_TEXT, "secret-project", "someone"]) assert.ok(!printed.includes(leak), `row leaks ${leak}`);
});

test("positiveIntEnv (security.md T7): a typo fails loudly instead of replaying everything or nothing", () => {
  assert.equal(positiveIntEnv("X", 5, {}), 5);
  assert.equal(positiveIntEnv("X", 5, { X: "12" }), 12);
  for (const bad of ["abc", "0", "-3", "1.5", "1e400"]) assert.throws(() => positiveIntEnv("X", 5, { X: bad }), /X must be a positive integer/, bad);
});
