import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_TURNS_POLICY, EXPECTATION_CHECKS, resolveTurnsPolicy } from "./policy.ts";
import { judgeAnswer } from "./section.ts";
import { SECTIONS } from "./sections.ts";

test("resolveTurnsPolicy: defaults when unset; out-of-range values fall back", () => {
  assert.deepEqual(resolveTurnsPolicy(undefined), DEFAULT_TURNS_POLICY);
  assert.equal(resolveTurnsPolicy({ repairTurns: 9, passMs: 1 }).repairTurns, 2);
  assert.equal(resolveTurnsPolicy({ passMs: 600_000 }).passMs, 600_000);
});

test("resolveTurnsPolicy: config can switch off an expectation check, never an integrity check or an unknown one", () => {
  const policy = resolveTurnsPolicy({ disabledChecks: ["now.resume", "labels.unlabelled", "made.up", "now.resume"] });
  assert.deepEqual(policy.disabledChecks, ["now.resume"]);
});

test("EXPECTATION_CHECKS: lists every excusable check the sections raise and nothing else", () => {
  const raised = new Set<string>();
  const facts = { spanOrdinals: [], seedOrdinals: [], textOf: () => undefined, activeCorrections: [], openErrorIds: ["E2"], unresolvedSpanErrorIds: ["E1"], spanModifiedFiles: ["a.ts"] };
  const ctx = { resolver: { resolve: () => ({ ok: false, rejection: { code: "empty" } }), position: () => undefined, messageText: () => undefined, hasEvidence: () => true }, state: { seq: 0 }, provenance: { source: "diff", span: 1, at: "" }, caps: {}, nearDuplicateThreshold: 1, acceptedThisSpan: 0, rememberCap: 0 } as never;
  const empties: Record<string, string> = { narrative: '{"narrative": "x"}', records: '{"decisions": [], "deadEnds": []}', now: '{"now": {"inProgress": [], "next": [], "blocked": [], "resume": ""}}' };
  for (const section of SECTIONS) {
    if (!empties[section.id]) continue;
    for (const complaint of judgeAnswer(section, empties[section.id], facts, ctx).complaints) if (complaint.excusable) raised.add(complaint.check);
  }
  assert.deepEqual([...raised].sort(), [...EXPECTATION_CHECKS].sort());
});

test("resolveTurnsPolicy: reasoning is per section, off by default, and only off or low is accepted", () => {
  assert.deepEqual(DEFAULT_TURNS_POLICY.reasoning, {});
  const policy = resolveTurnsPolicy({ reasoning: { records: "low", now: "medium", labels: "off", bogus: "low" }, reasoningOutputTokens: 6000 });
  assert.deepEqual(policy.reasoning, { records: "low", labels: "off" });
  assert.equal(policy.reasoningOutputTokens, 6000);
  assert.equal(resolveTurnsPolicy({ reasoningOutputTokens: 50 }).reasoningOutputTokens, DEFAULT_TURNS_POLICY.reasoningOutputTokens);
});
