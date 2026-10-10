/**
 * The dry replay (score/replay.ts): scripted sessions through a real pi session with the real
 * compaction-state extension and a faked model, compacted where the script says.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";

import { piGoalMessage } from "../test-support.ts";
import { QUIET_DIFF, replay, type ReplayStep } from "./replay.ts";

const bash = (command: string, output: string, exitCode = 0) => ({ tool: "bash" as const, args: { command }, output: `${output}\nCommand exited with code ${exitCode}` });

test("replay: a scripted run compacted through pi's own compact() is the state compactor's, with the run's command in World", async () => {
  const steps: ReplayStep[] = [
    { kind: "user", text: "Make the parser tests pass, then stop.", turns: [{ calls: [bash("npm test", "12 passing")] }, { text: "All 12 tests pass." }] },
    { kind: "compact" },
  ];
  const result = await replay(steps);
  assert.deepEqual(result.errors, []);
  assert.equal(result.compactions.length, 1);
  const [compaction] = result.compactions;
  assert.ok(compaction.byState, "the state compactor wrote it, not pi's fallback");
  assert.equal(result.summarizerRequests, 1);
  assert.match(compaction.summary, /## World \(live at compaction\)[\s\S]*npm test/);
});

const correction = "never mock the parser in these tests";

/** The rendered Constraints & corrections section alone, so a quote elsewhere (the Objective) cannot satisfy a check. */
const constraintsOf = (summary: string) => /## Constraints & corrections[^\n]*\n([\s\S]*?)(?:\n## |$)/.exec(summary)?.[1] ?? "";

test("replay: a correction remembered through the real remember tool survives two compactions and a restart", async () => {
  const remember = { tool: "longhaul_remember", args: { kind: "correction", quote: correction } };
  const steps: ReplayStep[] = [
    { kind: "user", text: `Fix the parser tests, and ${correction}.`, turns: [{ calls: [remember, bash("npm test", "3 failing", 1)] }, { text: "Three tests fail." }] },
    { kind: "compact" },
    { kind: "user", text: "Carry on with the failures.", turns: [{ calls: [bash("npm test", "12 passing")] }, { text: "Fixed." }] },
    { kind: "restart" },
    { kind: "user", text: "Now tidy the README.", turns: [{ calls: [{ tool: "edit", args: { path: "README.md" }, output: "edited" }] }, { text: "Tidied." }] },
    { kind: "compact" },
  ];
  const result = await replay(steps);
  assert.deepEqual(result.errors, []);
  assert.equal(result.compactions.length, 2);
  assert.ok(result.compactions.every((compaction) => compaction.byState));
  for (const [index, compaction] of result.compactions.entries()) assert.match(constraintsOf(compaction.summary), /never mock the parser in these tests/, `compaction ${index + 1} carries the correction as a constraint`);
});

/** Stands in for pi-goal: records the goal a goal-mode prompt carries, and its completion. */
function piGoalStandIn(goalText: string): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    let recorded = false;
    pi.on("before_agent_start", (event) => {
      if (event.prompt.includes("<goal_objective>") && !recorded) {
        recorded = true;
        pi.appendEntry("goal-state", { goal: { id: "goal-1", text: goalText, status: "active" } });
      }
      if (event.prompt === GOAL_DONE) pi.appendEntry("goal-state", { goal: { id: "goal-1", text: goalText, status: "complete" } });
    });
  };
}

const GOAL_DONE = "Thanks, the goal is done.";

test("replay: inside a /goal the Request the summarizer picked survives the next compaction, and a completed goal is never shown active again", async () => {
  const goal = "ship the replay scorer fixes end to end";
  const ask = "fix the probe parser before anything else";
  let calls = 0;
  const summarizer = () => (++calls === 1 ? JSON.stringify({ ...JSON.parse(QUIET_DIFF), objective: { messageRef: "u2", text: ask } }) : QUIET_DIFF);
  const work = (command: string) => ({ calls: [bash(command, "ok")] });
  const steps: ReplayStep[] = [
    { kind: "user", text: piGoalMessage(goal), turns: [work("npm test"), { text: "Started." }] },
    { kind: "user", text: ask, turns: [work("npm run probe"), { text: "Looking at the parser." }] },
    { kind: "compact" },
    { kind: "user", text: piGoalMessage(goal), turns: [work("npm test"), { text: "Continuing." }] },
    { kind: "compact" },
    { kind: "user", text: GOAL_DONE, turns: [{ text: "Glad it is done." }] },
    { kind: "compact" },
  ];
  const result = await replay(steps, { summarizer, extensions: [piGoalStandIn(goal)] });
  assert.deepEqual(result.errors, []);
  const [, second, third] = result.compactions;
  assert.ok(result.compactions.every((compaction) => compaction.byState));
  assert.match(second.summary, /Goal \(u1, the active \/goal\): "?ship the replay scorer[\s\S]*Request \(u2\): "?fix the probe parser/, "the Request the summarizer picked survives");
  assert.doesNotMatch(third.summary, /active \/goal/, "a completed goal is cleared");
});

test("replay: World lists the task the background service reports over pi's event bus, and ages the claims, across a custom-message run", async () => {
  const startTime = Date.now() - 14 * 60_000;
  const steps: ReplayStep[] = [
    { kind: "user", text: "Start the e2e suite in the background, then run the unit tests.", turns: [{ calls: [bash("npm test", "12 passing")] }, { text: "Unit tests pass; e2e is running." }] },
    { kind: "notice", text: "task T7 wrote 400 lines of output", turns: [{ text: "Still running; nothing to do yet." }] },
    { kind: "compact" },
  ];
  const result = await replay(steps, { tasks: () => [{ id: "T7", name: "e2e suite", startTime }] });
  assert.deepEqual(result.errors, []);
  const [compaction] = result.compactions;
  assert.ok(compaction.byState);
  assert.match(compaction.summary, /Background tasks running \(live at compaction\): T7 "e2e suite" \(command, started 1[45]m before compaction\)/);
  assert.match(compaction.summary, /npm test[^\n]*ran under 1m before compaction/);
});
