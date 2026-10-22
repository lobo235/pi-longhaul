import test from "node:test";
import assert from "node:assert/strict";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import { chain, compactionEntry, customEntry, userEntry } from "../test-support.ts";
import { EVENT_ENTRY_TYPE, SPAN_ENTRY_TYPE, type Quote, type SpanRecord, type StateEvent } from "./events.ts";
import { compactorOfEntry, isSpanRecord, readLog, spanNumberOf } from "./log.ts";
import { DEFAULT_CAPS } from "./events.ts";
import { activeCorrections, project } from "./project.ts";
import { verify } from "./verify.ts";
import { buildMessageIndex } from "../intent.ts";
import { closeEvent, ev, quote, resetSeq } from "./test-support.ts";

test.beforeEach(() => resetSeq());

const checker = { holds: (q: Quote) => q.text !== "FORGED" };
const record = (span: number, events: StateEvent[], compactionEntryId: string, extra: Partial<SpanRecord> = {}): SpanRecord => ({ v: 1, span, compactionEntryId, events, ledger: { commands: [], errors: [] }, ...extra });

test("readLog: an empty branch is the empty log", () => {
  assert.deepEqual(readLog([], checker), { events: [], spans: [], openSpan: 1, anomalies: [], nextSeq: 1 });
});

test("readLog: closed spans come from their span records, the open span from loose events after the last record", () => {
  const r1 = ev({ kind: "correction.add", id: "R1", quote: quote("u2", "never use mocks anywhere"), source: "remember", span: 1 });
  const close1 = closeEvent(1);
  const loose2 = ev({ kind: "decision.add", id: "D1", text: "copy the ledger", source: "remember", span: 2 });
  const branch = chain([
    userEntry("m-u1", "build it"),
    customEntry("e1", EVENT_ENTRY_TYPE, r1),
    compactionEntry("c1", { compactor: "state" }),
    customEntry("s1", SPAN_ENTRY_TYPE, record(1, [r1, close1], "c1")),
    customEntry("e2", EVENT_ENTRY_TYPE, loose2),
  ]);
  const log = readLog(branch, checker);
  assert.deepEqual(log.events.map((event) => event.kind), ["correction.add", "span.close", "decision.add"]);
  assert.deepEqual(log.spans.map((span) => [span.span, span.compactionEntryId, span.record?.span]), [[1, "c1", 1]]);
  assert.equal(log.openSpan, 2);
  assert.equal(log.nextSeq, loose2.seq + 1);
  assert.deepEqual(log.anomalies, []);
});

test("readLog: a loose event for an already closed span is ignored; the span record wins over loose entries for its span", () => {
  const r1 = ev({ kind: "correction.add", id: "R1", quote: quote("u2", "never use mocks anywhere"), source: "remember", span: 1 });
  const stray = ev({ kind: "decision.add", id: "D9", text: "not in the record", source: "remember", span: 1 });
  const branch = chain([
    customEntry("e1", EVENT_ENTRY_TYPE, r1),
    customEntry("e9", EVENT_ENTRY_TYPE, stray),
    compactionEntry("c1", { compactor: "state" }),
    customEntry("s1", SPAN_ENTRY_TYPE, record(1, [r1, closeEvent(1)], "c1")),
    customEntry("e10", EVENT_ENTRY_TYPE, { ...stray, seq: 99 }),
  ]);
  const log = readLog(branch, checker);
  assert.deepEqual(log.events.map((event) => (event as { id?: string }).id ?? event.kind), ["R1", "span.close"]);
  assert.equal(log.anomalies.length, 1);
  assert.match(log.anomalies[0].reason, /span 1 is closed/);
});

test("readLog: foreign compaction entry — pi's or another extension's entry, or a state entry without a span record, gets a synthesized close", () => {
  const branch = chain([
    userEntry("m-u1", "build it"),
    compactionEntry("c1", { readFiles: [] }, false),
    userEntry("m-u2", "more"),
    compactionEntry("c2", { readFiles: [], commands: [] }, true),
    compactionEntry("c3", { compactor: "state", state: {} }, true),
    customEntry("e1", EVENT_ENTRY_TYPE, ev({ kind: "decision.add", id: "D1", text: "after the foreign passes", source: "remember", span: 4 })),
  ]);
  const log = readLog(branch, checker);
  assert.deepEqual(log.spans.map((span) => [span.span, span.foreign]), [[1, "pi"], [2, "extension"], [3, undefined]]);
  const closes = log.events.filter((event) => event.kind === "span.close") as Array<Extract<StateEvent, { kind: "span.close" }>>;
  assert.deepEqual(closes.map((close) => [close.span, close.foreign, close.narrativeLess, close.source]), [[1, "pi", true, "pass"], [2, "extension", true, "pass"], [3, undefined, true, "pass"]]);
  assert.equal(log.openSpan, 4);
  assert.equal(log.events.at(-1)?.kind, "decision.add");
  assert.equal(log.anomalies.filter((a) => /no span record/.test(a.reason)).length, 1);
  assert.deepEqual(closes.map((close) => close.seq), [1, 2, 3], "synthesized closes take the next seq");
});

test("readLog: malformed entries, wrong-span events, duplicate seq and forged quotes are anomalies, never throws", () => {
  const good = ev({ kind: "correction.add", id: "R1", quote: quote("u2", "never use mocks anywhere"), source: "remember", span: 1 });
  const branch = chain([
    customEntry("e1", EVENT_ENTRY_TYPE, { nope: true }),
    customEntry("e2", EVENT_ENTRY_TYPE, ev({ kind: "correction.add", id: "R2", quote: quote("u2", "FORGED"), source: "remember", span: 1 })),
    customEntry("e3", EVENT_ENTRY_TYPE, ev({ kind: "decision.add", id: "D1", text: "wrong span", source: "remember", span: 7 })),
    customEntry("e4", EVENT_ENTRY_TYPE, good),
    customEntry("e5", EVENT_ENTRY_TYPE, { ...good, id: "R3" }),
    customEntry("e6", SPAN_ENTRY_TYPE, { v: 2 }),
    customEntry("e7", "someone-else.custom", { x: 1 }),
  ]);
  const log = readLog(branch, checker);
  assert.deepEqual(log.events.map((event) => (event as { id?: string }).id), ["R1"]);
  assert.deepEqual(log.anomalies.map((a) => a.reason.split(":")[0]), ["malformed event entry", "quote does not verify", "event names span 7 while folding span 1", "duplicate seq", "span record without a compaction entry"]);
});

test("readLog: an event from a newer state format is refused by name, never guessed at; format 1 and an unstamped event fold", () => {
  const stamped = ev({ kind: "correction.add", id: "R1", quote: quote("u2", "never use mocks anywhere"), source: "remember", span: 1 });
  const branch = chain([
    customEntry("e1", EVENT_ENTRY_TYPE, { ...stamped, stateFormat: 1 }),
    customEntry("e2", EVENT_ENTRY_TYPE, ev({ kind: "decision.add", id: "D1", text: "unstamped, written before formats", source: "remember", span: 1 })),
    customEntry("e3", EVENT_ENTRY_TYPE, { ...ev({ kind: "decision.add", id: "D2", text: "from the future", source: "remember", span: 1 }), stateFormat: 2 }),
  ]);
  const log = readLog(branch, checker);
  assert.deepEqual(log.events.map((event) => (event as { id?: string }).id), ["R1", "D1"]);
  assert.deepEqual(log.anomalies.map((a) => a.reason), ["event from a newer state format (2; this version reads 1): e3"]);
});

test("readLog: a span record that names a different compaction entry than the one before it is an anomaly and the span is synthesized", () => {
  const branch = chain([
    compactionEntry("c1", { compactor: "state" }),
    customEntry("s1", SPAN_ENTRY_TYPE, record(1, [closeEvent(1)], "cX")),
  ]);
  const log = readLog(branch, checker);
  assert.equal(log.spans[0].record, undefined);
  assert.match(log.anomalies[0].reason, /names compaction entry cX/);
});

test("readLog: another extension's entries between a compaction and its span record do not lose the record", () => {
  // pi-goal appends its goal-state (and sometimes a goal-contract message) at session_compact, before Longhaul's
  // span record lands: seen on 140 of 480 state compactions in real transcripts.
  const r1 = ev({ kind: "correction.add", id: "R1", quote: quote("u2", "never use mocks anywhere"), source: "pass", span: 1 });
  const contract = { ...customEntry("g2", "goal-contract", undefined), type: "custom_message", content: "Goal mode is inactive.", display: false } as unknown as SessionEntry;
  const branch = chain([
    compactionEntry("c1", { compactor: "state" }),
    customEntry("g1", "goal-state", { goal: null }),
    contract,
    customEntry("s1", SPAN_ENTRY_TYPE, record(1, [r1, closeEvent(1)], "c1")),
  ]);
  const log = readLog(branch, checker);
  assert.deepEqual(log.spans.map((span) => [span.span, span.record?.compactionEntryId]), [[1, "c1"]]);
  assert.deepEqual(log.events.map((event) => event.kind), ["correction.add", "span.close"]);
  assert.deepEqual(log.anomalies, []);
});

test("readLog: a message, a loose event or another compaction before the span record still means the record never landed", () => {
  const loose = ev({ kind: "decision.add", id: "D1", text: "written in span 2", source: "remember", span: 2 });
  for (const [name, boundary] of [["a message", userEntry("m-u2", "next turn")], ["a loose event", customEntry("e2", EVENT_ENTRY_TYPE, loose)], ["a compaction", compactionEntry("c2", { readFiles: [] }, false)]] as const) {
    const branch = chain([compactionEntry("c1", { compactor: "state" }), customEntry("g1", "goal-state", {}), boundary, customEntry("s1", SPAN_ENTRY_TYPE, record(1, [closeEvent(1)], "c1"))]);
    const log = readLog(branch, checker);
    assert.equal(log.spans[0].record, undefined, `${name} closes the span without its record`);
    assert.ok(log.anomalies.some((anomaly) => /no span record for compaction entry c1/.test(anomaly.reason)), name);
  }
});

test("readLog: span records whose passes reused seqs (written while earlier records were being lost) all fold", () => {
  // Before the fix above, a pass folded without the lost records and numbered its events from a lower seq,
  // so two spans' records can carry the same seqs. Each span's events are its own; only a seq repeated
  // INSIDE one span is a duplicate.
  const d1 = ev({ kind: "decision.add", id: "D1", text: "first span's decision", source: "pass", span: 1 });
  const close1 = closeEvent(1);
  const d2 = { ...ev({ kind: "decision.add", id: "D2", text: "second span's decision", source: "pass", span: 2 }), seq: d1.seq };
  const close2 = { ...closeEvent(2), seq: close1.seq };
  const branch = chain([
    compactionEntry("c1", { compactor: "state" }),
    customEntry("g1", "goal-state", {}),
    customEntry("s1", SPAN_ENTRY_TYPE, record(1, [d1, close1], "c1")),
    compactionEntry("c2", { compactor: "state" }),
    customEntry("s2", SPAN_ENTRY_TYPE, record(2, [d2, close2, { ...d2, id: "D3" } as StateEvent], "c2")),
  ]);
  const log = readLog(branch, checker);
  assert.deepEqual(log.events.map((event) => (event as { id?: string }).id ?? `${event.kind}@${event.span}`), ["D1", "span.close@1", "D2", "span.close@2"]);
  assert.deepEqual(log.anomalies.map((anomaly) => anomaly.reason), [`duplicate seq: ${d1.seq} at s2`]);
  assert.ok(log.nextSeq > close1.seq);
});

test("compactorOfEntry / spanNumberOf / isSpanRecord", () => {
  assert.equal(compactorOfEntry({}), "pi");
  assert.equal(compactorOfEntry({ fromHook: true }), "extension");
  assert.equal(compactorOfEntry({ fromHook: true, details: { compactor: "state" } }), "state");
  const branch = chain([compactionEntry("c1", {}), userEntry("m", "x"), compactionEntry("c2", {})]) as SessionEntry[];
  assert.equal(spanNumberOf(branch, "c2"), 2);
  assert.equal(spanNumberOf(branch, "nope"), undefined);
  assert.equal(isSpanRecord(record(1, [], "c1")), true);
  assert.equal(isSpanRecord({ v: 1, span: 1 }), false);
});

test("readLog: a remember write survives a span another compactor closes (it is the user's own word, not that compactor's)", () => {
  const r1 = ev({ kind: "correction.add", id: "R1", quote: quote("u2", "never use mocks anywhere"), source: "remember", span: 1 });
  const d1 = ev({ kind: "decision.add", id: "D1", text: "copy the ledger", source: "remember", span: 1 });
  const branch = chain([
    userEntry("m-u1", "build it"),
    customEntry("e1", EVENT_ENTRY_TYPE, r1),
    customEntry("e2", EVENT_ENTRY_TYPE, d1),
    compactionEntry("c1", { readFiles: [], commands: [] }, true),
  ]);
  const log = readLog(branch, checker);
  assert.deepEqual(log.events.map((event) => (event as { id?: string }).id ?? event.kind), ["R1", "D1", "span.close"], "the writes fold into the closed span, before its close");
  assert.deepEqual(log.spans.map((span) => [span.span, span.foreign]), [[1, "extension"]]);
  assert.deepEqual(log.anomalies, []);
  assert.ok(log.nextSeq > Math.max(r1.seq, d1.seq), "the synthesized close and later writes never reuse a remember write's seq");
});

test("readLog + project (security.md T1): an old transcript's reused correction id resolves a lift to the NEWEST holder, never to a rule the user did not withdraw", () => {
  // Before the fold fix a foreign close dropped R1, the cursor fell back, and the next remember minted R1 AGAIN.
  // Those transcripts are on disk: folding the old R1 back in leaves two corrections named R1. Any lift written
  // against them could only have seen the newer one, so the newest holder is the only correct target.
  const branch = chain([
    userEntry("m1", "never use mocks anywhere in these tests"),
    customEntry("e1", EVENT_ENTRY_TYPE, { kind: "correction.add", id: "R1", quote: { messageId: "m1", ordinal: "u1", text: "never use mocks anywhere" }, source: "remember", span: 1, at: "t", seq: 1 }),
    compactionEntry("c1", { readFiles: [], commands: [] }, true),
    userEntry("m2", "never push directly to the main branch"),
    customEntry("e2", EVENT_ENTRY_TYPE, { kind: "correction.add", id: "R1", quote: { messageId: "m2", ordinal: "u2", text: "never push directly to the main branch" }, source: "remember", span: 2, at: "t", seq: 3 }),
    userEntry("m3", "the direct-push rule no longer applies; push directly to main from now on"),
  ]);
  const index = buildMessageIndex(branch, { commandIds: new Set(), errorIds: new Set() });
  const state = project(readLog(branch, index), DEFAULT_CAPS);
  const lift = verify({ kind: "lift", target: "R1", ref: "u3", text: "the direct-push rule no longer applies; push directly to main from now on" } as never, { resolver: index, state, provenance: { source: "remember", span: 2, at: "t" }, caps: DEFAULT_CAPS, nearDuplicateThreshold: 0.8, acceptedThisSpan: 0, rememberCap: 5 } as never);
  assert.ok(lift.ok, "the lift is accepted");
  const recorded = chain([...branch, customEntry("e3", EVENT_ENTRY_TYPE, lift.ok ? lift.event : {})]);
  const after = activeCorrections(project(readLog(recorded, buildMessageIndex(recorded, { commandIds: new Set(), errorIds: new Set() })), DEFAULT_CAPS));
  // A lifted correction stays rendered, marked, until the next span retires it; the mark must land on the newest R1.
  assert.deepEqual(after.map((item) => [item.quote.text, item.liftedBy?.ordinal]), [["never use mocks anywhere", undefined], ["never push directly to the main branch", "u3"]], "the withdrawn rule is lifted; the one the user never withdrew still stands");
});

test("readLog: a branch with 200,000 events folds without overflowing the stack (nextSeq is a loop, not a spread)", () => {
  const count = 200_000;
  const loose = Array.from({ length: count }, (_, i) => customEntry(`e${i}`, EVENT_ENTRY_TYPE, ev({ kind: "decision.add", id: `D${i + 1}`, text: "kept it", source: "remember", span: 1, seq: i + 1 })));
  const open = readLog(chain(loose), checker);
  assert.equal(open.nextSeq, count + 1);
  const closed = readLog(chain([...loose, compactionEntry("c1", undefined, false)]), checker);
  assert.equal(closed.events.at(-1)?.kind, "span.close");
  assert.equal(closed.events.at(-1)?.seq, count + 1, "the synthesized close takes the next seq");
  assert.equal(closed.nextSeq, count + 2);
  const recorded = loose.map((entry) => (entry as { data: StateEvent }).data);
  const fromRecord = readLog(chain([compactionEntry("c1", { compactor: "state" }), customEntry("s1", SPAN_ENTRY_TYPE, record(1, recorded, "c1"))]), checker);
  assert.equal(fromRecord.events.length, count, "a span record's events are taken without a spread");
});
