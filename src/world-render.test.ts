import test from "node:test";
import assert from "node:assert/strict";

import type { CommandRecord, ErrorRecord, WorkspaceSnapshot } from "./ledger/handoff.ts";
import type { Claim } from "./world.ts";
import { ageLabel, evaluateDoneGate, openErrors, renderDoneGate, renderWorldLines } from "./world-render.ts";
import { DEFAULT_CAPS } from "./store/events.ts";

const command = (id: string, text: string, lastExitCode: number | null, runs = 1): CommandRecord => ({ id, command: text, runs, lastExitCode, failedThenSucceeded: false, lastSeenPass: 2 });
const claim = (commandRef: string, exitCode: number | null, stale = false, kind: Claim["kind"] = "test"): Claim => ({ kind, commandRef, exitCode, at: "2026-09-28T10:00:00.000Z", commit: "ab12cd", dirty: false, stale });
const clean: WorkspaceSnapshot = { capturedAt: "2026-09-28T10:00:00.000Z", cwd: "/repo", branch: "main", commit: "ab12cd" };
const dirty: WorkspaceSnapshot = { ...clean, statusShort: " M a.ts\n M b.ts\n?? c.ts", diffStat: " 2 files changed, 4 insertions(+)" };
const error = (id: string, signature: string, resolved: boolean, sourceCommand?: string): ErrorRecord => ({ id, signature, resolved, lastSeenPass: 3, sourceCommand });

test("evaluateDoneGate (table): a doneWhen naming a ledger command byte-exact after whitespace normalisation, or by its C<n>, is mechanical", () => {
  const commands = [command("C1", "npm test", 0), command("C2", "make check", 1)];
  const cases: Array<{ name: string; doneWhen?: string; claims: Claim[]; snapshot?: WorkspaceSnapshot; expect: Partial<Extract<ReturnType<typeof evaluateDoneGate>, { kind: "mechanical" }>> | { kind: "not-mechanical" } }> = [
    { name: "no doneWhen", doneWhen: undefined, claims: [], expect: { kind: "not-mechanical" } },
    { name: "words only", doneWhen: "when the tests are green and reviewed", claims: [], expect: { kind: "not-mechanical" } },
    { name: "command quoted, green, clean: met", doneWhen: "done when `npm test` passes", claims: [claim("C1", 0)], snapshot: clean, expect: { kind: "mechanical", commandRef: "C1", met: true, clean: true } },
    { name: "extra whitespace still matches", doneWhen: "done when   npm    test   passes", claims: [claim("C1", 0)], snapshot: clean, expect: { kind: "mechanical", commandRef: "C1" } },
    { name: "by id", doneWhen: "C2 exits 0", claims: [claim("C2", 1)], snapshot: clean, expect: { kind: "mechanical", commandRef: "C2", met: false, reason: "last exit 1" } },
    { name: "stale claim", doneWhen: "npm test", claims: [claim("C1", 0, true)], snapshot: clean, expect: { met: false, reason: "tree changed since the run" } },
    { name: "dirty tree", doneWhen: "npm test", claims: [claim("C1", 0)], snapshot: dirty, expect: { met: false, clean: false, reason: "tree dirty" } },
    { name: "no claim yet (never ran)", doneWhen: "npm test", claims: [], snapshot: clean, expect: { kind: "mechanical", exitCode: null, met: false, reason: "not run yet" } },
    { name: "no snapshot: clean unknown, not met", doneWhen: "npm test", claims: [claim("C1", 0)], snapshot: undefined, expect: { met: false, clean: undefined, reason: "tree state unknown" } },
  ];
  for (const c of cases) {
    const gate = evaluateDoneGate(c.doneWhen, commands, c.claims, c.snapshot);
    for (const [key, value] of Object.entries(c.expect)) assert.deepEqual((gate as Record<string, unknown>)[key], value, `${c.name}: ${key}`);
  }
});

test("evaluateDoneGate: the longest matching command wins so `npm test` inside `npm test -- x` binds the longer one", () => {
  const commands = [command("C1", "npm test", 0), command("C2", "npm test -- --grep x", 0)];
  assert.equal((evaluateDoneGate("run npm test -- --grep x", commands, [], clean) as { commandRef: string }).commandRef, "C2");
});

test("renderDoneGate: the two shapes", () => {
  assert.equal(renderDoneGate({ kind: "not-mechanical" }), "Done gate: not mechanical (acceptance in words)");
  assert.equal(renderDoneGate({ kind: "mechanical", commandRef: "C1", command: "npm test", exitCode: 0, commit: "ab12cd", clean: true, stale: false, met: true }), "Done gate: `npm test` last exit 0 @ ab12cd, clean tree: yes, met");
  assert.equal(renderDoneGate({ kind: "mechanical", commandRef: "C1", command: "npm test", exitCode: 1, commit: "ab12cd", clean: false, stale: false, met: false, reason: "last exit 1" }), "Done gate: `npm test` last exit 1 @ ab12cd, clean tree: no, not met (last exit 1)");
  assert.equal(renderDoneGate({ kind: "mechanical", commandRef: "C1", command: "npm test", exitCode: null, clean: undefined, stale: false, met: false, reason: "not run yet" }), "Done gate: `npm test` last exit -, clean tree: unknown, not met (not run yet)");
});

test("openErrors: unresolved only, newest id first, capped", () => {
  const errors = [error("E1", "a", false), error("E2", "b", true), error("E3", "c", false), error("E4", "d", false)];
  assert.deepEqual(openErrors(errors, 2).map((e) => e.id), ["E4", "E3"]);
});

test("renderWorldLines: branch/commit/tree line, one last-run line per claim kind, open errors; capped to worldChars", () => {
  const lines = renderWorldLines({
    snapshot: dirty,
    claims: [claim("C1", 0), claim("C3", 2, true, "lint")],
    commands: [command("C1", "npm test", 0), command("C3", "make lint", 2, 3)],
    errors: [error("E4", "Error: ECONNREFUSED 127.0.0.1:8081\n    at connect", false, "make lint")],
    pass: 4,
    caps: { openErrors: 5, worldChars: 1200 },
  });
  assert.deepEqual(lines, [
    "branch main @ ab12cd, tree dirty (3 files):  2 files changed, 4 insertions(+)",
    "last test: `npm test` exit 0 @ ab12cd, tree changed since: no",
    "last lint: `make lint` exit 2 @ ab12cd, tree changed since: yes",
    "open errors: E4 Error: ECONNREFUSED 127.0.0.1:8081 (last seen span 3; make lint ran 3×)",
  ]);
  assert.deepEqual(renderWorldLines({ snapshot: undefined, claims: [], commands: [], errors: [], pass: 1, caps: { openErrors: 5, worldChars: 1200 } }), ["branch unknown (no snapshot)", "no claims yet"]);
  const long = renderWorldLines({ snapshot: clean, claims: [], commands: [], errors: Array.from({ length: 5 }, (_, i) => error(`E${i + 1}`, "x".repeat(400), false)), pass: 1, caps: { openErrors: 5, worldChars: 600 } });
  assert.ok(long.join("\n").length <= 600, `${long.join("\n").length} chars`);
  assert.ok(long.at(-1)?.endsWith("… (longhaul_recall errors)"));
});

test("renderWorldLines: a test or build carries its age as of the compaction; a claim without a run time has none", () => {
  const commands = [command("C1", "npm test", 0), command("C2", "npm run build", 0)];
  const claims = [{ ...claim("C1", 0), ranAt: "2026-09-28T09:46:00.000Z" }, claim("C2", 0, false, "build")];
  const lines = renderWorldLines({ snapshot: clean, claims, commands, errors: [], pass: 2, caps: DEFAULT_CAPS });
  assert.match(lines.find((line) => line.startsWith("last test"))!, /exit 0 @ ab12cd, ran 14m before compaction, tree changed since: no$/);
  assert.match(lines.find((line) => line.startsWith("last build"))!, /exit 0 @ ab12cd, tree changed since: no$/);
});

test("renderWorldLines: with no snapshot (no git repo, capture skipped) ages are measured against the compaction time", () => {
  const claims = [{ ...claim("C1", 0), ranAt: "2026-09-28T09:46:00.000Z" }];
  const lines = renderWorldLines({ claims, commands: [command("C1", "npm test", 0)], errors: [], pass: 2, caps: DEFAULT_CAPS, compactedAt: "2026-09-28T10:00:00.000Z" });
  assert.match(lines.find((line) => line.startsWith("last test"))!, /ran 14m before compaction/);
});

test("ageLabel (table): minutes, hours, days; under a minute; a future or unreadable time has no age", () => {
  const cases: Array<[string, string | undefined, string | undefined]> = [
    ["seconds", "2026-09-28T09:59:30.000Z", "under 1m"],
    ["minutes", "2026-09-28T09:46:00.000Z", "14m"],
    ["hours round down", "2026-09-28T06:59:00.000Z", "3h"],
    ["days", "2026-09-26T09:00:00.000Z", "2d"],
    ["future (clock skew)", "2026-09-28T10:05:00.000Z", undefined],
    ["unreadable", "not a time", undefined],
    ["missing", undefined, undefined],
  ];
  for (const [name, ranAt, expected] of cases) assert.equal(ageLabel(ranAt, "2026-09-28T10:00:00.000Z"), expected, name);
});
