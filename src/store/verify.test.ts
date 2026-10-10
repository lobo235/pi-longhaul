import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_CAPS, describeRejection, type Provenance } from "./events.ts";
import { emptyState, project } from "./project.ts";
import { applyProposals, verify, type QuoteResolver, type VerifyContext } from "./verify.ts";
import { closeEvent, ev, logOf, NOW, quote, resetSeq } from "./test-support.ts";

/** A branch of user messages: ordinal -> text, in branch order. */
function fakeResolver(messages: Array<[string, string]>): QuoteResolver {
  const norm = (text: string) => text.replace(/\s+/g, " ").trim();
  return {
    resolve(text, ref) {
      const wanted = norm(text);
      if (wanted.length < 12) return { ok: false, rejection: { code: "empty" } };
      const candidates = ref ? messages.filter(([ordinal]) => ordinal === ref) : [...messages].reverse();
      if (ref && candidates.length === 0) return { ok: false, rejection: { code: "unknown-ref", ref, known: messages.map(([o]) => o) } };
      const hit = candidates.find(([, body]) => norm(body).includes(wanted));
      if (!hit) return { ok: false, rejection: { code: "not-substring", ref: ref ?? "any", excerpt: candidates[0]?.[1].slice(0, 40) ?? "", recent: [] } };
      return { ok: true, quote: { messageId: `m-${hit[0]}`, ordinal: hit[0], text: wanted }, position: messages.findIndex(([o]) => o === hit[0]) };
    },
    position: (messageId) => { const index = messages.findIndex(([o]) => `m-${o}` === messageId); return index < 0 ? undefined : index; },
    messageText: (messageId) => messages.find(([o]) => `m-${o}` === messageId)?.[1],
    hasEvidence: (evidence) => /^(C[1-3]|E1|u\d+|last command|last error)$/.test(evidence),
  };
}

const PROV: Provenance = { source: "remember", span: 2, at: "2026-09-28T10:00:00.000Z" };
const branch: Array<[string, string]> = [
  ["u1", "Build the state compactor. Done when npm test passes on the whole tree."],
  ["u2", "Never use mocks in these tests; use fakes."],
  ["u3", "The no-mocks rule is lifted; hand-edit it this once"],
  ["u4", "ok, go ahead and push the branch"],
];

function ctxWith(overrides: Partial<VerifyContext> = {}): VerifyContext {
  return { resolver: fakeResolver(branch), state: emptyState(), provenance: PROV, caps: DEFAULT_CAPS, nearDuplicateThreshold: 0.8, acceptedThisSpan: 0, rememberCap: 10, ...overrides };
}

test.beforeEach(() => resetSeq());

test("verify: a correction resolves newest-first without a ref, binds the id, issues R<n> from the cursor and seq from the state", () => {
  const state = { ...emptyState(), cursor: { R: 4, D: 0, X: 0 }, seq: 17 };
  const verdict = verify({ kind: "correction", text: "use mocks in these tests" }, ctxWith({ state }));
  assert.ok(verdict.ok);
  assert.deepEqual(verdict.event, { ...PROV, seq: 18, kind: "correction.add", id: "R5", quote: { messageId: "m-u2", ordinal: "u2", text: "use mocks in these tests" } });
});

test("verify rejections (table)", () => {
  const withR1 = project(logOf(ev({ kind: "correction.add", id: "R1", quote: quote("u2", "Never use mocks in these tests; use fakes."), span: 1 }), closeEvent(1)), DEFAULT_CAPS);
  const lifted = project(logOf(ev({ kind: "correction.add", id: "R1", quote: quote("u2", "Never use mocks in these tests") }), ev({ kind: "correction.lift", target: "R1", by: { messageId: "m-u3", ordinal: "u3" } })), DEFAULT_CAPS);
  const cases: Array<{ name: string; proposal: Parameters<typeof verify>[0]; ctx?: Partial<VerifyContext>; code: string }> = [
    { name: "short quote", proposal: { kind: "correction", text: "use fakes" }, code: "empty" },
    { name: "not a substring", proposal: { kind: "correction", text: "always use mocks in these tests" }, code: "not-substring" },
    { name: "unknown ordinal", proposal: { kind: "correction", ref: "u9", text: "use fakes in these tests" }, code: "unknown-ref" },
    { name: "near duplicate of R1", proposal: { kind: "correction", text: "Never use mocks in these tests; use fakes" }, ctx: { state: withR1 }, code: "near-duplicate" },
    { name: "decision too long", proposal: { kind: "decision", text: "x".repeat(DEFAULT_CAPS.itemChars + 1) }, code: "too-long" },
    { name: "decision empty", proposal: { kind: "decision", text: "   " }, code: "empty" },
    { name: "unknown evidence", proposal: { kind: "decision", text: "copy, never import", evidence: "C77" }, code: "unknown-evidence" },
    { name: "lift unknown target", proposal: { kind: "lift", target: "R9", text: "The no-mocks rule is lifted" }, ctx: { state: withR1 }, code: "unknown-target" },
    { name: "lift already lifted", proposal: { kind: "lift", target: "R1", text: "The no-mocks rule is lifted" }, ctx: { state: lifted }, code: "already-lifted" },
    { name: "lift not later than the correction", proposal: { kind: "lift", target: "R1", ref: "u1", text: "Build the state compactor." }, ctx: { state: withR1 }, code: "lift-not-later" },
    { name: "done-when with no objective", proposal: { kind: "done-when", text: "Done when npm test passes" }, code: "no-objective" },
    { name: "remember cap reached", proposal: { kind: "decision", text: "one more" }, ctx: { acceptedThisSpan: 10 }, code: "remember-cap" },
  ];
  for (const c of cases) {
    const verdict = verify(c.proposal, ctxWith(c.ctx));
    assert.ok(!verdict.ok, c.name);
    assert.equal(verdict.rejection.code, c.code, c.name);
  }
});

test("verify: the diff hand (source diff) is not subject to the remember cap; a lift that resolves later is accepted with the target's ordinal", () => {
  const withR1 = project(logOf(ev({ kind: "correction.add", id: "R1", quote: quote("u2", "Never use mocks in these tests; use fakes."), span: 1 }), closeEvent(1)), DEFAULT_CAPS);
  const verdict = verify({ kind: "lift", target: "R1", text: "The no-mocks rule is lifted" }, ctxWith({ state: withR1, acceptedThisSpan: 10, provenance: { ...PROV, source: "diff" } }));
  assert.ok(verdict.ok);
  assert.equal(verdict.event.kind, "correction.lift");
  assert.deepEqual((verdict.event as { by: unknown }).by, { messageId: "m-u3", ordinal: "u3" });
});

test("verify: objective with doneWhen resolves both quotes; done-when attaches to an existing objective; now passes through; evidence 'last command' is kept", () => {
  const objective = verify({ kind: "objective", ref: "u1", text: "Build the state compactor.", doneWhen: { ref: "u1", text: "Done when npm test passes on the whole tree." } }, ctxWith());
  assert.ok(objective.ok && objective.event.kind === "objective.set" && objective.event.doneWhen?.ordinal === "u1");
  const state = { ...emptyState(), objective: { quote: quote("u1", "Build the state compactor."), setSpan: 1, movedFrom: [] } };
  const doneWhen = verify({ kind: "done-when", text: "Done when npm test passes" }, ctxWith({ state }));
  assert.ok(doneWhen.ok && doneWhen.event.kind === "objective.doneWhen");
  const now = verify({ kind: "now", now: NOW }, ctxWith());
  assert.ok(now.ok && now.event.kind === "now.set");
  const decision = verify({ kind: "decision", text: "copy, never import", evidence: "last command" }, ctxWith());
  assert.ok(decision.ok && decision.event.evidence === "last command");
});

test("applyProposals: verified in order against a scratch projection, so the second copy inside one batch is the duplicate and ids do not collide", () => {
  const result = applyProposals([
    { kind: "correction", text: "Never use mocks in these tests" },
    { kind: "correction", text: "Never use mocks in these tests; use fakes" },
    { kind: "decision", text: "copy, never import" },
    { kind: "decision", text: "x".repeat(400) },
  ], ctxWith({ provenance: { ...PROV, source: "diff" } }));
  assert.deepEqual(result.events.map((event) => (event as { id?: string }).id), ["R1", "D1"]);
  assert.deepEqual(result.rejected.map((r) => [r.index, r.rejection.code]), [[1, "near-duplicate"], [3, "too-long"]]);
  assert.equal(result.state.cursor.R, 1);
  assert.equal(result.state.seq, 2);
});

test("applyProposals: the remember hand counts accepted writes toward the cap within the batch", () => {
  // The three texts must be genuinely distinct: with near-identical wording the overlap was 0.857,
  // so the second and third were rejected as near-duplicates instead of the third hitting the cap (events.length 1, not 2).
  const proposals = Array.from({ length: 3 }, (_, i) => ({ kind: "decision" as const, text: `${["alpha", "bravo", "charlie"][i]} decision about ${["copy", "import", "testing"][i]} semantics` }));
  const result = applyProposals(proposals, ctxWith({ acceptedThisSpan: 8, rememberCap: 10 }));
  assert.equal(result.events.length, 2);
  assert.equal(result.rejected[0]?.rejection.code, "remember-cap");
});

test("verify: a lift is judged on the whole message, so a quote cut out of a restatement cannot retire the rule", () => {
  const restated: Array<[string, string]> = [...branch, ["u5", "don't forget: never use mocks in these tests, ok?"], ["u6", "The no-mocks rule is lifted for the fixtures module."]];
  const withR1 = project(logOf(ev({ kind: "correction.add", id: "R1", quote: quote("u2", "Never use mocks in these tests; use fakes."), span: 1 }), closeEvent(1)), DEFAULT_CAPS);
  const ctx = ctxWith({ resolver: fakeResolver(restated), state: withR1 });
  const cut = verify({ kind: "lift", target: "R1", text: "forget: never use mocks" }, ctx);
  assert.ok(!cut.ok, "the quote alone withdraws, the message restates");
  assert.equal(cut.rejection.code, "lift-unnamed");
  const whole = verify({ kind: "lift", target: "R1", text: "The no-mocks rule is lifted" }, ctx);
  assert.ok(whole.ok, "a quote of a real withdrawal still lifts");
  const elsewhere = verify({ kind: "lift", target: "R1", ref: "u7", text: "forget: no mocks in these tests" }, ctxWith({ resolver: fakeResolver([...restated, ["u7", "Ignore the mocks warning from the linter. And don't forget: no mocks in these tests."]]), state: withR1 }));
  assert.ok(!elsewhere.ok, "a withdrawal elsewhere in the message does not lend the cut quote its meaning");
  const aside = verify({ kind: "lift", target: "R1", text: "for the fixtures module" }, ctx);
  assert.ok(aside.ok, "a quote only locates its message: the message withdraws the rule, so the lift stands");
});

test("verify: a lifted rule is not recorded again from the message that gave it (a carried span shown twice), but the user can say it again", () => {
  const restated: Array<[string, string]> = [...branch, ["u5", "Never use mocks in these tests; use fakes."]];
  const lifted = project(logOf(ev({ kind: "correction.add", id: "R1", quote: quote("u2", "Never use mocks in these tests; use fakes."), span: 1 }), ev({ kind: "correction.lift", target: "R1", by: { messageId: "m-u3", ordinal: "u3" }, span: 1 }), closeEvent(1), closeEvent(2)), DEFAULT_CAPS);
  const ctx = ctxWith({ resolver: fakeResolver(restated), state: lifted, provenance: { ...PROV, source: "diff" } });
  const again = verify({ kind: "correction", ref: "u2", text: "Never use mocks in these tests; use fakes." }, ctx);
  assert.ok(!again.ok);
  assert.deepEqual([again.rejection.code, again.rejection.code === "near-duplicate" && again.rejection.earlierId], ["near-duplicate", "R1"]);
  const said = verify({ kind: "correction", ref: "u5", text: "Never use mocks in these tests; use fakes." }, ctx);
  assert.ok(said.ok, "a new message stating the rule adopts it again");
});

test("verify: a lift may name its rule by the message that gave it (u<n>), for a rule recorded earlier in the same pass", () => {
  const applied = applyProposals([
    { kind: "correction", ref: "u2", text: "Never use mocks in these tests; use fakes." },
    { kind: "lift", target: "u2", ref: "u3", text: "The no-mocks rule is lifted" },
  ], ctxWith({ provenance: { ...PROV, source: "diff" } }));
  assert.deepEqual(applied.rejected, []);
  assert.deepEqual(applied.events.map((event) => event.kind === "correction.lift" ? event.target : event.kind), ["correction.add", "R1"]);
  const missing = verify({ kind: "lift", target: "u1", ref: "u3", text: "The no-mocks rule is lifted" }, ctxWith());
  assert.ok(!missing.ok);
  assert.equal(missing.rejection.code, "unknown-target", "no rule was given at u1");
});

test("verify: a lift whose words do not withdraw the rule it names is refused, whoever proposes it, and the rule stays", () => {
  const withR1 = project(logOf(ev({ kind: "correction.add", id: "R1", quote: quote("u2", "Never use mocks in these tests; use fakes."), span: 1 }), closeEvent(1)), DEFAULT_CAPS);
  for (const source of ["diff", "remember"] as const) {
    const verdict = verify({ kind: "lift", target: "R1", ref: "u4", text: "ok, go ahead and push the branch" }, ctxWith({ state: withR1, provenance: { ...PROV, source } }));
    assert.ok(!verdict.ok, source);
    assert.equal(verdict.rejection.code, "lift-unnamed");
    assert.match(describeRejection(verdict.rejection), /u4 does not say it withdraws R1 \("Never use mocks/);
  }
});

test("verify: a lift of a rule another message already replaced is refused, naming the replacement; only a lift of the replacement itself lands", () => {
  const tabs: Array<[string, string]> = [
    ["u2", "Use tabs for indentation in every TypeScript file in this project."],
    ["u5", "The tab rule is lifted. Never force-push to main."],
    ["u9", "To be clear, the tab rule is lifted."],
    ["u15", "The tab rule doesn't apply to the JSON files or package.json; keep tabs in the TypeScript files."],
    ["u17", "Switch the TypeScript files to two-space indentation instead of tabs from here on, and convert the existing files."],
  ];
  const ctx = (state: ReturnType<typeof project>) => ({ ...ctxWith(), resolver: fakeResolver(tabs), state });
  const replacedBy = (ordinal: string, id: string) => project(logOf(
    ev({ kind: "correction.add", id: "R1", quote: quote("u2", tabs[0][1]) }),
    ev({ kind: "correction.lift", target: "R1", by: { messageId: `m-${ordinal}`, ordinal } }),
    ev({ kind: "correction.add", id, quote: quote(ordinal, tabs.find(([o]) => o === ordinal)![1]) }),
  ), DEFAULT_CAPS);

  // A repeated lift must not reach a rule the earlier lifting message also gave (review SEC-1301).
  const repeated = verify({ kind: "lift", target: "R1", ref: "u9", text: tabs[2][1] }, ctx(replacedBy("u5", "R2")));
  assert.ok(!repeated.ok);
  assert.deepEqual(repeated.rejection, { code: "lift-replaced", target: "R1", by: "u5", replacement: "R2", rule: "The tab rule is lifted. Never force-push to main.", alsoSet: "Never force-push to main" });
  assert.equal(describeRejection(repeated.rejection), 'R1 was replaced by the rule u5 gave (R2); lift it only if this message withdraws that rule as well, naming what it set of its own, as "lifts u5" (or "rule and lifts u5"), otherwise leave it. u5 said: "The tab rule is lifted. Never force-push to main.". Of its own it set: "Never force-push to main", which a lift of it withdraws too.');
  // A long replacement is cut as its state line is, after the condition (review SEC-1502).
  const long = `The tab rule is lifted. ${"Never force-push to main or to any release branch. ".repeat(10)}`.trim();
  const longCtx = { ...ctx(replacedBy("u5", "R2")), resolver: fakeResolver([tabs[0], ["u5", long], tabs[2]]) };
  longCtx.state = project(logOf(
    ev({ kind: "correction.add", id: "R1", quote: quote("u2", tabs[0][1]) }),
    ev({ kind: "correction.lift", target: "R1", by: { messageId: "m-u5", ordinal: "u5" } }),
    ev({ kind: "correction.add", id: "R2", quote: quote("u5", long) }),
  ), DEFAULT_CAPS);
  const cutNote = verify({ kind: "lift", target: "R1", ref: "u9", text: tabs[2][1] }, longCtx);
  assert.ok(!cutNote.ok && cutNote.rejection.code === "lift-replaced");
  assert.ok(cutNote.rejection.rule.length === DEFAULT_CAPS.correctionChars && cutNote.rejection.rule.endsWith("…"));
  assert.ok(cutNote.rejection.alsoSet !== undefined && cutNote.rejection.alsoSet.length <= DEFAULT_CAPS.correctionChars);
  const byOrdinal = verify({ kind: "lift", target: "u2", ref: "u9", text: tabs[2][1] }, ctx(replacedBy("u5", "R2")));
  assert.equal(!byOrdinal.ok && byOrdinal.rejection.code, "lift-replaced", "the same by the old rule's message");

  // The replacement named outright is judged like any lift.
  const narrowed = replacedBy("u15", "R6");
  assert.equal(!verify({ kind: "lift", target: "R1", ref: "u17", text: tabs[4][1] }, ctx(narrowed)).ok, true);
  for (const target of ["R6", "u15"]) {
    const direct = verify({ kind: "lift", target, ref: "u17", text: tabs[4][1] }, ctx(narrowed));
    assert.ok(direct.ok, target);
    assert.deepEqual(direct.event.kind === "correction.lift" && [direct.event.target, direct.event.by.ordinal], ["R6", "u17"]);
  }

  // The retry the refusal suggests must not withdraw the replacement's own rule unnamed (review SEC-1401): a
  // replacement holds the old rule's words, so a lift of it is judged on the rest of what it set.
  for (const [target, by] of [["R2", "u5"], ["u5", "u5"], ["R2", "u7"]] as const) {
    const state = by === "u5" ? replacedBy("u5", "R2") : project(logOf(
      ev({ kind: "correction.add", id: "R1", quote: quote("u2", tabs[0][1]) }),
      ev({ kind: "correction.lift", target: "R1", by: { messageId: "m-u7", ordinal: "u7" } }),
      ev({ kind: "correction.add", id: "R2", quote: quote("u7", "The tab rule is lifted, and never force-push to main.") }),
    ), DEFAULT_CAPS);
    const lines: Array<[string, string]> = [...tabs, ["u7", "The tab rule is lifted, and never force-push to main."], ["u11", "The force-push rule is lifted too."]].sort(([a], [b]) => Number(a.slice(1)) - Number(b.slice(1))) as Array<[string, string]>;
    const at = { ...ctxWith(), resolver: fakeResolver(lines), state };
    const retried = verify({ kind: "lift", target, ref: "u9", text: tabs[2][1] }, at);
    assert.ok(!retried.ok, `${target} given by ${by}`);
    assert.deepEqual(retried.rejection, { code: "lift-unnamed", target: "R2", ordinal: "u9", rule: by === "u5" ? "Never force-push to main" : "never force-push to main" });
    const named = verify({ kind: "lift", target, ref: "u11", text: "The force-push rule is lifted too." }, at);
    assert.ok(named.ok, `a lift naming what ${by} set lands`);
  }

  // Own words that also carry the old rule's name do not let the repeated lift name them through that name.
  const unsplit = "Now that the tab rule is lifted you must never force-push.";
  const unsplitState = project(logOf(
    ev({ kind: "correction.add", id: "R1", quote: quote("u2", tabs[0][1]) }),
    ev({ kind: "correction.lift", target: "R1", by: { messageId: "m-u5", ordinal: "u5" } }),
    ev({ kind: "correction.add", id: "R2", quote: quote("u5", unsplit) }),
  ), DEFAULT_CAPS);
  const unsplitCtx = { ...ctxWith(), resolver: fakeResolver([tabs[0], ["u5", unsplit], tabs[2], ["u11", "The force-push rule is lifted too."]]), state: unsplitState };
  assert.equal(!verify({ kind: "lift", target: "u5", ref: "u9", text: tabs[2][1] }, unsplitCtx).ok, true, "the repeated lift names only the old rule");
  assert.ok(verify({ kind: "lift", target: "u5", ref: "u11", text: "The force-push rule is lifted too." }, unsplitCtx).ok);

  // Masking the old rule's words must not let a scope word in a repeated lift name the own rule (review SEC-1701).
  const tests: Array<[string, string]> = [["u2", "Run the tests before every push."], ["u5", "The tests rule is lifted. Never push to production on Fridays."], ["u9", "To be clear, the tests rule is lifted for production too."]];
  const testsCtx = { ...ctxWith(), resolver: fakeResolver(tests), state: project(logOf(
    ev({ kind: "correction.add", id: "R1", quote: quote("u2", tests[0][1]) }),
    ev({ kind: "correction.lift", target: "R1", by: { messageId: "m-u5", ordinal: "u5" } }),
    ev({ kind: "correction.add", id: "R2", quote: quote("u5", tests[1][1]) }),
  ), DEFAULT_CAPS) };
  assert.equal(!verify({ kind: "lift", target: "u5", ref: "u9", text: tests[2][1] }, testsCtx).ok, true, "a scope word is not the own rule's name");

  const plainLift = project(logOf(
    ev({ kind: "correction.add", id: "R1", quote: quote("u2", tabs[0][1]) }),
    ev({ kind: "correction.lift", target: "R1", by: { messageId: "m-u15", ordinal: "u15" } }),
  ), DEFAULT_CAPS);
  const nothingLeft = verify({ kind: "lift", target: "R1", ref: "u17", text: tabs[4][1] }, ctx(plainLift));
  assert.equal(!nothingLeft.ok && nothingLeft.rejection.code, "already-lifted", "a rule lifted outright has nothing to point at");
});

test("verify: a repeated lift aimed at a replacement by name never withdraws what the replacement set of its own (review rounds 14-18)", () => {
  const rows: Array<{ name: string; old: string; replacement: string; repeat: string }> = [
    { name: "a second sentence", old: "Use tabs for indentation.", replacement: "The tab rule is lifted. Never force-push to main.", repeat: "To be clear, the tab rule is lifted." },
    { name: "after a part break", old: "Use tabs for indentation.", replacement: "The tab rule is lifted, and never force-push to main.", repeat: "To be clear, the tab rule is lifted." },
    { name: "a shared noun (main)", old: "Never commit directly to main.", replacement: "The commit-to-main rule is lifted. Never force-push to main.", repeat: "To be clear, the commit-to-main rule is lifted." },
    { name: "an inflected naming word (committing)", old: "Never commit directly to main.", replacement: "The committing-to-main rule is lifted. Never force-push to main.", repeat: "To be clear, the committing-to-main rule is lifted." },
    { name: "a prefix collision (checkout, check)", old: "Always run make check before you commit.", replacement: "The make check rule is lifted. Never git checkout main directly.", repeat: "To be clear, the make check rule is lifted." },
    { name: "a prefix collision (confirm, config)", old: "Keep config in config.yaml.", replacement: "The config rule is lifted. Always confirm before deleting files.", repeat: "Again, the config rule is lifted." },
    { name: "a prefix collision (strip, Stripe)", old: "Never call the Stripe API from tests.", replacement: "The Stripe rule is lifted. Never strip debug symbols from release builds.", repeat: "To be clear, the Stripe rule is lifted." },
    { name: "a shared verb (push)", old: "Run the tests before every push.", replacement: "The tests rule is lifted. Never push to production on Fridays.", repeat: "Again, the tests rule is lifted." },
    { name: "a scope word in the repeat (production)", old: "Run the tests before every push.", replacement: "The tests rule is lifted. Never push to production on Fridays.", repeat: "To be clear, the tests rule is lifted for production too." },
    { name: "a shared first verb (write)", old: "Write tests for every new function.", replacement: "The tests rule is lifted. Never write to the production database.", repeat: "The tests rule is lifted for production code as well." },
    { name: "keep ... out of this", old: "Use tabs for indentation.", replacement: "The tab rule is lifted. Keep secrets out of this repo.", repeat: "To be clear, the tab rule is lifted." },
    { name: "an e-less look-alike (past, paste)", old: "Never paste secrets into chat.", replacement: "The paste rule is lifted. Never rewrite past releases.", repeat: "To be clear, the paste rule is lifted." },
    { name: "an e-less look-alike (plan, plane)", old: "Always update the release plan.", replacement: "The plan rule is lifted. Never edit the plane config.", repeat: "To be clear, the plan rule is lifted." },
  ];
  for (const { name, old, replacement, repeat } of rows) {
    const lines: Array<[string, string]> = [["u2", old], ["u5", replacement], ["u9", repeat], ["u11", "The force-push rule is lifted too."]];
    const state = project(logOf(
      ev({ kind: "correction.add", id: "R1", quote: quote("u2", old) }),
      ev({ kind: "correction.lift", target: "R1", by: { messageId: "m-u5", ordinal: "u5" } }),
      ev({ kind: "correction.add", id: "R2", quote: quote("u5", replacement) }),
    ), DEFAULT_CAPS);
    const at = { ...ctxWith(), resolver: fakeResolver(lines), state };
    const repeated = verify({ kind: "lift", target: "u5", ref: "u9", text: repeat }, at);
    assert.equal(!repeated.ok && repeated.rejection.code, "lift-unnamed", name);
    if (replacement.includes("force-push")) assert.ok(verify({ kind: "lift", target: "u5", ref: "u11", text: "The force-push rule is lifted too." }, at).ok, `${name}: naming it lands`);
  }
});
