/**
 * The operator's answers, from the tool result that carries them to the decisions that keep them: the `q<n>` numbering,
 * the composed text, and the two boundaries that must not move -- an answer is never quotable as a rule, and two
 * different answers to two similar questions are two decisions, not one.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { buildMessageIndex } from "./intent.ts";
import {
  ANSWER_ITEM_CHARS, answerDecisionText, answerEvents, answerLookupText, answersFromDetails, answersInBranch, answersOfEntry, ASK_TOOL, cut,
} from "./operator-answers.ts";
import { applyEvent, emptyState } from "./store/project.ts";
import { DEFAULT_CAPS } from "./store/events.ts";
import { verify } from "./store/verify.ts";
import { chain, toolResultEntry, userEntry } from "./test-support.ts";

/** One `ask_user_question` result's `details`, in the tool's own shape (rpiv-ask-user-question QuestionnaireResult). */
function details(answers: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) {
  return { answers, cancelled: false, ...extra };
}

const OPTION = { questionIndex: 0, question: "Where should the repo live?", kind: "option" as const, answer: "GitHub (Recommended)" };
const TYPED = { questionIndex: 1, question: "How should the cage be configured?", kind: "custom" as const, answer: "TOML, and keep it out of the repo" };

test("answersFromDetails: a picked option, a typed answer, a multi-selection with a typed addition, and notes", () => {
  const parsed = answersFromDetails(details([
    OPTION,
    TYPED,
    { questionIndex: 2, question: "Which checks?", kind: "multi", answer: "", selected: ["lint", "types"] },
    { questionIndex: 3, question: "Where to deploy?", kind: "option", answer: "staging-1", notes: "not the laptop" },
  ]));
  assert.deepEqual(parsed.map((answer) => [answer.questionIndex, answer.kind, answer.answer]), [
    [0, "option", "GitHub (Recommended)"],
    [1, "custom", "TOML, and keep it out of the repo"],
    [2, "multi", "lint, types"],
    [3, "option", "staging-1"],
  ]);
  assert.equal(parsed[3].notes, "not the laptop");
});

test("answersFromDetails: a decline, an unanswered question and an unknown shape all yield nothing", () => {
  assert.deepEqual(answersFromDetails({ answers: [OPTION], cancelled: true }), [], "a declined questionnaire is no decision");
  assert.deepEqual(answersFromDetails(details([{ ...OPTION, answer: "" }])), [], "an empty answer is unanswered however it was submitted");
  assert.deepEqual(answersFromDetails(details([{ ...OPTION, answer: null }])), []);
  assert.deepEqual(answersFromDetails(details([{ ...OPTION, questionIndex: "0" }])), [], "a missing index drops that answer only");
  assert.deepEqual(answersFromDetails(undefined), []);
  assert.deepEqual(answersFromDetails("User has answered your questions:"), []);
  assert.deepEqual(answersFromDetails({ answers: "nope" }), []);
});

test("answersOfEntry: only a non-error ask_user_question result carries answers", () => {
  const withDetails = (tool: string, isError = false) => chain([userEntry("u1", "hi"), toolResultEntry("t1", "c1", tool, "text", isError, details([OPTION]))]);
  assert.equal(answersOfEntry(withDetails(ASK_TOOL)[1]).length, 1);
  assert.deepEqual(answersOfEntry(withDetails(ASK_TOOL, true)[1]), [], "an errored result is not an answer");
  assert.deepEqual(answersOfEntry(withDetails("marshal_ask")[1]), [], "another tool's text cannot pass for an answer");
  assert.deepEqual(answersOfEntry(withDetails(ASK_TOOL)[0]), [], "a user message is not an answer");
});

test("answersInBranch: q1, q2, ... in branch order across results, each bound to its own result's entry id", () => {
  const branch = chain([
    userEntry("u1", "go ahead"),
    toolResultEntry("t1", "c1", ASK_TOOL, "User has answered", false, details([OPTION, TYPED])),
    toolResultEntry("t2", "c2", ASK_TOOL, "User has answered", false, details([{ ...OPTION, question: "And now?" }])),
  ]);
  const answers = answersInBranch(branch);
  assert.deepEqual(answers.map((answer) => answer.ordinal), ["q1", "q2", "q3"]);
  assert.deepEqual(answers.map((answer) => answer.messageId), ["t1", "t1", "t2"]);
  assert.equal(answerLookupText(answers[0]), 'Asked: "Where should the repo live?" — the operator chose: "GitHub (Recommended)"');
  assert.equal(answerLookupText(answers[1])?.includes('the operator answered: "TOML, and keep it out of the repo"'), true);
  assert.equal(answerLookupText(undefined), undefined);
});

test("answerDecisionText: the choice, enough of the question to stand alone, and the notes", () => {
  assert.equal(answerDecisionText({ ...OPTION, questionIndex: 0 }), 'Operator chose "GitHub (Recommended)" for: Where should the repo live?');
  assert.equal(answerDecisionText({ ...TYPED, questionIndex: 0 }), 'Operator answered "TOML, and keep it out of the repo" to: How should the cage be configured?');
  assert.equal(answerDecisionText({ ...OPTION, questionIndex: 0, notes: "  pin it  " }), 'Operator chose "GitHub (Recommended)" for: Where should the repo live?. Notes: pin it');
});

test("answerDecisionText: every part is cut with a visible marker, on one line, inside ANSWER_ITEM_CHARS", () => {
  const long = { questionIndex: 0, kind: "custom" as const, question: `q${"x".repeat(2000)}`, answer: `a${"y".repeat(2000)}`, notes: `n${"z".repeat(2000)}` };
  const text = answerDecisionText(long);
  assert.ok(text.length <= ANSWER_ITEM_CHARS, `${text.length} > ${ANSWER_ITEM_CHARS}`);
  assert.ok(text.startsWith('Operator answered "a'), "the operator's words lead");
  assert.doesNotMatch(text, /[\n\r]/, "one line");
  assert.equal(text.includes("…"), true, "a cut is always visible");
  assert.equal(answerDecisionText({ ...OPTION, questionIndex: 0, answer: "line\nbreak\u0007" }), 'Operator chose "line break" for: Where should the repo live?', "control characters and newlines collapse");
  assert.equal(cut("short", 10), "short");
});

test("answerDecisionText: a credential value in an answer is scrubbed rather than recorded (security.md T3)", () => {
  const text = answerDecisionText({ ...OPTION, questionIndex: 0, answer: "export DB_PASSWORD=hunter22 first" });
  assert.equal(text.includes("hunter22"), false, text);
  assert.match(text, /export DB_PASSWORD=<redacted> first/);
});

test("answerEvents: each answer becomes one decision through the mechanical hand, numbered from the state", () => {
  const branch = chain([userEntry("u1", "go ahead"), toolResultEntry("t1", "c1", ASK_TOOL, "answered", false, details([OPTION, TYPED]))]);
  const index = buildMessageIndex(branch, { commandIds: new Set(), errorIds: new Set() });
  const events = answerEvents(answersInBranch(branch), { state: emptyState(), resolver: index, caps: DEFAULT_CAPS, span: 1, at: "2026-11-06T10:00:00.000Z" });
  assert.deepEqual(events.map((event) => (event as { kind: string }).kind), ["decision.add", "decision.add"]);
  assert.deepEqual(events.map((event) => (event as { id: string }).id), ["D1", "D2"]);
  assert.deepEqual(events.map((event) => (event as { source: string }).source), ["pass", "pass"], "not the model's remember budget");
  assert.match((events[0] as { text: string }).text, /^Operator chose "GitHub \(Recommended\)" for: Where should the repo live\?$/);
  const state = events.reduce((folded, event) => applyEvent(folded, event, DEFAULT_CAPS), emptyState());
  assert.equal(state.decisions.length, 2);
});

test("answerEvents: two answers to two similar questions are two decisions; only an identical repeat is dropped", () => {
  const branch = chain([
    userEntry("u1", "go ahead"),
    toolResultEntry("t1", "c1", ASK_TOOL, "answered", false, details([{ questionIndex: 0, question: "Should I push it now?", kind: "option", answer: "Yes (Recommended)" }])),
    toolResultEntry("t2", "c2", ASK_TOOL, "answered", false, details([{ questionIndex: 0, question: "Should I deploy it now?", kind: "option", answer: "Yes (Recommended)" }])),
    toolResultEntry("t3", "c3", ASK_TOOL, "answered", false, details([{ questionIndex: 0, question: "Should I deploy it now?", kind: "option", answer: "Yes (Recommended)" }])),
  ]);
  const index = buildMessageIndex(branch, { commandIds: new Set(), errorIds: new Set() });
  const events = answerEvents(answersInBranch(branch), { state: emptyState(), resolver: index, caps: DEFAULT_CAPS, span: 1, at: "2026-11-06T10:00:00.000Z" });
  assert.deepEqual(events.map((event) => (event as { text: string }).text), [
    'Operator chose "Yes (Recommended)" for: Should I push it now?',
    'Operator chose "Yes (Recommended)" for: Should I deploy it now?',
  ], "the similar-but-different answer lands; the exact repeat does not");
});

test("an answer is never quotable as a rule, and its q<n> is accepted as a decision's evidence", () => {
  const branch = chain([userEntry("u1", "go ahead"), toolResultEntry("t1", "c1", ASK_TOOL, "answered", false, details([TYPED]))]);
  const index = buildMessageIndex(branch, { commandIds: new Set(), errorIds: new Set() });
  const ctx = { resolver: index, state: emptyState(), provenance: { source: "remember" as const, span: 1, at: "2026-11-06T10:00:00.000Z" }, caps: DEFAULT_CAPS, nearDuplicateThreshold: 0.8, acceptedThisSpan: 0, rememberCap: 10 };

  const quoted = verify({ kind: "correction", text: "TOML, and keep it out of the repo" }, ctx);
  assert.equal(quoted.ok, false, "a tool result cannot mint a standing rule (security.md T2)");
  assert.equal((quoted as { rejection: { code: string } }).rejection.code, "not-substring");

  const cited = verify({ kind: "decision", text: "Configured the cage from TOML kept outside the repo", evidence: "q1" }, ctx);
  assert.ok(cited.ok, JSON.stringify(cited));
  assert.equal((cited.event as { evidence?: string }).evidence, "q1");
  assert.equal(verify({ kind: "decision", text: "Something else entirely", evidence: "q9" }, ctx).ok, false, "an ordinal that names no answer is refused");
  assert.equal(verify({ kind: "decision", text: "Something else entirely", evidence: "u1" }, ctx).ok, true, "user ordinals still work");
});

test("the index resolves a q ordinal to the question and the answer, for recall", () => {
  const branch = chain([userEntry("u1", "go ahead"), toolResultEntry("t1", "c1", ASK_TOOL, "answered", false, details([OPTION]))]);
  const index = buildMessageIndex(branch, { commandIds: new Set(), errorIds: new Set() });
  assert.match(index.textOf("q1") ?? "", /Asked: "Where should the repo live\?" — the operator chose: "GitHub \(Recommended\)"/);
  assert.equal(index.textOf("q2"), undefined);
  assert.equal(index.textOf("u1"), "go ahead");
});
