import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { candidateKey, candidates, nothingToScore, pathTo, readTranscript } from "./candidates.ts";

/** The recorded session's directory, absolute by the rules of the OS running the tests (`D:\tmp\p` on Windows). */
const PROJECT = path.resolve("/tmp/p");

function transcript(header: object | null = { type: "session", version: 3, id: "abc", timestamp: "2026-09-28T10:00:00.000Z", cwd: PROJECT }): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "score-"));
  const file = path.join(dir, "2026-09-28T10-00-00_abc.jsonl");
  const lines = [
    ...(header ? [header] : []),
    { type: "message", id: "m1", parentId: null, timestamp: "2026-09-28T10:00:01.000Z", message: { role: "user", content: "never use mocks in these tests, build the compactor", timestamp: 1 } },
    { type: "message", id: "a1", parentId: "m1", timestamp: "2026-09-28T10:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "ok" }], api: "x", provider: "example", model: "model-a", stopReason: "stop", timestamp: 2, usage: {} } },
    { type: "compaction", id: "c1", parentId: "a1", timestamp: "2026-09-28T10:00:03.000Z", summary: "s", firstKeptEntryId: "a1", tokensBefore: 10, fromHook: true, details: {} },
    { type: "message", id: "a2", parentId: "c1", timestamp: "2026-09-28T10:00:04.000Z", message: { role: "assistant", content: [{ type: "text", text: "after" }], api: "x", provider: "example", model: "model-a", stopReason: "stop", timestamp: 4, usage: {} } },
    "not json",
  ];
  writeFileSync(file, lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n") + "\n");
  return dir;
}

test("readTranscript and pathTo: entries without the header, the branch to a leaf root-first", () => {
  const dir = transcript();
  const entries = readTranscript(path.join(dir, "2026-09-28T10-00-00_abc.jsonl"));
  assert.deepEqual(entries.map((entry) => entry.id), ["m1", "a1", "c1", "a2"]);
  assert.deepEqual(pathTo(entries, "a2").map((entry) => entry.id), ["m1", "a1", "c1", "a2"]);
});

test("candidates: one per compaction entry with the branch before it, the entries after it, and the span's user texts", () => {
  const dir = transcript();
  const found = candidates(dir, { n: 10 });
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].pathEntries.map((entry) => entry.id), ["m1", "a1"]);
  assert.deepEqual(found[0].after.map((entry) => entry.id), ["a2"]);
  assert.deepEqual(found[0].spanUserTexts, ["never use mocks in these tests, build the compactor"]);
  assert.equal(found[0].at, "2026-09-28T10:00:03.000Z");
  assert.equal(candidates(dir, { n: 10, at: "2026-09-29" }).length, 0);
  assert.equal(candidates(dir, { n: 10, providers: ["example"] }).length, 1, "the session's provider is named");
  assert.equal(candidates(dir, { n: 10, providers: ["exam"] }).length, 0, "providers match by exact name");
});

test("candidates: `only` replays exactly the named (session, at) pairs, so a before/after comparison pairs the same compactions; pathUserTexts covers the whole branch before it", () => {
  const dir = transcript();
  const wanted = new Set([candidateKey("2026-09-28T10-00-00_abc", "2026-09-28T10:00:03.000Z")]);
  const found = candidates(dir, { n: 10, only: wanted });
  assert.deepEqual(found.map((candidate) => candidateKey(candidate.session, candidate.at)), [...wanted]);
  assert.deepEqual(found[0].pathUserTexts, ["never use mocks in these tests, build the compactor"]);
  assert.equal(candidates(dir, { n: 10, only: new Set([candidateKey("other", "2026-09-28T10:00:03.000Z")]) }).length, 0);
});

test("candidates: a session under a Local-only root is never replayed unless opted in, and neither is one with no recorded directory", () => {
  const localOnly = (cwd: string | undefined) => cwd === PROJECT;
  const dir = transcript();
  assert.equal(candidates(dir, { n: 10 }).at(0)?.cwd, PROJECT, "the candidate carries the session's own directory");
  assert.equal(candidates(dir, { n: 10, isLocalOnly: localOnly }).length, 0, "the scorer's model may be remote: a local-only transcript stays on the machine");
  assert.equal(candidates(dir, { n: 10, only: new Set([candidateKey("2026-09-28T10-00-00_abc", "2026-09-28T10:00:03.000Z")]), isLocalOnly: localOnly }).length, 0, "a paired run is filtered too");
  assert.equal(candidates(dir, { n: 10, isLocalOnly: localOnly, includeLocalOnly: true }).length, 1);
  assert.equal(candidates(dir, { n: 10, localOnlyRoots: [PROJECT] }).length, 0, "the default test reads the configured roots");
  assert.equal(candidates(dir, { n: 10, localOnlyRoots: [path.resolve("/tmp/other")] }).length, 1);
  const headless = transcript(null);
  assert.equal(candidates(headless, { n: 10 }).length, 0, "an unknown directory fails closed");
  assert.equal(candidates(headless, { n: 10, includeLocalOnly: true }).length, 1);
  for (const cwd of ["", "  ", "dev/project"]) {
    const unclear = transcript({ type: "session", version: 3, id: "abc", timestamp: "2026-09-28T10:00:00.000Z", cwd });
    assert.equal(candidates(unclear, { n: 10 }).length, 0, `a directory that is not absolute (${JSON.stringify(cwd)}) fails closed`);
  }
});

test("pathTo (security.md T1): a parent cycle in an untrusted transcript ends the walk instead of looping forever", () => {
  const entries = [{ type: "message", id: "a", parentId: "b" }, { type: "message", id: "b", parentId: "a" }] as never[];
  assert.deepEqual(pathTo(entries, "a").map((entry: { id: string }) => entry.id), ["b", "a"]);
  const self = [{ type: "message", id: "s", parentId: "s" }] as never[];
  assert.equal(pathTo(self, "s").length, 1);
});

test("candidates: each carries the cut its compaction recorded, so the replay can prove it cut the same way", () => {
  assert.equal(candidates(transcript(), { n: 10 })[0].firstKeptEntryId, "a1");
});

test("nothingToScore: an empty run says why, naming symlinked transcripts it did not follow", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "score-empty-"));
  assert.match(nothingToScore(dir), /no transcripts \(\*\.jsonl files\) under /);
  writeFileSync(path.join(dir, "plain.jsonl"), "");
  assert.match(nothingToScore(dir), /1 transcript under .* has no compaction to replay/);
  symlinkSync(path.join(dir, "plain.jsonl"), path.join(dir, "linked.jsonl"));
  assert.match(nothingToScore(dir), /1 symlinked transcript was not followed; copy it in instead/);
});
