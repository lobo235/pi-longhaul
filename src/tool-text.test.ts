import test from "node:test";
import assert from "node:assert/strict";

import { formatRecall, formatRemember, NO_RETRY_CODES, RECALL_CHARS_CAP } from "./tool-text.ts";

test("formatRemember: accepted names the id, ordinal, text and the remaining budget; rejected carries the sentence and 'do not retry' only for terminal codes", () => {
  const accepted = formatRemember({ ok: true, remaining: 7, event: { source: "remember", span: 2, at: "x", seq: 3, kind: "correction.add", id: "R3", quote: { messageId: "m", ordinal: "u12", text: "never use mocks" } } });
  assert.equal(accepted, "remembered R3 [u12] never use mocks (7 remember writes left this span)");
  const decision = formatRemember({ ok: true, remaining: 0, event: { source: "remember", span: 2, at: "x", seq: 4, kind: "decision.add", id: "D2", text: "copy the ledger", evidence: "C1" } });
  assert.equal(decision, "remembered D2 copy the ledger (evidence C1) (0 remember writes left this span)");
  const dup = formatRemember({ ok: false, remaining: 7, rejection: { code: "near-duplicate", earlierId: "R1", overlap: 0.9 } });
  assert.match(dup, /^not remembered: .*R1.* do not retry\.$/);
  const sub = formatRemember({ ok: false, remaining: 7, rejection: { code: "not-substring", ref: "any user message", excerpt: "never use mo", closest: "never use fakes", recent: [{ ordinal: "u3", excerpt: "never use fakes" }] } });
  assert.match(sub, /^not remembered: /);
  assert.doesNotMatch(sub, /do not retry/);
  assert.ok(NO_RETRY_CODES.has("remember-cap") && !NO_RETRY_CODES.has("not-substring"));
});

test("formatRecall: brief = one line per hit; full = the same plus retired/lifted markers; the cap cuts whole lines and says how many more", () => {
  const hits = [
    { kind: "commands" as const, ref: "C1", span: 1, text: "C1 npm test (exit 0, 1 run, span 1)" },
    { kind: "corrections" as const, ref: "R1", span: 1, text: "R1 [u2] never use mocks", lifted: true },
    { kind: "decisions" as const, ref: "D1", span: 1, text: "D1 copy the ledger", retired: true },
  ];
  assert.equal(formatRecall(hits, 3, "brief"), "C1 npm test (exit 0, 1 run, span 1)\nR1 [u2] never use mocks\nD1 copy the ledger");
  assert.equal(formatRecall(hits, 3, "full"), "C1 npm test (exit 0, 1 run, span 1)\nR1 [u2] never use mocks (lifted)\nD1 copy the ledger (retired)");
  assert.equal(formatRecall([], 0, "brief"), "nothing recalled (try: longhaul_recall span N | commands <pattern> | errors | decisions | dead-ends | corrections | message uN | output C12)");
  const many = Array.from({ length: 200 }, (_, i) => ({ kind: "commands" as const, ref: `C${i}`, text: `C${i} ${"x".repeat(60)}` }));
  const cut = formatRecall(many, 500, "brief");
  assert.ok(cut.length <= RECALL_CHARS_CAP, `${cut.length}`);
  assert.match(cut, /\n… \d+ more \(narrow the query\)$/);
  assert.equal(formatRecall(many.slice(0, 2), 10, "brief").split("\n").at(-1), "… 8 more (narrow the query)");
});
