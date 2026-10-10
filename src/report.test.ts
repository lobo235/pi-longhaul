/**
 * /longhaul-report (report.ts): what an issue needs to reproduce a problem, and nothing that names the user's
 * directories, providers, models or messages.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildReport, digestRecord, modelClass, readLastRecords } from "./report.ts";
import { resolveStateConfig } from "./config.ts";
import { modelWith } from "./test-support.ts";

const HOME = "/home/someone";

test("digestRecord: numbers, booleans and short tokens stay; names, paths, prose and message text go", () => {
  const record = {
    at: "2026-10-06T22:00:00.000Z", event: "compaction", reason: "threshold", span: 3, tokensBefore: 90_000, capExhausted: false,
    cwd: "/home/someone/dev/secret", sessionId: "019a-x", sessionModel: "private-gw/model-x",
    route: { spec: "private-gw/fast", rule: "config", model: "private-gw/fast", localOnlyRoot: "/srv/x", routeAvailable: true },
    narrative: { kind: "diff", calls: [{ verdict: "diff", stopReason: "stop", usage: { input: 10, output: 5 }, provider: "private-gw" }], excerpt: "never use mocks in these tests" },
    rejected: [{ code: "quote-mismatch", quote: "the user's own words" }],
  };
  assert.deepEqual(digestRecord(record, HOME), {
    at: "2026-10-06T22:00:00.000Z", event: "compaction", reason: "threshold", span: 3, tokensBefore: 90_000, capExhausted: false,
    route: { rule: "config", routeAvailable: true },
    narrative: { kind: "diff", calls: [{ verdict: "diff", stopReason: "stop", usage: { input: 10, output: 5 } }] },
    rejected: [{ code: "quote-mismatch" }],
  });
});

test("digestRecord: an error message is kept for triage, with home, URLs and IP addresses masked", () => {
  const raw = "fetch failed: connect ECONNREFUSED 192.0.2.10:4000 (https://gw.internal.example/v1) in /home/someone/x.ts";
  const masked = "fetch failed: connect ECONNREFUSED <ip> (<url>) in ~/x.ts";
  assert.deepEqual(digestRecord({ event: "fallback", errorClass: "TypeError", error: raw }, HOME), { event: "fallback", errorClass: "TypeError", error: masked }, "the log's own field");
  assert.deepEqual(digestRecord({ event: "fallback", message: raw }, HOME), { event: "fallback", message: masked });
});

test("readLastRecords: the newest records, malformed lines skipped, a missing or non-file log is none", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "longhaul-report-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, "log.jsonl");
  fs.writeFileSync(log, [...Array.from({ length: 12 }, (_, i) => JSON.stringify({ event: "e", n: i })), "{broken", ""].join("\n"));
  assert.deepEqual(readLastRecords(log, 3).map((record) => (record as { n: number }).n), [9, 10, 11]);
  assert.deepEqual(readLastRecords(path.join(dir, "absent.jsonl"), 3), []);
  assert.deepEqual(readLastRecords(dir, 3), []);
});

test("modelClass: no reasoning, reasoning that can be turned off, or a must-reason model", () => {
  assert.equal(modelClass(modelWith({ reasoning: false })), "no reasoning");
  assert.equal(modelClass(modelWith({ reasoning: true })), "reasoning, can be turned off");
  assert.equal(modelClass(modelWith({ reasoning: true, thinkingLevelMap: { off: null } })), "must-reason (reasoning cannot be turned off)");
  assert.equal(modelClass(undefined), "no model selected");
});

test("buildReport: versions, the model's API and class, which config keys are set (never their values), and the digested records", () => {
  const config = resolveStateConfig(() => JSON.stringify({ model: "private-gw/fast", routeProviders: ["private-gw"], localOnlyRoots: ["~/dev/secret"], narrativeMode: "turns", keptWindowThinking: "keep" }));
  const report = buildReport({
    longhaulVersion: "1.0.0-rc.1", piVersion: "1.0.4", piStatus: "exact", node: "v24.1.0", platform: "linux",
    model: modelWith({ provider: "private-gw", id: "model-x", api: "openai-completions", contextWindow: 131072 } as never),
    configKeys: ["model", "routeProviders", "localOnlyRoots", "narrativeMode", "keptWindowThinking"], config,
    records: [{ event: "compaction", cwd: "/home/someone/dev/secret", span: 2 }], home: HOME,
  });
  for (const expected of ["1.0.0-rc.1", "pi 1.0.4 (verified)", "v24.1.0", "openai-completions", "131072", "reasoning, can be turned off", "narrativeMode: turns", "keptWindowThinking: keep", "routeProviders (1)", "localOnlyRoots (1)", '"span":2']) {
    assert.ok(report.includes(expected), `missing ${expected}`);
  }
  for (const leaked of ["private-gw", "model-x", "secret", "/home/someone"]) assert.ok(!report.includes(leaked), `leaked ${leaked}`);
});
