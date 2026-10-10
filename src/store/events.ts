/**
 * The store's vocabulary: the event union every accepted write becomes, the caps the projection
 * applies, the closed rejection union both hands answer with, and the persisted shapes. Nothing
 * here computes; project.ts folds, verify.ts gates, log.ts reads.
 */
import type { CommandRecord, ErrorRecord, WorkspaceSnapshot } from "../ledger/handoff.ts";
import type { Claim } from "../world.ts";
import { isRec, type Rec } from "../message-text.ts";

export type Source = "remember" | "diff" | "pass";

/** Provenance every accepted write carries; `pass` = mechanical, written by the pass itself. */
export interface Provenance {
  source: Source;
  span: number;
  at: string;
  /** "C3" | "E1" | "u12" */
  evidence?: string;
}

export interface Quote {
  messageId: string;
  /** "u12", display only; verification uses messageId. */
  ordinal: string;
  text: string;
}

export interface Now {
  inProgress: string[];
  next: string[];
  blocked: string[];
  resume: string;
}

export interface World {
  branch?: string;
  commit?: string;
  dirty?: boolean;
  claims: Claim[];
  openErrorIds: string[];
}

export type ForeignCompactor = "pi" | "extension";

export type EventBody =
  /** The Goal: the /goal pi-goal recorded, set by the pass alone. */
  | { kind: "goal.set"; quote: Quote }
  /** pi-goal no longer names that goal as active (cleared, completed or stopped): set by the pass alone. */
  | { kind: "goal.clear" }
  /** The Request: the summarizer's pick (or the pass default outside a /goal). */
  | { kind: "objective.set"; quote: Quote; doneWhen?: Quote }
  | { kind: "objective.doneWhen"; quote: Quote }
  | { kind: "correction.add"; id: string; quote: Quote }
  | { kind: "correction.lift"; target: string; by: { messageId: string; ordinal: string } }
  | { kind: "decision.add"; id: string; text: string }
  | { kind: "deadEnd.add"; id: string; text: string }
  | { kind: "now.set"; now: Now }
  | {
      kind: "span.close";
      fromRef: string;
      toRef: string;
      narrative?: string;
      narrativeLess: boolean;
      world: World;
      /** Chunk numbers (1-based) whose diff never verified on a chunked span. */
      missingChunks?: number[];
      /** Set on the synthesized close for a compaction another compactor wrote. */
      foreign?: ForeignCompactor;
    };

export type StateEvent = Provenance & { seq: number } & EventBody;

/**
 * A span Longhaul's own pass closed whole: the narrative landed and every chunk verified, so each of its user
 * messages was judged. Foreign, narrative-less and partial closes judged none or only some of them.
 */
export const closedWhole = (close: { foreign?: unknown; narrativeLess: boolean; missingChunks?: readonly number[] }): boolean =>
  !close.foreign && !close.narrativeLess && !close.missingChunks?.length;

export interface Caps {
  hardChars: number;
  objectiveQuoteChars: number;
  corrections: number;
  correctionChars: number;
  decisions: number;
  deadEnds: number;
  /** Free-text items (decisions, dead ends): over this they are rejected as too-long. */
  itemChars: number;
  workLogLines: number;
  openErrors: number;
  worldChars: number;
  /** The `## Files` section (files-render.ts): paths beyond it are left to `recall files`. */
  filesChars: number;
  /** The `## Learned values` section (learned.ts): older values beyond it are not shown; 0 drops the section. */
  learnedChars: number;
}

export const DEFAULT_CAPS: Caps = { hardChars: 13500, objectiveQuoteChars: 600, corrections: 8, correctionChars: 300, decisions: 10, deadEnds: 10, itemChars: 300, workLogLines: 12, openErrors: 5, worldChars: 1200, filesChars: 2500, learnedChars: 1500 };

export const MIN_QUOTE_CHARS = 12;

/**
 * The persisted state's format number, stamped on every loose event entry and on the compaction details. A reader
 * folds its own format and an unstamped entry (written before formats existed: format 1); a NEWER one is refused by
 * name rather than guessed at, so a downgrade starts a clean state instead of misreading one. The span record has
 * carried its own `v` from the start.
 */
export const STATE_FORMAT = 1;

/** An event as it is persisted: the event plus its format number. */
export type PersistedEvent = StateEvent & { stateFormat?: number };

/** A stamped format this version cannot read, or undefined when it can (unstamped counts as format 1). */
export function newerStateFormat(value: unknown): number | undefined {
  const format = typeof value === "object" && value !== null ? (value as { stateFormat?: unknown }).stateFormat : undefined;
  return typeof format === "number" && format > STATE_FORMAT ? format : undefined;
}

export const EVENT_ENTRY_TYPE = "compaction-state.event";
export const SPAN_ENTRY_TYPE = "compaction-state.span";

export type Rejection =
  | { code: "unknown-ref"; ref: string; known: string[] }
  | { code: "not-user-message"; ref: string }
  | { code: "not-substring"; ref: string; excerpt: string; closest?: string; recent: Array<{ ordinal: string; excerpt: string }> }
  | { code: "too-long"; max: number; actual: number }
  | { code: "empty" }
  | { code: "near-duplicate"; earlierId: string; overlap: number }
  | { code: "unknown-target"; target: string; known: string[] }
  | { code: "already-lifted"; target: string; by: string }
  /** The target was replaced: its lifting message gave a rule of its own, which only a lift naming it can withdraw. */
  | { code: "lift-replaced"; target: string; by: string; replacement: string; rule: string; alsoSet?: string }
  | { code: "lift-not-later"; target: string; targetOrdinal: string; ordinal: string }
  | { code: "lift-unnamed"; target: string; ordinal: string; rule: string }
  | { code: "no-objective" }
  | { code: "objective-unchanged"; ordinal: string }
  | { code: "objective-not-later"; ordinal: string; targetOrdinal: string }
  | { code: "unknown-evidence"; evidence: string }
  | { code: "remember-cap"; cap: number }
  | { code: "unlabelled"; refs: string[] }
  | { code: "value-not-in-turn"; ref: string; value: string }
  | { code: "value-rejected"; ref: string; reason: "credential" | "random" | "shape" | "name" }
  | { code: "bad-label"; ref: string; detail: string }
  | { code: "schema"; detail: string }
  | { code: "carried-shape"; detail: string }
  | { code: "internal"; detail: string };

/** The one model-facing sentence per rejection; the tool result and the retry prompt both use it. */
export function describeRejection(rejection: Rejection): string {
  switch (rejection.code) {
    case "unknown-ref":
      return `${rejection.ref} is not a user message on this branch (known: ${rejection.known.join(", ") || "none"}); cite one of them.`;
    case "not-user-message":
      return `${rejection.ref} is not a user message; quotes must come from the user's own messages.`;
    case "not-substring": {
      const closest = rejection.closest ? ` The closest window in that message is "${rejection.closest}".` : "";
      const recent = rejection.recent.map((entry) => `${entry.ordinal}: "${entry.excerpt}"`).join(" | ");
      return `The quote is not a verbatim substring of ${rejection.ref} ("${rejection.excerpt}").${closest} Recent user messages: ${recent}. Copy the user's exact words.`;
    }
    case "too-long":
      return `The text is ${rejection.actual} characters; at most ${rejection.max}. Shorten it to one sentence.`;
    case "empty":
      return `The quote must be at least ${MIN_QUOTE_CHARS} characters of the user's exact words.`;
    case "near-duplicate":
      return `This duplicates ${rejection.earlierId} (${Math.round(rejection.overlap * 100)}% token overlap); the earlier item stands, do not retry.`;
    case "unknown-target":
      return `${rejection.target} is not a correction in the state (known: ${rejection.known.join(", ") || "none"}).`;
    case "already-lifted":
      return `${rejection.target} was already lifted by ${rejection.by}; nothing to do.`;
    case "lift-replaced":
      // The condition comes before the quotes, so a retry note cut short still carries it.
      return `${rejection.target} was replaced by the rule ${rejection.by} gave (${rejection.replacement}); lift it only if this message withdraws that rule as well${rejection.alsoSet ? ", naming what it set of its own" : ""}, as "lifts ${rejection.by}" (or "rule and lifts ${rejection.by}"), otherwise leave it. ${rejection.by} said: "${rejection.rule}".${rejection.alsoSet ? ` Of its own it set: "${rejection.alsoSet}", which a lift of it withdraws too.` : ""}`;
    case "lift-not-later":
      return `A lift must quote a user message later than the correction it lifts: ${rejection.ordinal} is not later than ${rejection.targetOrdinal} (${rejection.target}).`;
    case "objective-unchanged":
      return `The objective already quotes ${rejection.ordinal}; it stands, do not retry.`;
    case "objective-not-later":
      return `${rejection.ordinal} is earlier than the objective's message ${rejection.targetOrdinal}; the objective moves only to a later request, so it stands. Do not retry.`;
    case "no-objective":
      return "No objective is set yet, so done-when cannot be attached; set the objective first.";
    case "unknown-evidence":
      return `${rejection.evidence} is not a command, error or message ref on this branch (C<n>, E<n>, u<n>, "last command", "last error").`;
    case "remember-cap":
      return `The span already holds ${rejection.cap} accepted writes this span; do not retry, the compaction pass captures the rest.`;
    case "value-not-in-turn":
      return `"${rejection.value}" is not in ${rejection.ref} (its message, replies and tool output); copy the value exactly as that turn shows it, or cite the turn that does.`;
    case "lift-unnamed":
      return `${rejection.ordinal} does not say it withdraws ${rejection.target} ("${rejection.rule}"). Lift a rule only when the message withdraws it in words that name it; otherwise label the message "not a rule" (or "rule").`;
    case "value-rejected":
      return `The value from ${rejection.ref} is not kept (${rejection.reason === "credential" ? "it stands on a credential line" : rejection.reason === "random" ? "it looks like a token" : rejection.reason === "name" ? "its name must be a short label of at most 40 characters, with no colon, no rule and no credential's name" : "it has no value's shape: a number with or without its unit, a version, a short hash, a path or file name (a format may hold <placeholders>), a host:port or a date"}); do not retry it.`;
    case "unlabelled":
      return `Label every user message of the span in "labels"; missing: ${rejection.refs.join(", ")}.`;
    case "bad-label":
      return `${rejection.ref}: ${rejection.detail}`;
    case "schema":
      return `The call does not match the schema: ${rejection.detail}`;
    case "carried-shape":
      return `A carried record has an unreadable shape (${rejection.detail}); it was skipped.`;
    case "internal":
      return `The store hit an internal error: ${rejection.detail}. Do not retry this turn.`;
  }
}

const isQuote = (value: unknown): value is Quote => isRec(value) && typeof value.messageId === "string" && typeof value.ordinal === "string" && typeof value.text === "string";
const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");

function isEventBody(event: Rec): boolean {
  switch (event.kind) {
    case "objective.set":
      return isQuote(event.quote) && (event.doneWhen === undefined || isQuote(event.doneWhen));
    case "goal.set":
    case "objective.doneWhen":
      return isQuote(event.quote);
    case "correction.add":
      return typeof event.id === "string" && isQuote(event.quote);
    case "correction.lift":
      return typeof event.target === "string" && isRec(event.by) && typeof event.by.messageId === "string" && typeof event.by.ordinal === "string";
    case "decision.add":
    case "deadEnd.add":
      return typeof event.id === "string" && typeof event.text === "string";
    case "now.set":
      return isRec(event.now) && isStringArray(event.now.inProgress) && isStringArray(event.now.next) && isStringArray(event.now.blocked) && typeof event.now.resume === "string";
    case "goal.clear":
      return true;
    case "span.close":
      return typeof event.fromRef === "string" && typeof event.toRef === "string" && typeof event.narrativeLess === "boolean" && isRec(event.world) && Array.isArray(event.world.claims) && isStringArray(event.world.openErrorIds);
    default:
      return false;
  }
}

/** Shape check for replayed entries: a malformed one is skipped and counted by the fold, never thrown. */
export function isStateEvent(value: unknown): value is StateEvent {
  if (!isRec(value)) return false;
  const provenanceOk = (value.source === "remember" || value.source === "diff" || value.source === "pass") && typeof value.span === "number" && typeof value.at === "string" && typeof value.seq === "number";
  return provenanceOk && isEventBody(value);
}

/** The compaction-state.span custom entry: that span's events plus the ledger slice (Cold memory). */
export interface SpanRecord {
  v: 1;
  span: number;
  compactionEntryId: string;
  events: StateEvent[];
  ledger: { commands: CommandRecord[]; errors: ErrorRecord[] };
  snapshot?: WorkspaceSnapshot;
  usage?: { input: number; output: number; calls: number };
}

export interface FoldAnomaly {
  span: number;
  reason: string;
  entryId?: string;
}

export interface SpanSummary {
  span: number;
  compactionEntryId?: string;
  /** Absent for a foreign span (no record) and for the open span. */
  record?: SpanRecord;
  foreign?: ForeignCompactor;
}

export interface StateLog {
  /** Every accepted event on the branch, seq ascending. */
  events: StateEvent[];
  /** Closed spans in order. */
  spans: SpanSummary[];
  /** The span being worked in: closed spans + 1. */
  openSpan: number;
  anomalies: FoldAnomaly[];
  nextSeq: number;
}

export const EMPTY_LOG: StateLog = { events: [], spans: [], openSpan: 1, anomalies: [], nextSeq: 1 };
