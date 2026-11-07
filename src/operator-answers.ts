/**
 * The operator's answers to `ask_user_question`, read out of the tool result that carries them.
 *
 * An answer is the operator's own decision, but it arrives as a TOOL RESULT, and `intent.ts` admits only user messages
 * as quotable: text injected through a tool result can neither mint nor lift a standing rule (security.md T2). That
 * boundary stays. What an answer may do is become a decision -- kind `decision` is the model's own sentence, so nothing
 * is laundered by citing one -- and be numbered `q1`, `q2`, ... in branch order so a decision can name the answer it
 * rests on as `evidence`.
 *
 * Both a picked option's label and a typed custom answer are recorded, because both are the operator's choice at a
 * fork; only the typed words are ever the operator's own WORDING, which is why nothing here feeds a correction quote.
 * A declined questionnaire is not a decision and yields nothing. The tool's `details` are another extension's shape,
 * so every field is read defensively: a missing one drops that answer, never the whole batch.
 */
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import { scrubCredentials } from "./credential-scrub.ts";
import { oneLine } from "./one-line.ts";
import type { Caps, StateEvent } from "./store/events.ts";
import type { SessionState } from "./store/project.ts";
import { applyProposals, type Proposal, type QuoteResolver } from "./store/verify.ts";

/** The tool whose result carries the answers (the pi extension's registered name). */
export const ASK_TOOL = "ask_user_question";

/** How much of the operator's answer, question and notes a composed decision shows. */
export const ANSWER_CHARS = 240;
export const ANSWER_QUESTION_CHARS = 160;
export const ANSWER_NOTES_CHARS = 120;
/** The most one composed decision text can be: every part cut to its cap, plus the scaffolding between them. */
export const ANSWER_ITEM_CHARS = ANSWER_CHARS + ANSWER_QUESTION_CHARS + ANSWER_NOTES_CHARS + 64;

export type AnswerKind = "option" | "custom" | "multi";

export interface OperatorAnswer extends AnsweredQuestion {
  /** `q1`, `q2`, ... In branch order, skipping nothing, so the ordinal is stable for a given transcript. */
  ordinal: string;
  /** The tool-result entry's id: what a later lookup binds to. */
  messageId: string;
}

/** One answered question, as the tool result carries it and as a decision text is composed from it. */
export interface AnsweredQuestion {
  questionIndex: number;
  question: string;
  /** The operator's typed words for `custom`, else the label of the option they picked (multi: every one, comma-joined). */
  answer: string;
  kind: AnswerKind;
  notes?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

const textOf = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/** A cut with the renderer's own marker, so a shortened field is visibly shortened rather than silently wrong. */
export function cut(text: string, max: number): string {
  const flat = oneLine(text);
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** `selected` labels then the typed addition, as the tool's own envelope joins a multi answer. */
function multiAnswer(selected: unknown, answer: string): string {
  const labels = Array.isArray(selected) ? selected.map(textOf).filter((label) => label.length > 0) : [];
  if (answer.length > 0) labels.push(answer);
  return labels.join(", ");
}

/**
 * The answered questions of one `ask_user_question` result's `details`, or [] when it carries none: a declined
 * questionnaire, a partial submit's blanks, an error, or a shape this build does not recognise.
 */
export function answersFromDetails(details: unknown): AnsweredQuestion[] {
  if (!isRecord(details)) return [];
  if (details.cancelled === true) return [];
  const raw = Array.isArray(details.answers) ? details.answers : [];
  const answers: AnsweredQuestion[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const questionIndex = typeof entry.questionIndex === "number" ? entry.questionIndex : -1;
    const kind = entry.kind === "custom" || entry.kind === "multi" ? entry.kind : "option";
    const answer = kind === "multi" ? multiAnswer(entry.selected, textOf(entry.answer)) : textOf(entry.answer);
    const question = textOf(entry.question);
    // An empty answer is an unanswered question however it was submitted ("(no input)" is the tool's placeholder, not words).
    if (questionIndex < 0 || answer.length === 0) continue;
    const notes = textOf(entry.notes);
    answers.push({ questionIndex, question, answer, kind, ...(notes.length > 0 ? { notes } : {}) });
  }
  return answers;
}

/** The answers a transcript entry carries, when it is an `ask_user_question` result: [] for every other entry. */
export function answersOfEntry(entry: SessionEntry): AnsweredQuestion[] {
  if (entry.type !== "message") return [];
  const message = (entry as { message?: { role?: unknown; toolName?: unknown; details?: unknown; isError?: unknown } }).message;
  if (!message || message.role !== "toolResult" || message.toolName !== ASK_TOOL || message.isError === true) return [];
  return answersFromDetails(message.details);
}

/**
 * Every answer on the branch, oldest first, numbered `q1`, `q2`, ... Each question of a questionnaire gets its own
 * ordinal, so a decision cites exactly the answer it was made from.
 */
export function answersInBranch(branchEntries: SessionEntry[]): OperatorAnswer[] {
  const answers: OperatorAnswer[] = [];
  for (const entry of branchEntries) {
    for (const raw of answersOfEntry(entry)) answers.push({ ordinal: `q${answers.length + 1}`, messageId: entry.id, ...raw });
  }
  return answers;
}

export const isAnswerOrdinal = (value: string): boolean => /^q\d+$/.test(value.trim());

/**
 * What `recall` shows for an answer: the question it settled and what the operator chose, on one line. This is the
 * only way a decision's `q<n>` evidence resolves to words, so it names both halves rather than the answer alone.
 */
export function answerLookupText(answer: OperatorAnswer | undefined): string | undefined {
  if (!answer) return undefined;
  const question = oneLine(answer.question);
  const notes = answer.notes ? ` (notes: ${oneLine(answer.notes)})` : "";
  return `Asked: "${question}" — the operator ${answer.kind === "custom" ? "answered" : "chose"}: "${oneLine(answer.answer)}"${notes}`;
}

/**
 * One decision text for an answer: the choice, enough of the question to make it mean something on its own, and the
 * operator's notes when they left any. Scrubbed like every model-written item (security.md T3), and cut to
 * ANSWER_ITEM_CHARS so an auto-recorded decision can never crowd the state the way a pasted answer would.
 */
export function answerDecisionText(answer: AnsweredQuestion): string {
  const chosen = cut(answer.answer, ANSWER_CHARS);
  const question = cut(answer.question, ANSWER_QUESTION_CHARS);
  const verb = answer.kind === "custom" ? "answered" : "chose";
  const link = answer.kind === "custom" ? "to" : "for";
  const body = `${chosen.length > 0 ? `Operator ${verb} "${chosen}"` : "Operator answered"} ${link}: ${question.length > 0 ? question : "(question not recorded)"}`;
  const withNotes = answer.notes ? `${body}. Notes: ${cut(answer.notes, ANSWER_NOTES_CHARS)}` : body;
  return cut(scrubCredentials(withNotes).text, ANSWER_ITEM_CHARS);
}

/**
 * The `decision.add` events that record a batch of answers, through the store's own gate. Provenance is `code` (not
 * `pass`): an answer is observed the moment it lands, at a tool result, not by a pass. So the model's per-span remember
 * budget is not spent on answers it never asked to record, and a reader of the log can tell the two apart.
 *
 * Near-duplicate detection runs at 1 (identical text only) rather than the configured threshold. Two answers to two
 * similar-sounding questions are two separate decisions -- "Yes (Recommended)" settles different things under different
 * questions, and the composed text carries each question -- so fuzzy overlap must not quietly drop the second one. The
 * same question answered the same way twice is text-identical and still lands once.
 */
export function answerEvents(answers: readonly AnsweredQuestion[], deps: { state: SessionState; resolver: QuoteResolver; caps: Caps; span: number; at: string }): StateEvent[] {
  if (answers.length === 0) return [];
  const proposals: Proposal[] = answers.map((answer) => ({ kind: "decision", text: answerDecisionText(answer) }));
  return applyProposals(proposals, {
    resolver: deps.resolver, state: deps.state, provenance: { source: "code", span: deps.span, at: deps.at }, caps: deps.caps,
    nearDuplicateThreshold: 1, acceptedThisSpan: 0, rememberCap: 0,
  }).events;
}
