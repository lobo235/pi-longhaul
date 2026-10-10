/**
 * The kept-window thinking strip (kept-window.ts): which assistant messages lose their thinking blocks after a
 * compaction, on which APIs, and the active tool turn it never touches.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";

import { stripKeptWindowContext, stripKeptWindowThinking } from "./kept-window.ts";
import { assistantMsg, modelWith } from "./test-support.ts";

function thinkingAssistant(timestamp: number, thinking: string, text = "answer"): AgentMessage {
  return assistantMsg({ timestamp, content: [{ type: "thinking", thinking, thinkingSignature: "reasoning_content" }, { type: "text", text }] } as Partial<AssistantMessage>);
}
const user = (text: string, timestamp = 1): AgentMessage => ({ role: "user", content: text, timestamp }) as AgentMessage;
const toolResult = (toolCallId: string, timestamp = 1): AgentMessage => ({ role: "toolResult", toolCallId, toolName: "bash", content: [{ type: "text", text: "ok" }], isError: false, timestamp }) as AgentMessage;
const summary = (timestamp: number): AgentMessage => ({ role: "compactionSummary", summary: "# Session state", tokensBefore: 90000, timestamp }) as unknown as AgentMessage;
const kinds = (messages: AgentMessage[]) => messages.map((m: any) => (m.role === "assistant" ? (m.content as any[]).map((b) => b.type).join("+") : m.role));

test("no compaction summary: the same array comes back and nothing is counted", () => {
  const messages: AgentMessage[] = [user("hi"), thinkingAssistant(1000, "let me think"), toolResult("c1")];
  const result = stripKeptWindowThinking(messages, { protectActiveTurn: false });
  assert.equal(result.messages, messages, "a no-op must not rebuild the context");
  assert.deepEqual({ strippedBlocks: result.strippedBlocks, strippedChars: result.strippedChars, cutoff: result.cutoff }, { strippedBlocks: 0, strippedChars: 0, cutoff: undefined });
});

test("with a compaction summary: kept-window assistant messages lose their thinking, newer ones keep it, the input is never mutated", () => {
  const messages: AgentMessage[] = [summary(5000), thinkingAssistant(4000, "old reasoning A", "did A"), toolResult("c1"), thinkingAssistant(4500, "old reasoning B", "did B"), user("next", 5500), thinkingAssistant(6000, "fresh reasoning", "doing C")];
  const result = stripKeptWindowThinking(messages, { protectActiveTurn: false });
  assert.equal(result.cutoff, 5000);
  assert.deepEqual({ strippedBlocks: result.strippedBlocks, strippedChars: result.strippedChars }, { strippedBlocks: 2, strippedChars: "old reasoning A".length + "old reasoning B".length });
  assert.deepEqual((result.messages[1] as any).content, [{ type: "text", text: "did A" }]);
  assert.equal(result.messages[2], messages[2], "other messages pass through by reference");
  assert.equal(result.messages[5], messages[5], "a message newer than the cutoff is the same object");
  assert.deepEqual((messages[1] as any).content.map((b: any) => b.type), ["thinking", "text"]);
});

test("a thinking-only kept message is dropped, an untimed one is left alone, and the LAST summary is the cutoff (pi's <= rule)", () => {
  const thinkingOnly = assistantMsg({ timestamp: 4000, content: [{ type: "thinking", thinking: "hmm", thinkingSignature: "reasoning_content" }] } as Partial<AssistantMessage>);
  const untimed = assistantMsg({ content: [{ type: "thinking", thinking: "no clock", thinkingSignature: "reasoning_content" }, { type: "text", text: "t" }] } as Partial<AssistantMessage>);
  delete (untimed as any).timestamp;
  const messages: AgentMessage[] = [summary(3000), thinkingAssistant(2000, "before the first summary", "x"), summary(5000), thinkingOnly, untimed, thinkingAssistant(5000, "at the cutoff", "y"), user("go", 5001), thinkingAssistant(5002, "after", "z")];
  const result = stripKeptWindowThinking(messages, { protectActiveTurn: false });
  assert.equal(result.cutoff, 5000);
  assert.deepEqual(kinds(result.messages), ["compactionSummary", "text", "compactionSummary", "thinking+text", "text", "user", "thinking+text"]);
  assert.equal(result.strippedBlocks, 3);
});

test("protectActiveTurn: after a mid-run compaction the whole kept tool turn keeps its thinking; an earlier turn and a finished turn do not", () => {
  const midRun: AgentMessage[] = [summary(5000), thinkingAssistant(4000, "plan", "calling"), toolResult("c1", 4100), thinkingAssistant(4500, "next", "calling again"), toolResult("c2", 4600)];
  assert.equal(stripKeptWindowThinking(midRun, { protectActiveTurn: true }).messages, midRun, "the summary starts the turn on the wire, so every kept assistant message is in it");
  assert.equal(stripKeptWindowThinking(midRun, { protectActiveTurn: false }).strippedBlocks, 2, "unprotected, the same context loses both");

  const withPrompt: AgentMessage[] = [summary(5000), thinkingAssistant(3000, "earlier turn", "done"), user("now do this", 3500), thinkingAssistant(4000, "current turn", "calling"), toolResult("c1", 4100)];
  const guarded = stripKeptWindowThinking(withPrompt, { protectActiveTurn: true });
  assert.deepEqual(kinds(guarded.messages), ["compactionSummary", "text", "user", "thinking+text", "toolResult"]);

  const finished: AgentMessage[] = [summary(5000), thinkingAssistant(4000, "a", "x"), toolResult("c1", 4100), thinkingAssistant(4500, "b", "y"), user("new prompt", 6000)];
  assert.equal(stripKeptWindowThinking(finished, { protectActiveTurn: true }).strippedBlocks, 2, "a new prompt ends the tool turn: nothing is active");
});

const modelOn = (api: string) => ({ ...modelWith(), api }) as never;

test("stripKeptWindowContext: by default only an API whose replay is verified is stripped; keep never strips; strip elsewhere protects the active turn", () => {
  const finished: AgentMessage[] = [summary(5000), thinkingAssistant(4000, "old", "a"), user("next", 5500), thinkingAssistant(6000, "new", "b")];
  for (const [name, api, setting, strips] of [
    ["openai-completions by default", "openai-completions", undefined, 1],
    ["anthropic-messages by default", "anthropic-messages", undefined, 0],
    ["openai-responses by default", "openai-responses", undefined, 0],
    ["keep on a verified API", "openai-completions", "keep", 0],
    ["strip on an unverified API", "anthropic-messages", "strip", 1],
  ] as const) assert.equal(stripKeptWindowContext({ messages: finished }, modelOn(api), setting)?.strippedBlocks ?? 0, strips, name);

  const midRun: AgentMessage[] = [summary(5000), thinkingAssistant(4000, "plan", "calling"), toolResult("c1", 4100)];
  assert.equal(stripKeptWindowContext({ messages: midRun }, modelOn("anthropic-messages"), "strip"), undefined, "an unverified API keeps its active tool turn whole even when strip is asked for");
  assert.equal(stripKeptWindowContext({ messages: midRun }, modelOn("openai-completions"), undefined)?.strippedBlocks, 1, "the verified API strips it, as before");
});

test("stripKeptWindowContext: undefined when there is nothing to do, and never throws", () => {
  const api = modelOn("openai-completions");
  assert.equal(stripKeptWindowContext({ messages: [summary(5000), thinkingAssistant(6000, "new", "b")] }, api, undefined), undefined);
  assert.equal(stripKeptWindowContext({ messages: [user("x")] }, api, undefined), undefined);
  assert.equal(stripKeptWindowContext({ messages: [summary(5000), thinkingAssistant(4000, "old")] }, undefined, undefined), undefined, "no model");
  const poisoned = [summary(5000), { role: "assistant", timestamp: 4000, content: [{ type: "thinking", thinking: null }] }] as unknown as AgentMessage[];
  assert.equal(stripKeptWindowContext({ messages: poisoned }, api, undefined), undefined, "a malformed block leaves the context to pi");
  assert.equal(stripKeptWindowContext({ messages: "nope" as unknown as AgentMessage[] }, api, undefined), undefined);
});
