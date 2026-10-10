/**
 * Sections 1, 2, 4 and 5 (labels.ts is section 3), in the order the runner asks for them. Each check
 * is written here and has a stable id ("<section>.<check>"): config may switch an expectation check
 * off (`narrativeTurns.disabledChecks`), never add one. World, Files and the ledger are code-only and
 * have no section.
 */
import { Type } from "typebox";
import { Value } from "typebox/value";

import { DEFAULT_CAPS, type Now } from "../../store/events.ts";
import { GOAL_SOURCE_LABEL } from "../../store/project.ts";
import type { Proposal } from "../../store/verify.ts";
import { quotableText } from "../../intent.ts";
import { normalizeDiffShape } from "../parse.ts";
import { NOW_ITEM_CHARS, NOW_ITEMS } from "../types.ts";
import { labelsSection } from "./labels.ts";
import type { Complaint, Facts, Parsed, Section } from "./section.ts";

export const NARRATIVE_CHARS = 4000;

const expectation = (check: string, message: string): Complaint => ({ check, message, excusable: true });
const integrityOf = (check: string, message: string, path?: string): Complaint => ({ check, message, excusable: false, ...(path ? { path } : {}) });
const basename = (path: string) => path.split("/").filter(Boolean).at(-1) ?? path;

export const narrativeSection: Section<{ narrative: string }> = {
  id: "narrative",
  instruction: () => 'Section 1 of 5: the narrative. Answer {"narrative": "<one paragraph, past tense: what happened in this span, naming the commands (C<n>) and the files>"}',
  parse: (value) => (typeof value.narrative === "string" ? { ok: true, answer: { narrative: value.narrative.trim() } } : { ok: false, error: 'expected {"narrative": "<one paragraph>"}' }),
  integrity: (answer) => {
    if (answer.narrative === "") return [integrityOf("narrative.empty", "the narrative is empty", "narrative")];
    if (answer.narrative.length > NARRATIVE_CHARS) return [integrityOf("narrative.too-long", `the narrative is ${answer.narrative.length} characters; at most ${NARRATIVE_CHARS}`, "narrative")];
    return [];
  },
  expectations: (answer, facts) => {
    if (facts.spanModifiedFiles.length === 0) return [];
    const named = facts.spanModifiedFiles.some((file) => answer.narrative.includes(basename(file)));
    return named ? [] : [expectation("narrative.names-modified-file", `files were modified in this span (${facts.spanModifiedFiles.slice(-5).map(basename).join(", ")}) and the narrative names none of them`)];
  },
  proposals: () => [],
  narrative: (answer) => answer.narrative,
};

type QuoteAnswer = { messageRef: string; text?: string };
type ObjectiveAnswer = { change?: QuoteAnswer; doneWhen?: QuoteAnswer };

function quoteAnswer(value: unknown): QuoteAnswer | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { messageRef, text } = value as Record<string, unknown>;
  if (typeof messageRef !== "string") return undefined;
  return { messageRef: messageRef.replace(/^\[|\]$/g, ""), ...(typeof text === "string" && text.trim() ? { text } : {}) };
}

function parseObjective(value: Record<string, unknown>): Parsed<ObjectiveAnswer> {
  const keep = typeof value.objective === "string" && /^keep$/i.test(value.objective.trim());
  const change = keep ? undefined : quoteAnswer(value.objective);
  if (!keep && !change) return { ok: false, error: 'expected {"objective": "keep"} or {"objective": {"messageRef": "u<n>"}}' };
  const doneWhen = value.doneWhen === undefined || value.doneWhen === null ? undefined : quoteAnswer(value.doneWhen);
  if (value.doneWhen && !doneWhen) return { ok: false, error: 'doneWhen must be {"messageRef": "u<n>", "text": "<exact words>"}' };
  return { ok: true, answer: { change, doneWhen } };
}

function objectiveProposals(answer: ObjectiveAnswer, facts: Facts): Array<{ path: string; proposal: Proposal }> {
  const textOf = (quote: QuoteAnswer) => quote.text ?? quotableText(facts.textOf(quote.messageRef) ?? "").trim();
  const doneWhen = answer.doneWhen ? { ref: answer.doneWhen.messageRef, text: textOf(answer.doneWhen) } : undefined;
  if (answer.change) return [{ path: "objective", proposal: { kind: "objective", ref: answer.change.messageRef, text: textOf(answer.change), doneWhen } }];
  return doneWhen ? [{ path: "doneWhen", proposal: { kind: "done-when", ...doneWhen } }] : [];
}

export const objectiveSection: Section<ObjectiveAnswer> = {
  id: "objective",
  instruction: (facts) => [
    "Section 2 of 5: the objective, the request the work is answering now.",
    ...(facts.goal ? [`The goal line is: [${facts.goal.ordinal}] ${facts.goal.text} (${GOAL_SOURCE_LABEL[facts.goal.source]}; code keeps it; never answer it as the objective; under it the objective is the specific ask).`] : []),
    `The objective is now: ${facts.objective ? `[${facts.objective.ordinal}] ${facts.objective.text}` : "(not set)"}`,
    'If a user message in this span set the request or moved to a different one, answer {"objective": {"messageRef": "u<n>"}} (add "text": "<the user\'s exact words>" when only part of the message is the request); otherwise answer {"objective": "keep"}.',
    'Add "doneWhen": {"messageRef": "u<n>", "text": "<the user\'s exact words>"} only when the user said when the work counts as done.',
  ].join("\n"),
  parse: parseObjective,
  integrity: (answer, facts) => [answer.change, answer.doneWhen].flatMap((quote, i) => (quote && facts.textOf(quote.messageRef) === undefined ? [integrityOf("objective.ref", `${quote.messageRef} is not a user message`, i === 0 ? "objective" : "doneWhen")] : [])),
  expectations: () => [],
  proposals: objectiveProposals,
};

type Item = { text: string; evidence?: string };
type Records = { decisions: Item[]; deadEnds: Item[] };

function itemsOf(value: unknown): Item[] | undefined {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return undefined;
  return value.map((item) => (typeof item === "string" ? { text: item } : { text: String((item as Item)?.text ?? ""), ...(typeof (item as Item)?.evidence === "string" ? { evidence: (item as Item).evidence } : {}) }));
}

/** Errors this span saw and never resolved that are not open errors either: each must be a dead end. */
const silentErrors = (facts: Facts) => facts.unresolvedSpanErrorIds.filter((id) => !facts.openErrorIds.includes(id));

function recordsIntegrity(answer: Records): Complaint[] {
  const out: Complaint[] = [];
  for (const [key, items] of [["decisions", answer.decisions], ["deadEnds", answer.deadEnds]] as const) {
    items.forEach((item, i) => {
      if (!item.evidence) out.push(integrityOf("records.evidence", `${key}[${i}] cites no id: add "evidence": "C<n>", "E<n>" or "u<n>" from the digest`, `${key}[${i}]`));
      else if (/^T\d+$/.test(item.evidence.trim())) out.push(integrityOf("records.evidence", `${key}[${i}]: ${item.evidence.trim()} is a transcript id, not evidence: cite the command id shown in brackets on that line (C<n>), the error E<n> it produced, or the user message u<n>`, `${key}[${i}]`));
    });
  }
  return out;
}

export const recordsSection: Section<Records> = {
  id: "records",
  instruction: (facts) => {
    const silent = silentErrors(facts);
    return [
      "Section 4 of 5: decisions and dead ends made in this span (not the ones already in the state).",
      'Answer {"decisions": [{"text": "<one sentence, past tense>", "evidence": "C3"}], "deadEnds": [{"text": "<what was tried and why it failed>", "evidence": "E1"}]}',
      `Each text is at most ${facts.itemChars ?? DEFAULT_CAPS.itemChars} characters: one sentence, no command output.`,
      "Every item cites one id from the digest as evidence: a command C<n>, an error E<n> or a user message u<n>. A transcript id T<n> is not evidence: cite the C<n> in brackets on its line. Empty lists are fine.",
      ...(silent.length ? [`Errors ${silent.join(", ")} were seen in this span and never resolved: record each as a dead end citing it.`] : []),
    ].join("\n");
  },
  parse: (value) => {
    const decisions = itemsOf(value.decisions);
    const deadEnds = itemsOf(value.deadEnds);
    return decisions && deadEnds ? { ok: true, answer: { decisions, deadEnds } } : { ok: false, error: '"decisions" and "deadEnds" must be lists' };
  },
  integrity: recordsIntegrity,
  expectations: (answer, facts) => {
    const cited = new Set(answer.deadEnds.map((item) => item.evidence));
    const silent = silentErrors(facts).filter((id) => !cited.has(id));
    return silent.length ? [expectation("records.unfixed-failure", `errors ${silent.join(", ")} were never fixed and are not open errors: record each as a dead end citing it`)] : [];
  },
  proposals: (answer) => [
    ...answer.decisions.map((item, i) => ({ path: `decisions[${i}]`, proposal: { kind: "decision" as const, text: item.text, evidence: item.evidence } })),
    ...answer.deadEnds.map((item, i) => ({ path: `deadEnds[${i}]`, proposal: { kind: "dead-end" as const, text: item.text, evidence: item.evidence } })),
  ],
};

const NowSchema = Type.Object({ inProgress: Type.Array(Type.String({ maxLength: NOW_ITEM_CHARS }), { maxItems: NOW_ITEMS }), next: Type.Array(Type.String({ maxLength: NOW_ITEM_CHARS }), { maxItems: NOW_ITEMS }), blocked: Type.Array(Type.String({ maxLength: NOW_ITEM_CHARS }), { maxItems: NOW_ITEMS }), resume: Type.String({ maxLength: NOW_ITEM_CHARS }) });

function parseNow(value: Record<string, unknown>): Parsed<{ now: Now }> {
  const now = (normalizeDiffShape({ now: value.now }) as { now: unknown }).now;
  if (!Value.Check(NowSchema, now)) return { ok: false, error: `expected {"now": {"inProgress": [...], "next": [...], "blocked": [...], "resume": "..."}}: ${[...Value.Errors(NowSchema, now)].slice(0, 3).map((error) => `${error.instancePath || "/"} ${error.message}`).join("; ")}` };
  return { ok: true, answer: { now: now as Now } };
}

export const nowSection: Section<{ now: Now }> = {
  id: "now",
  instruction: (facts) => [
    "Section 5 of 5: Now, where the work stands at the end of this span. It replaces the previous Now entirely.",
    'Answer {"now": {"inProgress": ["..."], "next": ["..."], "blocked": ["..."], "resume": "<the first thing to do on resume>"}}',
    'Short status lines, not paragraphs. Never write "done" unless the work is verified done in the transcript.',
    ...(facts.customInstructions ? [`The user asked for this compaction: ${facts.customInstructions}`] : []),
  ].join("\n"),
  parse: parseNow,
  integrity: () => [],
  expectations: (answer, facts) => {
    const out: Complaint[] = [];
    const empty = answer.now.inProgress.length + answer.now.next.length + answer.now.blocked.length === 0;
    if (empty && facts.openErrorIds.length) out.push(expectation("now.open-errors", `open errors ${facts.openErrorIds.join(", ")} remain and Now lists nothing in progress, next or blocked`));
    if (answer.now.resume.trim() === "") out.push(expectation("now.resume", "resume is empty: name the first thing to do on resume"));
    return out;
  },
  proposals: (answer) => [{ path: "now", proposal: { kind: "now", now: answer.now } }],
};

/** The turn order. */
export const SECTIONS: ReadonlyArray<Section<any>> = [narrativeSection, objectiveSection, labelsSection, recordsSection, nowSection];
