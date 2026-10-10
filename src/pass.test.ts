import test from "node:test";
import assert from "node:assert/strict";

import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { createRouteHealth } from "./narrative/route-health.ts";
import { runStatePass, type PassDeps, type PassInput } from "./pass.ts";
import { EVENT_ENTRY_TYPE, SPAN_ENTRY_TYPE } from "./store/events.ts";
import { assistantEntry, chain, compactionEntry, customEntry, modelWith, NOT_RULES, piGoalMessage, piGoalStateEntry, textResponse, toolResultEntry, userEntry } from "./test-support.ts";

const diffText = JSON.stringify({ narrative: "ran the tests", labels: NOT_RULES, corrections: [{ messageRef: "u2", text: "never use mocks in these tests" }], lifts: [], decisions: [{ text: "kept the ledger", evidence: "C1" }], deadEnds: [], now: { inProgress: [], next: ["fix the layout"], blocked: [], resume: "run npm test" } });
const answer = (text = diffText) => textResponse("```json\n" + text + "\n```");

function branch() {
  return chain([
    userEntry("m1", "Build the state compactor and keep the ledger modules as they are"),
    assistantEntry("a1", "running tests", [{ name: "bash", arguments: { command: "npm test" } }]),
    toolResultEntry("t1", "a1-t0", "bash", "ok\n[exit 0]"),
    userEntry("m2", "never use mocks in these tests, fakes only"),
    assistantEntry("a2", "sure"),
  ]);
}

function inputOf(entries = branch(), overrides: Partial<PassInput> = {}): PassInput {
  const messages = entries.filter((entry) => entry.type === "message").map((entry) => (entry as { message: AgentMessage }).message);
  return {
    preparation: { firstKeptEntryId: entries.at(-1)!.id, messagesToSummarize: messages.slice(0, -1), turnPrefixMessages: messages.slice(-1), isSplitTurn: true, tokensBefore: 90_000, fileOps: { read: new Set(["src/a.ts"]), written: new Set(), edited: new Set(["src/b.ts"]) }, settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 } } as never,
    branchEntries: entries,
    reason: "threshold",
    sessionModel: modelWith({ provider: "example", id: "model-a", contextWindow: 131072 }),
    cwd: "/tmp/project",
    env: {},
    ...overrides,
  };
}

// `git config --get-regexp` exits 1 when no key matches: no filter driver is configured.
const git = async (_file: string, args: string[]) => args.includes("config") ? { stdout: "", stderr: "", code: 1, killed: false } : ({ stdout: args.includes("rev-parse") ? (args.includes("--abbrev-ref") ? "main\n" : "ab12cd\n") : args.includes("status") ? "" : "1 file changed\n", stderr: "", code: 0, killed: false });

function depsOf(overrides: Partial<PassDeps> = {}): PassDeps & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    readConfig: () => undefined,
    exec: git as never,
    call: { complete: async (_model: unknown, context: unknown) => { prompts.push((context as { messages: Array<{ content: string }> }).messages[0].content); return answer() as never; } },
    find: (provider: string, id: string) => modelWith({ provider, id, contextWindow: 131072 }),
    routeHealth: createRouteHealth(),
    now: () => new Date("2026-09-28T12:00:00.000Z"),
    sleep: async () => {},
    ...overrides,
  };
}

test("runStatePass: first span — the summary is the rendered state, details carry the checkpoint, the pending record has the events, the ledger slice and the snapshot", async () => {
  const result = await runStatePass(inputOf(), depsOf());
  const { compaction, pending, outcome } = result;
  assert.ok(compaction.details);
  assert.match(compaction.summary, /^# Session state \(span 2/);
  assert.match(compaction.summary, /## Objective[\s\S]*Build the state compactor/);
  assert.match(compaction.summary, /## Constraints & corrections[\s\S]*R1 \[u2\] "never use mocks in these tests"/);
  assert.match(compaction.summary, /## Work log[\s\S]*ran the tests/);
  assert.match(compaction.summary, /## Now[\s\S]*Resume: run npm test/);
  assert.match(compaction.summary, /last test: `npm test` exit 0/);
  assert.equal(compaction.firstKeptEntryId, inputOf().preparation.firstKeptEntryId);
  assert.equal(compaction.tokensBefore, 90_000);
  assert.equal(compaction.details.compactor, "state");
  assert.equal(compaction.details.stateFormat, 1, "a later format can migrate or refuse this one by its number");
  assert.equal(compaction.details.state.span, 2, "the checkpoint is the state after the close: next open span");
  assert.deepEqual(compaction.details.readFiles, ["src/a.ts"]);
  assert.deepEqual(compaction.details.modifiedFiles, ["src/b.ts"]);
  assert.equal(compaction.details.narrative.kind, "diff");
  assert.equal(pending.span, 1);
  assert.deepEqual(pending.events.map((event) => event.kind), ["objective.set", "correction.add", "decision.add", "now.set", "span.close"]);
  assert.equal(pending.ledger.commands[0].id, "C1");
  assert.equal(pending.snapshot?.commit, "ab12cd");
  assert.equal(outcome.kind, "diff");
  assert.match(result.notice, /^longhaul: span 1 closed \(3 accepted, 0 dropped, \d+ chars\) via example\/model-a$/, "the session's own model writes the diff");
  assert.equal(result.route.spec, undefined);
  assert.equal(result.log.event, "compaction");
});

test("runStatePass: the compaction's usage is what the summarizer call cost, so pi's session totals count it", async () => {
  const priced = { input: 1200, output: 300, cacheRead: 400, cacheWrite: 50, totalTokens: 1950, cost: { input: 0.0036, output: 0.0045, cacheRead: 0.0001, cacheWrite: 0.0002, total: 0.0084 } };
  const call = { complete: async () => textResponse("```json\n" + diffText + "\n```", { usage: priced }) as never };
  const { compaction } = await runStatePass(inputOf(), depsOf({ call }));
  assert.deepEqual(compaction.usage, priced);
});

test("runStatePass: the log record carries no message text — a rejected quote logs its code and lengths, unless excerpts are asked for", async () => {
  const misquoted = JSON.stringify({ ...JSON.parse(diffText), corrections: [{ messageRef: "u2", text: "never use MOCKS anywhere" }] });
  const call = { complete: async () => answer(misquoted) as never };
  const plain = await runStatePass(inputOf(), depsOf({ call }));
  const logged = JSON.stringify(plain.log);
  assert.equal((plain.log.rejected as Array<{ code: string }>)[0].code, "not-substring");
  assert.doesNotMatch(logged, /MOCKS anywhere|fakes only/, "neither the model's quote nor the user's message reaches the log");
  const debug = await runStatePass(inputOf(undefined, { env: { PI_COMPACT_STATE_DEBUG_EXCERPTS: "1" } }), depsOf({ call }));
  assert.match(JSON.stringify(debug.log), /fakes only/, "the debug flag puts the excerpts back");
});

test("runStatePass: the objective defaults from the first user message when the diff sets none", async () => {
  const noObjective = JSON.stringify({ ...JSON.parse(diffText), objective: undefined });
  const result = await runStatePass(inputOf(), depsOf({ call: { complete: async () => answer(noObjective) as never } }));
  assert.match(result.compaction.summary, /## Objective[\s\S]*Build the state compactor/);
  assert.equal(result.pending.events[0].kind, "objective.set");
  assert.equal(result.pending.events[0].source, "pass");
});

test("runStatePass: second span — remember events of the open span are in the prompt state and the record; the previous span's claims carry; foreign entries fold", async () => {
  const first = await runStatePass(inputOf(), depsOf());
  const entries = [
    ...branch(),
    compactionEntry("c1", first.compaction.details),
    customEntry("s1", SPAN_ENTRY_TYPE, { v: 1, span: 1, compactionEntryId: "c1", events: first.pending.events, ledger: first.pending.ledger, snapshot: first.pending.snapshot }),
    userEntry("m3", "also: always run the full suite before you claim done"),
    customEntry("e1", EVENT_ENTRY_TYPE, { source: "remember", span: 2, at: "2026-09-28T12:05:00.000Z", seq: 100, kind: "correction.add", id: "R2", quote: { messageId: "m3", ordinal: "u3", text: "always run the full suite before you claim done" } }),
    assistantEntry("a3", "noted"),
  ];
  const deps = depsOf({ call: { complete: async (_m: unknown, context: unknown) => { deps.prompts.push((context as { messages: Array<{ content: string }> }).messages[0].content); return answer(JSON.stringify({ narrative: "second span", labels: NOT_RULES, corrections: [], lifts: [], decisions: [], deadEnds: [], now: { inProgress: [], next: [], blocked: [], resume: "go" } })) as never; } } });
  const second = await runStatePass(inputOf(chain(entries)), deps);
  assert.ok(second.compaction.details);
  assert.match(deps.prompts[0], /<remembered-this-span>[\s\S]*R2 \[u3\] always run the full suite/);
  assert.match(deps.prompts[0], /<state>[\s\S]*R1 \[u2\] never use mocks/);
  assert.equal(second.pending.span, 2);
  assert.ok(second.pending.events.some((event) => event.kind === "correction.add" && (event as { id: string }).id === "R2"), "the remember event rides the span record");
  assert.match(second.compaction.summary, /## Constraints & corrections[\s\S]*R1[\s\S]*R2/);
  assert.match(second.compaction.summary, /last test: `npm test` exit 0 @ ab12cd/);
  assert.equal(second.compaction.details.state.span, 3);
});

test("runStatePass: narrative-less — the state still closes with a code-written work-log line and a notice naming the reason", async () => {
  const result = await runStatePass(inputOf(), depsOf({ call: { complete: async () => textResponse("no") as never } }));
  assert.equal(result.outcome.kind, "narrative-less");
  assert.match(result.compaction.summary, /narrative unavailable for this span \(narrative-less pass\)/);
  assert.match(result.compaction.summary, /## Objective[\s\S]*Build the state compactor/, "the default objective still lands");
  assert.match(result.notice, /^longhaul: span 1 closed narrative-less \(invalid-json\)$/);
});

test("runStatePass: after a narrative-less pass, the next pass labels that span's user messages too, so a rule given there is recorded", async () => {
  const failed = await runStatePass(inputOf(), depsOf({ call: { complete: async () => textResponse("no") as never } }));
  assert.equal(failed.outcome.kind, "narrative-less");
  const entries = chain([...closed(branch(), failed, 1), userEntry("m3", "now add the report command"), assistantEntry("a3", "done")]);
  const own = entries.slice(-2).map((entry) => (entry as unknown as { message: AgentMessage }).message);
  const base = inputOf(entries);
  const labels = { u1: "not a rule", u2: "rule", u3: "not a rule" };
  const deps = answering({ labels });
  const next = await runStatePass({ ...base, preparation: { ...base.preparation, messagesToSummarize: own.slice(0, 1), turnPrefixMessages: own.slice(1) } }, deps);
  assert.match(deps.prompts[0], /<unsummarized-messages>[\s\S]*\[u2\] never use mocks in these tests, fakes only/);
  assert.deepEqual(carried(next), ["u2 never use mocks in these tests, fakes only"]);
});

test("runStatePass: the configured route is used only by a session whose provider routeProviders names", async () => {
  const models: string[] = [];
  const call = { complete: async (model: { provider: string; id: string }) => { models.push(`${model.provider}/${model.id}`); return answer() as never; } };
  const session = modelWith({ provider: "local", id: "dense", contextWindow: 131072 });
  const routed = await runStatePass(inputOf(branch(), { sessionModel: session }), depsOf({ call, readConfig: () => JSON.stringify({ model: "local/moe", routeProviders: ["local"] }) }));
  assert.deepEqual(models, ["local/moe"]);
  assert.equal(routed.route.routeIgnored, undefined);
  const unlisted = await runStatePass(inputOf(branch(), { sessionModel: session }), depsOf({ call, readConfig: () => JSON.stringify({ model: "local/moe" }) }));
  assert.deepEqual(models, ["local/moe", "local/dense"], "no routeProviders: the session summarizes on its own model");
  assert.match(unlisted.route.routeIgnored ?? "", /local is not a route provider/);
});

test("runStatePass: PI_COMPACT_STATE_MODEL routes this invocation whatever routeProviders says, as typed on purpose", async () => {
  const models: string[] = [];
  const call = { complete: async (model: { provider: string; id: string }) => { models.push(`${model.provider}/${model.id}`); return answer() as never; } };
  const session = modelWith({ provider: "local", id: "dense", contextWindow: 131072 });
  const result = await runStatePass(inputOf(branch(), { sessionModel: session, env: { PI_COMPACT_STATE_MODEL: "local/moe" } }), depsOf({ call, readConfig: () => "{}" }));
  assert.deepEqual(models, ["local/moe"]);
  assert.equal(result.route.routeIgnored, undefined);
});

test("runStatePass: a session not on a route provider self-summarizes (no route); no session model is narrative-less no-model", async () => {
  const models: string[] = [];
  const deps = depsOf({ call: { complete: async (model: { provider: string; id: string }) => { models.push(`${model.provider}/${model.id}`); return answer() as never; } } });
  const local = await runStatePass(inputOf(branch(), { sessionModel: modelWith({ provider: "anthropic", id: "claude", contextWindow: 200000 }) }), deps);
  assert.deepEqual(models, ["anthropic/claude"]);
  assert.equal(local.route.spec, undefined);
  const none = await runStatePass(inputOf(branch(), { sessionModel: undefined }), deps);
  assert.equal(none.outcome.reason, "no-model");
  assert.equal(models.length, 1);
});

test("runStatePass: the rendered state never exceeds the hard cap (capfit tests the fit; here: the pass wires the measure)", async () => {
  const big = JSON.stringify({ ...JSON.parse(diffText), decisions: Array.from({ length: 10 }, (_, i) => ({ text: `decision ${i} ${"y".repeat(250)}`, evidence: "C1" })), narrative: "z".repeat(3000) });
  const result = await runStatePass(inputOf(), depsOf({ readConfig: () => JSON.stringify({ caps: { hardChars: 2000 } }), call: { complete: async () => answer(big) as never } }));
  assert.ok(result.compaction.summary.length <= 2000 || result.capFit.exhausted, `${result.compaction.summary.length} chars`);
  assert.ok(result.capFit.retired.decisions > 0 || result.capFit.retired.workLog > 0);
});

test("runStatePass: an abort inside the narrative call surfaces as a rejection (index.ts logs aborted)", async () => {
  const controller = new AbortController();
  const deps = depsOf({ call: { complete: async () => { controller.abort(); const error = new Error("The operation was aborted"); error.name = "AbortError"; throw error; } } });
  const result = await runStatePass(inputOf(branch(), { signal: controller.signal }), deps);
  assert.equal(result.outcome.reason, "aborted");
});

const quietDiff = JSON.stringify({ narrative: "goal turn", labels: NOT_RULES, corrections: [], lifts: [], decisions: [], deadEnds: [], now: { inProgress: [], next: [], blocked: [], resume: "go" } });
const quiet = { call: { complete: async () => answer(quietDiff) as never } };

/** The branch after `pass` closed span `span`, as the extension persists it. */
function closed(entries: ReturnType<typeof branch>, pass: Awaited<ReturnType<typeof runStatePass>>, span: number) {
  return [
    ...entries,
    compactionEntry(`c${span}`, pass.compaction.details),
    customEntry(`s${span}`, SPAN_ENTRY_TYPE, { v: 1, span, compactionEntryId: `c${span}`, events: pass.pending.events, ledger: pass.pending.ledger, snapshot: pass.pending.snapshot }),
  ];
}

test("runStatePass: an active /goal sets the Goal (code alone), never the Request; the same goal again sets nothing", async () => {
  const first = await runStatePass(inputOf(), depsOf());
  const goal = piGoalMessage("ship the replay scorer fixes end to end");
  const entries = [...closed(branch(), first, 1), userEntry("m3", goal), assistantEntry("a3", "working on it")];
  const unrecorded = await runStatePass(inputOf(chain(entries)), depsOf(quiet));
  assert.equal(unrecorded.compaction.details?.state.goal, undefined, "security.md T2: a goal pi-goal never recorded sets no Goal");
  entries.splice(entries.length - 2, 0, piGoalStateEntry("g1", "ship the replay scorer fixes end to end"));
  const second = await runStatePass(inputOf(chain(entries)), depsOf(quiet));
  assert.equal(second.compaction.details?.state.goal?.quote.text, "ship the replay scorer fixes end to end");
  assert.ok(second.pending.events.some((event) => event.kind === "goal.set" && event.source === "pass"));
  assert.equal(second.compaction.details?.state.objective?.quote.text, first.compaction.details?.state.objective?.quote.text, "the Request is the summarizer's, the goal does not overwrite it");
  const third = [...closed(entries, second, 2), userEntry("m4", goal), assistantEntry("a4", "still working")];
  const again = await runStatePass(inputOf(chain(third)), depsOf(quiet));
  assert.ok(!again.pending.events.some((event) => event.kind === "goal.set" || event.kind === "objective.set"), "an unchanged goal sets nothing");
});

test("runStatePass: no objective ping-pong -- a Request the summarizer picked inside a /goal survives the next pass", async () => {
  const goalText = "ship the replay scorer fixes end to end";
  const first = await runStatePass(inputOf(), depsOf());
  const withGoal = [...closed(branch(), first, 1), piGoalStateEntry("g1", goalText), userEntry("m3", piGoalMessage(goalText)), assistantEntry("a3", "on it")];
  const second = await runStatePass(inputOf(chain(withGoal)), depsOf(quiet));
  const ask = "fix the probe parser before anything else in the scorer";
  const asked = [...closed(withGoal, second, 2), userEntry("m5", ask), assistantEntry("a5", "fixing the parser")];
  const picked = JSON.stringify({ ...JSON.parse(quietDiff), objective: { messageRef: "u4", text: ask } });
  const third = await runStatePass(inputOf(chain(asked)), depsOf({ call: { complete: async () => answer(picked) as never } }));
  assert.equal(third.compaction.details?.state.objective?.quote.text, ask, "the summarizer's pick is the Request");
  const later = [...closed(asked, third, 3), userEntry("m6", piGoalMessage(goalText)), assistantEntry("a6", "continuing")];
  const fourth = await runStatePass(inputOf(chain(later)), depsOf(quiet));
  assert.ok(!fourth.pending.events.some((event) => event.kind === "objective.set"), "the pass never re-sets the Request to the goal");
  assert.equal(fourth.compaction.details?.state.objective?.quote.text, ask);
  assert.equal(fourth.compaction.details?.state.goal?.quote.text, goalText);
  assert.match(fourth.compaction.summary, /Goal[\s\S]*ship the replay scorer[\s\S]*Request[\s\S]*fix the probe parser/);
});

test("runStatePass (security.md T2): a /goal pi-goal cleared or completed leaves the Goal; it is never rendered as active again", async () => {
  const goalText = "ship the replay scorer fixes end to end";
  const first = await runStatePass(inputOf(), depsOf());
  const withGoal = [...closed(branch(), first, 1), piGoalStateEntry("g1", goalText), userEntry("m3", piGoalMessage(goalText)), assistantEntry("a3", "on it")];
  const second = await runStatePass(inputOf(chain(withGoal)), depsOf(quiet));
  assert.equal(second.compaction.details?.state.goal?.quote.text, goalText);
  const done = [...closed(withGoal, second, 2), customEntry("g2", "goal-state", { goal: { id: "goal-1", text: goalText, status: "complete" } }), userEntry("m4", "now tidy the README"), assistantEntry("a4", "tidying")];
  const third = await runStatePass(inputOf(chain(done)), depsOf(quiet));
  assert.ok(third.pending.events.some((event) => event.kind === "goal.clear" && event.source === "pass"));
  assert.equal(third.compaction.details?.state.goal, undefined);
  assert.doesNotMatch(third.compaction.summary, /active \/goal/);
  const later = [...closed(done, third, 3), userEntry("m5", "and the changelog"), assistantEntry("a5", "done")];
  const fourth = await runStatePass(inputOf(chain(later)), depsOf(quiet));
  assert.ok(!fourth.pending.events.some((event) => event.kind === "goal.clear"), "no Goal, nothing to clear");
});

test("runStatePass: World lists the background tasks still running at compaction; an unknown task service lists none", async () => {
  const started = Date.parse("2026-09-28T11:46:00.000Z");
  const tasks = async () => [{ id: "T41", name: "e2e suite", isAgent: false, startTime: started }];
  const known = await runStatePass(inputOf(), depsOf({ runningTasks: tasks }));
  assert.match(known.compaction.summary, /## World \(live at compaction\)[\s\S]*Background tasks running \(live at compaction\): T41 "e2e suite" \(command, started 14m before compaction\)\. Do not relaunch these; check them with bg_status\./);
  const unknown = await runStatePass(inputOf(), depsOf({ runningTasks: async () => undefined }));
  assert.doesNotMatch(unknown.compaction.summary, /Background tasks/);
});

test("runStatePass: the first state span after another compactor sees its summary as a seed; a later state span does not", async () => {
  const entries = branch();
  const foreign = "## Goal\nShip it.\n\n## User Corrections\n- \"never use mocks in these tests\"\n\n## Next Steps\n1. fix the layout";
  const withSeed = inputOf(entries, { preparation: { ...inputOf(entries).preparation, previousSummary: foreign } as never });
  const deps = depsOf();
  const first = await runStatePass(withSeed, deps);
  assert.match(deps.prompts[0], /<previous-summary>[\s\S]*## User Corrections[\s\S]*fix the layout[\s\S]*<\/previous-summary>/);
  const later = [...entries, compactionEntry("c1", first.compaction.details), customEntry("s1", SPAN_ENTRY_TYPE, { v: 1, span: 1, compactionEntryId: "c1", events: first.pending.events, ledger: first.pending.ledger, snapshot: first.pending.snapshot }), userEntry("m3", "carry on please, thanks"), assistantEntry("a3", "ok")];
  const deps2 = depsOf();
  await runStatePass(inputOf(chain(later), { preparation: { ...inputOf(chain(later)).preparation, previousSummary: first.compaction.summary } as never }), deps2);
  assert.doesNotMatch(deps2.prompts[0], /<previous-summary>/);
});

test("runStatePass: the switchover pass lists the user's earlier rule-shaped messages verbatim, so a carried correction can be quoted, not paraphrased", async () => {
  const earlier = [
    userEntry("m0", "never deploy on a friday, whatever the change"),
    assistantEntry("a0", "understood"),
    userEntry("m00", "what time is it?"),
    assistantEntry("a00", "noon"),
    compactionEntry("c0", { compactor: "another-compactor" }),
  ];
  const span = branch();
  const entries = chain([...earlier, ...span]);
  const messages = span.filter((entry) => entry.type === "message").map((entry) => (entry as { message: AgentMessage }).message);
  const input = inputOf(entries, { preparation: { ...inputOf(entries).preparation, messagesToSummarize: messages.slice(0, -1), turnPrefixMessages: messages.slice(-1), previousSummary: "## Goal\nship it" } as never });
  const deps = depsOf();
  await runStatePass(input, deps);
  assert.match(deps.prompts[0], /<earlier-user-messages>[\s\S]*\[u1\] never deploy on a friday, whatever the change[\s\S]*<\/earlier-user-messages>/);
  assert.doesNotMatch(deps.prompts[0], /<earlier-user-messages>[^<]*what time is it/);
  assert.doesNotMatch(deps.prompts[0], /<earlier-user-messages>[^<]*never use mocks/, "span messages are not 'earlier'");
});

/** Another compactor's compaction, then this span: u1 is an earlier rule, u2 an earlier question, u3/u4 the span. */
function switchoverInput(): PassInput {
  const earlier = [userEntry("m0", "never deploy on a friday, whatever the change"), assistantEntry("a0", "understood"), userEntry("m00", "what time is it?"), assistantEntry("a00", "noon"), compactionEntry("c0", { compactor: "another-compactor" })];
  const span = branch();
  const entries = chain([...earlier, ...span]);
  const messages = span.filter((entry) => entry.type === "message").map((entry) => (entry as { message: AgentMessage }).message);
  return inputOf(entries, { preparation: { ...inputOf(entries).preparation, messagesToSummarize: messages.slice(0, -1), turnPrefixMessages: messages.slice(-1), previousSummary: "## Goal\nship it" } as never });
}
const answering = (diff: Record<string, unknown>) => withPrompts((prompts) => ({ complete: async (_m: unknown, context: unknown) => { prompts.push((context as { messages: Array<{ content: string }> }).messages[0].content); return answer(JSON.stringify({ narrative: "ran the tests", labels: NOT_RULES, corrections: [], lifts: [], decisions: [], deadEnds: [], now: { inProgress: [], next: [], blocked: [], resume: "go on" }, ...diff })) as never; } }));
function withPrompts(call: (prompts: string[]) => PassDeps["call"]): ReturnType<typeof depsOf> {
  const deps = depsOf();
  return { ...deps, call: call(deps.prompts) };
}
const carried = (result: Awaited<ReturnType<typeof runStatePass>>) => result.pending.events.flatMap((event) => (event.kind === "correction.add" ? [`${event.quote.ordinal} ${event.quote.text}`] : []));

test("runStatePass: on a switchover the code records each earlier rule it offered, verbatim, even when the model leaves it out", async () => {
  const result = await runStatePass(switchoverInput(), answering({}));
  assert.deepEqual(carried(result), ["u1 never deploy on a friday, whatever the change"]);
  assert.match(result.compaction.summary, /## Constraints & corrections[^\n]*\n- R1 \[u1\] "never deploy on a friday, whatever the change"/);
});

test("runStatePass: an earlier message the model names a one-off is not recorded; one the model already recorded is recorded once", async () => {
  assert.deepEqual(carried(await runStatePass(switchoverInput(), answering({ oneOffs: ["u1"] }))), []);
  const both = await runStatePass(switchoverInput(), answering({ corrections: [{ messageRef: "u1", text: "never deploy on a friday" }] }));
  assert.deepEqual(carried(both), ["u1 never deploy on a friday"], "the model's quote stands; the code adds no near-duplicate");
});

test("runStatePass: a narrative-less switchover still records the earlier rules: the floor does not depend on the model answering", async () => {
  const result = await runStatePass(switchoverInput(), depsOf({ call: { complete: async () => textResponse("no json here") as never } }));
  assert.equal(result.outcome.kind, "narrative-less");
  assert.deepEqual(carried(result), ["u1 never deploy on a friday, whatever the change"]);
});

test("runStatePass: a switchover from another compactor shows its carried files and this span's under ## Files, newest first", async () => {
  const earlier = [userEntry("m0", "start"), assistantEntry("a0", "ok"), compactionEntry("c0", { compactor: "another-compactor", readFiles: ["src/carried-read.ts"], modifiedFiles: ["src/carried-edit.ts"] })];
  const entries = chain([...earlier, ...branch()]);
  const result = await runStatePass(inputOf(entries), answering({}));
  const files = result.compaction.summary.split("\n").filter((line) => /^(## Files|Modified:|Read:)/.test(line));
  assert.deepEqual(files, ["## Files (modified, then read; newest first)", "Modified: src/b.ts, src/carried-edit.ts", "Read: src/a.ts, src/carried-read.ts"]);
  assert.ok(result.compaction.summary.indexOf("## Files") > result.compaction.summary.indexOf("## World"));
  assert.ok(result.compaction.summary.indexOf("## Files") < result.compaction.summary.indexOf("## Work log"));
});

test("runStatePass: narrativeMode turns asks section by section, sees the default objective and World, and records the section traces", async () => {
  const sectionAnswers: Record<number, string> = {
    1: '{"narrative": "Ran C1 and edited b.ts."}',
    2: '{"objective": "keep"}',
    3: '{"labels": {"u1": "not a rule", "u2": "rule"}}',
    4: '{"decisions": [{"text": "Kept the ledger modules.", "evidence": "C1"}], "deadEnds": []}',
    5: '{"now": {"inProgress": [], "next": ["fix the layout"], "blocked": [], "resume": "run npm test"}}',
  };
  const firstTurns: string[] = [];
  const call = { complete: async (_model: unknown, context: unknown) => {
    const messages = (context as { messages: Array<{ role: string; content: string }> }).messages;
    if (messages.length === 1) firstTurns.push(messages[0].content);
    const asked = /Section (\d) of 5/.exec(messages.at(-1)!.content)![1];
    return textResponse(sectionAnswers[Number(asked)]) as never;
  } };
  const result = await runStatePass(inputOf(), depsOf({ readConfig: () => JSON.stringify({ narrativeMode: "turns" }), call }));
  assert.equal(result.outcome.sections?.length, 5);
  assert.ok(result.outcome.sections!.every((section) => section.outcome === "accepted"), JSON.stringify(result.outcome.sections));
  assert.match(firstTurns[0], /objective: \[u1\] Build the state compactor/, "the default objective is in the state the turns see");
  assert.match(firstTurns[0], /<world>\nbranch main @ ab12cd/);
  assert.match(firstTurns[0], /Modified: src\/b.ts/);
  assert.deepEqual(result.pending.events.map((event) => event.kind), ["objective.set", "correction.add", "decision.add", "now.set", "span.close"]);
  assert.match(result.compaction.summary, /R1 \[u2\] "never use mocks in these tests, fakes only"/, "code copied the user's whole message");
  assert.equal(result.compaction.details!.promptRevision, "turns-8");
  assert.equal(result.compaction.details!.narrative.sections?.length, 5);
});

test("runStatePass: narrativeMode warm repeats the session's own request (PassInput.warmBase) with one instruction; without a base it is the single call", async () => {
  const warmBase = { systemPrompt: "You are a coding agent.", messages: [{ role: "user" as const, content: "the session so far", timestamp: 1 }], tools: [] };
  const contexts: Array<{ systemPrompt: string; messages: unknown[] }> = [];
  const call = { complete: async (_model: unknown, context: unknown) => { contexts.push(context as never); return answer() as never; } };
  const warm = await runStatePass(inputOf(undefined, { warmBase }), depsOf({ readConfig: () => JSON.stringify({ narrativeMode: "warm" }), call }));
  assert.equal(contexts[0].systemPrompt, warmBase.systemPrompt);
  assert.deepEqual(contexts[0].messages[0], warmBase.messages[0]);
  assert.equal(warm.outcome.calls[0].warm, true);
  await runStatePass(inputOf(), depsOf({ readConfig: () => JSON.stringify({ narrativeMode: "warm" }), call }));
  assert.equal(contexts[1].systemPrompt, "", "no base: the re-encoded single call");
  await runStatePass(inputOf(undefined, { warmBase }), depsOf({ call }));
  assert.equal(contexts[2].systemPrompt, "", "the single mode ignores a base");
});

test("runStatePass: a value the span learned from a command and used again is rendered as a Learned value and carried to the next pass", async () => {
  const entries = chain([
    userEntry("m1", "Which commit is the release on?"),
    assistantEntry("a1", "checking", [{ name: "bash", arguments: { command: "git log --oneline -1" } }]),
    toolResultEntry("t1", "a1-t0", "bash", "70eaffb release: v1.4.0"),
    assistantEntry("a2", "The release is commit 70eaffb."),
    userEntry("m2", "thanks"),
  ]);
  const first = await runStatePass(inputOf(entries), depsOf());
  assert.match(first.compaction.summary, /## Learned values \(verbatim; where each came from, then any label the summarizer gave it; newest first\)\n- 70eaffb \(C1\)\n/);
  assert.deepEqual(first.compaction.details?.learnedValues, [{ value: "70eaffb", source: "C1" }]);
  const later = chain([...entries, compactionEntry("c1", first.compaction.details), customEntry("s1", SPAN_ENTRY_TYPE, { v: 1, span: 1, compactionEntryId: "c1", events: first.pending.events, ledger: first.pending.ledger, snapshot: first.pending.snapshot }), userEntry("m3", "carry on please, thanks"), assistantEntry("a3", "ok")]);
  const second = await runStatePass(inputOf(later), depsOf());
  assert.match(second.compaction.summary, /- 70eaffb \(C1\)/);
});

/** A switchover whose earlier rule has no rule word in it: only a label can carry it. */
function switchoverPlainRuleInput(): PassInput {
  const earlier = [userEntry("m0", "Tests go under tests/, one file per module in src/"), assistantEntry("a0", "understood"), compactionEntry("c0", { compactor: "another-compactor" })];
  const span = branch();
  const entries = chain([...earlier, ...span]);
  const messages = span.filter((entry) => entry.type === "message").map((entry) => (entry as { message: AgentMessage }).message);
  return inputOf(entries, { preparation: { ...inputOf(entries).preparation, messagesToSummarize: messages.slice(0, -1), turnPrefixMessages: messages.slice(-1), previousSummary: "## Goal\nship it" } as never });
}

test("runStatePass: on a switchover every earlier message must be labeled, so a rule with no rule word is carried when labeled one", async () => {
  const { u1: _skipped, ...spanOnly } = NOT_RULES;
  const unlabeled = answering({ labels: spanOnly });
  await runStatePass(switchoverPlainRuleInput(), unlabeled);
  assert.ok(unlabeled.prompts.length > 1, "an earlier message left unlabeled is asked again");
  assert.match(unlabeled.prompts.at(-1)!, /u1/);
  const labeled = answering({ labels: { ...NOT_RULES, u1: "rule" } });
  const result = await runStatePass(switchoverPlainRuleInput(), labeled);
  assert.deepEqual(carried(result), ["u1 Tests go under tests/, one file per module in src/"]);
  assert.match(labeled.prompts[0], /Label every one of these/);
});

/** A switchover where an earlier message, which no rule word marks, withdrew the earlier rule. */
function switchoverLiftInput(): PassInput {
  const earlier = [userEntry("m0", "never deploy on a friday, whatever the change"), assistantEntry("a0", "understood"), userEntry("m00", "The friday deploy rule is lifted, ship whenever it is ready."), assistantEntry("a00", "noted"), compactionEntry("c0", { compactor: "another-compactor" })];
  const span = branch();
  const entries = chain([...earlier, ...span]);
  const messages = span.filter((entry) => entry.type === "message").map((entry) => (entry as { message: AgentMessage }).message);
  return inputOf(entries, { preparation: { ...inputOf(entries).preparation, messagesToSummarize: messages.slice(0, -1), turnPrefixMessages: messages.slice(-1), previousSummary: "## Constraints\n- never deploy on a friday" } as never });
}

test("runStatePass: on a switchover the model sees the user's other earlier messages too, and an earlier rule a later message lifted is not carried", async () => {
  const deps = answering({ labels: { ...NOT_RULES, u2: "lifts u1" } });
  const result = await runStatePass(switchoverLiftInput(), deps);
  assert.match(deps.prompts[0], /<earlier-other-messages>[\s\S]*u2: The friday deploy rule is lifted[\s\S]*<\/earlier-other-messages>/);
  assert.deepEqual(carried(result), [], "the lifted rule does not come back");
  assert.deepEqual(result.outcome.rejected, []);
});

/** A switchover where an earlier rule-shaped message (offered as a seed rule) replaced an earlier plain rule. */
function switchoverReplacedInput(): PassInput {
  const earlier = [userEntry("m0", "Indent every file with tabs."), assistantEntry("a0", "understood"), userEntry("m00", "Switch every file to two-space indentation instead of tabs."), assistantEntry("a00", "switched"), compactionEntry("c0", { compactor: "another-compactor" })];
  const span = branch();
  const entries = chain([...earlier, ...span]);
  const messages = span.filter((entry) => entry.type === "message").map((entry) => (entry as { message: AgentMessage }).message);
  return inputOf(entries, { preparation: { ...inputOf(entries).preparation, messagesToSummarize: messages.slice(0, -1), turnPrefixMessages: messages.slice(-1), previousSummary: "## Constraints\n- two-space indentation" } as never });
}
const activeRules = (result: Awaited<ReturnType<typeof runStatePass>>) => {
  const lifted = new Set(result.pending.events.flatMap((event) => (event.kind === "correction.lift" ? [event.target] : [])));
  return result.pending.events.flatMap((event) => (event.kind === "correction.add" && !lifted.has(event.id) ? [event.quote.ordinal] : []));
};

test("runStatePass: on a switchover an earlier rule-shaped message may be labeled, so it can withdraw the rule it replaced", async () => {
  const result = await runStatePass(switchoverReplacedInput(), answering({ labels: { ...NOT_RULES, u1: "rule", u2: "rule and lifts u1" } }));
  assert.deepEqual(activeRules(result), ["u2"], "u1 is lifted by u2; u2 stands");
  assert.deepEqual(result.outcome.rejected, []);
});

test("runStatePass: on a switchover an earlier rule-shaped message that may replace an earlier rule is asked about, and a yes lifts it", async () => {
  const deps = withPrompts((prompts) => ({ complete: async (_m: unknown, context: unknown) => {
    const prompt = (context as { messages: Array<{ content: string }> }).messages[0].content;
    prompts.push(prompt);
    if (prompt.includes("<label-question>")) return answer(JSON.stringify({ u2: "rule and lifts u1" })) as never;
    return answer(JSON.stringify({ narrative: "ran the tests", labels: { ...NOT_RULES, u1: "rule", u2: undefined }, corrections: [], lifts: [], decisions: [], deadEnds: [], now: { inProgress: [], next: [], blocked: [], resume: "go on" } })) as never;
  } }));
  const result = await runStatePass(switchoverReplacedInput(), deps);
  assert.match(deps.prompts.at(-1)!, /u2 is labeled "rule" and may replace the rule u1 gave/);
  assert.deepEqual(activeRules(result), ["u2"]);
});

test("runStatePass: on a switchover an earlier rule-shaped message labeled \"not a rule\" is still recorded: only oneOffs drops one", async () => {
  const result = await runStatePass(switchoverInput(), answering({ labels: { ...NOT_RULES, u1: "not a rule" } }));
  assert.deepEqual(carried(result), ["u1 never deploy on a friday, whatever the change"]);
});

/**
 * Longhaul's own compaction judged u1 a one-off; a later compaction fell back to another compactor (pi's own, after a
 * failed pass) over u3, a new rule; then this span. Only the gap since Longhaul's last compaction is a switchover.
 */
async function afterFallbackInput(firstDeps: PassDeps = answering({})): Promise<PassInput> {
  const own = chain([userEntry("m0", "never mind the timing for now, just make it parse"), assistantEntry("a0", "ok"), userEntry("m1", "carry on with the parser"), assistantEntry("a1", "done")]);
  const first = await runStatePass(inputOf(own), firstDeps);
  assert.deepEqual(carried(first), [], "Longhaul's own pass recorded no rule from u1");
  const gap = [userEntry("m3", "never push straight to main, open a branch"), assistantEntry("a3", "ok"), compactionEntry("c2", { compactor: "another-compactor" })];
  const span = [userEntry("m5", "add a --top option"), assistantEntry("a5", "added"), userEntry("m6", "looks good"), assistantEntry("a6", "thanks")];
  const entries = chain([...closed(own, first, 1), ...gap, ...span]);
  const messages = chain(span).filter((entry) => entry.type === "message").map((entry) => (entry as { message: AgentMessage }).message);
  return inputOf(entries, { preparation: { ...inputOf(entries).preparation, messagesToSummarize: messages.slice(0, -1), turnPrefixMessages: messages.slice(-1), previousSummary: "## Goal\nparse the logs" } as never });
}

test("runStatePass: after a fallback, the switchover floor offers only the messages since Longhaul's own last compaction", async () => {
  const deps = answering({});
  const result = await runStatePass(await afterFallbackInput(), deps);
  assert.deepEqual(carried(result), ["u3 never push straight to main, open a branch"], "the gap's rule is carried; u1, which the state already judged, is not");
  assert.doesNotMatch(deps.prompts[0], /<earlier-user-messages>[^<]*never mind the timing/);
});

test("runStatePass: after a fallback, the messages of a Longhaul span that closed narrative-less are still offered: it never judged them", async () => {
  const silent = depsOf({ call: { complete: async () => textResponse("no json here") as never } });
  const result = await runStatePass(await afterFallbackInput(silent), answering({}));
  assert.deepEqual(carried(result), ["u1 never mind the timing for now, just make it parse", "u3 never push straight to main, open a branch"]);
});

test("runStatePass: a value the summarizer names from a turn, and that turn shows, is kept under Learned values with its name, and carried in details", async () => {
  const timed = chain([
    userEntry("m1", "Build the state compactor and keep the ledger modules as they are"),
    assistantEntry("a1", "running tests", [{ name: "bash", arguments: { command: "npm test" } }]),
    toolResultEntry("t1", "a1-t0", "bash", "ok, 42 tests in 166 ms\n[exit 0]"),
    userEntry("m2", "never use mocks in these tests, fakes only"),
    assistantEntry("a2", "sure"),
  ]);
  const deps = answering({ values: [{ name: "the suite time", value: "166 ms", ref: "u1" }, { name: "invented", value: "9 passing", ref: "u1" }] });
  const result = await runStatePass(inputOf(timed), deps);
  assert.match(result.compaction.summary, /## Learned values[^\n]*\n- 166 ms \(u1; the suite time\)/);
  assert.deepEqual((result.compaction.details as { learnedValues: unknown[] }).learnedValues[0], { name: "the suite time", value: "166 ms", source: "u1" });
  assert.doesNotMatch(result.compaction.summary, /9 passing/);
});
