/** The narrative call's policy as data: retries, chunking, budgets. Read from longhaul.json `narrativePolicy`. */
import { DEFAULT_TRANSPORT_RETRY_POLICY, type TransportRetryPolicy } from "./transport-retry.ts";

export interface NarrativePolicy {
  /** Retries for fixable field errors (bad quote, unknown ref, over-long item), errors verbatim in a trailing note. */
  fixableRetries: number;
  /** Chunks a span may be split into when it does not fit the summarizer's window. */
  maxChunks: number;
  /** Fixed allowance in the fit maths for the retry note, so the prompt prefix stays cacheable. */
  retryNoteChars: number;
  /** Output budget for one diff answer. */
  outputTokens: number;
  /** Per-request timeout (the OpenAI SDK's 10-minute default is too short for a long span on local hardware). */
  timeoutMs: number;
  transportRetry: TransportRetryPolicy;
}

export const DEFAULT_NARRATIVE_POLICY: NarrativePolicy = {
  fixableRetries: 1,
  maxChunks: 4,
  retryNoteChars: 1500,
  outputTokens: 3000,
  timeoutMs: 30 * 60 * 1000,
  transportRetry: DEFAULT_TRANSPORT_RETRY_POLICY,
};

const BOUNDS = { fixableRetries: [0, 3], maxChunks: [1, 8], retryNoteChars: [200, 6000], outputTokens: [500, 16000], timeoutMs: [10_000, 3_600_000] } as const;

/** An integer inside `[min, max]`, or the fallback. */
export function bounded(value: unknown, fallback: number, [min, max]: readonly [number, number]): number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

export function resolveNarrativePolicy(configValue: unknown): NarrativePolicy {
  const raw = typeof configValue === "object" && configValue !== null ? (configValue as Record<string, unknown>) : {};
  return {
    fixableRetries: bounded(raw.fixableRetries, DEFAULT_NARRATIVE_POLICY.fixableRetries, BOUNDS.fixableRetries),
    maxChunks: bounded(raw.maxChunks, DEFAULT_NARRATIVE_POLICY.maxChunks, BOUNDS.maxChunks),
    retryNoteChars: bounded(raw.retryNoteChars, DEFAULT_NARRATIVE_POLICY.retryNoteChars, BOUNDS.retryNoteChars),
    outputTokens: bounded(raw.outputTokens, DEFAULT_NARRATIVE_POLICY.outputTokens, BOUNDS.outputTokens),
    timeoutMs: bounded(raw.timeoutMs, DEFAULT_NARRATIVE_POLICY.timeoutMs, BOUNDS.timeoutMs),
    transportRetry: DEFAULT_TRANSPORT_RETRY_POLICY,
  };
}
