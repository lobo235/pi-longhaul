import test from "node:test";
import assert from "node:assert/strict";

import { claimCorrectness, correctionRetention, earlierCorrections, nameCoverage, nameNeeds, needCoverage, needWindow, objectiveStability, ruleSections, summarize, userCorrections, withoutSection } from "./measures.ts";
import { assistantEntry, chain, piGoalMessage, toolResultEntry, userEntry } from "../test-support.ts";

test("needWindow: files read and commands run in the next k assistant messages, deduplicated", () => {
  const after = chain([
    assistantEntry("a1", "x", [{ name: "read", arguments: { path: "src/a.ts" } }, { name: "bash", arguments: { command: "npm test" } }]),
    toolResultEntry("t1", "a1-t0", "read", "..."),
    userEntry("m1", "ok"),
    assistantEntry("a2", "y", [{ name: "read", arguments: { path: "src/a.ts" } }, { name: "bash", arguments: { command: "npm test   " } }]),
    assistantEntry("a3", "z", [{ name: "read", arguments: { path: "src/b.ts" } }]),
  ]);
  assert.deepEqual(needWindow(after, 2), { filesRead: ["src/a.ts"], commandsRun: ["npm test"] });
  assert.deepEqual(needWindow(after), { filesRead: ["src/a.ts", "src/b.ts"], commandsRun: ["npm test"] });
});

test("needCoverage: a need counts as covered when the rendered text names it or recall can answer it", () => {
  const window = { filesRead: ["src/a.ts", "src/b.ts"], commandsRun: ["npm test", "make lint"] };
  const result = needCoverage(window, "read src/a.ts; last test: `npm test` exit 0", (needle) => needle === "make lint");
  assert.deepEqual(result, { covered: 3, total: 4, share: 0.75, missed: ["src/b.ts"] });
  assert.equal(needCoverage({ filesRead: [], commandsRun: [] }, "", () => false).share, null);
});

test("userCorrections and correctionRetention: rule-shaped user messages, retained when a 12-char window survives verbatim", () => {
  const corrections = userCorrections(["never use mocks in these tests, fakes only", "thanks", "you must always run the full suite"]);
  assert.deepEqual(corrections, ["never use mocks in these tests, fakes only", "you must always run the full suite"]);
  const rendered = "## Corrections\nR1 [u2] never use mocks in these tests\n";
  assert.deepEqual(correctionRetention(corrections, rendered), { retained: 1, total: 2, share: 0.5, missed: ["you must always run the full suite"], kept: ["never use mocks in these tests, fakes only"] });
  assert.equal(correctionRetention([], rendered).share, null);
});

test("objectiveStability and claimCorrectness (table)", () => {
  assert.equal(objectiveStability(undefined, undefined), "none");
  assert.equal(objectiveStability(undefined, "build it"), "set");
  assert.equal(objectiveStability("build it", "build it"), "stable");
  assert.equal(objectiveStability("build it", "ship it"), "moved");
  const commands = [{ id: "C1", command: "npm test", lastExitCode: 0, runs: 1, lastSeenPass: 1 }, { id: "C2", command: "make lint", lastExitCode: 1, runs: 1, lastSeenPass: 1 }] as never[];
  const claims = [{ kind: "test", commandRef: "C1", exitCode: 0, at: "x", stale: false }, { kind: "lint", commandRef: "C2", exitCode: 0, at: "x", stale: false }, { kind: "build", commandRef: "C9", exitCode: 0, at: "x", stale: false }] as never[];
  assert.deepEqual(claimCorrectness(claims, commands), { correct: 1, total: 3, wrong: [{ commandRef: "C2", claimed: 0, ledger: 1 }, { commandRef: "C9", claimed: 0, ledger: undefined }] });
});

test("summarize: per-arm means over the rows, null when a measure had no denominators; pi's own compactor is an arm like the others", () => {
  const row = (arm: "state" | "pi-default", chars: number, share: number | null) => ({ arm, at: "x", session: "s", renderedChars: chars, need: { covered: 1, total: 2, share, missed: [] }, corrections: { retained: 1, total: 1, share: 1, missed: [] }, objective: arm === "state" ? ("moved" as const) : null, claims: arm === "state" ? { correct: 1, total: 2, wrong: [{ commandRef: "C1", claimed: 0, ledger: 1 }] } : null });
  const summary = summarize([row("state", 10000, 0.5), row("state", 14000, null), row("pi-default", 15000, 0.25)]);
  assert.deepEqual(summary.state, { n: 2, renderedChars: 12000, needShare: 0.5, correctionShare: 1, objectiveMoved: 2, claimWrong: 2, fileShare: null, artifactShare: null, earlierCorrectionShare: null, earlierCorrectionsDistinct: { n: 0, share: null }, durationP50Ms: null, durationP90Ms: null, probeShare: null, probePlanned: null, probePrecision: null, factShare: null, factRecallShare: null, reusedShare: null, warmShare: null, warmCached: null, inputTokens: null, outputTokens: null });
  assert.deepEqual(summary["pi-default"], { n: 1, renderedChars: 15000, needShare: 0.25, correctionShare: 1, objectiveMoved: 0, claimWrong: 0, fileShare: null, artifactShare: null, earlierCorrectionShare: null, earlierCorrectionsDistinct: { n: 0, share: null }, durationP50Ms: null, durationP90Ms: null, probeShare: null, probePlanned: null, probePrecision: null, factShare: null, factRecallShare: null, reusedShare: null, warmShare: null, warmCached: null, inputTokens: null, outputTokens: null });
  assert.equal(summary["state-turns"].n, 0);
  assert.equal(summary["state-warm"].n, 0, "every published arm is summarized, the ones with no rows included");
});

test("summarize: a harness that adds an arm of its own names it, and only the arms named are summarized", () => {
  const row = { arm: "my-compactor", at: "x", session: "s", renderedChars: 7, need: { covered: 1, total: 1, share: 1, missed: [] }, corrections: { retained: 0, total: 0, share: null, missed: [] }, objective: null, claims: null };
  const summary = summarize([row], ["my-compactor", "state"]);
  assert.deepEqual(Object.keys(summary), ["my-compactor", "state"]);
  assert.equal(summary["my-compactor"].renderedChars, 7);
});

test("summarize: pass time is reported as p50 and p90 per arm, nearest rank, over the rows that recorded it", () => {
  const row = (durationMs?: number) => ({ arm: "state-turns" as const, at: "x", session: "s", renderedChars: 1, need: { covered: 0, total: 0, share: null, missed: [] }, corrections: { retained: 0, total: 0, share: null, missed: [] }, objective: null, claims: null, ...(durationMs === undefined ? {} : { durationMs }) });
  const summary = summarize([10, 20, 30, 40, 50, 60, 70, 80, 90, 300].map((seconds) => row(seconds * 1000)).concat([row()]))["state-turns"];
  assert.equal(summary.durationP50Ms, 50_000);
  assert.equal(summary.durationP90Ms, 90_000);
});

test("summarize: name-level and earlier-correction shares are pooled over the rows (covered / total), so a one-name row weighs one name", () => {
  const cov = (covered: number, total: number) => ({ covered, total, share: total ? covered / total : null, missed: [] });
  const base = { at: "x", session: "s", renderedChars: 1, need: cov(0, 0), corrections: { retained: 0, total: 0, share: null, missed: [] }, objective: null, claims: null };
  const rows = [
    { ...base, arm: "state" as const, names: { files: cov(1, 1), artifacts: cov(0, 9) }, earlierCorrections: { retained: 1, total: 4, share: 0.25, missed: [], kept: [] } },
    { ...base, arm: "state" as const, names: { files: cov(0, 3), artifacts: cov(1, 1) }, earlierCorrections: { retained: 0, total: 0, share: null, missed: [], kept: [] } },
  ];
  const summary = summarize(rows).state;
  assert.deepEqual([summary.fileShare, summary.artifactShare, summary.earlierCorrectionShare], [0.25, 0.1, 0.25]);
});

test("nameNeeds: file tools by basename; bash commands contribute the file-like names they touch; a name is counted once", () => {
  const after = chain([
    assistantEntry("a1", "x", [{ name: "read", arguments: { path: "/home/u/p/src/pass.ts" } }, { name: "bash", arguments: { command: "cd /home/u/p && node --test pass.test.ts && cat deploy/app.service.hcl | head" } }]),
    assistantEntry("a2", "y", [{ name: "edit", arguments: { path: "src/pass.ts" } }, { name: "bash", arguments: { command: "ls -la" } }]),
  ]);
  assert.deepEqual(nameNeeds(after), { files: ["pass.ts"], artifacts: ["pass.test.ts", "app.service.hcl"] });
});

test("nameCoverage: covered when the rendered text names it or recall answers it", () => {
  assert.deepEqual(nameCoverage(["pass.ts", "app.service.hcl", "x.json"], "edited `src/pass.ts`", (needle) => needle === "x.json"), { covered: 2, total: 3, share: 2 / 3, missed: ["app.service.hcl"] });
});

test("userCorrections: a /goal-mode message counts only its objective, never pi's rule template; a pasted document is not a correction", () => {
  const goal = piGoalMessage("keep going and never touch prod");
  const quiet = piGoalMessage("ship the scorer");
  assert.deepEqual(userCorrections([goal, quiet, `do not ${"x".repeat(2100)}`]), ["keep going and never touch prod"]);
});

test("earlierCorrections: corrections given before this span, which only a carried state or summary can still hold", () => {
  const path = ["never use mocks in these tests", "hello", "always run make lint first", "you must ship today"];
  assert.deepEqual(earlierCorrections(path, ["you must ship today"]), ["never use mocks in these tests", "always run make lint first"]);
});

test("ruleSections: only the sections that carry rules count, in either compactor's layout, so a rule echoed in a log line is not a kept rule", () => {
  const state = "## Objective (set)\n> build it\n## Constraints & corrections (verbatim, newest last)\n- R1 [u2] never use mocks anywhere\n## Work log (one line per span)\n- span 1: user said always run make lint first\n";
  assert.equal(ruleSections(state), "## Constraints & corrections (verbatim, newest last)\n- R1 [u2] never use mocks anywhere");
  assert.deepEqual(correctionRetention(["always run make lint first"], ruleSections(state)).missed, ["always run make lint first"]);
  const otherSummary = "## Goal\nship\n## Constraints & Preferences\n- never use mocks anywhere\n## Progress\n### Done\n- always run make lint first\n## User Corrections\n- stop pushing to main\n## Next Steps\n- x\n";
  assert.equal(ruleSections(otherSummary), "## Constraints & Preferences\n- never use mocks anywhere\n## User Corrections\n- stop pushing to main");
  assert.equal(ruleSections("no headings at all"), "");
});

test("summarize: earlier corrections also weigh each distinct correction once per session, so one rule due at many compactions cannot carry the result", () => {
  const base = { session: "s", renderedChars: 1, need: { covered: 0, total: 0, share: null, missed: [] }, corrections: correctionRetention([], ""), objective: null, claims: null };
  const row = (at: string, rendered: string, due: string[], session = "s") => ({ ...base, arm: "state" as const, at, session, earlierCorrections: correctionRetention(due, rendered) });
  const rows = [
    row("t1", "", ["never expose the endpoint publicly"]),
    row("t2", "", ["never expose the endpoint publicly"]),
    row("t3", "", ["never expose   the endpoint publicly", "always run make lint first"]),
    row("t4", "always run make lint first", ["always run make lint first"]),
    row("t1", "never expose the endpoint publicly", ["never expose the endpoint publicly"], "other"),
  ];
  const summary = summarize(rows).state;
  assert.equal(summary.earlierCorrectionShare, 2 / 6, "pooled: every due instance counts");
  // s/endpoint: 0 of 3; s/lint: 1 of 2; other/endpoint: 1 of 1 (the same words in another session are another rule).
  assert.deepEqual(summary.earlierCorrectionsDistinct, { n: 3, share: (0 + 0.5 + 1) / 3 });
});

test("summarize: the continuation probe is pooled per arm, with the share of answers that held a plan", () => {
  const row = (probe?: { hit: number; total: number; parsed: boolean; onTarget: number; targets: number }) => ({ arm: "state" as const, at: "x", session: "s", renderedChars: 1, need: { covered: 0, total: 0, share: null, missed: [] }, corrections: { retained: 0, total: 0, share: null, missed: [] }, objective: null, claims: null, ...(probe ? { probe: { ...probe, share: null } } : {}) });
  const summary = summarize([row({ hit: 1, total: 4, parsed: true, onTarget: 2, targets: 5 }), row({ hit: 2, total: 4, parsed: false, onTarget: 1, targets: 3 }), row()]).state;
  assert.equal(summary.probeShare, 3 / 8);
  assert.equal(summary.probePlanned, 1 / 2);
  assert.equal(summary.probePrecision, 3 / 8, "the share of planned targets the next span actually touched");
});

test("summarize: the learned-facts share is pooled over the rows that carry it", () => {
  const row = (facts?: { kept: number; total: number }) => ({ arm: "state" as const, at: "x", session: "s", renderedChars: 1, need: { covered: 0, total: 0, share: null, missed: [] }, corrections: { retained: 0, total: 0, share: null, missed: [] }, objective: null, claims: null, ...(facts ? { facts: { ...facts, share: null, byKind: {} } } : {}) });
  assert.equal(summarize([row({ kept: 1, total: 4 }), row({ kept: 3, total: 4 }), row()]).state.factShare, 0.5);
  assert.equal(summarize([row()]).state.factShare, null);
});

test("summarize: the reused-values share is pooled over the rows that carry it", () => {
  const row = (reused?: { kept: number; total: number }) => ({ arm: "state" as const, at: "x", session: "s", renderedChars: 1, need: { covered: 0, total: 0, share: null, missed: [] }, corrections: { retained: 0, total: 0, share: null, missed: [] }, objective: null, claims: null, ...(reused ? { reused: { ...reused, share: null, byKind: {} } } : {}) });
  assert.equal(summarize([row({ kept: 1, total: 2 }), row({ kept: 2, total: 2 }), row()]).state.reusedShare, 0.75);
  assert.equal(summarize([row()]).state.reusedShare, null);
});

test("summarize: the recall-credited facts share pools keptWithRecall, and a row written before it existed counts its text-only figure", () => {
  const row = (facts: { kept: number; keptWithRecall?: number; total: number }) => ({ arm: "state" as const, at: "x", session: "s", renderedChars: 1, need: { covered: 0, total: 0, share: null, missed: [] }, corrections: { retained: 0, total: 0, share: null, missed: [] }, objective: null, claims: null, facts: { ...facts, share: null, byKind: {} } });
  const summary = summarize([row({ kept: 1, keptWithRecall: 3, total: 4 }), row({ kept: 1, total: 4 })]).state;
  assert.equal(summary.factShare, 0.25);
  assert.equal(summary.factRecallShare, 0.5);
});

test("summarize: state-warm reports the share of its compactions whose narrative call went warm (the rest fell back to the re-encoded call)", () => {
  const row = (warm?: boolean) => ({ arm: "state-warm" as const, at: "x", session: "s", renderedChars: 1, need: { covered: 0, total: 0, share: null, missed: [] }, corrections: { retained: 0, total: 0, share: null, missed: [] }, objective: null, claims: null, ...(warm === undefined ? {} : { warm }) });
  const summary = summarize([row(true), row(true), row(false), row()]);
  assert.equal(summary["state-warm"].n, 4);
  assert.equal(summary["state-warm"].warmShare, 2 / 3);
  assert.equal(summary.state.warmShare, null);
});

test("summarize: state-warm pools the prompt tokens its warm calls read from the server's cache", () => {
  const row = (warmTokens?: { cacheRead: number; prompt: number }) => ({ arm: "state-warm" as const, at: "x", session: "s", renderedChars: 1, need: { covered: 0, total: 0, share: null, missed: [] }, corrections: { retained: 0, total: 0, share: null, missed: [] }, objective: null, claims: null, ...(warmTokens ? { warmTokens } : {}) });
  assert.equal(summarize([row({ cacheRead: 90, prompt: 100 }), row({ cacheRead: 10, prompt: 100 }), row()])["state-warm"].warmCached, 0.5);
  assert.equal(summarize([row()])["state-warm"].warmCached, null);
});

test("withoutSection: drops one section of a rendered state, heading to the next heading, and nothing else", () => {
  const text = "# Session state\nprecedence\n## Files\nRead: a.ts\n## Learned values (from tool output)\n- 70eaffb (C1)\n- 5.9.3 (C2)\n## Work log\n1. did it\nrecall: hint\n";
  assert.equal(withoutSection(text, "## Learned values"), "# Session state\nprecedence\n## Files\nRead: a.ts\n## Work log\n1. did it\nrecall: hint\n");
  assert.equal(withoutSection(text, "## Missing"), text);
});

test("summarize: prompt and output tokens are means over the rows that reported them, so an arm's cost per compaction can be compared", () => {
  const row = (tokens?: { input: number; output: number }) => ({ arm: "pi-default", at: "x", session: "s", renderedChars: 1, need: { covered: 0, total: 0, share: null, missed: [] }, corrections: { retained: 0, total: 0, share: null, missed: [] }, objective: null, claims: null, ...(tokens ? { tokens } : {}) });
  const summary = summarize([row({ input: 1000, output: 100 }), row({ input: 3000, output: 300 }), row()])["pi-default"];
  assert.equal(summary.inputTokens, 2000);
  assert.equal(summary.outputTokens, 200);
});
