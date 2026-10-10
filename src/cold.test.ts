import test from "node:test";
import assert from "node:assert/strict";

import { buildSpanRecord } from "./cold.ts";
import { DEFAULT_COLD_SLICE_CAPS } from "./config.ts";
import { isSpanRecord } from "./store/log.ts";
import { closeEvent, ev, resetSeq } from "./store/test-support.ts";

test.beforeEach(() => resetSeq());

const command = (n: number, text = `cmd ${n}`) => ({ id: `C${n}`, command: text, runs: 1, lastExitCode: 0, failedThenSucceeded: false, lastSeenPass: 1 }) as never;
const error = (n: number) => ({ id: `E${n}`, signature: `boom ${n}`, resolved: false, lastSeenPass: 1 }) as never;

test("buildSpanRecord: a valid SpanRecord with the events as given, the newest N commands and errors, command text cut", () => {
  const events = [ev({ kind: "decision.add", id: "D1", text: "x" }), closeEvent(1)];
  const record = buildSpanRecord({ span: 1, compactionEntryId: "c1", events, ledger: { commands: [command(1), command(2, "x".repeat(500)), command(3)], errors: [error(1), error(2)] }, usage: { input: 1, output: 2, calls: 1 }, caps: { ...DEFAULT_COLD_SLICE_CAPS, commands: 2, errors: 1 } });
  assert.ok(isSpanRecord(record));
  assert.deepEqual({ v: record.v, span: record.span, compactionEntryId: record.compactionEntryId }, { v: 1, span: 1, compactionEntryId: "c1" });
  assert.equal(record.events, events);
  assert.deepEqual(record.ledger.commands.map((c) => c.id), ["C2", "C3"]);
  assert.equal(record.ledger.commands[0].command.length, DEFAULT_COLD_SLICE_CAPS.commandChars);
  assert.deepEqual(record.ledger.errors.map((e) => e.id), ["E2"]);
  assert.deepEqual(record.usage, { input: 1, output: 2, calls: 1 });
});
