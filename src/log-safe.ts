/**
 * What may go into the JSONL log. A log line is what people paste into bug reports, so a record carries
 * codes, ids, counts and lengths -- never a piece of the conversation. The model-facing retry prompt keeps
 * the excerpts; that is where they are needed. `PI_COMPACT_STATE_DEBUG_EXCERPTS=1` puts them back in the log
 * for local debugging, and `PI_COMPACT_STATE_DEBUG_STACK=1` adds stacks to error records.
 */
import os from "node:os";

import type { NarrativeTrace } from "./carry.ts";
import type { PruneRemoval, PruneRule } from "./prune.ts";
import type { NarrativeOutcome, SectionTrace } from "./narrative/types.ts";
import type { Rejection } from "./store/events.ts";

export interface LogOptions {
  excerpts: boolean;
  stack: boolean;
}

export function logOptionsOf(env: Record<string, string | undefined>): LogOptions {
  return { excerpts: env.PI_COMPACT_STATE_DEBUG_EXCERPTS === "1", stack: env.PI_COMPACT_STATE_DEBUG_STACK === "1" };
}

/** Item ids and message ordinals the store mints (R1, D12, C3, u2, a7): references, not content. */
const ID_RE = /^[A-Za-z]{1,3}\d{1,6}$/;

type LoggedRejection = { chunk: number; path: string; final: boolean; code: Rejection["code"] } & Record<string, unknown>;

/** The fields that hold an id or a fixed reason, never content; the key decides, not the shape (a password can look like `ab123456`). */
const ID_KEYS = new Set(["ref", "target", "by", "targetOrdinal", "ordinal", "earlierId", "evidence"]);
const REASON_KEYS = new Set(["reason"]);

/** One rejection as the log carries it: the code, every number, ids and reasons by key; any other string becomes its length. */
function safeRejection(rejection: Rejection): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rejection)) {
    if (key === "code" || typeof value === "number") safe[key] = value;
    else if (typeof value === "string") {
      const kept = (ID_KEYS.has(key) && ID_RE.test(value)) || (REASON_KEYS.has(key) && /^[a-z-]{1,20}$/.test(value));
      safe[kept ? key : `${key}Chars`] = kept ? value : value.length;
    }
    else if (Array.isArray(value)) safe[`${key}Count`] = value.length;
  }
  return safe;
}

export function logSafeRejected(rejected: NarrativeOutcome["rejected"], options: LogOptions): LoggedRejection[] {
  return rejected.map(({ chunk, path, final, rejection }) => ({ chunk, path, final, ...(options.excerpts ? rejection : safeRejection(rejection)), code: rejection.code }));
}

type LoggedSection = Omit<SectionTrace, "excused"> & { excused: Array<{ check: string; reason?: string }> };
export type LoggedNarrativeTrace = Omit<NarrativeTrace, "sections"> & { sections?: LoggedSection[] };

/** The narrative trace as the log carries it: section checks by id; the model's not-applicable reasons and the check messages stay out. */
export function logSafeNarrative(trace: NarrativeTrace, options: LogOptions): LoggedNarrativeTrace {
  if (options.excerpts || !trace.sections) return trace;
  const sections = trace.sections.map((section) => ({
    ...section,
    unresolved: section.unresolved.map((line) => line.split(":")[0]),
    excused: section.excused.map(({ check }) => ({ check })),
  }));
  return { ...trace, sections };
}

const ERROR_CHARS = 200;

/** The first 200 characters of a diagnostic, home directory as `~`: a size cap, not a content filter. */
function shortMessage(raw: string, home: string): string {
  const homeless = home ? raw.split(home).join("~") : raw;
  return homeless.length > ERROR_CHARS ? `${homeless.slice(0, ERROR_CHARS - 1)}…` : homeless;
}

/** An error as the log carries it: its class and the first 200 characters of its message, home directory as `~`. */
export function logSafeError(error: unknown, options: LogOptions, home: string = os.homedir()): { errorClass: string; error: string; stack?: string } {
  const errorClass = error instanceof Error ? error.constructor.name : typeof error;
  const raw = error instanceof Error ? error.message : String(error);
  return { errorClass, error: shortMessage(raw, home), ...(options.stack && error instanceof Error && error.stack ? { stack: error.stack } : {}) };
}

/** Why the workspace capture was skipped (a code, or the failing git command and its stderr), shortened like an error. */
export function logSafeSkipped(skipped: string, options: LogOptions, home: string = os.homedir()): string {
  return options.excerpts ? skipped : shortMessage(skipped, home);
}

/** The carried file paths a prune dropped, as a count per rule: the paths are the conversation's files. */
export function logSafeRemoved(removed: PruneRemoval[], options: LogOptions): PruneRemoval[] | Partial<Record<PruneRule, number>> {
  if (options.excerpts) return removed;
  const counts: Partial<Record<PruneRule, number>> = {};
  for (const { rule } of removed) counts[rule] = (counts[rule] ?? 0) + 1;
  return counts;
}
