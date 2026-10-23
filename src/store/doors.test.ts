import test from "node:test";
import assert from "node:assert/strict";

import type { CommandRecord, ErrorRecord } from "../ledger/handoff.ts";
import { render } from "../render.ts";
import { closeSpan } from "./close.ts";
import { commitRemember } from "./commit.ts";
import { DEFAULT_CAPS, EVENT_ENTRY_TYPE, type StateEvent } from "./events.ts";
import { project, projectAt, type SessionState } from "./project.ts";
import { recall } from "./recall.ts";
import { closeEvent, ev, logOf, NOW, quote, resetSeq, WORLD } from "./test-support.ts";
import type { QuoteResolver } from "./verify.ts";

test.beforeEach(() => resetSeq());

const branch: Array<[string, string]> = [["u1", "Build the state compactor. Done when npm test passes."], ["u2", "Never use mocks in these tests; use fakes."], ["u3", "ok, hand-edit it this once"]];
const resolver: QuoteResolver = {
  resolve(text, ref) {
    const norm = (t: string) => t.replace(/\s+/g, " ").trim();
    const wanted = norm(text);
    if (wanted.length < 12) return { ok: false, rejection: { code: "empty" } };
    const hit = (ref ? branch.filter(([o]) => o === ref) : [...branch].reverse()).find(([, body]) => norm(body).includes(wanted));
    if (!hit) return { ok: false, rejection: { code: "not-substring", ref: ref ?? "any", excerpt: "", recent: [] } };
    return { ok: true, quote: { messageId: `m-${hit[0]}`, ordinal: hit[0], text: wanted }, position: branch.findIndex(([o]) => o === hit[0]) };
  },
  position: (id) => { const i = branch.findIndex(([o]) => `m-${o}` === id); return i < 0 ? undefined : i; },
  messageText: (id) => branch.find(([o]) => `m-${o}` === id)?.[1],
  hasEvidence: (e) => /^(C1|E1|u[1-3]|last command|last error)$/.test(e),
};
const commands: CommandRecord[] = [{ id: "C1", command: "npm test", runs: 1, lastExitCode: 0, failedThenSucceeded: false, lastSeenPass: 1 }];
const errors: ErrorRecord[] = [{ id: "E1", signature: "Error: boom\n  at x", resolved: false, lastSeenPass: 1 }];

test("commitRemember: an accepted write is appended as a compaction-state.event entry and counts toward the cap; a rejection appends nothing", () => {
  const appended: Array<{ customType: string; data: StateEvent }> = [];
  const deps = { log: logOf(), resolver, caps: DEFAULT_CAPS, nearDuplicateThreshold: 0.8, rememberCap: 10, now: () => "2026-09-28T10:00:00.000Z", appendEntry: (customType: string, data: StateEvent) => appended.push({ customType, data }) };
  const accepted = commitRemember({ kind: "correction", text: "use mocks in these tests" }, deps);
  assert.ok(accepted.ok);
  assert.equal(accepted.remaining, 9);
  assert.deepEqual(appended, [{ customType: EVENT_ENTRY_TYPE, data: { ...accepted.event, stateFormat: 1 } }]);
  assert.deepEqual(accepted.event, { source: "remember", span: 1, at: "2026-09-28T10:00:00.000Z", seq: 1, kind: "correction.add", id: "R1", quote: { messageId: "m-u2", ordinal: "u2", text: "use mocks in these tests" } });
  const rejected = commitRemember({ kind: "correction", text: "use fakes" }, deps);
  assert.ok(!rejected.ok && rejected.rejection.code === "empty");
  assert.equal(appended.length, 1);
});

test("commitRemember: a throwing appendEntry becomes an internal rejection, never a throw", () => {
  const deps = { log: logOf(), resolver, caps: DEFAULT_CAPS, nearDuplicateThreshold: 0.8, rememberCap: 10, now: () => "t", appendEntry: () => { throw new Error("disk full"); } };
  const outcome = commitRemember({ kind: "decision", text: "copy the ledger" }, deps);
  assert.ok(!outcome.ok && outcome.rejection.code === "internal" && /disk full/.test(outcome.rejection.detail));
});

test("closeSpan: appends the diff events and the close, projects, fits the cap, and the checkpoint equals projectAt(log, span)", () => {
  const log = logOf(ev({ kind: "correction.add", id: "R1", quote: quote("u2", "Never use mocks in these tests"), source: "remember" }));
  const diffEvents = [ev({ kind: "decision.add", id: "D1", text: "copy the ledger", seq: 2 }), ev({ kind: "now.set", now: NOW, seq: 3 })];
  const closed = closeSpan({ log, caps: DEFAULT_CAPS, diffEvents, close: { fromRef: "u1", toRef: "u3", narrative: "did the thing", narrativeLess: false, world: WORLD }, at: "2026-09-28T11:00:00.000Z", measure: () => 100 });
  assert.deepEqual(closed.events.map((event) => event.kind), ["decision.add", "now.set", "span.close"]);
  assert.equal(closed.closeEvent.seq, 4);
  assert.equal(closed.closeEvent.span, 1);
  assert.equal(closed.log.openSpan, 2);
  assert.equal(closed.log.events.length, 4);
  assert.equal(closed.state.span, 2);
  assert.deepEqual(closed.state, projectAt(closed.log, 1, DEFAULT_CAPS), "pinned: the checkpoint IS the projection at the span");
  assert.equal(closed.capFit.exhausted, false);
});

test("closeSpan: the cap fit retires from the checkpoint the pass renders, but the log keeps everything", () => {
  const log = logOf(closeEvent(1), closeEvent(2), closeEvent(3));
  const closed = closeSpan({ log, caps: { ...DEFAULT_CAPS, hardChars: 10 }, diffEvents: [], close: { fromRef: "u4", toRef: "u5", narrative: "x", narrativeLess: false, world: WORLD }, at: "t", measure: (state) => 5 * state.workLog.length });
  assert.equal(closed.capFit.retired.workLog, 2);
  assert.equal(closed.state.workLog.length, 2);
  assert.equal(project(closed.log, DEFAULT_CAPS).workLog.length, 4, "the log never deletes");
});

test("closeSpan: under the hard cap with more rules than fit whole, every rule stays in the rendered state, the oldest condensed", () => {
  const rules = Array.from({ length: 25 }, (_, i) => ev({ kind: "correction.add", id: `R${i + 1}`, quote: quote(`u${i + 2}`, `rule ${i + 1}: always keep the ${"careful ".repeat(28)}order of steps`) }));
  const caps = { ...DEFAULT_CAPS, hardChars: 5000 };
  const rendered = (state: SessionState) => render({ state, tokensBefore: 0, ledger: { commands: [], errors: [] }, caps });
  const closed = closeSpan({ log: logOf(...rules), caps, diffEvents: [], close: { fromRef: "u1", toRef: "u30", narrative: "x", narrativeLess: false, world: WORLD }, at: "t", measure: (state) => rendered(state).length });
  const text = rendered(closed.state);
  assert.equal(closed.capFit.exhausted, false);
  assert.ok(text.length <= caps.hardChars, `${text.length} chars`);
  for (let i = 1; i <= 25; i++) assert.match(text, new RegExp(`^- R${i} \\[u${i + 1}\\] "rule ${i}: `, "m"), `R${i} is still shown`);
  assert.ok(closed.capFit.condensed > 0 && closed.capFit.condensed < 25);
  assert.ok(closed.state.corrections[0].condensed && !closed.state.corrections[24].condensed, "the oldest condense first");
  assert.match(text, /^- R1 \[u2\] "rule 1: [^"]*… \(longhaul_recall message u2\)"$/m);
});

test("recall: by what, by query, by ordinal; retired and lifted items stay reachable; span slices carry commands and errors", () => {
  const log = logOf(
    ev({ kind: "correction.add", id: "R1", quote: quote("u2", "Never use mocks in these tests") }),
    ev({ kind: "decision.add", id: "D1", text: "copy the ledger modules" }),
    ev({ kind: "deadEnd.add", id: "X1", text: "structured outputs" }),
    closeEvent(1, { narrative: "scaffolded" }),
    ev({ kind: "correction.lift", target: "R1", by: { messageId: "m-u3", ordinal: "u3" }, span: 2 }),
    closeEvent(2),
  );
  log.spans[0].record = { v: 1, span: 1, compactionEntryId: "c1", events: log.events.slice(0, 4), ledger: { commands, errors } };
  const deps = { log, ledger: { commands, errors }, messageText: (ordinal: string) => branch.find(([o]) => o === ordinal)?.[1], caps: DEFAULT_CAPS };
  assert.deepEqual(recall({ what: "decisions" }, deps).hits.map((h) => h.ref), ["D1"]);
  assert.deepEqual(recall({ what: "corrections" }, deps).hits.map((h) => [h.ref, h.lifted]), [["R1", true]]);
  assert.deepEqual(recall({ what: "span", query: "1" }, deps).hits.map((h) => h.kind), ["span", "commands", "errors", "corrections", "decisions", "dead-ends"]);
  assert.equal(recall({ what: "commands", query: "npm" }, deps).hits[0]?.text, "C1 npm test (exit 0, 1 run, span 1)");
  assert.equal(recall({ what: "errors" }, deps).hits[0]?.text, "E1 Error: boom (open, span 1)");
  assert.equal(recall({ what: "message", query: "u2" }, deps).hits[0]?.text, "Never use mocks in these tests; use fakes.");
  assert.deepEqual(recall({ query: "ledger" }, deps).hits.map((h) => h.ref), ["D1"], "no what = search every kind");
  assert.equal(recall({ what: "message", query: "u99" }, deps).hits.length, 0);
  const limited = recall({ what: "all", limit: 2 }, deps);
  assert.equal(limited.hits.length, 2);
  assert.ok(limited.total > 2);
});

test("recall: text is sanitised to one line with control characters stripped", () => {
  const log = logOf(ev({ kind: "decision.add", id: "D1", text: "line one\nline\u0007 two" }));
  const deps = { log, ledger: { commands: [], errors: [] }, messageText: () => undefined, caps: DEFAULT_CAPS };
  assert.equal(recall({ what: "decisions" }, deps).hits[0].text, "D1 line one line two");
});

test("recall (security.md T1): a lift marks only the correction it landed on, also in the span view of an earlier span", () => {
  // An old transcript can hold two corrections named R1; the projection lifts the newest holder, and recall must agree.
  const log = logOf(
    ev({ kind: "correction.add", id: "R1", quote: quote("u2", "Never use mocks in these tests") }),
    closeEvent(1),
    ev({ kind: "correction.add", id: "R1", quote: quote("u3", "hand-edit it this once"), span: 2 }),
    ev({ kind: "correction.lift", target: "R1", by: { messageId: "m-u3", ordinal: "u3" }, span: 2 }),
  );
  const deps = { log, ledger: { commands: [], errors: [] }, messageText: () => undefined, caps: DEFAULT_CAPS };
  assert.deepEqual(recall({ what: "corrections" }, deps).hits.map((h) => [h.text, h.lifted]), [["R1 [u2] Never use mocks in these tests", false], ["R1 [u3] hand-edit it this once", true]]);
  assert.equal(recall({ what: "span", query: "1" }, deps).hits.find((h) => h.kind === "corrections")?.lifted, false, "the span-1 rule was never lifted");
  const single = logOf(ev({ kind: "correction.add", id: "R1", quote: quote("u2", "Never use mocks in these tests") }), closeEvent(1), ev({ kind: "correction.lift", target: "R1", by: { messageId: "m-u3", ordinal: "u3" }, span: 2 }));
  assert.equal(recall({ what: "span", query: "1" }, { ...deps, log: single }).hits.find((h) => h.kind === "corrections")?.lifted, true, "a lift written in a later span still shows on the span that holds the rule");
});
