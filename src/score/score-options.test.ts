import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { scoreOptionsOf } from "./score-options.ts";

test("scoreOptionsOf: the sessions directory is required, so the scorer never reads a transcript store nobody named", () => {
  assert.throws(() => scoreOptionsOf({}, "/repo"), /SCORE_SESSIONS/);
});

test("scoreOptionsOf: defaults are the state arm against pi's own, ten compactions, three caps, output under score-out", () => {
  const options = scoreOptionsOf({ SCORE_SESSIONS: "/data/synthetic" }, "/repo");
  assert.deepEqual(options.arms, ["state", "pi-default"]);
  assert.equal(options.sessions, "/data/synthetic");
  assert.equal(options.n, 10);
  assert.deepEqual(options.caps, [8000, 12000, 16000]);
  assert.equal(path.dirname(options.out), path.join("/repo", "score-out"));
  assert.match(path.basename(options.out), /^\d{4}-/);
  assert.equal(options.probe, false);
  assert.equal(options.warmPrime, true);
  assert.equal(options.includeLocalOnly, false);
});

test("scoreOptionsOf: arms run in published order whatever order they are named in; a bad list is refused, naming the arms", () => {
  const cases: Array<[string, Record<string, string>, string[] | RegExp]> = [
    ["named arms, published order", { SCORE_ARMS: "pi-default,state-turns,state" }, ["state", "state-turns", "pi-default"]],
    ["an unknown arm", { SCORE_ARMS: "state,summary" }, /summary.*state, state-unlearned, state-turns, state-warm, pi-default/],
    ["the derived arm needs the state arm", { SCORE_ARMS: "state-unlearned" }, /state-unlearned needs the state arm/],
    ["an empty list", { SCORE_ARMS: " , " }, /no arm/],
  ];
  for (const [name, env, expected] of cases) {
    const run = () => scoreOptionsOf({ SCORE_SESSIONS: "/s", ...env }, "/repo");
    if (expected instanceof RegExp) assert.throws(run, expected, name);
    else assert.deepEqual(run().arms, expected, name);
  }
});

test("scoreOptionsOf: numbers out of range fall back to the default rather than running zero or unbounded compactions", () => {
  assert.equal(scoreOptionsOf({ SCORE_SESSIONS: "/s", SCORE_CHAIN: "0", SCORE_N: "0" }, "/repo").n, 10);
  assert.equal(scoreOptionsOf({ SCORE_SESSIONS: "/s", SCORE_CHAIN: "0", SCORE_N: "abc" }, "/repo").n, 10);
  assert.equal(scoreOptionsOf({ SCORE_SESSIONS: "/s", SCORE_CHAIN: "0", SCORE_N: "3" }, "/repo").n, 3);
  assert.deepEqual(scoreOptionsOf({ SCORE_SESSIONS: "/s", SCORE_CAPS: "6000,x,-1" }, "/repo").caps, [6000]);
});

test("scoreOptionsOf: a SCORE_CAPS with no valid entry stops the run; an empty one measures no cap renders on purpose", () => {
  assert.throws(() => scoreOptionsOf({ SCORE_SESSIONS: "/s", SCORE_CAPS: "x,-1" }, "/repo"), /SCORE_CAPS: no valid cap in "x,-1"/);
  assert.deepEqual(scoreOptionsOf({ SCORE_SESSIONS: "/s", SCORE_CAPS: "" }, "/repo").caps, []);
});

test("scoreOptionsOf: SCORE_KEEP_RECENT_TOKENS is the recording's keepRecentTokens; unset means pi's default, a bad value is refused", () => {
  assert.equal(scoreOptionsOf({ SCORE_SESSIONS: "/s" }, "/repo").keepRecentTokens, undefined);
  assert.equal(scoreOptionsOf({ SCORE_SESSIONS: "/s", SCORE_KEEP_RECENT_TOKENS: "8000" }, "/repo").keepRecentTokens, 8000);
  for (const raw of ["0", "-1", "8k", "1.5"]) {
    assert.throws(() => scoreOptionsOf({ SCORE_SESSIONS: "/s", SCORE_KEEP_RECENT_TOKENS: raw }, "/repo"), /SCORE_KEEP_RECENT_TOKENS/, raw);
  }
});

test("scoreOptionsOf: the replay is chained by default; SCORE_CHAIN=0 replays each compaction on its recorded path", () => {
  assert.equal(scoreOptionsOf({ SCORE_SESSIONS: "/s" }, "/repo").chain, true);
  assert.equal(scoreOptionsOf({ SCORE_SESSIONS: "/s", SCORE_CHAIN: "0" }, "/repo").chain, false);
  assert.throws(() => scoreOptionsOf({ SCORE_SESSIONS: "/s", SCORE_CHAIN: "yes" }, "/repo"), /SCORE_CHAIN/);
});

test("scoreOptionsOf: a chained replay runs whole sessions, so picking single compactions is refused unless SCORE_CHAIN=0", () => {
  for (const env of [{ SCORE_N: "5" }, { SCORE_AT: "2026-10" }, { SCORE_CANDIDATES_FROM: "/r/rows.jsonl" }]) {
    const name = Object.keys(env)[0];
    assert.throws(() => scoreOptionsOf({ SCORE_SESSIONS: "/s", ...env }, "/repo"), new RegExp(`${name}.*SCORE_CHAIN=0`), name);
    assert.doesNotThrow(() => scoreOptionsOf({ SCORE_SESSIONS: "/s", SCORE_CHAIN: "0", ...env }, "/repo"), name);
  }
});

test("scoreOptionsOf: SCORE_LABELS names the label file; unset, the scorer looks for labels.json beside the sessions", () => {
  assert.equal(scoreOptionsOf({ SCORE_SESSIONS: "/s", SCORE_LABELS: "/l/labels.json" }, "/repo").labels, "/l/labels.json");
  assert.equal(scoreOptionsOf({ SCORE_SESSIONS: "/s" }, "/repo").labels, undefined);
});
