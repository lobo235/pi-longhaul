import test from "node:test";
import assert from "node:assert/strict";

import type { Message } from "@earendil-works/pi-ai";
import { serializeConversation } from "@earendil-works/pi-coding-agent";

import {
  CHARS_PER_TOKEN,
  CONTEXT_SAFETY_TOKENS,
  conversationCharsThatFit,
  elideMiddle,
  fitFirstChunk,
  fitsWindow,
  isContextOverflowMessage,
  serializeConversationCapped,
} from "./fit.ts";

const user = (text: string): Message => ({ role: "user", content: text, timestamp: 0 });
const assistant = (text: string, args?: Record<string, unknown>): Message =>
  ({
    role: "assistant",
    content: [{ type: "text", text }, ...(args ? [{ type: "toolCall", id: "t0", name: "write", arguments: args }] : [])],
    api: "openai-completions",
    provider: "test",
    model: "m",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: 0,
  }) as unknown as Message;
const toolResult = (text: string): Message =>
  ({ role: "toolResult", toolCallId: "t0", toolName: "write", content: [{ type: "text", text }], isError: false, timestamp: 0 }) as unknown as Message;

test("fitsWindow: prompt tokens + output budget + pi's safety margin must fit; an unknown window always fits", () => {
  const promptChars = 30_000; // 10 000 tokens at CHARS_PER_TOKEN 3
  assert.equal(CHARS_PER_TOKEN, 3);
  const exact = 10_000 + 1_000 + CONTEXT_SAFETY_TOKENS;
  assert.equal(fitsWindow({ promptChars, outputBudget: 1_000, contextWindow: exact }), true);
  assert.equal(fitsWindow({ promptChars, outputBudget: 1_000, contextWindow: exact - 1 }), false);
  assert.equal(fitsWindow({ promptChars: 10_000_000, outputBudget: 1_000, contextWindow: 0 }), true);
});

test("conversationCharsThatFit subtracts the budget, the safety margin and the fixed prompt parts", () => {
  assert.equal(conversationCharsThatFit(1_000, 2_000, 12_000), (12_000 - 2_000 - CONTEXT_SAFETY_TOKENS) * 3 - 1_000);
  assert.equal(conversationCharsThatFit(1_000, 2_000, 0), Number.POSITIVE_INFINITY);
});

test("elideMiddle keeps the head and the tail with a marker, and leaves short text alone", () => {
  assert.equal(elideMiddle("short", { head: 3, tail: 2 }), "short");
  assert.equal(elideMiddle("abcdefghij", { head: 3, tail: 2 }), "abc\n\n[... 5 characters elided ...]\n\nij");
});

test("serializeConversationCapped renders exactly pi's format when nothing exceeds a cap", () => {
  const messages = [user("do it"), assistant("Doing it.", { path: "a.ts", content: "x" }), toolResult("a b\nc")];
  assert.equal(serializeConversationCapped(messages), serializeConversation(messages));
});

test("serializeConversationCapped elides user text, assistant text, tool-call argument strings and tool results", () => {
  const long = "u".repeat(10_000);
  const out = serializeConversationCapped([user(long), assistant(long, { path: "a.ts", content: long, lines: 3 }), toolResult(long)]);
  const textElided = `${"u".repeat(3000)}\n\n[... 6000 characters elided ...]\n\n${"u".repeat(1000)}`;
  assert.ok(out.startsWith(`[User]: ${textElided}\n\n[Assistant]: ${textElided}\n\n[Assistant tool calls]: write(`), "user and assistant text: head 3000 + tail 1000");
  const callsPart = out.slice(out.indexOf("[Assistant tool calls]:"), out.indexOf("\n\n[Tool result]:"));
  assert.ok(callsPart.includes('path="a.ts"') && callsPart.includes("lines=3"), "non-string and short arguments untouched");
  assert.ok(callsPart.includes("[... 6000 characters elided ...]"), "long string argument elided");
  assert.ok(callsPart.length < 6_000, `tool call rendered in ${callsPart.length} chars`);
  assert.ok(out.endsWith(`[Tool result]: ${"u".repeat(1500)}\n\n[... 8000 characters elided ...]\n\n${"u".repeat(500)}`), "tool result: head 1500 + tail 500, pi's 2000 total");
});

test("fitFirstChunk: pi's serialization when it fits, the capped one when only that fits, the largest capped prefix otherwise", () => {
  const six = Array.from({ length: 6 }, (_, i) => user(String.fromCharCode(97 + i).repeat(4_000)));
  const full = serializeConversation(six); // 6 * (8 + 4000) + 5 * 2 = 24 058 chars
  const window = (chars: number) => Math.ceil(chars / 3) + CONTEXT_SAFETY_TOKENS; // budget 0, fixed 0

  const fits = fitFirstChunk({ messages: six, fixedChars: 0, outputBudget: 0, contextWindow: window(full.length) })!;
  assert.deepEqual([fits.messageCount, fits.capped, fits.conversation], [6, false, full]);

  const prefix = fitFirstChunk({ messages: six, fixedChars: 0, outputBudget: 0, contextWindow: window(15_000) })!;
  assert.deepEqual([prefix.messageCount, prefix.capped], [3, true]);
  assert.ok(prefix.conversation.startsWith("[User]: aaaa") && prefix.conversation.includes("cccc") && !prefix.conversation.includes("dddd"));

  const one = fitFirstChunk({ messages: [user("v".repeat(10_000))], fixedChars: 0, outputBudget: 0, contextWindow: window(5_000) })!;
  assert.deepEqual([one.messageCount, one.capped], [1, true]);
  assert.ok(one.conversation.includes("[... 6000 characters elided ...]"));

  assert.equal(fitFirstChunk({ messages: [user("w".repeat(10_000))], fixedChars: 0, outputBudget: 0, contextWindow: window(100) }), undefined);

  const empty = fitFirstChunk({ messages: [], fixedChars: 100, outputBudget: 10, contextWindow: 131072 })!;
  assert.deepEqual([empty.messageCount, empty.capped, empty.conversation], [0, false, ""]);
});

test("fitFirstChunk: the fixed prompt parts count against the window", () => {
  const messages = [user("q".repeat(3_000))];
  const justFits = Math.ceil((3_008 + 1_000) / 3) + CONTEXT_SAFETY_TOKENS;
  assert.equal(fitFirstChunk({ messages, fixedChars: 1_000, outputBudget: 0, contextWindow: justFits })?.capped, false);
  // One token less: 3000 chars is under the cap, so capping cannot help, and one message cannot be chunked.
  assert.equal(fitFirstChunk({ messages, fixedChars: 1_000, outputBudget: 0, contextWindow: justFits - 1 }), undefined);
});

test("isContextOverflowMessage recognises common servers' overflow errors and not throttling", () => {
  for (const msg of [
    "This model's maximum context length is 131072 tokens. However, you requested 140000 tokens",
    "Requested token count exceeds the model's maximum context length of 131072 tokens",
    "Your input exceeds the context window of this model",
    "context_length_exceeded",
    "too many tokens",
  ]) {
    assert.equal(isContextOverflowMessage(msg), true, msg);
  }
  for (const msg of [undefined, "", "ThrottlingException: Too many tokens, please wait", "rate limit exceeded", "connection reset"]) {
    assert.equal(isContextOverflowMessage(msg), false, String(msg));
  }
});
