/** The learned-facts probe (score/facts.ts): deterministic, no model judge. */
import assert from "node:assert/strict";
import test from "node:test";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import { assistantEntry, chain, toolResultEntry, userEntry } from "../test-support.ts";
import { factCoverage, factNeeds, factTokens, isCodeNameFact, OUTPUT_CHARS, recordedFacts } from "./facts.ts";

test("factTokens (table): paths by basename, hashes, uuids, versions, long numbers and compound identifiers; short or plain words are not facts", () => {
  const cases: Array<[string, string, string[]]> = [
    ["path", "found in src/store/project.ts:112", ["project.ts"]],
    ["commit", "HEAD is now at 58fe0d0 CONTEXT", ["58fe0d0"]],
    ["uuid", "session 01a0fef2-3b4c-4d5e-8f90-123456789abc started", ["01a0fef2-3b4c-4d5e-8f90-123456789abc"]],
    ["version", "pi 1.0.2 installed, node v26.8.2", ["1.0.2", "v26.8.2"]],
    ["port", "listening on :8081", ["8081"]],
    ["snake and camel", "call resolve_log_path then buildMessageIndex", ["resolve_log_path", "buildMessageIndex"]],
    ["plain", "all 12 tests pass in the suite today", []],
    ["word-only hex", "deadbeef cafebabe", []],
  ];
  for (const [name, text, expected] of cases) assert.deepEqual(factTokens(text).map((fact) => fact.value).sort(), [...expected].sort(), name);
});

test("factCoverage: a fact the rendered text lacks but longhaul_recall finds counts toward keptWithRecall only; kept stays the text alone", () => {
  const facts = factTokens("pass.ts 58fe0d0 buildMessageIndex").map((fact) => ({ ...fact }));
  const coverage = factCoverage(facts, "edited pass.ts", (needle) => needle === "buildMessageIndex");
  assert.equal(coverage.kept, 1);
  assert.equal(coverage.keptWithRecall, 2);
  assert.equal(factCoverage(facts, "edited pass.ts").keptWithRecall, 1, "no recall: the same as kept");
});

test("factNeeds (includeSaid): a value from the span's tool output that the span also used, and that is needed again after the cut, is a reused value", () => {
  const span = chain([
    userEntry("u1", "start the server"),
    assistantEntry("a1", "", [{ name: "bash", arguments: { command: "npm start" } }]),
    toolResultEntry("r1", "a1-t0", "bash", "listening on 7232, pid 48213"),
    assistantEntry("a2", "It listens on 7232."),
  ]);
  const after = chain([assistantEntry("a3", "", [{ name: "bash", arguments: { command: "curl localhost:7232/health" } }])]);
  assert.deepEqual(factNeeds({ span, kept: [], after }).map((fact) => fact.value), [], "facts exclude what the span said");
  assert.deepEqual(factNeeds({ span, kept: [], after, includeSaid: true }).map((fact) => fact.value), ["7232"]);
});

test("isCodeNameFact (table): identifiers and dotted names without a file extension are code; files and name formats are not", () => {
  const cases: Array<[string, boolean]> = [["buildMessageIndex", true], ["process.exit", true], ["performance.now", true], ["server.ts", false], ["sample-semi.csv", false], ["backup.tar.gz", false], ["<base>-YYYYMMDD.tar.gz", false], ["8081", false], ["58fe0d0", false]];
  for (const [value, code] of cases) assert.equal(isCodeNameFact(factTokens(value)[0]), code, value);
});

const grepCall = (id: string) => assistantEntry(id, "", [{ name: "bash", arguments: { command: "rg -n defaultObjective" } }]);

test("factNeeds: a value first seen in the span's tool output and used again in the next assistant messages; not one the span's calls or user named, nor one the kept window still shows", () => {
  const span = chain([
    userEntry("u1", "find where the objective is set"),
    grepCall("a1"),
    toolResultEntry("r1", "a1-t0", "bash", "pass.ts:121:function defaultObjectiveEvent\nintent.ts:141:function defaultObjectiveOf\nport 8081 fixed in 58fe0d0"),
    assistantEntry("a2", "Found it."),
  ]);
  const kept = chain([assistantEntry("a3", "", [{ name: "bash", arguments: { command: "git show 58fe0d0" } }]), toolResultEntry("r3", "a3-t0", "bash", "ok")]);
  const after = chain([
    assistantEntry("a4", "", [{ name: "edit", arguments: { path: "pass.ts", oldText: "defaultObjectiveEvent(" } }]),
    assistantEntry("a5", "The daemon listens on 8081 (since 58fe0d0) and intent.ts is untouched; defaultObjective stays."),
  ]);
  const needs = factNeeds({ span, kept, after });
  assert.deepEqual(needs.map((fact) => fact.value).sort(), ["8081", "defaultObjectiveEvent", "intent.ts", "pass.ts"].sort());
});

test("factCoverage: a fact is kept when the rendered state carries it; counts by kind, the facts themselves never leave as text", () => {
  const facts = [{ value: "8081", kind: "number" as const }, { value: "pass.ts", kind: "path" as const }, { value: "58fe0d0", kind: "hash" as const }];
  assert.deepEqual(factCoverage(facts, "## World\nlast test ... pass.ts edited; daemon on 8081"), { kept: 2, keptWithRecall: 2, total: 3, share: 2 / 3, byKind: { number: { kept: 1, total: 1 }, path: { kept: 1, total: 1 }, hash: { kept: 0, total: 1 } } });
  assert.deepEqual(factCoverage([], "anything"), { kept: 0, keptWithRecall: 0, total: 0, share: null, byKind: {} });
});

test("recordedFacts: each recorded compaction scored against its own summary; the span runs from the previous kept window to this one's", () => {
  const compaction = (id: string, firstKept: string, summary: string, compactor: "state" | "extension" | "pi") =>
    ({ type: "compaction", id, parentId: null, timestamp: new Date(0).toISOString(), summary, firstKeptEntryId: firstKept, tokensBefore: 1, details: compactor === "state" ? { compactor } : {}, fromHook: compactor !== "pi" }) as unknown as SessionEntry;
  const branch = chain([
    userEntry("u1", "check the daemon"),
    grepCall("a1"),
    toolResultEntry("r1", "a1-t0", "bash", "listening on 8081, build 58fe0d0"),
    assistantEntry("a2", "ok"),
    compaction("c1", "a2", "daemon on 8081", "state"),
    assistantEntry("a3", "Port 8081 and build 58fe0d0 noted."),
    userEntry("u2", "next"),
    assistantEntry("a4", "", [{ name: "bash", arguments: { command: "curl localhost:8082" } }]),
    toolResultEntry("r4", "a4-t0", "bash", "upstream 7f3e9a1 answered"),
    assistantEntry("a5", "fine"),
    compaction("c2", "a5", "nothing kept", "extension"),
    assistantEntry("a6", "Pinning 7f3e9a1."),
  ]);
  const rows = recordedFacts(branch);
  assert.deepEqual(rows.map((row) => ({ compactor: row.compactor, kept: row.coverage.kept, total: row.coverage.total })), [
    { compactor: "state", kept: 1, total: 2 },
    { compactor: "extension", kept: 0, total: 1 },
  ]);
});

test("factTokens (security.md T4): a long dotless run is linear, and absolute and relative paths still reduce to their basename", () => {
  const started = Date.now();
  factTokens(`${"a".repeat(200_000)}/${"b".repeat(50_000)}`);
  assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`);
  const values = factTokens("see /home/x/src/parse.ts and lib/util.go").map((fact) => fact.value);
  assert.ok(values.includes("parse.ts") && values.includes("util.go"), values.join(","));
});

test("factNeeds (security.md T4): only the first OUTPUT_CHARS of a tool output are searched", () => {
  const late = chain([
    userEntry("m1", "go"),
    assistantEntry("a1", "Fetching.", [{ name: "fetch", arguments: { url: "x" } }]),
    toolResultEntry("r1", "a1-t0", "fetch", `${"-".repeat(OUTPUT_CHARS)} 7f3a9c2e1b`),
  ]);
  const after = [assistantEntry("a2", "Using 7f3a9c2e1b now.")];
  assert.equal(factNeeds({ span: late, kept: [], after }).length, 0);
});
