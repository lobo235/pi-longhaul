import test from "node:test";
import assert from "node:assert/strict";

import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { buildMessageIndex } from "../intent.ts";
import { chain, piGoalMessage, userEntry, assistantEntry } from "../test-support.ts";
import { CARRIED_MAX_MESSAGES, carryUnlabeled, prepareSpan, stripThinkingBlocks } from "./prepare.ts";

const EVIDENCE = { commandIds: new Set<string>(), errorIds: new Set<string>() };

test("stripThinkingBlocks: thinking blocks leave assistant messages; counts are reported; other messages untouched", () => {
  const messages = [
    { role: "assistant", content: [{ type: "thinking", thinking: "hmm".repeat(10) }, { type: "text", text: "answer" }], timestamp: 1 },
    { role: "user", content: "q", timestamp: 2 },
  ] as unknown as AgentMessage[];
  const result = stripThinkingBlocks(messages);
  assert.deepEqual((result.messages[0] as { content: unknown[] }).content, [{ type: "text", text: "answer" }]);
  assert.equal(result.strippedBlocks, 1);
  assert.equal(result.strippedChars, 30);
  assert.equal(result.messages[1], messages[1]);
});

test("prepareSpan: user messages are prefixed with their ordinal, the turn prefix follows the span, refs and the ordinal index are computed (an image-only message keeps its ordinal)", () => {
  const entries = chain([
    userEntry("m1", "Build the state compactor please, thanks a lot"),
    assistantEntry("a1", "ok"),
    userEntry("m2", [{ type: "image", data: "" }]),
    userEntry("m3", [{ type: "text", text: "and fix the layout" }, { type: "image", data: "" }]),
    assistantEntry("a2", "sure", [{ name: "bash", arguments: { command: "ls" } }]),
  ]);
  const index = buildMessageIndex(entries, EVIDENCE);
  const messages = entries.map((entry) => (entry as { message: AgentMessage }).message);
  const span = prepareSpan({ messagesToSummarize: messages.slice(0, 3), turnPrefixMessages: messages.slice(3), index });
  assert.equal(span.messages.length, 5);
  assert.equal((span.messages[0] as { content: string }).content, "[u1] Build the state compactor please, thanks a lot");
  assert.deepEqual((span.messages[2] as { content: unknown[] }).content, [{ type: "text", text: "[u2] " }, { type: "image", data: "" }]);
  assert.deepEqual((span.messages[3] as { content: unknown[] }).content, [{ type: "text", text: "[u3] and fix the layout" }, { type: "image", data: "" }]);
  assert.deepEqual({ fromRef: span.fromRef, toRef: span.toRef }, { fromRef: "u1", toRef: "u3" });
  assert.deepEqual(span.ordinals.map(({ ordinal, excerpt }) => ({ ordinal, excerpt })), [{ ordinal: "u1", excerpt: "Build the state compactor please, thanks a lot" }, { ordinal: "u2", excerpt: "" }, { ordinal: "u3", excerpt: "and fix the layout" }]);
  assert.equal(span.ordinals[0].text, "Build the state compactor please, thanks a lot", "the whole words, which a rule label records");
  assert.notEqual(span.messages[0], messages[0], "input messages are never mutated");
  assert.equal((messages[0] as { content: string }).content, "Build the state compactor please, thanks a lot");
});

test("prepareSpan: a /goal-mode message is listed by its objective, not by pi's template opening", () => {
  const entries = chain([
    userEntry("m1", piGoalMessage("ship the scorer fixes")),
    assistantEntry("a1", "on it"),
  ]);
  const messages = entries.map((entry) => (entry as unknown as { message: AgentMessage }).message);
  const span = prepareSpan({ messagesToSummarize: messages, turnPrefixMessages: [], index: buildMessageIndex(entries, EVIDENCE) });
  assert.deepEqual(span.ordinals.map(({ ordinal, excerpt }) => ({ ordinal, excerpt })), [{ ordinal: "u1", excerpt: "[/goal] ship the scorer fixes" }]);
});

test("prepareSpan: a message is listed whole up to 240 characters, and a longer one ends in an ellipsis where it is cut", () => {
  const short = `Keep the type hints for the ledger package itself; ${"the test files may skip them. ".repeat(5)}`.trim();
  const long = `The type hint rule is lifted for test files, but keep it for the ledger package itself. ${"Then rerun the suite and paste the summary. ".repeat(6)}`.trim();
  const entries = chain([userEntry("m1", short), assistantEntry("a1", "ok"), userEntry("m2", long), assistantEntry("a2", "ok")]);
  const messages = entries.map((entry) => (entry as unknown as { message: AgentMessage }).message);
  const span = prepareSpan({ messagesToSummarize: messages, turnPrefixMessages: [], index: buildMessageIndex(entries, EVIDENCE) });
  assert.ok(short.length > 80 && short.length <= 240);
  assert.equal(span.ordinals[0].excerpt, short, "a message of at most 240 characters is shown whole");
  assert.equal(span.ordinals[1].excerpt.length, 240);
  assert.ok(span.ordinals[1].excerpt.endsWith("…"), "a cut excerpt says it was cut");
  assert.ok(span.ordinals[1].excerpt.includes("keep it for the ledger package itself"));
});

function sixMessages() {
  const entries = chain([
    userEntry("m1", "Build the backup script"), assistantEntry("a1", "ok"),
    userEntry("m2", "Every dry-run line must start with DRY: so it is easy to grep."), assistantEntry("a2", "ok"),
    userEntry("m3", "Add a lock file"), assistantEntry("a3", "ok"),
    userEntry("m4", "Add weekly retention"), assistantEntry("a4", "ok"),
    userEntry("m5", "Run the tests"), assistantEntry("a5", "ok"),
  ]);
  const index = buildMessageIndex(entries, EVIDENCE);
  const messages = entries.map((entry) => (entry as unknown as { message: AgentMessage }).message);
  return { index, span: prepareSpan({ messagesToSummarize: messages.slice(8), turnPrefixMessages: [], index }) };
}

const close = (fromRef: string, toRef: string, narrativeLess: boolean, foreign?: string, missingChunks?: number[]) => ({ fromRef, toRef, narrativeLess, ...(foreign ? { foreign } : {}), ...(missingChunks ? { missingChunks } : {}) });

test("carryUnlabeled: the user messages of a narrative-less span before this one are listed first and marked carried, words and all", () => {
  const { index, span } = sixMessages();
  const carried = carryUnlabeled(span, [close("u1", "u1", false), close("u2", "u4", true)], index);
  assert.deepEqual(carried.ordinals.map((entry) => entry.ordinal), ["u2", "u3", "u4", "u5"]);
  assert.deepEqual(carried.carried, ["u2", "u3", "u4"]);
  assert.equal(carried.ordinals[0].text, "Every dry-run line must start with DRY: so it is easy to grep.");
  assert.equal(carried.ordinals[0].excerpt, "Every dry-run line must start with DRY: so it is easy to grep.");
  assert.equal(carried.messages, span.messages, "the conversation is this span's own");
  assert.deepEqual({ fromRef: carried.fromRef, toRef: carried.toRef }, { fromRef: span.fromRef, toRef: span.toRef }, "the span's refs stay its own");
});

test("carryUnlabeled: nothing is carried after a span that closed with a narrative", () => {
  const { index, span } = sixMessages();
  assert.equal(carryUnlabeled(span, [close("u1", "u4", false)], index), span);
  assert.equal(carryUnlabeled(span, [], index), span);
});

test("carryUnlabeled: failed spans in a row are all carried, back to the last span that closed with a narrative; a foreign compaction ends the walk", () => {
  const { index, span } = sixMessages();
  assert.deepEqual(carryUnlabeled(span, [close("u1", "u1", false), close("u2", "u2", true), close("?", "?", true), close("u3", "u4", true)], index).carried, ["u2", "u3", "u4"], "a failed span with no user message of its own does not end the walk");
  assert.deepEqual(carryUnlabeled(span, [close("u1", "u2", true), close("?", "?", true, "pi"), close("u3", "u4", true)], index).carried, ["u3", "u4"], "another compactor summarized what came before");
});

test("carryUnlabeled: a span whose chunk never verified is carried whole: the close does not say which messages that chunk held", () => {
  const { index, span } = sixMessages();
  assert.deepEqual(carryUnlabeled(span, [close("u1", "u1", false), close("u2", "u4", false, undefined, [2])], index).carried, ["u2", "u3", "u4"]);
});

test("carryUnlabeled: at most CARRIED_MAX_MESSAGES are carried, the oldest first", () => {
  const turns = Array.from({ length: CARRIED_MAX_MESSAGES + 6 }, (_, i) => [userEntry(`m${i + 1}`, `request number ${i + 1}`), assistantEntry(`a${i + 1}`, "ok")]).flat();
  const entries = chain(turns);
  const index = buildMessageIndex(entries, EVIDENCE);
  const messages = entries.map((entry) => (entry as unknown as { message: AgentMessage }).message);
  const last = CARRIED_MAX_MESSAGES + 6;
  const span = prepareSpan({ messagesToSummarize: messages.slice(-2), turnPrefixMessages: [], index });
  const carried = carryUnlabeled(span, [close("u1", `u${last - 1}`, true)], index).carried ?? [];
  assert.equal(carried.length, CARRIED_MAX_MESSAGES);
  assert.equal(carried[0], "u1");
});
