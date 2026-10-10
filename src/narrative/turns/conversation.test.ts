import test from "node:test";
import assert from "node:assert/strict";

import type { AssistantMessage, Context } from "@earendil-works/pi-ai";

import { assistantMsg, modelWith, textResponse, USAGE } from "../../test-support.ts";
import { DEFAULT_TRANSPORT_RETRY_POLICY } from "../transport-retry.ts";
import { ANSWER_NOW, runTurn, SHOW_TOOL, type TurnInput } from "./conversation.ts";

const showCall = (ref: string, id = `call-${ref}`) => assistantMsg({ content: [{ type: "toolCall", id, name: "show", arguments: { ref } }], stopReason: "toolUse" });

function scripted(...answers: AssistantMessage[]) {
  const contexts: Context[] = [];
  const options: Array<Record<string, unknown>> = [];
  return { contexts, options, complete: async (_model: unknown, context: Context, opts: Record<string, unknown>) => { contexts.push(structuredClone(context)); options.push(opts); return answers[Math.min(contexts.length - 1, answers.length - 1)]; } };
}

function input(overrides: Partial<TurnInput> = {}): TurnInput {
  let clock = 1_000;
  return { model: modelWith(), messages: [], text: "digest + section 1", show: (ref) => (ref === "T1" ? "full output of T1" : undefined), showCap: 2, outputTokens: 800, deadline: 121_000, chunk: 1, attempt: 1, transportRetry: { ...DEFAULT_TRANSPORT_RETRY_POLICY, maxRetries: 0 }, sleep: async () => {}, now: () => (clock += 10), ...overrides };
}

test("runTurn: one answer without a tool call ends the turn; the conversation grows by the user text and the answer", async () => {
  const call = scripted(textResponse('{"narrative": "x"}'));
  const turn = await runTurn(input(), call);
  assert.equal(turn.text, '{"narrative": "x"}');
  assert.deepEqual(turn.messages.map((message) => message.role), ["user", "assistant"]);
  assert.equal(turn.traces.length, 1);
  assert.equal(call.contexts[0].tools?.[0].name, SHOW_TOOL.name);
  assert.equal(call.options[0].reasoning, "off");
  assert.equal(call.options[0].maxTokens, 800);
});

test("runTurn: show(ref) answers from the digest and the model answers after it, in the same turn", async () => {
  const call = scripted(showCall("T1"), textResponse('{"narrative": "y"}'));
  const turn = await runTurn(input(), call);
  assert.equal(turn.text, '{"narrative": "y"}');
  assert.equal(turn.shows, 1);
  const result = call.contexts[1].messages.at(-1) as { role: string; content: Array<{ text: string }>; isError: boolean };
  assert.equal(result.role, "toolResult");
  assert.equal(result.content[0].text, "full output of T1");
  assert.equal(result.isError, false);
});

test("runTurn: an unknown ref is an error result, and past the cap show says answer now; a model that never stops calling ends the turn", async () => {
  const call = scripted(showCall("T9"), showCall("T1", "a"), showCall("T1", "b"), showCall("T1", "c"));
  const turn = await runTurn(input({ showCap: 1 }), call);
  assert.equal(turn.failure, "show-loop");
  assert.equal(call.contexts.length, 3, "showCap + 2 requests at most");
  const results = turn.messages.filter((message) => message.role === "toolResult") as Array<{ content: Array<{ text: string }> }>;
  assert.match(results[0].content[0].text, /T9 is not an id/);
  assert.match(results[2].content[0].text, /show limit for this turn \(1\) is reached/);
});

test("runTurn: the deadline bounds each request's timeout and ends the turn once passed", async () => {
  const call = scripted(textResponse("{}"));
  await runTurn(input({ deadline: 5_000 }), call);
  assert.ok((call.options[0].timeoutMs as number) <= 4_000);
  const late = await runTurn(input({ deadline: 0 }), scripted(textResponse("{}")));
  assert.equal(late.failure, "deadline");
  assert.equal(late.traces.length, 0);
});

test("runTurn: reasoning tokens in usage are recorded on the trace, so a reasoning-off breach is visible", async () => {
  const call = scripted(textResponse("{}", { usage: { ...USAGE, reasoning: 321 } }));
  const turn = await runTurn(input(), call);
  assert.equal(turn.traces[0].usage?.reasoning, 321);
});

test("runTurn: a transport failure ends the turn with the error, not an exception", async () => {
  const failing = { complete: async () => { throw new Error("ECONNRESET socket hang up"); } };
  const turn = await runTurn(input(), failing);
  assert.equal(turn.failure, "transport");
  assert.match(turn.error!, /ECONNRESET/);
});

test("runTurn: a request that dies at the deadline is a deadline failure, not an abort of the pass; only the pass signal aborts", async () => {
  let clock = 1_000;
  const timingOut = { complete: async () => { clock = 200_000; const error = new Error("Request was aborted"); error.name = "AbortError"; throw error; } };
  const turn = await runTurn(input({ now: () => clock, deadline: 121_000 }), timingOut);
  assert.equal(turn.failure, "deadline");
  const controller = new AbortController();
  controller.abort();
  const aborting = { complete: async () => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); } };
  await assert.rejects(runTurn(input({ signal: controller.signal }), aborting));
});

test("runTurn: a retry never starts after the turn's deadline", async () => {
  let clock = 1_000;
  let attempts = 0;
  const flaky = { complete: async () => { attempts++; clock = 130_000; throw new Error("502 Bad Gateway"); } };
  const turn = await runTurn(input({ now: () => clock, deadline: 121_000, transportRetry: { maxRetries: 2, baseDelayMs: 1 } }), flaky);
  assert.equal(attempts, 1);
  assert.equal(turn.failure, "deadline");
});

test("runTurn: once the show cap is reached, code tells the model as the user to answer now", async () => {
  const call = scripted(showCall("T1"), textResponse('{"narrative": "z"}'));
  const turn = await runTurn(input({ showCap: 1 }), call);
  assert.equal(turn.text, '{"narrative": "z"}');
  const sent = call.contexts[1].messages;
  assert.equal((sent.at(-1) as { content: string }).content, ANSWER_NOW);
  assert.equal(call.contexts[1].tools, undefined, "past the cap a model kept calling show: the request offers no tool at all");
  assert.deepEqual(call.options.map((options) => options.toolChoice), [undefined, undefined], "tool_choice none makes some servers drop a call the model insists on and return no answer at all");
});

test("runTurn: the request before the last is told to answer now, even when no show ever succeeded", async () => {
  const call = scripted(showCall("T9"), showCall("T8", "a"), textResponse('{"now": {}}'));
  const turn = await runTurn(input({ showCap: 1 }), call);
  assert.equal(turn.failure, undefined);
  assert.equal((call.contexts[2].messages.at(-1) as { content: string }).content, ANSWER_NOW);
  assert.ok(call.options.every((options) => options.toolChoice === undefined));
});

test("runTurn: the last request a turn may make carries no tools, with the show exchanges as plain text, so the model can only answer", async () => {
  const call = scripted(showCall("T1"), showCall("T1", "b"), textResponse('{"now": {}}'));
  const turn = await runTurn(input({ showCap: 1 }), call);
  assert.equal(turn.failure, undefined);
  assert.equal(turn.text, '{"now": {}}');
  const last = call.contexts[2];
  assert.equal(last.tools, undefined, "no tool to call: tool_choice none would make some servers drop the call instead");
  assert.ok(last.messages.every((message) => message.role !== "toolResult" && !(message.role === "assistant" && message.content.some((block) => block.type === "toolCall"))), "tool history without tools is rejected by the server");
  const texts = last.messages.map((message) => (typeof message.content === "string" ? message.content : message.content.map((block) => ("text" in block ? block.text : "")).join("")));
  assert.ok(texts.some((text) => text.includes("show(T1)")), "the call the model made is kept as text");
  assert.ok(texts.some((text) => text.includes("full output of T1")), "what show returned is kept as text");
  assert.equal(texts.at(-1), ANSWER_NOW);
  assert.ok(turn.messages.some((message) => message.role === "toolResult"), "the conversation the next section continues keeps its tool form, so its prefix is unchanged");
});
