/**
 * One section turn's answer, judged by code (CONTEXT.md *Integrity check*, *Expectation check*,
 * *Not-applicable flag*). A Section is data: its instruction, a parser for its answer, the checks
 * written in code, and the Proposals its answer contributes to the store's verify gate. judgeAnswer
 * is pure: it takes the model's text and returns what landed, what was excused, and the complaints a
 * repair turn would name. The gate never throws and never fails the compaction: whatever still fails
 * after the repairs is dropped (integrity) or recorded as unresolved (expectation).
 */
import { describeRejection, type Rejection, type StateEvent } from "../../store/events.ts";
import type { SessionState } from "../../store/project.ts";
import type { PromptState } from "../prompt.ts";
import { applyProposals, type Proposal, type VerifyContext } from "../../store/verify.ts";
import { extractJsonCandidate, missingJsonShape } from "../parse.ts";
import type { UnparsedShape } from "../types.ts";
import { FIXABLE_CODES } from "../validate.ts";

export type SectionId = "narrative" | "objective" | "labels" | "records" | "now";

/**
 * A check that failed. `excusable` = an expectation check; integrity checks never are. `path` names the item an
 * integrity failure drops; a path equal to the section's id drops the whole answer (the narrative is one item).
 */
export interface Complaint {
  check: string;
  message: string;
  excusable: boolean;
  path?: string;
  /** For a verify complaint: the rejection code, and for unknown evidence the id's kind (T, C, E, u or other). Content-free, for the trace. */
  code?: string;
}

export interface Excuse {
  check: string;
  reason: string;
}

/** What code knows that the checks need: computed once per pass by the runner. */
export interface Facts {
  spanOrdinals: string[];
  /** Earlier rule-shaped messages offered on a switchover (label rule / not a rule only). */
  seedOrdinals: string[];
  /** The switchover's other earlier messages: labeled like the span's, since a rule with no rule word is carried only by its label. */
  contextOrdinals?: string[];
  textOf: (ordinal: string) => string | undefined;
  goal?: PromptState["goal"];
  objective?: { ordinal: string; text: string };
  activeCorrections: Array<{ id: string; ordinal: string; text: string }>;
  openErrorIds: string[];
  /** Errors the ledger saw in this span and did not see resolved. */
  unresolvedSpanErrorIds: string[];
  /** Files written or edited in this span (not carried ones). */
  spanModifiedFiles: string[];
  /** The store's cap on a decision or dead end (caps.itemChars); longer items are rejected as too-long. */
  itemChars?: number;
  customInstructions?: string;
}

export type Parsed<A> = { ok: true; answer: A } | { ok: false; error: string };

export interface Section<A> {
  id: SectionId;
  /** False when there is nothing to ask (no messages to label): the section closes accepted with no turn. */
  applies?(facts: Facts): boolean;
  instruction(facts: Facts): string;
  parse(value: Record<string, unknown>, facts: Facts): Parsed<A>;
  integrity(answer: A, facts: Facts): Complaint[];
  expectations(answer: A, facts: Facts): Complaint[];
  proposals(answer: A, facts: Facts): Array<{ path: string; proposal: Proposal }>;
  narrative?(answer: A): string;
  oneOffs?(answer: A, facts: Facts): string[];
}

export interface Judgement<A> {
  answer?: A;
  /** Unresolved: every integrity failure plus each expectation the answer did not excuse. */
  complaints: Complaint[];
  excused: Excuse[];
  events: StateEvent[];
  rejected: Array<{ path: string; rejection: Rejection; final: boolean }>;
  state: SessionState;
  /** Set when the answer did not parse: its shape, never its text. */
  unparsed?: UnparsedShape;
}

const MISSING_JSON: Record<string, string> = {
  empty: "the answer is empty; answer with one JSON object",
  "no-brace": "no JSON object in the answer; answer with one JSON object and nothing else",
  "open-string": 'the JSON object never closes because a string never ends. Almost always a double quote inside a string value that is not escaped: write \\" inside strings (commands and paths often contain quotes), and answer with one valid JSON object',
  unclosed: "the JSON object never closes: a closing } or ] is missing. Answer with one complete JSON object; count the closing brackets",
};

export const REASON_CHARS = 300;

function rejectionCode(rejection: Rejection): string {
  if (rejection.code !== "unknown-evidence") return rejection.code;
  const evidence = String((rejection as { evidence?: unknown }).evidence ?? "").trim();
  return `unknown-evidence:${/^[TCEu]\d+$/.test(evidence) ? evidence[0] : "other"}`;
}

function excusesOf(value: unknown): Excuse[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const check = (item as Record<string, unknown>)?.check;
    const reason = (item as Record<string, unknown>)?.reason;
    if (typeof check !== "string" || typeof reason !== "string" || reason.trim() === "") return [];
    return [{ check, reason: reason.trim().slice(0, REASON_CHARS) }];
  });
}

type ParsedObject = { ok: true; answer: Record<string, unknown> } | { ok: false; error: string; shape: UnparsedShape };

function parseObject(text: string): ParsedObject {
  const candidate = extractJsonCandidate(text);
  if (!candidate) {
    const shape = missingJsonShape(text);
    return { ok: false, error: MISSING_JSON[shape], shape };
  }
  try {
    const value: unknown = JSON.parse(candidate.json);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return { ok: false, error: "the answer must be one JSON object", shape: "not-object" };
    return { ok: true, answer: value as Record<string, unknown> };
  } catch (error) {
    return { ok: false, error: `invalid JSON: ${(error as Error).message}`, shape: "invalid-json" };
  }
}

function unparsed<A>(section: Section<A>, error: string, shape: UnparsedShape, ctx: VerifyContext): Judgement<A> {
  return { complaints: [{ check: `${section.id}.parse`, message: error, excusable: false, code: shape }], excused: [], events: [], rejected: [], state: ctx.state, unparsed: shape };
}

export function judgeAnswer<A>(section: Section<A>, text: string, facts: Facts, ctx: VerifyContext): Judgement<A> {
  const object = parseObject(text);
  if (!object.ok) return unparsed(section, object.error, object.shape, ctx);
  const parsed = section.parse(object.answer, facts);
  if (!parsed.ok) return unparsed(section, parsed.error, "schema", ctx);
  const answer = parsed.answer;
  const integrity = section.integrity(answer, facts);
  const blocked = new Set(integrity.flatMap((complaint) => (complaint.path ? [complaint.path] : [])));
  const entries = section.proposals(answer, facts).filter((entry) => !blocked.has(entry.path));
  const applied = applyProposals(entries.map((entry) => entry.proposal), ctx);
  const rejected = applied.rejected.map(({ index, rejection }) => ({ path: entries[index].path, rejection, fixable: FIXABLE_CODES.has(rejection.code) }));
  const verifyComplaints = rejected.filter((item) => item.fixable).map((item) => ({ check: `${section.id}.verify`, message: `${item.path}: ${describeRejection(item.rejection)}`, excusable: false, path: item.path, code: rejectionCode(item.rejection) }));
  const raised = section.expectations(answer, facts);
  const offered = excusesOf(object.answer.notApplicable);
  const excused = offered.filter((excuse) => raised.some((complaint) => complaint.check === excuse.check));
  const unexcused = raised.filter((complaint) => !excused.some((excuse) => excuse.check === complaint.check));
  return {
    answer,
    complaints: [...integrity, ...verifyComplaints, ...unexcused],
    excused,
    events: applied.events,
    rejected: rejected.map(({ path, rejection }) => ({ path, rejection, final: false })),
    state: applied.state,
  };
}

/** The follow-up turn's text: integrity failures must be fixed; an expectation may be excused instead. */
export function repairNote(complaints: Complaint[]): string {
  const must = complaints.filter((complaint) => !complaint.excusable).map((complaint) => `- ${complaint.check}: ${complaint.message}`);
  const may = complaints.filter((complaint) => complaint.excusable).map((complaint) => `- ${complaint.check}: ${complaint.message}`);
  return [
    "Your answer did not pass the checks. Answer this section again in full, as one JSON object.",
    ...(must.length ? ["Fix these:", ...must] : []),
    ...(may.length ? ['Fix these, or if one truly does not apply, add "notApplicable": [{"check": "<check id>", "reason": "<one sentence>"}] to your answer:', ...may] : []),
  ].join("\n");
}
