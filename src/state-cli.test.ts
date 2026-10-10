import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { newestTranscript, parseArgs, runStateCli } from "./state-cli.ts";

type Forge = { narrative?: string; fromRef?: string; toRef?: string; decision?: Record<string, unknown>; readFiles?: string[]; learnedValues?: Array<{ value: string; source: string }> };

function transcript(name = "2026-09-28T10-00-00_abc.jsonl", forge: Forge = {}): { dir: string; file: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "state-cli-"));
  const file = path.join(dir, name);
  const close = { source: "pass", span: 1, at: "2026-09-28T10:00:03.000Z", seq: 2, kind: "span.close", fromRef: forge.fromRef ?? "u1", toRef: forge.toRef ?? "u1", narrative: forge.narrative ?? "built the thing", narrativeLess: false, world: { claims: [], openErrorIds: [] } };
  const objective = { source: "pass", span: 1, at: "2026-09-28T10:00:03.000Z", seq: 1, kind: "objective.set", quote: { messageId: "m1", ordinal: "u1", text: "Build the state compactor and keep it small please" } };
  const lines = [
    { type: "session", version: 3, id: "abc", timestamp: "2026-09-28T10:00:00.000Z", cwd: "/tmp/p" },
    { type: "message", id: "m1", parentId: null, timestamp: "2026-09-28T10:00:01.000Z", message: { role: "user", content: "Build the state compactor and keep it small please", timestamp: 1 } },
    { type: "message", id: "a1", parentId: "m1", timestamp: "2026-09-28T10:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "ok" }], api: "x", provider: "example", model: "model-a", stopReason: "stop", timestamp: 2, usage: {} } },
    { type: "compaction", id: "c1", parentId: "a1", timestamp: "2026-09-28T10:00:03.000Z", summary: "s", firstKeptEntryId: "a1", tokensBefore: 90500, fromHook: true, details: { compactor: "state", state: {}, caps: {}, ledger: { commands: [], errors: [] }, narrative: {}, readFiles: forge.readFiles ?? [], modifiedFiles: [], ...(forge.learnedValues ? { learnedValues: forge.learnedValues } : {}) } },
    { type: "custom", id: "s1", parentId: "c1", timestamp: "2026-09-28T10:00:04.000Z", customType: "compaction-state.span", data: { v: 1, span: 1, compactionEntryId: "c1", events: forge.decision ? [objective, { ...forge.decision, seq: 2 }, { ...close, seq: 3 }] : [objective, close], ledger: { commands: [], errors: [] } } },
  ];
  writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  return { dir, file };
}

test("parseArgs: a file, a session dir, flags; unknown flags are an error", () => {
  assert.deepEqual(parseArgs(["/tmp/x.jsonl", "--json"]), { file: "/tmp/x.jsonl", sessionDir: undefined, span: undefined, json: true, spans: false, anomalies: false });
  assert.deepEqual(parseArgs(["--session-dir", "/tmp/d", "--span", "2", "--spans", "--anomalies"]), { file: undefined, sessionDir: "/tmp/d", span: 2, json: false, spans: true, anomalies: true });
  assert.deepEqual(parseArgs(["--bogus"]), { error: "unknown flag --bogus" });
  assert.deepEqual(parseArgs(["--span", "x"]), { error: "--span needs a positive integer" });
});

test("runStateCli: renders the newest transcript's state; --json prints the projection; --spans lists the record; --span picks the checkpoint", () => {
  const { dir, file } = transcript();
  assert.equal(newestTranscript(dir), file);
  const out: string[] = [];
  assert.equal(runStateCli({ sessionDir: dir, json: false, spans: false, anomalies: false }, (text) => out.push(text)), 0);
  assert.match(out.join(""), /^# Session state \(span 2, 91k tokens compacted\)/, "the header carries the checkpoint's compaction size, not 0");
  assert.match(out.join(""), /Build the state compactor and keep it small please/);
  const json: string[] = [];
  runStateCli({ file, json: true, spans: false, anomalies: false }, (text) => json.push(text));
  assert.equal(JSON.parse(json.join("")).objective.quote.ordinal, "u1");
  const spans: string[] = [];
  runStateCli({ file, json: false, spans: true, anomalies: false }, (text) => spans.push(text));
  assert.match(spans.join(""), /span 1: entry c1, 2 events, 0 commands, 0 errors, narrative: built the thing/);
  // One might expect `projectAt` to return a state whose `span` is the named one; measured, it filters
  // the events to span <= N and keeps the log's open span (consistent with the header always showing the
  // state's own span). So the span-1 view still heads with span 2; what it proves is
  // that the projection is the span-1 one.
  const at: string[] = [];
  runStateCli({ file, span: 1, json: false, spans: false, anomalies: false }, (text) => at.push(text));
  assert.match(at.join(""), /^# Session state \(span 2/);
  assert.match(at.join(""), /\[u1–u1\] built the thing/);
});

test("runStateCli: the latest state shows the carried files, as the model saw them; a --span view does not claim them", () => {
  const { file } = transcript(undefined, { readFiles: ["src/carried.ts"] });
  const out: string[] = [];
  runStateCli({ file, json: false, spans: false, anomalies: false }, (text) => out.push(text));
  assert.match(out.join(""), /## Files \(modified, then read; newest first\)\nRead: src\/carried\.ts/);
  const at: string[] = [];
  runStateCli({ file, span: 1, json: false, spans: false, anomalies: false }, (text) => at.push(text));
  assert.doesNotMatch(at.join(""), /## Files/);
});

test("runStateCli: a missing file or empty dir is exit 1 with a message, never a throw", () => {
  const out: string[] = [];
  assert.equal(runStateCli({ file: "/nonexistent/x.jsonl", json: false, spans: false, anomalies: false }, (text) => out.push(text)), 1);
  assert.match(out.join(""), /cannot read/);
  const empty = mkdtempSync(path.join(os.tmpdir(), "state-cli-empty-"));
  assert.equal(runStateCli({ sessionDir: empty, json: false, spans: false, anomalies: false }, (text) => out.push(text)), 1);
  assert.match(out.join(""), /no transcript/);
});

test("runStateCli: control characters in a forged transcript never reach stdout (security.md T1): C0, DEL and C1 are stripped from --spans and from the rendered state", () => {
  const decision = { source: "pass", span: 1, at: "2026-09-28T10:00:03.000Z", kind: "decision.add", id: "D1\u001b[0m", text: "copy\u0085the ledger", evidence: "C1\u007f" };
  const { file } = transcript("2026-09-28T10-00-00_forged.jsonl", { narrative: "built\u001b]0;pwned\u0007 the thing", fromRef: "u1\u001b[31m", toRef: "u1\u009b31m", decision });
  const controls = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/;
  for (const spans of [true, false]) {
    const out: string[] = [];
    assert.equal(runStateCli({ file, json: false, spans, anomalies: false }, (text) => out.push(text)), 0);
    const text = out.join("");
    assert.equal(controls.test(text), false, `${spans ? "--spans" : "render"} output carries a control character: ${JSON.stringify(text.match(controls))}`);
    assert.match(text, spans ? /narrative: built/ : /D1.*copy.the ledger/);
  }
});

test("runStateCli: the latest state shows the carried Learned values; a --span view does not claim them", () => {
  const { file } = transcript(undefined, { learnedValues: [{ value: "70eaffb", source: "C1" }] });
  const latest: string[] = [];
  runStateCli({ file, json: false, spans: false, anomalies: false }, (text) => latest.push(text));
  assert.match(latest.join(""), /## Learned values[^\n]*\n- 70eaffb \(C1\)/);
  const at: string[] = [];
  runStateCli({ file, span: 1, json: false, spans: false, anomalies: false }, (text) => at.push(text));
  assert.doesNotMatch(at.join(""), /Learned values/);
});

test("runStateCli: with no file and no --session-dir, it reads the sessions of pi's agent dir, PI_CODING_AGENT_DIR included", (t) => {
  const { file } = transcript();
  const agentDir = mkdtempSync(path.join(os.tmpdir(), "state-cli-agent-"));
  const sessions = path.join(agentDir, "sessions", "--tmp-p--");
  mkdirSync(sessions, { recursive: true });
  writeFileSync(path.join(sessions, path.basename(file)), readFileSync(file));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; });
  const out: string[] = [];
  assert.equal(runStateCli({ json: false, spans: true, anomalies: false }, (text) => out.push(text)), 0, out.join(""));
  assert.match(out.join(""), /span 1: entry c1/);
});
