import test from "node:test";
import assert from "node:assert/strict";

import { buildMessageIndex } from "../intent.ts";
import { DEFAULT_CAPS, type StateEvent } from "../store/events.ts";
import { emptyState } from "../store/project.ts";
import { chain, modelWith, textResponse, userEntry, assistantEntry } from "../test-support.ts";
import { DEFAULT_NARRATIVE_POLICY } from "./policy.ts";
import { LOWEST_REASONING_OUTPUT_TOKENS } from "./reasoning.ts";
import { carryUnlabeled, prepareSpan } from "./prepare.ts";
import { promptStateOf } from "./prompt.ts";
import { createRouteHealth, DEFAULT_ROUTE_HEALTH } from "./route-health.ts";
import { runNarrativeCall, type NarrativeInput } from "./run.ts";
import type { ModelCall } from "./call.ts";

const entries = chain([
  userEntry("m1", "Build the state compactor and keep the ledger modules as they are"),
  assistantEntry("a1", "ok"),
  userEntry("m2", "never use mocks in these tests, fakes only"),
  assistantEntry("a2", "sure"),
]);
const index = buildMessageIndex(entries, { commandIds: new Set(["C1"]), errorIds: new Set() });
const messages = entries.map((entry) => (entry as unknown as { message: never }).message);
const diff = (overrides: Record<string, unknown> = {}) => JSON.stringify({ narrative: "did the thing", labels: { u1: "not a rule", u2: "not a rule" }, corrections: [], lifts: [], decisions: [{ text: "copied the ledger", evidence: "C1" }], deadEnds: [], now: { inProgress: [], next: ["tests"], blocked: [], resume: "run npm test" }, ...overrides });
const answer = (text: string) => textResponse("```json\n" + text + "\n```");
const noSleep = async () => {};

function input(overrides: Partial<NarrativeInput> = {}): NarrativeInput {
  const state = emptyState();
  return {
    span: prepareSpan({ messagesToSummarize: messages, turnPrefixMessages: [], index }),
    state,
    promptState: promptStateOf(state, []),
    verify: { resolver: index, provenance: { source: "diff", span: 1, at: "2026-09-28T10:00:00.000Z" }, caps: DEFAULT_CAPS, nearDuplicateThreshold: 0.8, acceptedThisSpan: 0, rememberCap: 10 },
    model: modelWith({ contextWindow: 131072 }),
    routeHealth: createRouteHealth(),
    routeConfig: DEFAULT_ROUTE_HEALTH,
    routeAvailable: true,
    policy: DEFAULT_NARRATIVE_POLICY,
    ...overrides,
  };
}

const scripted = (...answers: Array<() => Promise<unknown>>) => {
  let i = 0;
  return { complete: async () => { const next = answers[Math.min(i, answers.length - 1)]; i++; return (await next()) as never; }, calls: () => i };
};

test("runNarrativeCall: a clean diff lands in one call; the outcome carries events, the narrative, usage and one trace", async () => {
  const call = scripted(async () => answer(diff()));
  const outcome = await runNarrativeCall(input(), { call, sleep: noSleep });
  assert.equal(outcome.kind, "diff");
  assert.deepEqual(outcome.events.map((event) => event.kind), ["decision.add", "now.set"]);
  assert.equal(outcome.narrative, "did the thing");
  assert.equal(outcome.calls.length, 1);
  assert.equal(outcome.usage.calls, 1);
  assert.deepEqual(outcome.missingChunks, []);
  assert.equal(outcome.routeHealth.failures, 0);
  assert.equal(call.calls(), 1);
});

test("runNarrativeCall: a fixable field error is retried once with the note; the second answer's items land and the trace says rescued", async () => {
  const bad = diff({ corrections: [{ messageRef: "u2", text: "never use MOCKS anywhere" }] });
  const good = diff({ corrections: [{ messageRef: "u2", text: "never use mocks in these tests" }] });
  const prompts: string[] = [];
  const call = { complete: async (_m: unknown, context: unknown) => { prompts.push((context as { messages: Array<{ content: string }> }).messages[0].content); return (prompts.length === 1 ? answer(bad) : answer(good)) as never; } };
  const outcome = await runNarrativeCall(input(), { call, sleep: noSleep });
  assert.equal(outcome.kind, "diff");
  assert.ok(outcome.events.some((event) => event.kind === "correction.add"));
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /<retry-note>[\s\S]*corrections\[0\]/);
  assert.equal(outcome.calls[1].rescued, 1);
  assert.deepEqual(outcome.rejected, []);
});

test("runNarrativeCall: a retried diff costs both calls; usage sums tokens, cache and the priced cost of each", async () => {
  const bad = diff({ corrections: [{ messageRef: "u2", text: "never use MOCKS anywhere" }] });
  const good = diff({ corrections: [{ messageRef: "u2", text: "never use mocks in these tests" }] });
  const priced = (input: number, cacheRead: number, total: number) => ({ input, output: 100, cacheRead, cacheWrite: 0, totalTokens: input + 100 + cacheRead, cost: { input: total / 2, output: total / 2, cacheRead: 0, cacheWrite: 0, total } });
  const call = scripted(async () => ({ ...answer(bad), usage: priced(1000, 0, 0.25) }), async () => ({ ...answer(good), usage: priced(200, 800, 0.5) }));
  const outcome = await runNarrativeCall(input(), { call, sleep: noSleep });
  assert.equal(outcome.usage.calls, 2);
  assert.equal(outcome.usage.input, 1200);
  assert.equal(outcome.usage.cacheRead, 800);
  assert.equal(outcome.usage.cost.total, 0.75);
});

test("runNarrativeCall: a fixable error that survives the retry is dropped and logged final; the rest of the diff still lands", async () => {
  const bad = diff({ corrections: [{ messageRef: "u2", text: "never use MOCKS anywhere" }] });
  const call = scripted(async () => answer(bad));
  const outcome = await runNarrativeCall(input(), { call, sleep: noSleep });
  assert.equal(outcome.kind, "diff");
  assert.deepEqual(outcome.rejected.map((r) => [r.path, r.rejection.code, r.final]), [["corrections[0]", "not-substring", true]]);
  assert.equal(outcome.calls[1].dropped, 1);
  assert.ok(outcome.events.some((event) => event.kind === "decision.add"));
});

test("runNarrativeCall: no diff twice is narrative-less with the last reason; nothing lands", async () => {
  const call = scripted(async () => textResponse("I cannot."), async () => textResponse(""));
  const outcome = await runNarrativeCall(input(), { call, sleep: noSleep });
  assert.equal(outcome.kind, "narrative-less");
  assert.equal(outcome.reason, "empty");
  assert.deepEqual(outcome.events, []);
  assert.equal(outcome.calls.length, 2);
  assert.deepEqual(outcome.missingChunks, [1]);
});

test("runNarrativeCall: a retry that does not parse keeps the earlier answer that did, minus its fixable errors; the trace says why", async () => {
  const flawed = diff({ corrections: [{ messageRef: "u2", text: "never use MOCKS anywhere" }] });
  const call = scripted(async () => answer(flawed), async () => answer("{\"narrative\": 3}"));
  const outcome = await runNarrativeCall(input(), { call, sleep: noSleep });
  assert.equal(outcome.kind, "diff");
  assert.equal(outcome.narrative, "did the thing");
  assert.deepEqual(outcome.events.map((event) => event.kind), ["decision.add", "now.set"]);
  assert.deepEqual(outcome.rejected.map((item) => [item.path, item.rejection.code, item.final]), [["corrections[0]", "not-substring", true]]);
  assert.equal(outcome.calls[1].verdict, "schema");
  assert.deepEqual(outcome.calls.map((trace) => trace.dropped), [1, 0], "the drop is counted on the answer that was used");
  assert.match(outcome.calls[1].errors.join(" "), /narrative/, "a parse failure records its detail");
});

test("runNarrativeCall: a routed transport failure falls back to the session model once and opens the breaker after the threshold", async () => {
  const models: string[] = [];
  const call = { complete: async (model: { id: string }) => { models.push(model.id); if (model.id === "routed") throw new Error("fetch failed"); return answer(diff()) as never; } };
  const health = createRouteHealth();
  const outcome = await runNarrativeCall(input({ model: modelWith({ id: "routed" }), fallbackModel: modelWith({ id: "session" }), routeHealth: health, routeConfig: { ...DEFAULT_ROUTE_HEALTH, failureThreshold: 1 }, policy: { ...DEFAULT_NARRATIVE_POLICY, transportRetry: { maxRetries: 0, baseDelayMs: 0 } } }), { call, sleep: noSleep });
  assert.equal(outcome.kind, "diff");
  assert.deepEqual(models, ["routed", "session"]);
  assert.equal(outcome.model, "example/session");
  assert.equal(outcome.routeHealth.failures, 1);
  assert.ok((outcome.routeHealth.openUntilMs ?? 0) > 0);
});

test("runNarrativeCall: an open breaker with a fallback goes straight to the session model: the route is never tried and its health is untouched", async () => {
  const models: string[] = [];
  const call = { complete: async (model: { id: string }) => { models.push(model.id); return answer(diff()) as never; } };
  const health = { ...createRouteHealth(), failures: 3, openUntilMs: Number.MAX_SAFE_INTEGER };
  const outcome = await runNarrativeCall(input({ model: modelWith({ id: "routed" }), fallbackModel: modelWith({ id: "session" }), routeHealth: health, routeAvailable: false }), { call, sleep: noSleep });
  assert.equal(outcome.kind, "diff");
  assert.deepEqual(models, ["session"], "the routed model is not attempted while the breaker is open");
  assert.equal(outcome.model, "example/session");
  assert.deepEqual(outcome.routeHealth, health, "no attempt on the route, so no success or failure to record");
});

test("runNarrativeCall: no model is narrative-less no-model without a call; an open breaker with no fallback is route-skipped", async () => {
  const call = scripted(async () => answer(diff()));
  const none = await runNarrativeCall(input({ model: undefined }), { call, sleep: noSleep });
  assert.deepEqual([none.kind, none.reason, call.calls()], ["narrative-less", "no-model", 0]);
  const skipped = await runNarrativeCall(input({ routeAvailable: false }), { call, sleep: noSleep });
  assert.deepEqual([skipped.kind, skipped.reason, call.calls()], ["narrative-less", "route-skipped", 0]);
});

test("runNarrativeCall: two chunks; the second chunk's give-up is a missing chunk, the first chunk's diff lands and the merged narrative is the first's", async () => {
  const call = scripted(async () => answer(diff({ narrative: "chunk one" })), async () => textResponse("nope"), async () => textResponse("nope"));
  const stages = { plan: () => ({ chunks: [{ index: 1, conversation: "<c1>", messageCount: 2, capped: false }, { index: 2, conversation: "<c2>", messageCount: 2, capped: false }], total: 2, truncated: false }) };
  const outcome = await runNarrativeCall(input(), { call, sleep: noSleep, stages });
  assert.equal(outcome.kind, "diff");
  assert.equal(outcome.narrative, "chunk one");
  assert.deepEqual(outcome.missingChunks, [2]);
  assert.equal(outcome.calls.length, 3);
});

test("runNarrativeCall: messages carried from a narrative-less span are shown whole in the first chunk and must be labeled; a rule among them lands", async () => {
  const span = carryUnlabeled(prepareSpan({ messagesToSummarize: messages.slice(2), turnPrefixMessages: [], index }), [{ fromRef: "u1", toRef: "u1", narrativeLess: true }], index);
  const prompts: string[] = [];
  const answers = [diff({ labels: { u2: "not a rule" } }), diff({ labels: { u1: "rule", u2: "not a rule" } })];
  const call = { complete: async (_m: unknown, context: unknown) => { prompts.push((context as { messages: Array<{ content: string }> }).messages[0].content); return answer(answers[prompts.length - 1]) as never; } };
  const outcome = await runNarrativeCall(input({ span }), { call, sleep: noSleep });
  assert.match(prompts[0], /<unsummarized-messages>[\s\S]*\[u1\] Build the state compactor and keep the ledger modules as they are[\s\S]*<\/unsummarized-messages>/);
  assert.equal(prompts.length, 2, "a carried message left unlabeled is a fixable error");
  assert.match(prompts[1], /<retry-note>[\s\S]*missing: u1/);
  assert.ok(outcome.events.some((event) => event.kind === "correction.add" && event.quote.ordinal === "u1"));
});

test("runNarrativeCall: carried messages are shown and required in the first chunk only", async () => {
  const span = carryUnlabeled(prepareSpan({ messagesToSummarize: messages.slice(2), turnPrefixMessages: [], index }), [{ fromRef: "u1", toRef: "u1", narrativeLess: true }], index);
  const prompts: string[] = [];
  const call = { complete: async (_m: unknown, context: unknown) => { prompts.push((context as { messages: Array<{ content: string }> }).messages[0].content); return answer(diff({ labels: prompts.length === 1 ? { u1: "not a rule" } : {} })) as never; } };
  const stages = { plan: () => ({ chunks: [{ index: 1, conversation: "<c1>", messageCount: 1, capped: false }, { index: 2, conversation: "<c2>", messageCount: 1, capped: false }], total: 2, truncated: false }) };
  const outcome = await runNarrativeCall(input({ span }), { call, sleep: noSleep, stages });
  assert.equal(prompts.length, 2, "neither chunk needed a retry");
  assert.doesNotMatch(prompts[1], /unsummarized-messages/);
  assert.deepEqual(outcome.missingChunks, []);
});

test("runNarrativeCall: an abort is reported, never thrown (the pass logs aborted and returns)", async () => {
  const controller = new AbortController();
  const call = { complete: async () => { controller.abort(); const error = new Error("The operation was aborted"); error.name = "AbortError"; throw error; } };
  const outcome = await runNarrativeCall(input({ signal: controller.signal }), { call, sleep: noSleep });
  assert.deepEqual([outcome.kind, outcome.reason], ["narrative-less", "aborted"]);
});

test("runNarrativeCall: a stage that throws is caught and reported as internal narrative-less (never throws)", async () => {
  const call = scripted(async () => answer(diff()));
  const outcome = await runNarrativeCall(input(), { call, sleep: noSleep, stages: { validate: () => { throw new Error("boom"); } } });
  assert.equal(outcome.kind, "narrative-less");
  assert.equal(outcome.reason, "schema");
  assert.match(outcome.calls[0]?.errors.join() ?? "", /boom/);
});

/** The session's own request: what pi last sent, which the warm request repeats byte for byte before its one instruction. */
const warmBase = () => ({
  systemPrompt: "You are a coding agent.",
  messages: [{ role: "user" as const, content: "Build the state compactor", timestamp: 1 }, { role: "user" as const, content: "never use mocks", timestamp: 2 }],
  tools: [{ name: "bash", description: "Run a shell command.", parameters: { type: "object", properties: {} } }] as never,
});

const capturing = (...answers: Array<() => Promise<unknown>>) => {
  const contexts: Array<{ systemPrompt?: string; messages: Array<{ role: string; content: unknown }>; tools?: unknown[] }> = [];
  const options: Array<Record<string, unknown>> = [];
  const inner = scripted(...answers);
  const complete = async (_model: unknown, context: unknown, opts: unknown) => {
    contexts.push(context as (typeof contexts)[number]);
    options.push(opts as Record<string, unknown>);
    return inner.complete();
  };
  return { contexts, options, complete: complete as ModelCall["complete"] };
};

test("runNarrativeCall (warm): one request = the session's own system prompt, messages and tools, then ONE instruction; no re-encoded conversation, cache kept", async () => {
  const base = warmBase();
  const call = capturing(async () => answer(diff()));
  const outcome = await runNarrativeCall(input({ warm: base }), { call, sleep: noSleep });
  assert.equal(outcome.kind, "diff");
  const [context] = call.contexts;
  assert.equal(context.systemPrompt, base.systemPrompt);
  assert.deepEqual(context.tools, base.tools);
  assert.deepEqual(context.messages.slice(0, 2), base.messages, "the session's messages come first, unchanged");
  assert.equal(context.messages.length, 3);
  const instruction = String(context.messages[2].content);
  assert.match(instruction, /<state>/);
  assert.match(instruction, /Do not call tools/);
  assert.doesNotMatch(instruction, /never use mocks in these tests, fakes only\n.*assistant/i, "the conversation is not re-encoded into the instruction");
  assert.notEqual(call.options[0].cacheRetention, "none", "the warm request keeps the prefix cache");
  assert.equal(outcome.calls[0].warm, true);
});

test("runNarrativeCall (warm): a base that does not fit the summarizer's window falls back to the re-encoded transcript", async () => {
  const huge = { ...warmBase(), messages: [{ role: "user" as const, content: "x".repeat(500_000), timestamp: 1 }] };
  const call = capturing(async () => answer(diff()));
  const outcome = await runNarrativeCall(input({ warm: huge }), { call, sleep: noSleep });
  assert.equal(outcome.kind, "diff");
  assert.equal(call.contexts[0].messages.length, 1, "the single re-encoded prompt");
  assert.equal(call.contexts[0].systemPrompt, "");
  assert.equal(outcome.calls[0].warm, undefined);
});

test("runNarrativeCall (warm): an answer that calls a tool instead is a failed attempt, retried", async () => {
  const toolCall = async () => ({ ...textResponse(""), content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } }], stopReason: "toolUse" });
  const call = capturing(toolCall, async () => answer(diff()));
  const outcome = await runNarrativeCall(input({ warm: warmBase() }), { call, sleep: noSleep });
  assert.equal(outcome.kind, "diff");
  assert.equal(call.contexts.length, 2);
  assert.equal(outcome.calls[0].verdict, "empty");
});

test("runNarrativeCall (warm, security.md T7): a warm request the server rejects as a context overflow falls back to the re-encoded call", async () => {
  const overflow = async () => ({ ...textResponse(""), stopReason: "error", errorMessage: "This model's maximum context length is 131072 tokens. However, you requested 140000 tokens" });
  const call = capturing(overflow, async () => answer(diff()));
  const outcome = await runNarrativeCall(input({ warm: warmBase() }), { call, sleep: noSleep });
  assert.equal(outcome.kind, "diff");
  assert.equal(call.contexts.length, 2, "one warm attempt, then the cold call; never the same warm request again");
  assert.equal(call.contexts[1].systemPrompt, "");
  assert.equal(outcome.calls.at(-1)?.warm, undefined);
});

test("runNarrativeCall (warm, security.md T2): an answer with a valid diff AND a tool call is still a failed attempt", async () => {
  const mixed = async () => ({ ...(answer(diff()) as object), content: [...(answer(diff()) as { content: unknown[] }).content, { type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } }], stopReason: "toolUse" });
  const call = capturing(mixed, async () => answer(diff()));
  const outcome = await runNarrativeCall(input({ warm: warmBase() }), { call, sleep: noSleep });
  assert.equal(call.contexts.length, 2);
  assert.equal(outcome.calls[0].verdict, "empty");
  assert.equal(outcome.kind, "diff");
});

test("runNarrativeCall: the chunk plan reserves the output budget the call will ask for, the larger one for a model that cannot turn reasoning off", async () => {
  const budgets: number[] = [];
  const stages = { plan: (args: { outputBudget: number }) => { budgets.push(args.outputBudget); return { chunks: [{ index: 1, conversation: "<c1>", messageCount: 2, capped: false }], total: 1, truncated: false }; } };
  const call = { complete: async () => answer(diff()) };
  await runNarrativeCall(input(), { call, sleep: noSleep, stages: stages as never });
  await runNarrativeCall(input({ model: modelWith({ maxTokens: 64_000, thinkingLevelMap: { off: null } }) }), { call, sleep: noSleep, stages: stages as never });
  assert.deepEqual(budgets, [DEFAULT_NARRATIVE_POLICY.outputTokens, LOWEST_REASONING_OUTPUT_TOKENS]);
});

test("runNarrativeCall: an answer cut off at the output limit is retried with more room, never the same budget (hidden thinking)", async () => {
  const asked: number[] = [];
  const cutOff = async () => ({ ...textResponse(""), stopReason: "length" });
  const answers = [cutOff, async () => answer(diff())];
  const call = { complete: async (_model: unknown, _context: unknown, options: { maxTokens: number }) => { asked.push(options.maxTokens); return (await answers[asked.length - 1]()) as never; } };
  const outcome = await runNarrativeCall(input(), { call: call as unknown as ModelCall, sleep: noSleep });
  assert.equal(outcome.kind, "diff");
  assert.deepEqual(asked, [DEFAULT_NARRATIVE_POLICY.outputTokens, LOWEST_REASONING_OUTPUT_TOKENS]);
  assert.equal(outcome.calls[1].maxTokens, LOWEST_REASONING_OUTPUT_TOKENS, "the trace says the budget was raised");
  assert.equal(outcome.calls[0].maxTokens, undefined, "a first call at the planned budget records nothing new");
});

test("runNarrativeCall: the raised budget doubles past the reasoning floor and never exceeds the model's own limit", async () => {
  for (const [name, model, wanted] of [
    ["a model that must reason starts at the floor, so the retry doubles it", modelWith({ contextWindow: 131072, maxTokens: 64_000, thinkingLevelMap: { off: null } }), [LOWEST_REASONING_OUTPUT_TOKENS, 2 * LOWEST_REASONING_OUTPUT_TOKENS]],
    ["a model whose limit is below the floor gets its limit", modelWith({ contextWindow: 131072, maxTokens: 5000 }), [DEFAULT_NARRATIVE_POLICY.outputTokens, 5000]],
    ["a model already asked for its whole limit is retried at that limit", modelWith({ contextWindow: 131072, maxTokens: DEFAULT_NARRATIVE_POLICY.outputTokens }), [DEFAULT_NARRATIVE_POLICY.outputTokens, DEFAULT_NARRATIVE_POLICY.outputTokens]],
  ] as const) {
    const asked: number[] = [];
    const call = { complete: async (_model: unknown, _context: unknown, options: { maxTokens: number }) => { asked.push(options.maxTokens); return (asked.length === 1 ? { ...textResponse(""), stopReason: "length" } : answer(diff())) as never; } };
    await runNarrativeCall(input({ model }), { call: call as unknown as ModelCall, sleep: noSleep });
    assert.deepEqual(asked, wanted, name);
  }
});

test("runNarrativeCall: a lift-replaced question first raised on the last call gets one more call to answer it", async () => {
  const tabEntries = chain([
    userEntry("t1", "Use tabs for indentation in every TypeScript file in this project."),
    assistantEntry("b1", "ok"),
    userEntry("t2", "The tab rule doesn't apply to the JSON files or package.json; keep tabs in the TypeScript files."),
    assistantEntry("b2", "ok"),
    userEntry("t3", "Switch the TypeScript files to two-space indentation instead of tabs from here on, and convert the existing files."),
    assistantEntry("b3", "ok"),
  ]);
  const tabIndex = buildMessageIndex(tabEntries, { commandIds: new Set(["C1"]), errorIds: new Set() });
  const tabMessages = tabEntries.map((entry) => (entry as unknown as { message: never }).message);
  const labelled = (u3: string) => diff({ labels: { u1: "rule", u2: "rule and lifts u1", u3 } });
  // The first answer breaks the schema, so the one regular retry is the last call when u3 aims at the replaced rule.
  const call = scripted(async () => answer(JSON.stringify({ narrative: "x" })), async () => answer(labelled("rule and lifts u1")), async () => answer(labelled("rule and lifts u2")));
  const outcome = await runNarrativeCall(input({ span: prepareSpan({ messagesToSummarize: tabMessages, turnPrefixMessages: [], index: tabIndex }), verify: { ...input().verify, resolver: tabIndex } }), { call, sleep: noSleep });
  assert.equal(outcome.kind, "diff");
  assert.equal(call.calls(), 3, "one more call, for the question only");
  assert.deepEqual(outcome.rejected, []);
  const lifts = outcome.events.flatMap((event) => (event.kind === "correction.lift" ? [`${event.target} by ${event.by.ordinal}`] : []));
  assert.deepEqual(lifts, ["R1 by u2", "R2 by u3"], "the narrowing is lifted by the rule that replaced it");
});

test("runNarrativeCall: the extra call is for a new lift-replaced question only; other errors on the last call are dropped", async () => {
  const bad = diff({ corrections: [{ messageRef: "u2", text: "never use MOCKS anywhere" }] });
  const call = scripted(async () => answer(JSON.stringify({ narrative: "x" })), async () => answer(bad), async () => answer(diff()));
  const outcome = await runNarrativeCall(input(), { call, sleep: noSleep });
  assert.equal(call.calls(), 2);
  assert.deepEqual(outcome.rejected.map((r) => [r.path, r.rejection.code, r.final]), [["corrections[0]", "not-substring", true]]);
});

const swapEntries = chain([
  userEntry("s1", "Use tabs for indentation in every TypeScript file in this project."),
  assistantEntry("c1", "ok"),
  userEntry("s2", "Switch the TypeScript files to two-space indentation instead of tabs from here on."),
  assistantEntry("c2", "ok"),
]);
const swapIndex = buildMessageIndex(swapEntries, { commandIds: new Set(["C1"]), errorIds: new Set() });
const swapInput = () => input({ span: prepareSpan({ messagesToSummarize: swapEntries.map((entry) => (entry as unknown as { message: never }).message), turnPrefixMessages: [], index: swapIndex }), verify: { ...input().verify, resolver: swapIndex } });
const swapDiff = (u2: string, overrides: Record<string, unknown> = {}) => diff({ labels: { u1: "rule", u2 }, ...overrides });
const liftsOf = (events: readonly StateEvent[]) => events.flatMap((event) => (event.kind === "correction.lift" ? [`${event.target} by ${event.by.ordinal}`] : []));

const reaskOf = (u2: unknown) => answer(JSON.stringify({ u2 }));
const capture = (answers: unknown[]) => {
  const prompts: string[] = [];
  const call = { complete: async (_model: unknown, context: { messages: Array<{ content: unknown }> }) => { prompts.push(JSON.stringify(context.messages)); return answers[prompts.length - 1] as never; } };
  return { prompts, call: call as unknown as ModelCall };
};
const correctionsOf = (events: readonly StateEvent[]) => events.flatMap((event) => (event.kind === "correction.add" ? [event.quote.text] : []));

test("runNarrativeCall: a rule label that may replace an earlier rule is asked about once, after the answer; a yes lands the lift", async () => {
  const { prompts, call } = capture([answer(swapDiff("rule")), reaskOf("rule and lifts u1")]);
  const outcome = await runNarrativeCall(swapInput(), { call, sleep: noSleep });
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /may replace the rule u1 gave/);
  assert.match(prompts[1], /quoted or pasted text does not withdraw a rule/i, "the burden is on lifting");
  assert.deepEqual(liftsOf(outcome.events), ["R1 by u2"]);
  assert.equal(outcome.calls[1].reask, "answered");
  assert.deepEqual(outcome.rejected, []);
});

test("runNarrativeCall: a question is asked whole or not at all; one that does not fit the note cap is not asked", async () => {
  const { prompts, call } = capture([answer(swapDiff("rule")), reaskOf("rule and lifts u1")]);
  const outcome = await runNarrativeCall({ ...swapInput(), policy: { ...swapInput().policy, retryNoteChars: 120 } }, { call, sleep: noSleep });
  assert.equal(prompts.length, 1, "no cut question: its rule and both answers are shown or none is");
  assert.deepEqual(liftsOf(outcome.events), []);
});

test("runNarrativeCall: a full answer given in reply to the question is read for the asked label only", async () => {
  const { call } = capture([answer(swapDiff("rule")), answer(swapDiff("rule and lifts u1", { narrative: "a rewritten narrative" }))]);
  const outcome = await runNarrativeCall(swapInput(), { call, sleep: noSleep });
  assert.deepEqual(liftsOf(outcome.events), ["R1 by u2"]);
  assert.equal(outcome.calls[1].reask, "answered");
  assert.equal(outcome.kind === "diff" ? outcome.narrative : undefined, "did the thing", "the rest of the reply is ignored");
});

test("runNarrativeCall: a full answer that changes a label it was not asked about changes nothing", async () => {
  const { call } = capture([answer(swapDiff("rule")), answer(diff({ labels: { u1: "not a rule", u2: "rule and lifts u1" } }))]);
  const outcome = await runNarrativeCall(swapInput(), { call, sleep: noSleep });
  assert.deepEqual(liftsOf(outcome.events), ["R1 by u2"], "only the asked label is read; u1 keeps its kept label");
  assert.equal(correctionsOf(outcome.events).length, 2);
});

test("runNarrativeCall: a reply's prototype-named keys are not read as answers", async () => {
  for (const reply of ['{"__proto__": {"u2": "rule and lifts u1"}}', '{"labels": {"__proto__": {"u2": "rule and lifts u1"}}}', '{"constructor": "rule and lifts u1", "hasOwnProperty": "x"}']) {
    const { call } = capture([answer(swapDiff("rule")), answer(reply)]);
    const outcome = await runNarrativeCall(swapInput(), { call, sleep: noSleep });
    assert.deepEqual(liftsOf(outcome.events), [], reply);
    assert.equal(outcome.calls[1].reask, "unreadable", reply);
  }
});

test("runNarrativeCall: keeping \"rule\" answers the question; both rules stand", async () => {
  const { prompts, call } = capture([answer(swapDiff("rule")), reaskOf("rule")]);
  const outcome = await runNarrativeCall(swapInput(), { call, sleep: noSleep });
  assert.equal(prompts.length, 2);
  assert.deepEqual(liftsOf(outcome.events), []);
  assert.equal(correctionsOf(outcome.events).length, 2);
});

test("runNarrativeCall: a question waits for the chunk's final answer and never rides a retry note", async () => {
  const bad = swapDiff("rule", { corrections: [{ messageRef: "u2", text: "never use MOCKS anywhere" }] });
  const { prompts, call } = capture([answer(bad), answer(swapDiff("rule")), reaskOf("rule and lifts u1")]);
  const outcome = await runNarrativeCall(swapInput(), { call, sleep: noSleep });
  assert.equal(prompts.length, 3);
  assert.doesNotMatch(prompts[1], /may replace/);
  assert.deepEqual(liftsOf(outcome.events), ["R1 by u2"]);
});

test("runNarrativeCall: a question on an answer kept after an unreadable retry is still asked", async () => {
  const { prompts, call } = capture([answer("no json here"), answer(swapDiff("rule")), reaskOf("rule and lifts u1")]);
  const outcome = await runNarrativeCall(swapInput(), { call, sleep: noSleep });
  assert.equal(prompts.length, 3);
  assert.deepEqual(liftsOf(outcome.events), ["R1 by u2"]);
});

test("runNarrativeCall: an unreadable answer to the question keeps the answer as it was", async () => {
  const { call } = capture([answer(swapDiff("rule")), answer("still not json")]);
  const outcome = await runNarrativeCall(swapInput(), { call, sleep: noSleep });
  assert.deepEqual(liftsOf(outcome.events), []);
  assert.equal(correctionsOf(outcome.events).length, 2);
  assert.equal(outcome.calls[1].reask, "unreadable");
});

test("runNarrativeCall: no question after a call that threw; the kept answer stands", async () => {
  const bad = swapDiff("rule", { corrections: [{ messageRef: "u2", text: "never use MOCKS anywhere" }] });
  const call = scripted(async () => answer(bad), async () => { throw new Error("connection reset"); }, async () => reaskOf("rule and lifts u1"));
  const outcome = await runNarrativeCall(swapInput(), { call, sleep: noSleep });
  assert.equal(call.calls(), 2, "the route that just failed is not asked again");
  assert.deepEqual(liftsOf(outcome.events), []);
  assert.equal(correctionsOf(outcome.events).length, 2);
});

for (const [name, reply] of [
  ["dropping the rule", "none"],
  ["a lift without the rule", "lifts u1"],
  ["a target that was not asked about", "rule and lifts u1, u9"],
  ["new words for the rule", { rule: "two spaces" }],
] as const) {
  test(`runNarrativeCall: an answer to the question that is not one of its two answers changes nothing (${name})`, async () => {
    const { call } = capture([answer(swapDiff("rule")), reaskOf(reply)]);
    const outcome = await runNarrativeCall(swapInput(), { call, sleep: noSleep });
    assert.deepEqual(liftsOf(outcome.events), [], name);
    assert.equal(correctionsOf(outcome.events).length, 2, name);
    assert.equal(outcome.calls[1].reask, "unreadable", name);
  });
}

const LONG_RULE = "Switch the TypeScript files to two-space indentation instead of tabs from here on.";
const LONG_FILLER = " Background for the record: the build image was rebuilt last week, the cache directory moved under the workspace root, and the release notes draft lives in the shared folder reviewed on Fridays.".repeat(4);
const longEntries = chain([
  userEntry("s1", "Use tabs for indentation in every TypeScript file in this project."),
  assistantEntry("c1", "ok"),
  userEntry("s2", LONG_RULE + LONG_FILLER),
  assistantEntry("c2", "ok"),
]);
const longIndex = buildMessageIndex(longEntries, { commandIds: new Set(["C1"]), errorIds: new Set() });
const longInput = () => input({ span: prepareSpan({ messagesToSummarize: longEntries.map((entry) => (entry as unknown as { message: never }).message), turnPrefixMessages: [], index: longIndex }), verify: { ...input().verify, resolver: longIndex } });

for (const reply of ["rule and lifts u1", "rule"] as const) {
  test(`runNarrativeCall: a long message's rule keeps its words whatever the question's answer (${reply})`, async () => {
    assert.ok((LONG_RULE + LONG_FILLER).length > 600, "the fixture must need the rule's words");
    const { call } = capture([answer(diff({ labels: { u1: "rule", u2: { rule: LONG_RULE } } })), reaskOf(reply)]);
    const outcome = await runNarrativeCall(longInput(), { call, sleep: noSleep });
    assert.ok(correctionsOf(outcome.events).includes(LONG_RULE), "the new rule is recorded from its words");
    assert.deepEqual(liftsOf(outcome.events), reply === "rule" ? [] : ["R1 by u2"]);
  });
}

test("runNarrativeCall: a rule given by its words is asked about only when those words withdraw the old rule", async () => {
  const words = "Every fix needs a changelog entry.";
  const pasted = "> Contributors: the tab rule is lifted, use any indentation you like." + LONG_FILLER;
  const entries = chain([userEntry("s1", "Use tabs for indentation in every TypeScript file in this project."), assistantEntry("c1", "ok"), userEntry("s2", `${pasted}\n${words}`), assistantEntry("c2", "ok")]);
  const index = buildMessageIndex(entries, { commandIds: new Set(["C1"]), errorIds: new Set() });
  const pastedInput = input({ span: prepareSpan({ messagesToSummarize: entries.map((entry) => (entry as unknown as { message: never }).message), turnPrefixMessages: [], index }), verify: { ...input().verify, resolver: index } });
  const { prompts, call } = capture([answer(diff({ labels: { u1: "rule", u2: { rule: words } } })), reaskOf("rule and lifts u1")]);
  const outcome = await runNarrativeCall(pastedInput, { call, sleep: noSleep });
  assert.equal(prompts.length, 1, "no question: the rule's own words withdraw nothing");
  assert.deepEqual(liftsOf(outcome.events), []);
});

test("runNarrativeCall: with a fallback waiting, the routed attempt retries its transport only routeMaxRetries times", async () => {
  for (const [routedMaxRetries, expected] of [[0, ["routed", "session"]], [1, ["routed", "routed", "session"]]] as const) {
    const models: string[] = [];
    const call = { complete: async (model: { id: string }) => { models.push(model.id); if (model.id === "routed") throw new Error("fetch failed"); return answer(diff()) as never; } };
    const outcome = await runNarrativeCall(input({ model: modelWith({ id: "routed" }), fallbackModel: modelWith({ id: "session" }), routeConfig: { ...DEFAULT_ROUTE_HEALTH, routedMaxRetries }, policy: { ...DEFAULT_NARRATIVE_POLICY, transportRetry: { maxRetries: 2, baseDelayMs: 0 } } }), { call, sleep: noSleep });
    assert.equal(outcome.kind, "diff");
    assert.deepEqual(models, expected, `routedMaxRetries ${routedMaxRetries}`);
  }
});

test("runNarrativeCall: with no fallback, the routed model keeps the shared transport retries", async () => {
  const models: string[] = [];
  let failures = 2;
  const call = { complete: async (model: { id: string }) => { models.push(model.id); if (failures-- > 0) throw new Error("fetch failed"); return answer(diff()) as never; } };
  const outcome = await runNarrativeCall(input({ model: modelWith({ id: "routed" }), routeConfig: { ...DEFAULT_ROUTE_HEALTH, routedMaxRetries: 0 }, policy: { ...DEFAULT_NARRATIVE_POLICY, transportRetry: { maxRetries: 2, baseDelayMs: 0 } } }), { call, sleep: noSleep });
  assert.equal(outcome.kind, "diff");
  assert.deepEqual(models, ["routed", "routed", "routed"]);
});
