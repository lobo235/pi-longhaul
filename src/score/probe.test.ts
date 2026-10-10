import test from "node:test";
import assert from "node:assert/strict";

import { assistantEntry, assistantMsg, chain, modelWith, textResponse, toolResultEntry, userEntry } from "../test-support.ts";
import { parseProbe, PROBE_QUESTION, probeContext, probeScore, runProbe, sessionRequestOf } from "./probe.ts";

test("probeContext: what a resumed session sends — the compaction summary, then the kept messages, then the probe question", () => {
  const entries = chain([
    userEntry("m1", "old request that the compaction covers"),
    assistantEntry("a1", "old answer"),
    userEntry("m2", "fix the failing test in src/a.test.ts"),
    assistantEntry("a2", "Running it.", [{ name: "bash", arguments: { command: "npm test" } }]),
    toolResultEntry("r2", "a2-t0", "bash", "1 failed"),
  ]);
  const context = probeContext(entries, { summary: "## Objective\nFix the test.", firstKeptEntryId: "m2", tokensBefore: 1000 });
  const texts = context.messages.map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)));
  assert.match(texts[0], /compacted into the following summary[\s\S]*Fix the test\./);
  assert.ok(!texts.some((text) => text.includes("old request")), "messages before the kept window are gone");
  assert.ok(texts.some((text) => text.includes("fix the failing test")));
  assert.equal(context.messages.at(-1)!.role, "user");
  assert.equal(texts.at(-1), PROBE_QUESTION);
  assert.ok((context.tools ?? []).some((tool) => tool.name === "bash"), "tool history needs tools declared, or the server rejects it");
});

test("parseProbe: the plan's objective and targets; anything else is no plan", () => {
  assert.deepEqual(parseProbe('Sure. {"objective": "fix it", "next": ["src/a.test.ts", "npm test", 7]}'), { objective: "fix it", targets: ["src/a.test.ts", "npm test"] });
  assert.equal(parseProbe("I will read the file."), undefined);
  assert.equal(parseProbe('{"objective": "x"}'), undefined);
});

test("probeScore: a needed name is hit when a planned target contains it", () => {
  const score = probeScore(["read src/a.test.ts", "npm test -- --grep x"], { files: ["a.test.ts", "b.ts"], artifacts: ["report.json"] });
  assert.deepEqual(score, { hit: 1, total: 3, share: 1 / 3, targets: 2, onTarget: 1 });
  assert.deepEqual(probeScore([], { files: [], artifacts: [] }), { hit: 0, total: 0, share: null, targets: 0, onTarget: 0 });
});

test("runProbe: one reasoning-off, answer-only request; a plan is scored, an unparsable answer scores as no plan", async () => {
  const seen: Array<Record<string, unknown>> = [];
  const call = (text: string) => ({ complete: async (_m: unknown, _c: unknown, options: Record<string, unknown>) => (seen.push(options), textResponse(text)) });
  const entries = chain([userEntry("m1", "fix src/a.ts")]);
  const context = probeContext(entries, { summary: "s", firstKeptEntryId: "m1", tokensBefore: 1 });
  const needs = { files: ["a.ts"], artifacts: [] };
  const planned = await runProbe(call('{"objective": "fix", "next": ["src/a.ts"]}'), modelWith({}), context, needs);
  assert.deepEqual(planned, { hit: 1, total: 1, share: 1, targets: 1, onTarget: 1, parsed: true });
  assert.equal(seen[0].reasoning, "off");
  assert.equal(seen[0].toolChoice, undefined, "tool_choice none makes the server swallow a call the model insists on, leaving no answer");
  const vague = await runProbe(call("I'd look around first."), modelWith({}), context, needs);
  assert.deepEqual(vague, { hit: 0, total: 1, share: 0, targets: 0, onTarget: 0, parsed: false });
});

test("runProbe: a model that acts instead of planning is scored on the tool calls it makes, its real next actions", async () => {
  const acting = { complete: async () => assistantMsg({ content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "src/a.ts" } }, { type: "toolCall", id: "c2", name: "bash", arguments: { command: "npm test" } }], stopReason: "toolUse" }) };
  const context = probeContext(chain([userEntry("m1", "fix src/a.ts")]), { summary: "s", firstKeptEntryId: "m1", tokensBefore: 1 });
  assert.deepEqual(await runProbe(acting, modelWith({}), context, { files: ["a.ts"], artifacts: [] }), { hit: 1, total: 1, share: 1, targets: 2, onTarget: 1, parsed: true });
});

test("sessionRequestOf (state-warm arm): the request the session sent before compacting — every message on the path, tools declared, no question appended", () => {
  const entries = chain([
    userEntry("m1", "old request that the compaction covers"),
    assistantEntry("a1", "Running it.", [{ name: "bash", arguments: { command: "npm test" } }]),
    toolResultEntry("r1", "a1-t0", "bash", "1 failed"),
  ]);
  const base = sessionRequestOf(entries);
  const texts = base.messages.map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)));
  assert.ok(texts[0].includes("old request"), "nothing is compacted yet: the span is in the request");
  assert.equal(base.messages.at(-1)!.role, "toolResult");
  assert.ok(base.tools.some((tool) => tool.name === "bash"));
});
