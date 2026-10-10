import test from "node:test";
import assert from "node:assert/strict";

import { logOptionsOf, logSafeError, logSafeNarrative, logSafeRejected, logSafeRemoved, logSafeSkipped } from "./log-safe.ts";
import type { NarrativeTrace } from "./carry.ts";

const trace = (): NarrativeTrace => ({
  kind: "diff", calls: 5, accepted: 3, dropped: 0, rescued: 0, missingChunks: [], usage: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, calls: 5 },
  timings: { prepareMs: 0, callsMs: 0, validateMs: 0, totalMs: 0 },
  sections: [{ section: "objective", turns: 2, shows: 0, outcome: "partial", repairs: [["objective.quote"]], unresolved: ["objective.quote: \"ship the secret fix\" is not in u3"], excused: [{ check: "now.next", reason: "the user said to stop after the deploy to prod-db" }], durationMs: 10 }],
});

test("logSafeNarrative: section traces keep check ids and drop the model's and the user's words", () => {
  const logged = JSON.stringify(logSafeNarrative(trace(), logOptionsOf({})));
  assert.doesNotMatch(logged, /secret fix|prod-db/);
  const section = logSafeNarrative(trace(), logOptionsOf({})).sections![0];
  assert.deepEqual(section.unresolved, ["objective.quote"]);
  assert.deepEqual(section.excused, [{ check: "now.next" }]);
  assert.deepEqual(section.repairs, [["objective.quote"]]);
});

test("logSafeNarrative: the excerpts flag logs the trace as it is", () => {
  assert.deepEqual(logSafeNarrative(trace(), logOptionsOf({ PI_COMPACT_STATE_DEBUG_EXCERPTS: "1" })), trace());
});

test("logSafeError: the error class and a short message with the home directory as ~; the stack only when asked for", () => {
  const error = new TypeError(`failed to read /home/someone/projects/app/secret.txt: ${"x".repeat(400)}`);
  const plain = logSafeError(error, logOptionsOf({}), "/home/someone");
  assert.equal(plain.errorClass, "TypeError");
  assert.match(plain.error, /^failed to read ~\/projects\/app\/secret\.txt: x+…$/);
  assert.equal(plain.error.length, 200);
  assert.equal(plain.stack, undefined);
  assert.match(logSafeError(error, logOptionsOf({ PI_COMPACT_STATE_DEBUG_STACK: "1" }), "/home/someone").stack ?? "", /TypeError/);
  assert.deepEqual(logSafeError("plain string", logOptionsOf({}), "/home/someone"), { errorClass: "string", error: "plain string" });
});

test("logSafeSkipped: a workspace skip is cut to 200 characters with the home directory as ~; the excerpts flag keeps it whole", () => {
  const skipped = `git status exited 128: fatal: detected dubious ownership in repository at '/home/someone/work/app' ${"y".repeat(400)}`;
  const plain = logSafeSkipped(skipped, logOptionsOf({}), "/home/someone");
  assert.match(plain, /^git status exited 128: fatal: detected dubious ownership in repository at '~\/work\/app' y+…$/);
  assert.equal(plain.length, 200);
  assert.equal(logSafeSkipped("not-a-git-repo", logOptionsOf({}), "/home/someone"), "not-a-git-repo");
  assert.equal(logSafeSkipped(skipped, logOptionsOf({ PI_COMPACT_STATE_DEBUG_EXCERPTS: "1" }), "/home/someone"), skipped);
});

test("logSafeRemoved: pruned file paths are logged as a count per rule; the excerpts flag keeps the paths", () => {
  const removed = [{ path: "/home/someone/app/dist/a.js", rule: "build-tree" }, { path: "/home/someone/app/dist/b.js", rule: "build-tree" }, { path: "/home/someone/app/src", rule: "redundant-directory" }] as const;
  assert.deepEqual(logSafeRemoved([...removed], logOptionsOf({})), { "build-tree": 2, "redundant-directory": 1 });
  assert.deepEqual(logSafeRemoved([], logOptionsOf({})), {});
  assert.deepEqual(logSafeRemoved([...removed], logOptionsOf({ PI_COMPACT_STATE_DEBUG_EXCERPTS: "1" })), removed);
});

test("logSafeRejected: a model-supplied value is logged as its length, even one shaped like an id; ids and reasons stay", () => {
  const options = { excerpts: false, stack: false };
  const [logged] = logSafeRejected([{ chunk: 0, path: "values[0]", final: false, rejection: { code: "value-not-in-turn", ref: "u4", value: "ab123456" } }], options);
  assert.deepEqual(logged, { chunk: 0, path: "values[0]", final: false, ref: "u4", valueChars: 8, code: "value-not-in-turn" });
  const [reason] = logSafeRejected([{ chunk: 0, path: "values[1]", final: true, rejection: { code: "value-rejected", ref: "u4", reason: "credential" } }], options);
  assert.equal(reason.reason, "credential");
});
