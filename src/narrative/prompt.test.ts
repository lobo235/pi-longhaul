import test from "node:test";
import assert from "node:assert/strict";

import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { DEFAULT_CAPS } from "../store/events.ts";
import { project } from "../store/project.ts";
import { closeEvent, ev, logOf, quote, resetSeq } from "../store/test-support.ts";
import { fixedPromptChars, NARRATIVE_PROMPT_REVISION, NARRATIVE_SYSTEM_PROMPT, planChunks, promptStateOf, renderNarrativePrompt, SEED_HEAD_CHARS, SEED_TAIL_CHARS, seedOf } from "./prompt.ts";
import { EARLIER_REQUEST, NOT_A_RULE, RULE_DEFINITION } from "./message-labels.ts";

test.beforeEach(() => resetSeq());

const user = (text: string, ts: number) => ({ role: "user", content: text, timestamp: ts }) as AgentMessage;
const assistant = (text: string, ts: number) => ({ role: "assistant", content: [{ type: "text", text }], api: "x", provider: "x", model: "x", stopReason: "stop", timestamp: ts, usage: {} }) as unknown as AgentMessage;

test("promptStateOf: each rule's text is cut to the quote cap, naming its recall, so the summarizer prompt stays bounded", () => {
  const long = `never ${"touch the vendored tree ".repeat(60)}`;
  const state = promptStateOf(project(logOf(ev({ kind: "correction.add", id: "R1", quote: quote("u2", long) })), DEFAULT_CAPS), [], 600);
  assert.ok(state.corrections[0].text.length <= 640);
  assert.match(state.corrections[0].text, /… \(longhaul_recall message u2\)$/);
});

test("promptStateOf: hot items with ids and ordinals; remembered events of this span listed by kind", () => {
  const log = logOf(
    ev({ kind: "objective.set", quote: quote("u1", "build the state compactor") }),
    ev({ kind: "correction.add", id: "R1", quote: quote("u2", "never use mocks in these tests"), source: "remember" }),
    ev({ kind: "decision.add", id: "D1", text: "copy the ledger" }),
    closeEvent(1),
    ev({ kind: "correction.lift", target: "R1", by: { messageId: "m-u5", ordinal: "u5" }, span: 2 }),
    ev({ kind: "deadEnd.add", id: "X1", text: "structured outputs", source: "remember", span: 2 }),
  );
  const state = promptStateOf(project(log, DEFAULT_CAPS), log.events.filter((event) => event.source === "remember" && event.span === 2));
  assert.deepEqual(state.objective, { ordinal: "u1", text: "build the state compactor", doneWhen: undefined });
  assert.deepEqual(state.corrections, [{ id: "R1", ordinal: "u2", text: "never use mocks in these tests", lifted: "u5" }]);
  assert.deepEqual(state.decisions, [{ id: "D1", text: "copy the ledger" }]);
  assert.deepEqual(state.remembered, [{ kind: "dead-end", text: "X1 structured outputs" }]);
});

test("promptStateOf: outside a /goal the opening request is the goal line once the Request moved, and the prompt says code keeps it", () => {
  const unmoved = logOf(ev({ kind: "objective.set", quote: quote("u1", "build logstat, an access-log summarizer") }), closeEvent(1));
  assert.equal(promptStateOf(project(unmoved, DEFAULT_CAPS), []).goal, undefined);
  const moved = logOf(...unmoved.events, ev({ kind: "objective.set", quote: quote("u6", "add a --top option"), span: 2 }), closeEvent(2));
  const state = promptStateOf(project(moved, DEFAULT_CAPS), []);
  assert.deepEqual(state.goal, { ordinal: "u1", text: "build logstat, an access-log summarizer", source: "opening" });
  const text = renderNarrativePrompt({ state, ordinals: [], conversation: "", chunk: { index: 1, total: 1 } });
  assert.match(text, /\ngoal: \[u1\] build logstat, an access-log summarizer \(the session's opening request; kept by code\)\nobjective: \[u6\] add a --top option\n/);
});

test("promptStateOf: the goal and the Request are cut at the quote cap with the recall pointer, so a pasted first message cannot fill every later prompt", () => {
  const pasted = "summarize this log: " + "x".repeat(5000);
  const log = logOf(ev({ kind: "objective.set", quote: quote("u1", pasted) }), closeEvent(1), ev({ kind: "objective.set", quote: quote("u6", "y".repeat(900)), span: 2 }), closeEvent(2));
  const state = promptStateOf(project(log, DEFAULT_CAPS), [], 600);
  assert.equal(state.goal!.text, pasted.slice(0, 599) + "… (longhaul_recall message u1)");
  assert.equal(state.objective!.text, "y".repeat(599) + "… (longhaul_recall message u6)");
  const text = renderNarrativePrompt({ state, ordinals: [], conversation: "", chunk: { index: 1, total: 1 } });
  assert.ok(!text.includes("x".repeat(600)), "the paste is not in the prompt whole");
});

test("planChunks: one chunk when it fits, several capped chunks when it does not, truncated past maxChunks", () => {
  const messages = Array.from({ length: 20 }, (_, i) => (i % 2 ? assistant("y".repeat(3000), i) : user("x".repeat(3000), i)));
  const one = planChunks({ messages: messages.slice(0, 2), fixedChars: 1000, outputBudget: 1000, contextWindow: 131072, maxChunks: 4 });
  assert.equal(one.chunks.length, 1);
  assert.equal(one.chunks[0].messageCount, 2);
  const several = planChunks({ messages, fixedChars: 1000, outputBudget: 1000, contextWindow: 12000, maxChunks: 4 });
  assert.ok(several.chunks.length > 1 && several.chunks.length <= 4, `${several.chunks.length} chunks`);
  assert.equal(several.chunks.reduce((n, c) => n + c.messageCount, 0) <= messages.length, true);
  assert.equal(several.truncated, several.chunks.reduce((n, c) => n + c.messageCount, 0) < messages.length);
  const none = planChunks({ messages, fixedChars: 131072 * 3, outputBudget: 1000, contextWindow: 131072, maxChunks: 4 });
  assert.equal(none.chunks.length, 0);
});

test("renderNarrativePrompt: system prompt first (cacheable), then state, ordinals, the conversation, Now guidance and the retry note last", () => {
  const state = { corrections: [{ id: "R1", ordinal: "u2", text: "never use mocks" }], decisions: [], deadEnds: [], remembered: [{ kind: "decision", text: "D3 x" }] };
  const text = renderNarrativePrompt({ state, ordinals: [{ ordinal: "u2", excerpt: "never use mocks" }], conversation: "<conversation>c</conversation>", chunk: { index: 1, total: 2 }, customInstructions: "focus on the tests", retryNote: "corrections[0]: not a substring" });
  assert.ok(text.startsWith(NARRATIVE_SYSTEM_PROMPT));
  const order = ["<state>", "R1 [u2]", "<remembered-this-span>\ndecision: D3 x", "D3 x", "<user-messages>", "u2: never use mocks", "<conversation>c</conversation>", "chunk 1 of 2", "<now-guidance>", "focus on the tests", "<retry-note>", "corrections[0]"];
  let last = NARRATIVE_SYSTEM_PROMPT.length - 1;
  for (const needle of order) {
    const at = text.indexOf(needle, NARRATIVE_SYSTEM_PROMPT.length);
    assert.ok(at > last, `${needle} in order`);
    last = at;
  }
  assert.ok(text.trimEnd().endsWith("</retry-note>"));
  assert.match(NARRATIVE_SYSTEM_PROMPT, /```json/);
  assert.match(NARRATIVE_SYSTEM_PROMPT, /"messageRef"/);
  assert.equal(NARRATIVE_PROMPT_REVISION, "state-19");
});

test("NARRATIVE_SYSTEM_PROMPT: every user message of the span is labeled, in every form the parser reads, whatever words it uses", () => {
  assert.match(NARRATIVE_SYSTEM_PROMPT, /"labels": \{ "u1": "not a rule", "u2": "rule", "u3": "lifts R1" \}/);
  for (const form of ['"rule"', '"not a rule"', '"lifts R<n>"', '"lifts u<n>"', '"rule and lifts R<n>"', '{"rule": "<the rule\'s exact words>"']) assert.ok(NARRATIVE_SYSTEM_PROMPT.includes(form), form);
  assert.match(NARRATIVE_SYSTEM_PROMPT, /Label EVERY message in <user-messages>/);
  assert.match(NARRATIVE_SYSTEM_PROMPT, /asks for work and also sets a constraint[^.]*is a rule/, "a request carrying a standing constraint is a rule");
  assert.doesNotMatch(NARRATIVE_SYSTEM_PROMPT, /requirement on the output of that work/, "state-9's feature-output sentence made feature specs rules");
  assert.match(NARRATIVE_SYSTEM_PROMPT, /Code keeps a message of at most 300 characters whole; for a longer one, give the constraint's exact words/);
  assert.doesNotMatch(NARRATIVE_SYSTEM_PROMPT, /"lifts": \[/, "lifts are labels now");
});

test("NARRATIVE_SYSTEM_PROMPT: a description of what is being built is not a rule; a constraint stated over all later work is", () => {
  assert.match(NARRATIVE_SYSTEM_PROMPT, /A description of what is being built[^.]*is not a rule[^.]*the code and its tests keep it/);
  assert.match(NARRATIVE_SYSTEM_PROMPT, /only when the user states it as standing over later work/);
});

test("NARRATIVE_SYSTEM_PROMPT: how to carry out a withdrawal is not a new rule", () => {
  assert.match(NARRATIVE_SYSTEM_PROMPT, /how to carry out the withdrawal \("keep the existing tests passing"\) is not a new rule either/);
});

test("NARRATIVE_SYSTEM_PROMPT: a message that narrows a rule replaces it rather than lifting it outright", () => {
  assert.match(NARRATIVE_SYSTEM_PROMPT, /"rule and lifts R<n>" only when[^.]*replaces the rule, or narrows it/);
  assert.match(NARRATIVE_SYSTEM_PROMPT, /"lifts R<n>" alone only when the rule no longer holds anywhere/);
  assert.match(NARRATIVE_SYSTEM_PROMPT, /A permission for one occasion[^.]*is not a lift/);
});

test("NARRATIVE_SYSTEM_PROMPT: a new rule that cannot hold beside a rule in the state replaces it, and names every rule it replaces", () => {
  assert.match(NARRATIVE_SYSTEM_PROMPT, /A new rule that cannot hold together with a rule in the state replaces it, even when it does not say so/);
  assert.match(NARRATIVE_SYSTEM_PROMPT, /name every rule it replaces, a narrowing of it included \("rule and lifts R1, R6"\)/);
  assert.ok(NARRATIVE_SYSTEM_PROMPT.includes('"lifts R1, R6"'), "the several-targets form is listed");
});

test("NARRATIVE_SYSTEM_PROMPT: a message that only withdraws a rule is a lift, even when it says what is fine instead", () => {
  assert.match(NARRATIVE_SYSTEM_PROMPT, /only withdraws a rule is "lifts R<n>", even when it says what is fine instead/);
  assert.match(NARRATIVE_SYSTEM_PROMPT, /"rule and lifts R<n>" only when the message puts a new standing rule in the old one's place/);
  assert.match(NARRATIVE_SYSTEM_PROMPT, /words that need the rest of the message to make sense \("keep it for \.\.\."\) are not the rule/);
});

test("NARRATIVE_SYSTEM_PROMPT: values are named and cited by the turn that shows them, copied exactly, never a secret", () => {
  assert.match(NARRATIVE_SYSTEM_PROMPT, /"values": \[ \{ "name": "[^"]+", "value": "[^"]+", "ref": "u\d+" \} \]/);
  assert.match(NARRATIVE_SYSTEM_PROMPT, /"values":[^]*exactly as[^]*never a password, key or token/);
  assert.match(NARRATIVE_SYSTEM_PROMPT, /"name" is a short label \(at most 40 characters, no colon\)/);
  assert.match(NARRATIVE_SYSTEM_PROMPT, /a value is a number with or without its unit \("166 ms"\), a version, a short commit hash, a path or file name \(with <placeholders> if the format has them\), a host:port or a date/);
});

test("fixedPromptChars: everything but the conversation, plus the retry-note allowance", () => {
  const state = { corrections: [], decisions: [], deadEnds: [], remembered: [] };
  const without = renderNarrativePrompt({ state, ordinals: [], conversation: "", chunk: { index: 1, total: 1 } }).length;
  assert.equal(fixedPromptChars({ state, ordinals: [] }, 1500), without + 1500);
});

test("seedOf: absent or blank is no seed; a long summary keeps its head (the goal) and its tail (corrections, next steps) and says what it elided", () => {
  assert.equal(seedOf(undefined), undefined);
  assert.equal(seedOf("  \n"), undefined);
  assert.equal(seedOf("## Goal\nship it"), "## Goal\nship it");
  const long = `HEAD${"a".repeat(SEED_HEAD_CHARS)}${"b".repeat(5000)}${"c".repeat(SEED_TAIL_CHARS)}TAIL`;
  const seed = seedOf(long)!;
  assert.ok(seed.startsWith("HEAD") && seed.endsWith("TAIL"));
  assert.match(seed, /\[… 5008 chars elided …\]/);
  assert.ok(!seed.includes("b"));
});

test("renderNarrativePrompt: the earlier rules say the code records them and that a one-off goes into oneOffs, never into corrections", () => {
  const state = { corrections: [], decisions: [], deadEnds: [], remembered: [], seed: "## Goal\nship it", seedRules: [{ ordinal: "u1", text: "never deploy on a friday" }] };
  const text = renderNarrativePrompt({ state, ordinals: [], conversation: "", chunk: { index: 1, total: 1 } });
  assert.match(text, /recorded as corrections automatically[\s\S]*"oneOffs": \["u3"\][\s\S]*<earlier-user-messages>\n\[u1\] never deploy on a friday\n<\/earlier-user-messages>/);
  assert.match(text, /need no label unless one replaces or withdraws an earlier rule: label that one "rule and lifts u<n>" or "lifts u<n>"/, "a listed message that replaces a rule still lifts it");
});

test("renderNarrativePrompt: the other earlier messages say an earlier request is not a rule, however it says the result must behave", () => {
  const state = { corrections: [], decisions: [], deadEnds: [], remembered: [], seed: "## Goal\nship it", seedRules: [], seedContext: [{ ordinal: "u2", text: "add an export button" }] };
  const text = renderNarrativePrompt({ state, ordinals: [], conversation: "", chunk: { index: 1, total: 1 } });
  assert.ok(text.includes(EARLIER_REQUEST), "the switchover's boundary for earlier requests");
  assert.ok(text.indexOf(EARLIER_REQUEST) < text.indexOf("<earlier-other-messages>"));
});

test("NARRATIVE_SYSTEM_PROMPT: a file-name format the user chose is a value, placeholders and all", () => {
  assert.match(NARRATIVE_SYSTEM_PROMPT, /a file-name format the user chose \("<name>-YYYYMMDD\.tar\.gz"\)/);
  assert.match(NARRATIVE_SYSTEM_PROMPT, /with <placeholders> if the format has them/);
});

test("promptStateOf: a remembered decision with a credential in it reaches the summarizer redacted (security.md T3)", () => {
  const log = logOf(ev({ kind: "decision.add", id: "D1", text: "call it with Bearer 3f7a2c91-5b4e-4d8a-9c1f-7e6b2a0d4c58", source: "remember" }));
  const state = promptStateOf(project(log, DEFAULT_CAPS), log.events);
  assert.deepEqual(state.remembered, [{ kind: "decision", text: "D1 call it with Bearer <redacted>" }]);
});

test("renderNarrativePrompt: the single call says what a rule is and is not in the words both modes share", () => {
  const text = renderNarrativePrompt({ state: promptStateOf(project(logOf(), DEFAULT_CAPS), []), ordinals: [], conversation: "", chunk: { index: 1, total: 1 } });
  assert.ok(text.includes(RULE_DEFINITION) && text.includes(NOT_A_RULE));
});
