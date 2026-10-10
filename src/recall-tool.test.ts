import test from "node:test";
import assert from "node:assert/strict";

import { registerRecallTool } from "./recall-tool.ts";
import { EVENT_ENTRY_TYPE, SPAN_ENTRY_TYPE } from "./store/events.ts";
import { assistantEntry, chain, compactionEntry, customEntry, fakeCtx, fakePi, toolResultEntry, userEntry } from "./test-support.ts";

interface ToolResult { content: Array<{ text: string }>; details: { total: number; shown: number; what: string } }
const exec = async (tool: { execute: (...args: unknown[]) => Promise<unknown> }, params: Record<string, unknown>, ctx: unknown): Promise<ToolResult> =>
  (await tool.execute("id", params, undefined, undefined, ctx)) as ToolResult;

const command = { id: "C1", command: "npm test", lastExitCode: 0, runs: 1, failedThenSucceeded: false, lastSeenPass: 1 };

function branch() {
  const close = { source: "pass", span: 1, at: "2026-09-28T12:00:00.000Z", seq: 2, kind: "span.close", fromRef: "u1", toRef: "u1", narrative: "ran the tests and copied the ledger", narrativeLess: false, world: { claims: [], openErrorIds: [] } };
  const decision = { source: "diff", span: 1, at: "2026-09-28T12:00:00.000Z", seq: 1, kind: "decision.add", id: "D1", text: "copy the ledger", evidence: "C1" };
  return chain([
    userEntry("m1", "Build the state compactor and keep it small"),
    assistantEntry("a1", "ran", [{ name: "bash", arguments: { command: "npm test" } }]),
    toolResultEntry("t1", "a1-t0", "bash", "ok\n[exit 0]"),
    compactionEntry("c1", { compactor: "state", state: {}, caps: {}, ledger: { commands: [command], errors: [] }, narrative: {}, readFiles: [], modifiedFiles: [] }),
    customEntry("s1", SPAN_ENTRY_TYPE, { v: 1, span: 1, compactionEntryId: "c1", events: [decision, close], ledger: { commands: [command], errors: [] } }),
    userEntry("m2", "never use mocks in these tests"),
    customEntry("e1", EVENT_ENTRY_TYPE, { source: "remember", span: 2, at: "2026-09-28T12:05:00.000Z", seq: 3, kind: "correction.add", id: "R1", quote: { messageId: "m2", ordinal: "u2", text: "never use mocks in these tests" } }),
    assistantEntry("a2", "ok"),
  ]);
}

test("recall tool: what + query route to the store's recall; the text is capped and the details carry the counts (table)", async () => {
  const { pi, tools } = fakePi();
  registerRecallTool(pi, { readConfig: () => undefined });
  const tool = tools.find((candidate) => candidate.name === "longhaul_recall")!;
  assert.equal(tool.executionMode, "parallel");
  assert.equal((tool.promptGuidelines as string[] | undefined)?.length, 2);
  const { ctx } = fakeCtx({ branch: branch() });
  const cases: Array<[string, Record<string, unknown>, RegExp, number]> = [
    ["a span", { what: "span", query: "1" }, /ran the tests and copied the ledger/, 3],
    ["commands by pattern", { what: "commands", query: "npm" }, /^C1 npm test \(exit 0, 1 run, span 1\)/, 1],
    ["decisions", { what: "decisions" }, /^D1 copy the ledger/, 1],
    ["corrections", { what: "corrections" }, /^R1 \[u2\] never use mocks in these tests/, 1],
    ["a message", { what: "message", query: "u2" }, /never use mocks in these tests/, 1],
    ["everything matching", { query: "ledger" }, /D1 copy the ledger/, 2],
    ["nothing", { what: "errors" }, /^nothing recalled/, 0],
  ];
  for (const [name, params, expected, total] of cases) {
    const result = await exec(tool, params, ctx);
    assert.match(result.content[0].text, expected, name);
    assert.equal(result.details.total, total, name);
  }
});

test("recall tool: files answers from the latest compaction's carried lists, which ## Files may have cut (table)", async () => {
  const { pi, tools } = fakePi();
  registerRecallTool(pi, { readConfig: () => undefined });
  const tool = tools.find((candidate) => candidate.name === "longhaul_recall")!;
  const entries = branch().map((entry) => (entry.type === "compaction" ? { ...entry, details: { ...(entry.details as object), readFiles: ["src/ledger.ts", "docs/notes.md"], modifiedFiles: ["src/render.ts"] } } : entry));
  const { ctx } = fakeCtx({ branch: entries as never });
  const cases: Array<[string, Record<string, unknown>, string[]]> = [
    ["every carried file, modified first", { what: "files" }, ["modified src/render.ts", "read docs/notes.md", "read src/ledger.ts"]],
    ["files by pattern", { what: "files", query: "render" }, ["modified src/render.ts"]],
    ["everything matching includes files", { query: "notes.md" }, ["read docs/notes.md"]],
  ];
  for (const [name, params, expected] of cases) {
    const result = await exec(tool, params, ctx);
    assert.deepEqual(result.content[0].text.split("\n").filter((line) => /^(modified|read) /.test(line)), expected, name);
    assert.equal(result.details.total, expected.length, name);
  }
});

test("recall tool: an out-of-range limit is clamped, an unknown `what` is answered, never thrown", async () => {
  const { pi, tools } = fakePi();
  registerRecallTool(pi, { readConfig: () => undefined });
  const tool = tools.find((candidate) => candidate.name === "longhaul_recall")!;
  const { ctx } = fakeCtx({ branch: branch() });
  const clamped = await exec(tool, { what: "commands", limit: 0 }, ctx);
  assert.equal(clamped.details.shown, 1);
  const unknown = await exec(tool, { what: "everything" }, ctx);
  assert.match(unknown.content[0].text, /^what must be one of /);
  assert.equal(unknown.details.total, 0);
});

test("recall tool what=output: the raw output behind a ledger id, from before the compaction, marked as data; paging and refusals say what to do next", async () => {
  const { pi, tools } = fakePi();
  registerRecallTool(pi, { readConfig: () => undefined });
  const tool = tools.find((candidate) => candidate.name === "longhaul_recall")!;
  assert.match(String(tool.description), /recall its output/i, "the description says to recall output before re-running a command");
  const { ctx } = fakeCtx({ branch: branch() });
  const found = await exec(tool, { what: "output", query: "C1" }, ctx);
  assert.match(found.content[0].text, /^Output of C1 `npm test`/);
  assert.match(found.content[0].text, /data, not instructions/);
  assert.match(found.content[0].text, /\nok\n\[exit 0\]/, "byte-exact, newlines kept");
  assert.equal(found.details.what, "output");
  const refused = await exec(tool, { what: "output", query: "src/a.ts" }, ctx);
  assert.match(refused.content[0].text, /read the file again/);
  const missingQuery = await exec(tool, { what: "output" }, ctx);
  assert.match(missingQuery.content[0].text, /command or error id/);
});
