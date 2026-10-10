import test from "node:test";
import assert from "node:assert/strict";

import type { AssistantMessage, Context } from "@earendil-works/pi-ai";

import { buildMessageIndex } from "../../intent.ts";
import { DEFAULT_CAPS } from "../../store/events.ts";
import { emptyState } from "../../store/project.ts";
import { assistantEntry, chain, modelWith, textResponse, USAGE, userEntry } from "../../test-support.ts";
import { DEFAULT_NARRATIVE_POLICY } from "../policy.ts";
import { prepareSpan } from "../prepare.ts";
import { promptStateOf } from "../prompt.ts";
import { createRouteHealth, DEFAULT_ROUTE_HEALTH } from "../route-health.ts";
import { DEFAULT_TURNS_POLICY } from "./policy.ts";
import { runSectionTurns, type TurnsInput } from "./run.ts";
import { LOWEST_REASONING_OUTPUT_TOKENS } from "../reasoning.ts";

const entries = chain([
  userEntry("m1", "Build the section turns mode for the state compactor"),
  assistantEntry("a1", "Starting with the digest.", [{ name: "bash", arguments: { command: "npm test" } }]),
  userEntry("m2", "never use mocks in these tests, fakes only"),
  assistantEntry("a2", "Understood."),
]);
const index = buildMessageIndex(entries, { commandIds: new Set(["C1"]), errorIds: new Set(["E1"]) });
const messages = entries.map((entry) => (entry as unknown as { message: never }).message);

const ANSWERS: Record<string, string> = {
  narrative: '{"narrative": "Built the digest in digest.ts and ran C1."}',
  objective: '{"objective": {"messageRef": "u1"}}',
  labels: '{"labels": {"u1": "not a rule", "u2": "rule"}}',
  records: '{"decisions": [{"text": "Built the digest before the runner.", "evidence": "C1"}], "deadEnds": []}',
  now: '{"now": {"inProgress": ["runner"], "next": ["wire the pass"], "blocked": [], "resume": "run npm test"}}',
};

/** Answers by the section the last user message asks for; overrides replace an answer by section, in order of asking. */
function model(overrides: Record<string, string[]> = {}) {
  const contexts: Context[] = [];
  const asked: Record<string, number> = {};
  const complete = async (_model: unknown, context: Context): Promise<AssistantMessage> => {
    contexts.push(structuredClone(context));
    const last = String((context.messages.at(-1) as { content: unknown }).content);
    const id = Object.keys(ANSWERS).find((key) => last.includes(`Section ${Object.keys(ANSWERS).indexOf(key) + 1} of 5`)) ?? [...contexts].reverse().map((c) => String((c.messages.filter((m) => m.role === "user").at(-2) as { content: unknown } | undefined)?.content ?? "")).map((text) => Object.keys(ANSWERS).find((key) => text.includes(`Section ${Object.keys(ANSWERS).indexOf(key) + 1} of 5`))).find(Boolean)!;
    const n = (asked[id] = (asked[id] ?? 0) + 1);
    return textResponse(overrides[id]?.[n - 1] ?? ANSWERS[id]);
  };
  return { complete, contexts };
}

function input(overrides: Partial<TurnsInput> = {}): TurnsInput {
  const state = emptyState();
  return {
    span: prepareSpan({ messagesToSummarize: messages, turnPrefixMessages: [], index }), state, promptState: promptStateOf(state, []),
    verify: { resolver: index, provenance: { source: "diff", span: 1, at: "2026-10-04T10:00:00.000Z" }, caps: DEFAULT_CAPS, nearDuplicateThreshold: 0.8, acceptedThisSpan: 0, rememberCap: 0 },
    model: modelWith({ contextWindow: 131072 }), routeHealth: createRouteHealth(), routeConfig: DEFAULT_ROUTE_HEALTH, routeAvailable: true, policy: DEFAULT_NARRATIVE_POLICY,
    turns: DEFAULT_TURNS_POLICY,
    context: { commands: [{ id: "C1", command: "npm test", runs: 1, lastExitCode: 0, failedThenSucceeded: false, lastSeenPass: 1 }], errors: [], files: { readFiles: [], modifiedFiles: ["src/digest.ts"] }, filesChars: 2500, worldLines: ["branch main"], openErrorIds: [], unresolvedSpanErrorIds: [], spanModifiedFiles: ["src/digest.ts"], textOf: (ordinal) => index.textOf(ordinal) },
    ...overrides,
  };
}

let clock = 0;
const deps = (call: { complete: (...args: never[]) => Promise<AssistantMessage> }) => ({ call: call as never, sleep: async () => {}, now: () => (clock += 100) });

test("runSectionTurns: five turns in one conversation, digest once; the outcome carries every section's events in order", async () => {
  const call = model();
  const outcome = await runSectionTurns(input(), deps(call));
  assert.equal(outcome.kind, "diff");
  assert.equal(call.contexts.length, 5);
  assert.deepEqual(outcome.events.map((event) => event.kind), ["objective.set", "correction.add", "decision.add", "now.set"]);
  assert.equal(outcome.narrative, "Built the digest in digest.ts and ran C1.");
  assert.deepEqual(outcome.sections?.map((section) => [section.section, section.outcome]), [["narrative", "accepted"], ["objective", "accepted"], ["labels", "accepted"], ["records", "accepted"], ["now", "accepted"]]);
  const last = call.contexts[4];
  assert.equal(last.messages.filter((message) => message.role === "user").length, 5, "one continuing conversation");
  const digestTurns = last.messages.filter((message) => message.role === "user" && String(message.content).includes("<user-messages>"));
  assert.equal(digestTurns.length, 1, "the digest is sent once");
  assert.deepEqual(outcome.calls.map((trace) => trace.chunk), [1, 2, 3, 4, 5]);
});

test("runSectionTurns: a failing check gets a repair turn in the same conversation; the repaired answer lands", async () => {
  const call = model({ labels: ['{"labels": {"u2": "rule"}}'] });
  const outcome = await runSectionTurns(input(), deps(call));
  const labels = outcome.sections!.find((section) => section.section === "labels")!;
  assert.equal(labels.turns, 2);
  assert.equal(labels.outcome, "accepted");
  assert.deepEqual(labels.repairs, [["labels.unlabelled"]], "each repair turn is traced by the check ids that caused it");
  const repair = call.contexts.find((context) => String((context.messages.at(-1) as { content: unknown }).content).startsWith("Your answer did not pass the checks"));
  assert.match(String((repair!.messages.at(-1) as { content: unknown }).content), /missing: u1/);
});

test("runSectionTurns: after the repair turns run out, the section lands partial with its failing items dropped and logged", async () => {
  const bad = '{"decisions": [{"text": "A decision with no evidence."}], "deadEnds": []}';
  const outcome = await runSectionTurns(input(), deps(model({ records: [bad, bad, bad] })));
  const records = outcome.sections!.find((section) => section.section === "records")!;
  assert.equal(records.turns, 3);
  assert.equal(records.outcome, "partial");
  assert.match(records.unresolved[0], /^records.evidence/);
  assert.ok(!outcome.events.some((event) => event.kind === "decision.add"));
});

test("runSectionTurns: a not-applicable flag excuses an expectation and is recorded with its reason", async () => {
  const outcome = await runSectionTurns(input(), deps(model({ narrative: ['{"narrative": "Worked on the compactor.", "notApplicable": [{"check": "narrative.names-modified-file", "reason": "the edit was generated"}]}'] })));
  const narrative = outcome.sections![0];
  assert.equal(narrative.turns, 1);
  assert.deepEqual(narrative.excused, [{ check: "narrative.names-modified-file", reason: "the edit was generated" }]);
});

test("runSectionTurns: past the pass budget the remaining sections are skipped and carry; what landed stays", async () => {
  let now = 0;
  const call = model();
  const slow = { complete: async (model: unknown, context: Context, options: { timeoutMs: number }) => {
    if (options.timeoutMs < 110_000) { now += options.timeoutMs; throw new Error("Request timed out."); }
    now += 110_000;
    return call.complete(model, context);
  } };
  const outcome = await runSectionTurns(input(), { call: slow as never, sleep: async () => {}, now: () => now });
  const skipped = outcome.sections!.filter((section) => section.outcome === "skipped").map((section) => [section.section, section.skipped]);
  assert.deepEqual(skipped, [["labels", "deadline"], ["records", "budget"], ["now", "budget"]]);
  assert.ok(now <= 300_000, `the pass ended at ${now} ms, inside its 5-minute budget`);
  assert.equal(outcome.kind, "diff");
  assert.ok(!outcome.events.some((event) => event.kind === "now.set"), "Now carries from the previous state");
});

test("runSectionTurns: usage sums every request, reasoning included, so a reasoning-off breach shows in the outcome", async () => {
  const call = model();
  const leaky = { complete: async (...args: unknown[]) => ({ ...(await call.complete(...(args as [unknown, Context]))), usage: { ...USAGE, reasoning: 50 } }) };
  const outcome = await runSectionTurns(input(), deps(leaky));
  assert.equal(outcome.usage.calls, 5);
  assert.equal(outcome.usage.reasoning, 250);
});

test("runSectionTurns: usage sums the priced cost of every request", async () => {
  const call = model();
  const priced = { complete: async (...args: unknown[]) => ({ ...(await call.complete(...(args as [unknown, Context]))), usage: { ...USAGE, cacheWrite: 40, cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0.001, total: 0.004 } } }) };
  const outcome = await runSectionTurns(input(), deps(priced));
  assert.equal(outcome.usage.calls, 5);
  assert.equal(outcome.usage.cacheWrite, 200);
  assert.ok(Math.abs(outcome.usage.cost.total - 0.02) < 1e-12);
});

test("runSectionTurns: a dead transport on every turn ends narrative-less without throwing", async () => {
  const dead = { complete: async () => { throw new Error("ECONNREFUSED"); } };
  const outcome = await runSectionTurns(input(), deps(dead));
  assert.equal(outcome.kind, "narrative-less");
  assert.ok(outcome.sections!.every((section) => section.outcome === "skipped" && section.skipped === "transport"));
});

test("runSectionTurns: a span with no user messages asks no labels turn", async () => {
  const call = model();
  const span = { ...prepareSpan({ messagesToSummarize: messages, turnPrefixMessages: [], index }), ordinals: [] };
  const outcome = await runSectionTurns(input({ span }), deps(call));
  const labels = outcome.sections!.find((section) => section.section === "labels")!;
  assert.deepEqual([labels.turns, labels.outcome], [0, "accepted"]);
  assert.equal(call.contexts.length, 4);
});

test("runSectionTurns: the turn that carries the digest gets digestTurnMs; later turns get turnMs", async () => {
  const timeouts: number[] = [];
  const call = model();
  const timed = { complete: async (m: unknown, context: Context, options: { timeoutMs: number }) => { timeouts.push(options.timeoutMs); return call.complete(m, context); } };
  let now = 0;
  await runSectionTurns(input({ turns: { ...DEFAULT_TURNS_POLICY, digestTurnMs: 170_000, turnMs: 90_000 } }), { call: timed as never, sleep: async () => {}, now: () => now });
  assert.equal(timeouts[0], 170_000);
  assert.equal(timeouts[1], 90_000);
});

test("runSectionTurns: a narrative that still fails integrity after its repairs is dropped whole, never landed over its cap", async () => {
  const huge = JSON.stringify({ narrative: `Built digest.ts. ${"x".repeat(5000)}` });
  const outcome = await runSectionTurns(input(), deps(model({ narrative: [huge, huge, huge] })));
  const narrative = outcome.sections![0];
  assert.deepEqual([narrative.outcome, narrative.skipped, narrative.turns], ["skipped", "integrity", 3]);
  assert.match(narrative.unresolved[0], /^narrative.too-long/);
  assert.equal(outcome.narrative, undefined);
  assert.equal(outcome.kind, "diff", "the other sections still land");
});

test("runSectionTurns: an answer whose JSON never closes is traced by shape, and the repair names the likely cause", async () => {
  for (const [answer, shape, cause] of [['{"now": {"inProgress": ["a"], "next": [', "unclosed", /closing \} or \] is missing/], ['{"now": {"resume": "edit "a.ts": then', "open-string", /escape/i]] as const) {
    const fake = model({ now: [answer, answer, answer] });
    const outcome = await runSectionTurns(input(), deps(fake));
    const now = outcome.sections!.find((section) => section.section === "now")!;
    assert.deepEqual([now.outcome, now.skipped, now.unparsed], ["skipped", "unparsed", shape]);
    assert.match(String((fake.contexts.at(-1)!.messages.at(-1) as { content: unknown }).content), cause);
  }
});

test("runSectionTurns: a section with reasoning low asks for it, with its own output budget; every other section stays off", async () => {
  const seen: Array<{ prompt: string; reasoning: unknown; maxTokens: unknown }> = [];
  const fake = model();
  const call = { complete: async (m: unknown, context: Context, options: Record<string, unknown>) => {
    seen.push({ prompt: String((context.messages.at(-1) as { content: unknown }).content), reasoning: options.reasoning, maxTokens: options.maxTokens });
    return fake.complete(m, context);
  } };
  await runSectionTurns(input({ turns: { ...DEFAULT_TURNS_POLICY, reasoning: { records: "low" }, reasoningOutputTokens: 5000 } }), deps(call));
  const records = seen.filter((request) => request.prompt.includes("Section 4 of 5"));
  assert.ok(records.length > 0);
  assert.deepEqual(records.map((request) => [request.reasoning, request.maxTokens]), records.map(() => ["low", 5000]));
  assert.ok(seen.filter((request) => !request.prompt.includes("Section 4 of 5")).every((request) => request.reasoning === "off" && request.maxTokens === DEFAULT_TURNS_POLICY.outputTokens));
});

test("runSectionTurns: a reasoning-low section's budget never asks for more than the model can produce", async () => {
  const seen: unknown[] = [];
  const fake = model();
  const call = { complete: async (m: unknown, context: Context, options: Record<string, unknown>) => {
    if (options.reasoning === "low") seen.push(options.maxTokens);
    return fake.complete(m, context);
  } };
  await runSectionTurns(input({ model: modelWith({ contextWindow: 131072, maxTokens: 2048 }), turns: { ...DEFAULT_TURNS_POLICY, reasoning: { records: "low" }, reasoningOutputTokens: 5000 } }), deps(call));
  assert.ok(seen.length > 0);
  assert.ok(seen.every((maxTokens) => maxTokens === 2048), JSON.stringify(seen));
});

test("runSectionTurns: the digest's transcript tags a bash call with the ledger's command id", async () => {
  const call = model();
  await runSectionTurns(input(), deps(call));
  const first = String((call.contexts[0].messages[0] as { content: unknown }).content);
  assert.match(first, /T1 → bash \[C1\]: npm test/);
});

test("runSectionTurns: on a model that cannot turn reasoning off, an off section asks for the lowest level with the larger budget and its trace says so", async () => {
  const seen: Array<{ reasoning: unknown; maxTokens: unknown }> = [];
  const fake = model();
  const call = { complete: async (m: unknown, context: Context, options: Record<string, unknown>) => {
    seen.push({ reasoning: options.reasoning, maxTokens: options.maxTokens });
    return fake.complete(m, context);
  } };
  const outcome = await runSectionTurns(input({ model: modelWith({ contextWindow: 131072, maxTokens: 64_000, thinkingLevelMap: { off: null } }) }), deps(call));
  assert.ok(seen.length > 0);
  assert.ok(seen.every((request) => request.reasoning === "minimal" && request.maxTokens === LOWEST_REASONING_OUTPUT_TOKENS), JSON.stringify(seen));
  assert.ok(outcome.calls.every((trace) => trace.reasoning === "minimal"));
});

test("runSectionTurns: the digest leaves room for the larger output budget of a model that cannot turn reasoning off", async () => {
  const longEntries = chain([userEntry("m1", "Build the digest and keep it small"), ...Array.from({ length: 400 }, (_, i) => assistantEntry(`a${i}`, `step ${i}: ${"word ".repeat(60)}`))]);
  const longIndex = buildMessageIndex(longEntries, { commandIds: new Set(), errorIds: new Set() });
  const span = prepareSpan({ messagesToSummarize: longEntries.map((entry) => (entry as unknown as { message: never }).message), turnPrefixMessages: [], index: longIndex });
  const digestChars = async (thinkingLevelMap: Record<string, string | null> | undefined) => {
    const fake = model();
    await runSectionTurns(input({ span, model: modelWith({ contextWindow: 40_000, maxTokens: 64_000, thinkingLevelMap }) }), deps(fake));
    return String((fake.contexts[0].messages[0] as { content: unknown }).content).length;
  };
  const offable = await digestChars(undefined);
  const mustReason = await digestChars({ off: null });
  // The extra budget at 3 chars per token, less a little: the transcript is fitted in whole lines.
  assert.ok(offable - mustReason >= (LOWEST_REASONING_OUTPUT_TOKENS - DEFAULT_TURNS_POLICY.outputTokens) * 3 * 0.9, `${offable} vs ${mustReason}`);
});

test("runSectionTurns: a lift-replaced question first raised on the last turn gets one more turn to answer it", async () => {
  const tabEntries = chain([
    userEntry("t1", "Use tabs for indentation in every TypeScript file in this project."),
    assistantEntry("b1", "ok", [{ name: "bash", arguments: { command: "npm test" } }]),
    userEntry("t2", "The tab rule doesn't apply to the JSON files or package.json; keep tabs in the TypeScript files."),
    assistantEntry("b2", "ok"),
    userEntry("t3", "Switch the TypeScript files to two-space indentation instead of tabs from here on, and convert the existing files."),
    assistantEntry("b3", "ok"),
  ]);
  const tabIndex = buildMessageIndex(tabEntries, { commandIds: new Set(["C1"]), errorIds: new Set() });
  const tabMessages = tabEntries.map((entry) => (entry as unknown as { message: never }).message);
  const unlabelled = '{"labels": {"u1": "rule"}}';
  const labelled = (u3: string) => `{"labels": {"u1": "rule", "u2": "rule and lifts u1", "u3": "${u3}"}}`;
  const call = model({ labels: [unlabelled, unlabelled, labelled("rule and lifts u1"), labelled("rule and lifts u2")] });
  const base = input();
  const outcome = await runSectionTurns(input({ span: prepareSpan({ messagesToSummarize: tabMessages, turnPrefixMessages: [], index: tabIndex }), verify: { ...base.verify, resolver: tabIndex }, context: { ...base.context, textOf: (ordinal) => tabIndex.textOf(ordinal) } }), deps(call));
  const labels = outcome.sections!.find((section) => section.section === "labels")!;
  assert.equal(labels.turns, 4, "one more turn, for the question only");
  assert.equal(labels.outcome, "accepted");
  const lifts = outcome.events.flatMap((event) => (event.kind === "correction.lift" ? [`${event.target} by ${event.by.ordinal}`] : []));
  assert.deepEqual(lifts, ["R1 by u2", "R2 by u3"]);
});

test("runSectionTurns: with a fallback waiting, the routed turn retries its transport only routeMaxRetries times", async () => {
  const answering = model();
  const models: string[] = [];
  const call = { complete: async (target: { id: string }, context: Context) => { models.push(target.id); if (target.id === "routed") throw new Error("fetch failed"); return answering.complete(target, context); } };
  const outcome = await runSectionTurns(input({ model: modelWith({ id: "routed", contextWindow: 131072 }), fallbackModel: modelWith({ id: "session", contextWindow: 131072 }), routeConfig: { ...DEFAULT_ROUTE_HEALTH, routedMaxRetries: 0 }, policy: { ...DEFAULT_NARRATIVE_POLICY, transportRetry: { maxRetries: 2, baseDelayMs: 0 } } }), deps(call));
  assert.equal(outcome.kind, "diff");
  assert.deepEqual(models.filter((id) => id === "routed"), ["routed"]);
});
