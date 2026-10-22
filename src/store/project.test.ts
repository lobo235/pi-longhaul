import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_CAPS } from "./events.ts";
import { activeCorrections, activeDecisions, activeWorkLog, acceptedRemembers, emptyState, project, projectAt } from "./project.ts";
import { closeEvent, ev, logOf, NOW, quote, resetSeq } from "./test-support.ts";

test.beforeEach(() => resetSeq());

test("emptyState: span 1, nothing set, cursor at zero", () => {
  assert.deepEqual(emptyState(), { span: 1, corrections: [], decisions: [], deadEnds: [], workLog: [], retired: { corrections: 0, decisions: 0, deadEnds: 0, workLog: 0 }, cursor: { R: 0, D: 0, X: 0 }, seq: 0 });
});

test("objective: set, doneWhen attached, and a later set MOVES it keeping the previous in movedFrom", () => {
  const state = project(logOf(
    ev({ kind: "objective.set", quote: quote("u1", "build the state compactor") }),
    ev({ kind: "objective.doneWhen", quote: quote("u1", "done when npm test passes"), span: 1 }),
    closeEvent(1),
    ev({ kind: "objective.set", quote: quote("u9", "actually, ship the selector first"), span: 2 }),
  ), DEFAULT_CAPS);
  assert.equal(state.span, 2);
  assert.equal(state.objective?.quote.ordinal, "u9");
  assert.equal(state.objective?.setSpan, 2);
  assert.equal(state.objective?.doneWhen, undefined, "a moved objective drops the old doneWhen");
  assert.deepEqual(state.objective?.movedFrom, [{ quote: quote("u1", "build the state compactor"), span: 1 }]);
});

test("corrections: added in order with ids, cursor follows the highest id, the oldest retires past the cap", () => {
  const events = Array.from({ length: DEFAULT_CAPS.corrections + 1 }, (_, i) => ev({ kind: "correction.add", id: `R${i + 1}`, quote: quote(`u${i + 2}`, `rule number ${i + 1} stands`) }));
  const state = project(logOf(...events), DEFAULT_CAPS);
  assert.equal(activeCorrections(state).length, DEFAULT_CAPS.corrections);
  assert.equal(state.corrections[0].retired, true);
  assert.equal(state.retired.corrections, 1);
  assert.equal(state.cursor.R, DEFAULT_CAPS.corrections + 1);
  assert.equal(state.seq, events.at(-1)!.seq);
});

test("lifts: a lifted correction stays hot through the close of its own span (the summary shows it once as lifted), then retires at the following close; ids R/D/X are independent", () => {
  const log = logOf(
    ev({ kind: "correction.add", id: "R1", quote: quote("u2", "never touch the lockfile") }),
    ev({ kind: "decision.add", id: "D1", text: "copy, do not import" }),
    closeEvent(1),
    ev({ kind: "correction.lift", target: "R1", by: { messageId: "m-u7", ordinal: "u7" }, span: 2 }),
  );
  const inSpan = project(log, DEFAULT_CAPS);
  assert.deepEqual(inSpan.corrections[0].liftedBy, { messageId: "m-u7", ordinal: "u7", span: 2 });
  assert.equal(inSpan.corrections[0].retired, false, "still hot: lifted this span");
  const afterOwnClose = project(logOf(...log.events, closeEvent(2)), DEFAULT_CAPS);
  assert.equal(afterOwnClose.corrections[0].retired, false, "the summary at span 2's close renders it as lifted (glossary: shown once as lifted)");
  assert.equal(activeCorrections(afterOwnClose).length, 1);
  const afterNextClose = project(logOf(...log.events, closeEvent(2), closeEvent(3)), DEFAULT_CAPS);
  assert.equal(afterNextClose.corrections[0].retired, true, "retired at the close after the one that showed it");
  assert.equal(afterNextClose.retired.corrections, 1);
  assert.equal(activeCorrections(afterNextClose).length, 0);
  assert.equal(activeDecisions(afterNextClose).length, 1);
});

test("now: last wins; a close without a now.set in that span marks it carried", () => {
  const set = project(logOf(ev({ kind: "now.set", now: NOW }), closeEvent(1)), DEFAULT_CAPS);
  assert.equal(set.now?.carried, false);
  const carried = project(logOf(ev({ kind: "now.set", now: NOW }), closeEvent(1), closeEvent(2, { narrativeLess: true, narrative: undefined })), DEFAULT_CAPS);
  assert.equal(carried.now?.carried, true);
  assert.equal(carried.now?.span, 1);
});

test("span.close: one work-log line per span (narrative, narrative-less, foreign, missing chunks), world from the last close, span advances", () => {
  const state = project(logOf(
    closeEvent(1),
    closeEvent(2, { narrativeLess: true, narrative: undefined }),
    closeEvent(3, { foreign: "extension", narrativeLess: true, narrative: undefined }),
    closeEvent(4, { missingChunks: [2], narrative: "chunk 1 landed" }),
  ), DEFAULT_CAPS);
  assert.deepEqual(state.workLog.map((line) => line.text), [
    "span 1 work",
    "narrative unavailable for this span (narrative-less pass)",
    "compacted by another extension's compactor; no state diff for this span",
    "chunk 1 landed (chunk 2 of this span did not verify)",
  ]);
  assert.equal(state.span, 5);
  assert.equal(state.world?.commit, "ab12cd");
});

test("work log consolidation: past the cap the oldest lines fold into one code-written line", () => {
  const closes = Array.from({ length: DEFAULT_CAPS.workLogLines + 2 }, (_, i) => closeEvent(i + 1));
  const state = project(logOf(...closes), DEFAULT_CAPS);
  const active = activeWorkLog(state);
  assert.equal(active.length, DEFAULT_CAPS.workLogLines);
  assert.deepEqual(active[0].retiredSpans, [1, 3]);
  assert.equal(active[0].text, "Spans 1–3 retired (recall span N for one of them)");
  assert.equal(state.retired.workLog, 3);
});

test("projectAt: events after the named span are not folded; acceptedRemembers lists the span's remember events", () => {
  const log = logOf(
    ev({ kind: "correction.add", id: "R1", quote: quote("u2", "never touch the lockfile"), source: "remember" }),
    closeEvent(1),
    ev({ kind: "decision.add", id: "D1", text: "later", span: 2, source: "remember" }),
  );
  assert.equal(projectAt(log, 1, DEFAULT_CAPS).decisions.length, 0);
  assert.equal(project(log, DEFAULT_CAPS).decisions.length, 1);
  assert.deepEqual(acceptedRemembers(log, 2).map((event) => event.kind), ["decision.add"]);
});

test("corrections: one message's rule recorded again in later spans is one rule, under its newest id, and a lift of any of its ids lifts it", () => {
  // Spans whose records were once lost re-recorded the rules of messages they were shown again (log.ts endsPendingSpan);
  // with the records restored, every copy is in the log.
  const rule = quote("u2", "vault writes go through the vault cli");
  const state = project(logOf(
    ev({ kind: "correction.add", id: "R1", quote: rule }),
    closeEvent(1),
    ev({ kind: "correction.add", id: "R1", quote: rule, span: 2 }),
    ev({ kind: "correction.add", id: "R2", quote: quote("u5", "never restart the primary"), span: 2 }),
    closeEvent(2),
    ev({ kind: "correction.add", id: "R3", quote: rule, span: 3 }),
  ), DEFAULT_CAPS);
  assert.deepEqual(activeCorrections(state).map((item) => [item.id, item.quote.ordinal, item.span]), [["R2", "u5", 2], ["R3", "u2", 3]]);
  assert.equal(state.retired.corrections, 0, "a copy folded into its rule is not a retirement");
  assert.equal(state.cursor.R, 3);

  const lifted = project(logOf(
    ev({ kind: "correction.add", id: "R1", quote: rule }),
    closeEvent(1),
    ev({ kind: "correction.add", id: "R4", quote: rule, span: 2 }),
    ev({ kind: "correction.lift", target: "R1", by: { messageId: "m-u9", ordinal: "u9" }, span: 2 }),
  ), DEFAULT_CAPS);
  assert.deepEqual(lifted.corrections.map((item) => [item.id, item.liftedBy?.ordinal]), [["R4", "u9"]], "the lift named the id the copy had when the lifting pass saw it");
});

test("corrections: a rule recorded again from the message it was lifted from stays lifted", () => {
  const rule = quote("u2", "vault writes go through the vault cli");
  const state = project(logOf(
    ev({ kind: "correction.add", id: "R1", quote: rule }),
    ev({ kind: "correction.lift", target: "R1", by: { messageId: "m-u4", ordinal: "u4" } }),
    closeEvent(1),
    closeEvent(2),
    ev({ kind: "correction.add", id: "R1", quote: rule, span: 3 }),
  ), DEFAULT_CAPS);
  assert.deepEqual(activeCorrections(state), []);
  assert.equal(state.corrections.length, 1);
});

test("corrections: a copy in other words from the same message is the same rule; two rules from one message stay two", () => {
  const long = quote("u5", "and when you're ready, run /setup-tools so we can use the build tools here");
  const short = quote("u5", "run /setup-tools so we can use the build tools");
  const lifted = project(logOf(
    ev({ kind: "correction.add", id: "R2", quote: long }),
    closeEvent(1),
    ev({ kind: "correction.add", id: "R1", quote: short, span: 2 }),
    ev({ kind: "correction.lift", target: "R1", by: { messageId: "m-u10", ordinal: "u10" }, span: 2 }),
  ), DEFAULT_CAPS);
  assert.deepEqual(lifted.corrections.map((item) => [item.id, item.quote.text, item.liftedBy?.ordinal]), [["R1", short.text, "u10"]]);

  const two = project(logOf(
    ev({ kind: "correction.add", id: "R3", quote: quote("u13", "run the security review before any push") }),
    ev({ kind: "correction.add", id: "R4", quote: quote("u13", "print a release plan before mutation") }),
  ), DEFAULT_CAPS);
  assert.deepEqual(activeCorrections(two).map((item) => item.id), ["R3", "R4"]);
});

test("corrections: a lift naming an id one rule holds now lands on that rule, never on another that held the id before (security.md T2)", () => {
  const forcePush = quote("u1", "never force-push to the main branch");
  const state = project(logOf(
    ev({ kind: "correction.add", id: "R1", quote: forcePush }),
    closeEvent(1),
    ev({ kind: "correction.add", id: "R1", quote: quote("u2", "use tabs for indentation everywhere"), span: 2 }),
    closeEvent(2),
    ev({ kind: "correction.add", id: "R2", quote: forcePush, span: 3 }),
    ev({ kind: "correction.lift", target: "R1", by: { messageId: "m-u9", ordinal: "u9" }, span: 3 }),
  ), DEFAULT_CAPS);
  assert.deepEqual(state.corrections.map((item) => [item.id, item.quote.ordinal, item.liftedBy?.ordinal]), [["R1", "u2", "u9"], ["R2", "u1", undefined]]);
});

test("corrections: many copies of one rule fold in linear time (security.md T4)", () => {
  const rule = quote("u2", "vault writes go through the vault cli");
  const copies = 20_000;
  const events = Array.from({ length: copies }, (_, i) => ev({ kind: "correction.add", id: `R${(i % 2) + 1}`, quote: rule, span: i + 1 }));
  const started = performance.now();
  const state = project(logOf(...events), DEFAULT_CAPS);
  assert.equal(state.corrections.length, 1);
  assert.equal(state.corrections[0].copyKeys?.length, copies - 1);
  assert.ok(performance.now() - started < 1500, `took ${Math.round(performance.now() - started)} ms`);
});
