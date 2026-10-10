import test from "node:test";
import assert from "node:assert/strict";

import { assistantMsg, modelWith, textResponse } from "../test-support.ts";
import { callNarrativeModel, decideNextStep, registryCall } from "./call.ts";
import { DEFAULT_NARRATIVE_POLICY } from "./policy.ts";
import { LOWEST_REASONING_OUTPUT_TOKENS } from "./reasoning.ts";

const diffText = JSON.stringify({ narrative: "n", corrections: [], lifts: [], decisions: [], deadEnds: [], now: { inProgress: [], next: [], blocked: [], resume: "r" } });
const noSleep = async () => {};

test("callNarrativeModel: one request with the summarizer's options; the trace carries usage, stop reason and the parse verdict", async () => {
  const seen: Array<Record<string, unknown>> = [];
  const call = { complete: async (_m: unknown, context: { messages: unknown[] }, options: Record<string, unknown>) => { seen.push({ ...options, messages: context.messages.length }); return textResponse("```json\n" + diffText + "\n```", { usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } as never }); } };
  const result = await callNarrativeModel({ model: modelWith({ maxTokens: 8000 }), prompt: "P", chunk: 1, attempt: 1, policy: DEFAULT_NARRATIVE_POLICY, sleep: noSleep }, call);
  assert.ok("parsed" in result && result.parsed.ok);
  assert.equal(result.trace.verdict, "diff");
  assert.deepEqual(result.trace.usage, { input: 100, output: 50, reasoning: 0 });
  assert.equal(result.trace.stopReason, "stop");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].reasoning, "off");
  assert.equal(seen[0].maxTokens, DEFAULT_NARRATIVE_POLICY.outputTokens);
  assert.equal(seen[0].cacheRetention, "none");
  assert.equal(seen[0].timeoutMs, DEFAULT_NARRATIVE_POLICY.timeoutMs);
  assert.equal(seen[0].messages, 1);
});

test("callNarrativeModel: a transport error is retried by the transport policy, then surfaces as thrown in the trace (never thrown to the caller)", async () => {
  let calls = 0;
  const call = { complete: async () => { calls++; throw new Error("fetch failed: ECONNRESET"); } };
  const result = await callNarrativeModel({ model: modelWith(), prompt: "P", chunk: 1, attempt: 1, policy: DEFAULT_NARRATIVE_POLICY, sleep: noSleep }, call);
  assert.ok("thrown" in result);
  assert.equal(calls, 1 + DEFAULT_NARRATIVE_POLICY.transportRetry.maxRetries);
  assert.equal(result.trace.retries, DEFAULT_NARRATIVE_POLICY.transportRetry.maxRetries);
  assert.match(result.trace.errors.join(), /ECONNRESET/);
});

test("callNarrativeModel: an abort rethrows so the pass can log aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  const call = { complete: async () => { const error = new Error("aborted"); error.name = "AbortError"; throw error; } };
  await assert.rejects(callNarrativeModel({ model: modelWith(), prompt: "P", chunk: 1, attempt: 1, policy: DEFAULT_NARRATIVE_POLICY, signal: controller.signal, sleep: noSleep }, call), /abort/i);
});

test("callNarrativeModel: a model answer with a length stop and half an object is truncated in the trace", async () => {
  const call = { complete: async () => assistantMsg({ content: [{ type: "text", text: "```json\n{\"narrative\": \"cut" }], stopReason: "length" }) };
  const result = await callNarrativeModel({ model: modelWith(), prompt: "P", chunk: 1, attempt: 1, policy: DEFAULT_NARRATIVE_POLICY, sleep: noSleep }, call);
  assert.ok("parsed" in result && !result.parsed.ok && result.parsed.reason === "truncated");
  assert.equal(result.trace.verdict, "truncated");
});

test("decideNextStep: the ladder (table)", () => {
  const ok = { ok: true as const, diff: JSON.parse(diffText), prose: "" };
  const fixable = [{ path: "corrections[0]", rejection: { code: "empty" as const }, fixable: true }];
  const unfixable = [{ path: "corrections[0]", rejection: { code: "near-duplicate" as const, earlierId: "R1", overlap: 0.9 }, fixable: false }];
  const cases: Array<[string, Parameters<typeof decideNextStep>[0], ReturnType<typeof decideNextStep>["step"]]> = [
    ["a clean diff is accepted", { parsed: ok, fieldErrors: [], attempt: 1, policy: DEFAULT_NARRATIVE_POLICY, noteChars: 1500 }, "accept"],
    ["fixable errors on attempt 1 retry with a note", { parsed: ok, fieldErrors: fixable, attempt: 1, policy: DEFAULT_NARRATIVE_POLICY, noteChars: 1500 }, "retry-with-note"],
    ["fixable errors on the last attempt are accepted as they are (survivors land, the rest is dropped)", { parsed: ok, fieldErrors: fixable, attempt: 2, policy: DEFAULT_NARRATIVE_POLICY, noteChars: 1500 }, "accept"],
    ["only unfixable errors are accepted at once", { parsed: ok, fieldErrors: unfixable, attempt: 1, policy: DEFAULT_NARRATIVE_POLICY, noteChars: 1500 }, "accept"],
    ["no diff on attempt 1 retries the same prompt", { parsed: { ok: false, reason: "invalid-json", detail: "x" }, fieldErrors: [], attempt: 1, policy: DEFAULT_NARRATIVE_POLICY, noteChars: 1500 }, "retry-same"],
    ["a schema failure on attempt 1 retries with the field errors as the note", { parsed: { ok: false, reason: "schema", detail: "/narrative: expected string" }, fieldErrors: [], attempt: 1, policy: DEFAULT_NARRATIVE_POLICY, noteChars: 1500 }, "retry-with-note"],
    ["no diff on the last attempt gives up", { parsed: { ok: false, reason: "empty", detail: "x" }, fieldErrors: [], attempt: 2, policy: DEFAULT_NARRATIVE_POLICY, noteChars: 1500 }, "give-up"],
    ["fixableRetries 0 accepts survivors on attempt 1", { parsed: ok, fieldErrors: fixable, attempt: 1, policy: { ...DEFAULT_NARRATIVE_POLICY, fixableRetries: 0 }, noteChars: 1500 }, "accept"],
  ];
  for (const [name, input, step] of cases) assert.equal(decideNextStep(input).step, step, name);
  const noted = decideNextStep(cases[1][1]);
  assert.ok(noted.step === "retry-with-note" && /corrections\[0\]/.test(noted.note));
});

test("registryCall: a request that asks for reasoning goes through streamSimple; every reasoning-off request keeps complete", async () => {
  const used: string[] = [];
  const answer = textResponse("{}");
  const registry = {
    complete: async (_m: unknown, _c: unknown, o: Record<string, unknown>) => (used.push(`complete ${JSON.stringify(o.headers)}`), answer),
    streamSimple: (_m: unknown, _c: unknown, o: Record<string, unknown>) => ({ result: async () => (used.push(`streamSimple ${JSON.stringify(o.headers)}`), answer) }),
  };
  const call = registryCall(registry, (options) => ({ ...options, headers: { wrapped: "1" } }));
  await call.complete(modelWith({}), { messages: [] }, { reasoning: "off" });
  await call.complete(modelWith({}), { messages: [] }, {});
  await call.complete(modelWith({}), { messages: [] }, { reasoning: "low" });
  assert.deepEqual(used, ['complete {"wrapped":"1"}', 'complete {"wrapped":"1"}', 'streamSimple {"wrapped":"1"}'], "both paths carry the wrapped options (the affinity key)");
});

test("callNarrativeModel: a model that cannot turn reasoning off is asked for its lowest level with the larger budget, and the trace says which level", async () => {
  const seen: Array<Record<string, unknown>> = [];
  const call = { complete: async (_m: unknown, _c: unknown, options: Record<string, unknown>) => { seen.push(options); return textResponse("```json\n" + diffText + "\n```"); } };
  const mustReason = modelWith({ maxTokens: 64_000, thinkingLevelMap: { off: null } });
  const result = await callNarrativeModel({ model: mustReason, prompt: "P", chunk: 1, attempt: 1, policy: DEFAULT_NARRATIVE_POLICY, sleep: noSleep }, call);
  assert.equal(seen[0].reasoning, "minimal");
  assert.equal(seen[0].maxTokens, LOWEST_REASONING_OUTPUT_TOKENS);
  assert.equal(result.trace.reasoning, "minimal");
  const offable = await callNarrativeModel({ model: modelWith(), prompt: "P", chunk: 1, attempt: 1, policy: DEFAULT_NARRATIVE_POLICY, sleep: noSleep }, call);
  assert.equal(offable.trace.reasoning, undefined, "the common path adds nothing to the trace");
});
