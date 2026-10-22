import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_CAPS, type StateEvent } from "./events.ts";
import { recall, type RecallDeps } from "./recall.ts";
import { closeEvent, ev, logOf, quote, resetSeq } from "./test-support.ts";

test.beforeEach(() => resetSeq());

function corrections(...events: StateEvent[]): Array<[string, boolean | undefined]> {
  const deps: RecallDeps = { log: logOf(...events), ledger: { commands: [], errors: [] }, messageText: () => undefined, caps: DEFAULT_CAPS };
  return recall({ what: "corrections" }, deps).hits.map((hit) => [hit.text, hit.lifted]);
}

test("recall: a lift marks the correction it landed on, not another span's correction with the same seq", () => {
  // Spans written while records were lost numbered from too low a seq (log.ts seqKey).
  const hits = corrections(
    ev({ kind: "correction.add", id: "R1", quote: quote("u2", "never touch the lockfile"), seq: 1 }),
    closeEvent(1, { seq: 2 }),
    ev({ kind: "correction.add", id: "R2", quote: quote("u6", "keep every file under 400 lines"), span: 2, seq: 1 }),
    ev({ kind: "correction.lift", target: "R2", by: { messageId: "m-u8", ordinal: "u8" }, span: 2, seq: 3 }),
  );
  assert.deepEqual(hits, [["R1 [u2] never touch the lockfile", false], ["R2 [u6] keep every file under 400 lines", true]]);
});

test("recall: every copy of a rule recorded again from its message shows as lifted when the rule is, as the projection folds them", () => {
  const long = quote("u5", "and when you're ready, run /setup-tools so we can use the build tools here");
  const short = quote("u5", "run /setup-tools so we can use the build tools");
  const hits = corrections(
    ev({ kind: "correction.add", id: "R2", quote: long }),
    closeEvent(1),
    ev({ kind: "correction.add", id: "R1", quote: short, span: 2 }),
    ev({ kind: "correction.lift", target: "R1", by: { messageId: "m-u10", ordinal: "u10" }, span: 2 }),
    closeEvent(2),
    ev({ kind: "correction.add", id: "R1", quote: short, span: 3 }),
    ev({ kind: "correction.add", id: "R2", quote: quote("u7", "never restart the primary"), span: 3 }),
  );
  assert.deepEqual(hits.map(([, lifted]) => lifted), [true, true, true, false]);
});

test("recall: a correction shows as lifted exactly when the projection lifted it", () => {
  // Newest event holding R1 is the force-push copy; the projection's R1 is the tabs rule (project.ts liftTarget).
  const forcePush = quote("u1", "never force-push to the main branch");
  const hits = corrections(
    ev({ kind: "correction.add", id: "R1", quote: quote("u2", "use tabs for indentation everywhere") }),
    closeEvent(1),
    ev({ kind: "correction.add", id: "R1", quote: forcePush, span: 2 }),
    closeEvent(2),
    ev({ kind: "correction.add", id: "R2", quote: forcePush, span: 3 }),
    ev({ kind: "correction.lift", target: "R1", by: { messageId: "m-u9", ordinal: "u9" }, span: 3 }),
  );
  assert.deepEqual(hits.map(([text, lifted]) => [text.slice(0, 7), lifted]), [["R1 [u2]", true], ["R1 [u1]", false], ["R2 [u1]", false]]);
});
