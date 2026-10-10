import test from "node:test";
import assert from "node:assert/strict";

import { proposalOf, registerRememberTool, REMEMBER_KINDS } from "./remember-tool.ts";
import { EVENT_ENTRY_TYPE } from "./store/events.ts";
import { assistantEntry, chain, fakeCtx, fakePi, userEntry } from "./test-support.ts";

const now = () => new Date("2026-09-28T12:00:00.000Z");

interface ToolResult { content: Array<{ text: string }>; details: Record<string, unknown> }
const exec = async (tool: { execute: (...args: unknown[]) => Promise<unknown> }, params: Record<string, unknown>, ctx: unknown): Promise<ToolResult> =>
  (await tool.execute("id", params, undefined, undefined, ctx)) as ToolResult;

test("proposalOf: each kind maps to a store proposal; quote/text swapped by the model is repaired with a note; missing fields are an error (table)", () => {
  const cases: Array<[string, Parameters<typeof proposalOf>[0], unknown]> = [
    ["correction from quote", { kind: "correction", quote: "never use mocks in these tests" }, { proposal: { kind: "correction", text: "never use mocks in these tests" } }],
    ["correction given as text is repaired", { kind: "correction", text: "never use mocks in these tests" }, { proposal: { kind: "correction", text: "never use mocks in these tests" }, note: "Note: quote taken from `text`; corrections quote the user, pass `quote`." }],
    ["decision from text with evidence", { kind: "decision", text: "copy the ledger", evidence: "C1" }, { proposal: { kind: "decision", text: "copy the ledger", evidence: "C1" } }],
    ["decision given as quote is repaired", { kind: "decision", quote: "copy the ledger" }, { proposal: { kind: "decision", text: "copy the ledger", evidence: undefined }, note: "Note: text taken from `quote`; decisions are your own words, pass `text`." }],
    ["dead-end", { kind: "dead-end", text: "structured outputs", evidence: "E2" }, { proposal: { kind: "dead-end", text: "structured outputs", evidence: "E2" } }],
    ["done-when quotes", { kind: "done-when", quote: "done when npm test passes" }, { proposal: { kind: "done-when", text: "done when npm test passes" } }],
    ["lift needs target and quote", { kind: "lift", target: "R1", quote: "fakes are fine now" }, { proposal: { kind: "lift", target: "R1", text: "fakes are fine now" } }],
    ["lift without target", { kind: "lift", quote: "fakes are fine now" }, { error: "lift needs `target` (a correction id such as R2) and `quote` (the user's withdrawing words)." }],
    ["nothing to remember", { kind: "correction" }, { error: "correction needs `quote`: the user's exact words." }],
    ["unknown kind", { kind: "objective" as never, quote: "x" }, { error: `kind must be one of ${REMEMBER_KINDS.join(", ")}.` }],
  ];
  // JSON round-trip: the code returns `note: undefined` for un-repaired kinds while the rows here leave
  // the key absent; a real value difference still fails.
  const strip = (value: unknown) => JSON.parse(JSON.stringify(value));
  for (const [name, params, expected] of cases) assert.deepEqual(strip(proposalOf(params)), strip(expected), name);
});

test("remember tool: an accepted write appends the event entry and answers with the id; a rejection answers with the sentence and appends nothing", async () => {
  const { pi, tools, entries } = fakePi();
  registerRememberTool(pi, { readConfig: () => undefined, now });
  const tool = tools.find((candidate) => candidate.name === "longhaul_remember")!;
  assert.equal(tool.executionMode, "sequential");
  assert.equal((tool.promptGuidelines as string[] | undefined)?.length, 2);
  const branch = chain([userEntry("m1", "Build the state compactor and keep it small"), assistantEntry("a1", "ok"), userEntry("m2", "never use mocks in these tests, fakes only"), assistantEntry("a2", "sure")]);
  const { ctx } = fakeCtx({ branch });
  const accepted = await exec(tool, { kind: "correction", quote: "never use mocks in these tests" }, ctx);
  assert.match(accepted.content[0].text, /^remembered R1 \[u2\] never use mocks in these tests \(9 remember writes left this span\)$/);
  assert.equal(accepted.details.ok, true);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].customType, EVENT_ENTRY_TYPE);
  assert.equal((entries[0].data as { stateFormat?: number }).stateFormat, 1, "the persisted event carries its format number");
  const rejected = await exec(tool, { kind: "correction", quote: "never use MOCKS anywhere" }, ctx);
  assert.match(rejected.content[0].text, /^not remembered: /);
  assert.equal(rejected.details.ok, false);
  assert.equal(entries.length, 1);
});

test("remember tool: the repaired-argument note prefixes the answer; a malformed call is a plain rejection, never a throw", async () => {
  const { pi, tools } = fakePi();
  registerRememberTool(pi, { readConfig: () => undefined, now });
  const tool = tools.find((candidate) => candidate.name === "longhaul_remember")!;
  const { ctx } = fakeCtx({ branch: chain([userEntry("m1", "never use mocks in these tests, fakes only"), assistantEntry("a1", "ok")]) });
  const repaired = await exec(tool, { kind: "correction", text: "never use mocks in these tests" }, ctx);
  assert.match(repaired.content[0].text, /^Note: quote taken from `text`.*\nremembered R1/);
  const malformed = await exec(tool, { kind: "lift" }, ctx);
  assert.match(malformed.content[0].text, /^not remembered: lift needs `target`/);
  assert.equal(malformed.details.ok, false);
});
