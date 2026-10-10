import test from "node:test";
import assert from "node:assert/strict";

import type { CommandRecord, WorkspaceSnapshot } from "./ledger/handoff.ts";
import { bashCall, toolResult } from "./ledger/test-support.ts";
import { DEFAULT_CLAIM_PATTERNS, classifyClaim, deriveClaims, isDirty, observeWrites, type Claim } from "./world.ts";

const command = (id: string, text: string, lastExitCode: number | null, lastSeenPass: number, runs = 1): CommandRecord => ({ id, command: text, runs, lastExitCode, failedThenSucceeded: false, lastSeenPass });
const snapshot = (commit: string | undefined, statusShort?: string): WorkspaceSnapshot => ({ capturedAt: "2026-09-28T10:00:00.000Z", cwd: "/repo", branch: "main", commit, statusShort });
const NOW = "2026-09-28T10:00:00.000Z";
const noWrites = { writeAfterRun: new Set<string>(), anyWrite: false };

test("classifyClaim: leading tokens of the command or of any &&-segment match a pattern; a longer first token does not", () => {
  const cases: Array<[string, ReturnType<typeof classifyClaim>]> = [
    ["npm test", "test"],
    ["npm test -- --grep x", "test"],
    ["  npm   test", "test"],
    ["cd extensions/x && npm test", "test"],
    ["npm testx", undefined],
    ["make lint", "lint"],
    ["cargo build --release", "build"],
    ["golangci-lint run ./...", "lint"],
    ["tsc --noEmit -p tslonghaul.json", "build"],
    ["ls -la", undefined],
    ["echo npm test", undefined],
  ];
  for (const [text, kind] of cases) assert.equal(classifyClaim(text, DEFAULT_CLAIM_PATTERNS), kind, text);
  assert.equal(classifyClaim("./scripts/verify.sh", [{ pattern: "./scripts/verify.sh", kind: "custom" }]), "custom");
});

test("isDirty: undefined without a snapshot, false on an empty status, true otherwise", () => {
  assert.equal(isDirty(undefined), undefined);
  assert.equal(isDirty(snapshot("ab12cd")), false);
  assert.equal(isDirty(snapshot("ab12cd", " M a.ts")), true);
});

test("observeWrites: a write/edit tool call or a writing bash command after a command's last run marks it, in message order", () => {
  const messages = [
    ...bashCall("npm test", 0),
    { role: "assistant", content: [{ type: "toolCall", id: "w1", name: "edit", arguments: { path: "a.ts" } }], api: "x", provider: "x", model: "x", stopReason: "toolUse", timestamp: 1 },
    toolResult("w1", "edit", "ok", false),
    ...bashCall("make lint", 0),
    ...bashCall("sed -i 's/a/b/' a.ts", 0),
  ] as never[];
  const writes = observeWrites(messages);
  assert.equal(writes.anyWrite, true);
  assert.ok(writes.writeAfterRun.has("npm test"), "edit after npm test");
  assert.ok(writes.writeAfterRun.has("make lint"), "sed -i after make lint");
  assert.ok(!writes.writeAfterRun.has("sed -i 's/a/b/' a.ts"), "nothing after the last write");
  assert.deepEqual(observeWrites(bashCall("npm test", 0) as never[]), noWrites);
});

test("deriveClaims: the last run of a pattern command yields a claim bound to the pass's commit and tree state", () => {
  const claims = deriveClaims({ commands: [command("C1", "npm test", 0, 2), command("C2", "ls", 0, 2)], previous: [], pass: 2, snapshot: snapshot("ab12cd"), writes: noWrites, patterns: DEFAULT_CLAIM_PATTERNS, now: NOW });
  assert.deepEqual(claims, [{ kind: "test", commandRef: "C1", exitCode: 0, at: NOW, commit: "ab12cd", dirty: false, stale: false }]);
});

test("deriveClaims stale rules (table)", () => {
  const fresh: Claim = { kind: "test", commandRef: "C1", exitCode: 0, at: "2026-09-28T09:00:00.000Z", commit: "ab12cd", dirty: false, stale: false };
  const carried = command("C1", "npm test", 0, 1); // last ran in span 1; this is span 2
  const cases: Array<{ name: string; previous: Claim[]; commands: CommandRecord[]; snapshot?: WorkspaceSnapshot; writes: ReturnType<typeof observeWrites>; stale: boolean; at: string }> = [
    { name: "carried, nothing changed: not stale, keeps its timestamp", previous: [fresh], commands: [carried], snapshot: snapshot("ab12cd"), writes: noWrites, stale: false, at: fresh.at },
    { name: "a write after the run this span", previous: [], commands: [command("C1", "npm test", 0, 2)], snapshot: snapshot("ab12cd"), writes: { writeAfterRun: new Set(["npm test"]), anyWrite: true }, stale: true, at: NOW },
    { name: "carried and any write this span", previous: [fresh], commands: [carried], snapshot: snapshot("ab12cd"), writes: { writeAfterRun: new Set(), anyWrite: true }, stale: true, at: fresh.at },
    { name: "the commit moved", previous: [fresh], commands: [carried], snapshot: snapshot("ff00aa"), writes: noWrites, stale: true, at: fresh.at },
    { name: "clean at the claim, dirty now", previous: [fresh], commands: [carried], snapshot: snapshot("ab12cd", " M a.ts"), writes: noWrites, stale: true, at: fresh.at },
    { name: "once stale, stays stale until it runs again", previous: [{ ...fresh, stale: true }], commands: [carried], snapshot: snapshot("ab12cd"), writes: noWrites, stale: true, at: fresh.at },
    { name: "ran again this span: fresh claim", previous: [{ ...fresh, stale: true }], commands: [command("C1", "npm test", 1, 2, 2)], snapshot: snapshot("ab12cd"), writes: noWrites, stale: false, at: NOW },
    { name: "no snapshot: commit and dirty unknown, not stale by them", previous: [fresh], commands: [carried], snapshot: undefined, writes: noWrites, stale: false, at: fresh.at },
  ];
  for (const c of cases) {
    const [claim] = deriveClaims({ commands: c.commands, previous: c.previous, pass: 2, snapshot: c.snapshot, writes: c.writes, patterns: DEFAULT_CLAIM_PATTERNS, now: NOW });
    assert.equal(claim.stale, c.stale, c.name);
    assert.equal(claim.at, c.at, `${c.name}: at`);
  }
});

test("deriveClaims: a command no longer in the ledger has no claim; claims are ordered by command id", () => {
  const claims = deriveClaims({ commands: [command("C3", "make lint", 0, 2), command("C2", "npm test", 1, 2)], previous: [{ kind: "build", commandRef: "C9", exitCode: 0, at: NOW, stale: false }], pass: 2, snapshot: snapshot("ab12cd"), writes: noWrites, patterns: DEFAULT_CLAIM_PATTERNS, now: NOW });
  assert.deepEqual(claims.map((c) => c.commandRef), ["C2", "C3"]);
});
