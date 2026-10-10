import test from "node:test";
import assert from "node:assert/strict";

import { EVENT_ENTRY_TYPE } from "./store/events.ts";
import { assistantEntry, chain, compactionEntry, customEntry, toolResultEntry, userEntry } from "./test-support.ts";
import { buildToolContext, liveLedger, messagesSinceLastCompaction } from "./tool-context.ts";

test("buildToolContext: the fold over the branch, the index over user messages, and the ledger = carried + observed since the last compaction", () => {
  const branch = chain([
    userEntry("m1", "Build the state compactor please, and keep it small"),
    assistantEntry("a1", "ran", [{ name: "bash", arguments: { command: "npm test" } }]),
    toolResultEntry("t1", "a1-t0", "bash", "ok\n[exit 0]"),
    compactionEntry("c1", { compactor: "state", state: {}, caps: {}, ledger: { commands: [{ id: "C1", command: "npm test", lastExitCode: 0, runs: 1, failedThenSucceeded: false, lastSeenPass: 1 }], errors: [] }, narrative: {}, readFiles: [], modifiedFiles: [] }),
    userEntry("m2", "never use mocks in these tests"),
    customEntry("e1", EVENT_ENTRY_TYPE, { source: "remember", span: 2, at: "2026-09-28T12:05:00.000Z", seq: 100, kind: "correction.add", id: "R1", quote: { messageId: "m2", ordinal: "u2", text: "never use mocks in these tests" } }),
    assistantEntry("a2", "again", [{ name: "bash", arguments: { command: "npm run lint" } }]),
    toolResultEntry("t2", "a2-t0", "bash", "bad\n[exit 1]"),
  ]);
  const context = buildToolContext(branch);
  assert.equal(context.log.openSpan, 2);
  assert.equal(context.log.events.length, 2, "the synthesized close for span 1 (from the state entry) plus the open span's own remember event");
  assert.deepEqual(context.index.messages.map((message) => message.ordinal), ["u1", "u2"]);
  assert.deepEqual(context.ledger.commands.map((record) => [record.id, record.command]), [["C1", "npm test"], ["C2", "npm run lint"]]);
  assert.deepEqual(liveLedger(branch), context.ledger, "the ledger alone is the same ledger the full context carries");
  assert.equal(messagesSinceLastCompaction(branch).length, 3, "m2, a2, t2 — the custom entry is not a message");
  assert.equal(messagesSinceLastCompaction(branch.slice(0, 3)).length, 3);
});
