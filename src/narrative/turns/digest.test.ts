import test from "node:test";
import assert from "node:assert/strict";

import type { CommandRecord, ErrorRecord } from "../../ledger/handoff.ts";
import { emptyState } from "../../store/project.ts";
import { promptStateOf } from "../prompt.ts";
import { buildDigest, SHOW_CHARS, type DigestInput } from "./digest.ts";

const command: CommandRecord = { id: "C1", command: "npm test", runs: 2, lastExitCode: 1, failedThenSucceeded: false, lastSeenPass: 3 };
const error: ErrorRecord = { id: "E1", signature: "FAIL src/a.test.ts", sourceCommand: "npm test", resolved: false, lastSeenPass: 3 };

function input(overrides: Partial<DigestInput> = {}): DigestInput {
  return {
    userMessages: [{ ordinal: "u4", text: "fix the failing test\nand never touch the fixtures" }],
    textOf: (ordinal) => (ordinal === "u1" ? "the original goal" : ordinal === "u4" ? "fix the failing test\nand never touch the fixtures" : undefined),
    commands: [command],
    errors: [error],
    files: { readFiles: ["src/a.ts"], modifiedFiles: ["src/a.test.ts"] },
    filesChars: 2500,
    worldLines: ["branch main @ abc123, tree clean", "open errors: E1 FAIL src/a.test.ts"],
    promptState: promptStateOf(emptyState(), []),
    transcript: { text: "T1 → bash: npm test\n  ← error: FAIL", outputs: new Map([["T1", "FAIL src/a.test.ts\nfull output"]]) },
    ...overrides,
  };
}

test("buildDigest: the user's words whole with ordinals, the ledger with outcomes, files, World, state and transcript, in that order of blocks", () => {
  const { text } = buildDigest(input());
  const order = ["<state>", "<user-messages>", "[u4] fix the failing test\nand never touch the fixtures", "<commands>", "C1 [runs:2 exit:1] npm test", "<errors>", "E1 [unresolved C1] FAIL src/a.test.ts", "## Files", "Modified: src/a.test.ts", "<world>", "open errors: E1", "<transcript>", "T1 → bash: npm test"];
  let at = -1;
  for (const marker of order) {
    const next = text.indexOf(marker, at + 1);
    assert.ok(next > at, `${marker} missing or out of order`);
    at = next;
  }
});

test("buildDigest: a switchover carries the previous summary and the earlier rule-shaped messages", () => {
  const promptState = { ...promptStateOf(emptyState(), []), seed: "## Goal\nship it", seedRules: [{ ordinal: "u1", text: "never push" }] };
  const { text } = buildDigest(input({ promptState }));
  assert.ok(text.includes("<previous-summary>\n## Goal\nship it\n</previous-summary>"));
  assert.ok(text.includes("<earlier-user-messages>\n[u1] never push\n</earlier-user-messages>"));
});

test("buildDigest: a pasted user message is cut head and tail with a show pointer; show(uN) returns up to SHOW_CHARS of it", () => {
  const paste = `start ${"log ".repeat(1500)} end`;
  const digest = buildDigest(input({ userMessages: [{ ordinal: "u4", text: paste }], textOf: () => paste }));
  assert.ok(digest.text.includes("show u4"), "cut message names its show ref");
  assert.ok(!digest.text.includes(paste));
  assert.ok(digest.text.includes(" end\n</user-messages>"), "the tail survives");
  assert.equal(digest.show("u4"), paste);
  const huge = "y".repeat(SHOW_CHARS + 10);
  assert.ok(buildDigest(input({ textOf: () => huge })).show("u4")!.endsWith("[… 10 more chars not shown]"));
});

test("buildDigest: show resolves u, C, E and T ids and answers undefined for anything else", () => {
  const digest = buildDigest(input());
  assert.equal(digest.show("u1"), "the original goal");
  assert.equal(digest.show("C1"), "C1 [runs:2 exit:1] npm test");
  assert.equal(digest.show("E1"), "E1 [unresolved C1] FAIL src/a.test.ts");
  assert.equal(digest.show("T1"), "FAIL src/a.test.ts\nfull output");
  assert.equal(digest.show("T9"), undefined);
  assert.equal(digest.show("../etc/passwd"), undefined);
});

test("buildDigest: no commands, errors or messages say so instead of leaving empty blocks", () => {
  const { text } = buildDigest(input({ userMessages: [], commands: [], errors: [] }));
  assert.ok(text.includes("<user-messages>\n(none in this span)\n</user-messages>"));
  assert.ok(text.includes("<commands>\n(none)\n</commands>"));
  assert.ok(text.includes("<errors>\n(none)\n</errors>"));
});
