/** Recorded transcript → dry-replay steps (score/replay-steps.ts), on a synthetic transcript. */
import assert from "node:assert/strict";
import test from "node:test";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import { assistantEntry, chain, compactionEntry, customEntry, piGoalMessage, toolResultEntry, userEntry } from "../test-support.ts";
import { replay } from "./replay.ts";
import { stepsOf } from "./replay-steps.ts";

const noticeEntry = (id: string, content: string): SessionEntry =>
  ({ type: "custom_message", id, parentId: null, timestamp: new Date(0).toISOString(), customType: "bg-notice", content, display: false }) as SessionEntry;
const shellEntry = (id: string): SessionEntry =>
  ({ type: "message", id, parentId: null, timestamp: new Date(0).toISOString(), message: { role: "bashExecution", command: "ls", output: "x", exitCode: 0, timestamp: 0 } }) as unknown as SessionEntry;

test("stepsOf: user runs with their recorded turns and tool outputs, foreign custom entries, triggering notices and compactions, in transcript order", () => {
  const branch = chain([
    userEntry("u1", "Fix the parser."),
    assistantEntry("a1", "", [{ name: "bash", arguments: { command: "npm test" } }]),
    toolResultEntry("r1", "a1-t0", "bash", "3 failing\nCommand exited with code 1", true),
    assistantEntry("a2", "Three fail."),
    customEntry("g1", "goal-state", { goal: { id: "goal-1", text: "fix it", status: "active" } }),
    customEntry("e1", "compaction-state.event", { kind: "decision.add" }),
    noticeEntry("n1", "task T1 finished"),
    assistantEntry("a3", "Noted."),
    noticeEntry("n2", "display-only status"),
    shellEntry("b1"),
    compactionEntry("c1", { compactor: "state" }),
    userEntry("u2", [{ type: "text", text: "Carry on." }, { type: "image", data: "AAAA" }]),
    assistantEntry("a4", "Fine."),
  ]);
  const { steps, skipped } = stepsOf(branch);
  assert.deepEqual(steps, [
    { kind: "user", text: "Fix the parser.", turns: [{ calls: [{ tool: "bash", args: { command: "npm test" }, output: "3 failing\nCommand exited with code 1", error: true }] }, { text: "Three fail." }] },
    { kind: "entry", customType: "goal-state", data: { goal: { id: "goal-1", text: "fix it", status: "active" } } },
    { kind: "notice", text: "task T1 finished", turns: [{ text: "Noted." }] },
    { kind: "notice", text: "display-only status", turns: [] },
    { kind: "compact" },
    { kind: "user", text: "Carry on.", turns: [{ text: "Fine." }] },
  ]);
  assert.deepEqual({ ...skipped }, { "compaction-state.event": 1, bashExecution: 1 });
});

test("stepsOf → replay: a recorded /goal session replays through pi with its goal-state re-appended and an unknown tool stood in", async () => {
  const goal = "ship the replay scorer fixes end to end";
  const branch = chain([
    customEntry("g1", "goal-state", { goal: { id: "goal-1", text: goal, status: "active" } }),
    userEntry("u1", piGoalMessage(goal)),
    assistantEntry("a1", "", [{ name: "bg_run", arguments: { command: "npm run e2e" } }]),
    toolResultEntry("r1", "a1-t0", "bg_run", "started T3"),
    assistantEntry("a2", "", [{ name: "bash", arguments: { command: "npm test" } }]),
    toolResultEntry("r2", "a2-t0", "bash", "12 passing\nCommand exited with code 0"),
    assistantEntry("a3", "Unit tests pass."),
    assistantEntry("a4", "A text-only turn pi would not have asked for."),
    compactionEntry("c1", { compactor: "state" }),
  ]);
  const result = await replay(stepsOf(branch).steps, { lenient: true });
  assert.deepEqual(result.errors, []);
  assert.equal(result.leftoverTurns, 1, "the recorded turn after the run's final text is counted, not replayed");
  const [compaction] = result.compactions;
  assert.ok(compaction.byState);
  assert.match(compaction.summary, /Goal \(u1, the active \/goal\)/);
  assert.match(compaction.summary, /last test: `npm test` exit 0/);
});

test("stepsOf: a remember or recall call recorded before the rename replays under today's tool name", () => {
  const branch = chain([
    userEntry("u1", "never use mocks in these tests"),
    assistantEntry("a1", "", [{ name: "remember", arguments: { kind: "correction", quote: "never use mocks" } }, { name: "recall", arguments: { what: "errors" } }]),
    assistantEntry("a2", "Noted."),
  ]);
  const user = stepsOf(branch).steps[0] as { turns: Array<{ calls?: Array<{ tool: string }> }> };
  assert.deepEqual(user.turns[0].calls?.map((call) => call.tool), ["longhaul_remember", "longhaul_recall"]);
});

test("stepsOf (security.md T1): skipped kinds are a fixed vocabulary, so a crafted role or custom type never reaches the printed row", () => {
  const odd = chain([
    userEntry("u1", "go"),
    { ...userEntry("x1", "?"), message: { role: "constructor", content: "x", timestamp: 1 } } as never,
    customEntry("c1", "compaction-state.<pwned>", {}),
    customEntry("c2", "system-pin.patch", {}),
  ]);
  const { skipped } = stepsOf(odd);
  assert.deepEqual({ ...skipped }, { "other-role": 1, "compaction-state.other": 1, "system-pin.patch": 1 });
  assert.equal(Object.getPrototypeOf(skipped), null);
});
