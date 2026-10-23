/**
 * The narrative call's vocabulary: the fenced-JSON diff the model answers with (validated with
 * TypeBox, since some providers have no structured outputs), the per-call trace, and the outcome
 * record the driver returns and the pass logs as one line.
 */
import type { LearnedValue } from "../learned.ts";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

import type { Rejection, StateEvent } from "../store/events.ts";
import type { RouteHealthState } from "./route-health.ts";
import type { TransportTimings } from "./timings.ts";
import type { CallUsage, PassUsage } from "./usage.ts";

export const REF_CHARS = 16;
export const NOW_ITEM_CHARS = 400;
export const NOW_ITEMS = 24;

const Ref = Type.String({ minLength: 1, maxLength: REF_CHARS });
const Text = Type.String({ maxLength: 4000 });
const QuoteRef = Type.Object({ messageRef: Ref, text: Text });
/**
 * The `Now` block is the state's hottest section -- rendered into the prompt at every compaction --
 * so it is bounded where its shape is declared (security.md T2) rather than only by the route's output
 * budget and the renderer's cuts. The numbers are generous for one item and tight for a list: a
 * status line, not a paragraph, and two dozen of them. `store/events.ts` already bounds a
 * `remember`-written item at `itemChars` (300), so 400 can never reject what the store would keep.
 */
const NowItem = Type.String({ maxLength: NOW_ITEM_CHARS });
const NowList = Type.Array(NowItem, { maxItems: NOW_ITEMS });

/** The most rules, lifts, decisions or dead ends one answer may carry: far above a real span's, so only a runaway answer is refused. */
export const LIST_ITEMS = 32;

export const NarrativeDiffSchema = Type.Object({
  narrative: Text,
  objective: Type.Optional(Type.Object({ messageRef: Ref, text: Text, doneWhen: Type.Optional(QuoteRef) })),
  corrections: Type.Array(QuoteRef, { maxItems: LIST_ITEMS }),
  /** `text` is the withdrawing words: unlike a summary's handoff, the diff hand quotes too. */
  lifts: Type.Array(Type.Object({ target: Ref, messageRef: Ref, text: Text }), { maxItems: LIST_ITEMS }),
  decisions: Type.Array(Type.Object({ text: Text, evidence: Type.Optional(Ref) }), { maxItems: LIST_ITEMS }),
  deadEnds: Type.Array(Type.Object({ text: Text, evidence: Type.Optional(Ref) }), { maxItems: LIST_ITEMS }),
  now: Type.Object({ inProgress: NowList, next: NowList, blocked: NowList, resume: NowItem }),
  /** Every user message of the span, labeled (message-labels.ts): code turns a "rule" into a correction in the user's own words. */
  labels: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  /** Values a later turn may need, each named and cited by turn; code keeps one only when it stands in that turn (named-values.ts). */
  values: Type.Optional(Type.Array(Type.Object({ name: Type.String({ maxLength: 400 }), value: Type.String({ maxLength: 400 }), ref: Ref }), { maxItems: 32 })),
  /** Switchover only: ordinals of offered earlier messages that were one-offs, not standing rules. */
  oneOffs: Type.Optional(Type.Array(Ref, { maxItems: 64 })),
});

export type NarrativeDiff = Static<typeof NarrativeDiffSchema>;

export function checkNarrativeDiff(value: unknown): { ok: true; diff: NarrativeDiff } | { ok: false; errors: string[] } {
  if (Value.Check(NarrativeDiffSchema, value)) return { ok: true, diff: value };
  const errors = [...Value.Errors(NarrativeDiffSchema, value)].map((error) => `${error.instancePath || "/"}: ${error.message}`);
  return { ok: false, errors };
}

export type NotADiffReason = "empty" | "truncated" | "invalid-json" | "wrong-type" | "schema";

export interface CallTrace {
  chunk: number;
  attempt: number;
  verdict: "diff" | NotADiffReason;
  fieldErrors: string[];
  dropped: number;
  rescued: number;
  stopReason?: string;
  usage?: CallUsage;
  transport?: TransportTimings;
  retries: number;
  errors: string[];
  durationMs: number;
  /** The warm-cache request (warm.ts): the session's own request plus one instruction. */
  warm?: true;
  /** The level asked for when the model cannot turn reasoning off (reasoning.ts); absent when it was off. */
  reasoning?: string;
  /** The raised output budget of a retry after an answer ran out of output (reasoning.ts raisedBudget); absent otherwise. */
  maxTokens?: number;
  /** A call that asked the replacement questions (run.ts askReplacements); its verdict is the full-answer parse, which a reply to the questions fails. */
  reask?: "answered" | "unreadable";
}

/** One section of the turns mode (narrative/turns/): how it went, for the span record and the user's audit. */
export type UnparsedShape = "empty" | "no-brace" | "open-string" | "unclosed" | "invalid-json" | "not-object" | "schema";

export interface SectionTrace {
  section: string;
  turns: number;
  shows: number;
  /** accepted = passed the gate; partial = landed with items dropped or expectations unresolved; skipped = nothing landed, the state carries. */
  outcome: "accepted" | "partial" | "skipped";
  /** integrity = the answer itself failed an integrity check after the repairs (an empty or over-cap narrative). */
  skipped?: "budget" | "deadline" | "transport" | "show-loop" | "unparsed" | "integrity";
  /** Content-free shape of the last answer that did not parse (set with skipped "unparsed"). */
  unparsed?: UnparsedShape;
  /** Per repair turn, the check ids that caused it (no messages, no content). */
  repairs?: string[][];
  /** Checks still failing when the section closed ("<section>.<check>: message"). */
  unresolved: string[];
  /** Not-applicable flags the model gave for expectation checks, with its one-sentence reasons. */
  excused: Array<{ check: string; reason: string }>;
  durationMs: number;
}

export interface NarrativeOutcome {
  kind: "diff" | "narrative-less";
  /** Accepted, in order. */
  events: StateEvent[];
  /** `final` = dropped after the retry, not merely retried. */
  rejected: Array<{ chunk: number; path: string; rejection: Rejection; final: boolean }>;
  narrative?: string;
  reason?: NotADiffReason | "aborted" | "no-model" | "route-skipped";
  routeHealth: RouteHealthState;
  usage: PassUsage;
  calls: CallTrace[];
  missingChunks: number[];
  timings: { prepareMs: number; callsMs: number; validateMs: number; totalMs: number };
  /** The provider/id that answered, when one did. */
  model?: string;
  /** Ordinals of offered earlier rules the model named one-offs (a switchover only); the pass records the rest. */
  oneOffs?: string[];
  /** The named values that verified (named-values.ts), every chunk's in order. */
  values?: LearnedValue[];
  /** Turns mode only: one trace per section, in turn order. */
  sections?: SectionTrace[];
}
