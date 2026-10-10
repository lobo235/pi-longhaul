/**
 * Transport retry: repeat a summarizer call that failed on a transient transport or provider error,
 * with exponential backoff, before the attempt chain gives the job to the next model.
 *
 * pi's own compaction wraps its single LLM call in pi-ai's retryAssistantCall (dist/utils/retry.js)
 * for exactly this; the extension could not import it (pi-ai is not resolvable from the extension
 * under plain node), so the policy loop and the error classification are mirrored here. The
 * classification lists are kept in the same shape as pi-ai's so pi-compat.test.ts can check them
 * against the installed pi-ai on every verified pi version. Two deliberate differences:
 *
 * - a leading 4xx status other than 408/429 is never retried, whatever the body says (a 400 whose
 *   body mentions a "timeout" parameter is still a bad request);
 * - a context-overflow message is never retried here: the fit check (fit.ts, applied by run.ts) owns that.
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";

import { isContextOverflowMessage } from "./fit.ts";

export interface TransportRetryPolicy {
  /** Retries after the first attempt; 2 means three attempts in total. */
  maxRetries: number;
  /** Delay before the first retry; doubles on each further retry. */
  baseDelayMs: number;
}

/** Three attempts, 1 s then 2 s apart: at most 3 s added to a compaction that would otherwise fail. */
export const DEFAULT_TRANSPORT_RETRY_POLICY: TransportRetryPolicy = { maxRetries: 2, baseDelayMs: 1000 };

/** Mirror of pi-ai's NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN entries: account limits, not throttles. */
export const NON_RETRYABLE_LIMIT_PATTERNS = [
  "GoUsageLimitError",
  "FreeUsageLimitError",
  "Monthly usage limit reached",
  "available balance",
  "insufficient_quota",
  "out of budget",
  "quota exceeded",
  "billing",
];

/** Mirror of pi-ai's RETRYABLE_PROVIDER_ERROR_PATTERN entries: load, 5xx, transport and stream drops. */
export const RETRYABLE_TRANSPORT_PATTERNS = [
  "overloaded",
  "currently experiencing high demand",
  "rate.?limit",
  "too many requests",
  "429",
  "500",
  "502",
  "503",
  "504",
  "520",
  "524",
  "service.?unavailable",
  "server.?error",
  "internal.?error",
  "provider.?returned.?error",
  "exceeded request buffer limit while retrying upstream",
  "network.?error",
  "connection.?error",
  "connection.?refused",
  "connection.?lost",
  "other side closed",
  "fetch failed",
  "getaddrinfo",
  "ENOTFOUND",
  "EAI_AGAIN",
  "upstream.?connect",
  "reset before headers",
  "socket hang up",
  "socket connection was closed",
  "timed? out",
  "timeout",
  "terminated",
  "websocket.?closed",
  "websocket.?error",
  "ended without",
  "stream ended before message_stop",
  "stream ended before a terminal response event",
  "http2 request did not get a response",
  "retry delay",
  "you can retry your request",
  "try your request again",
  "please retry your request",
  "ResourceExhausted",
];

const NON_RETRYABLE_LIMIT = new RegExp(NON_RETRYABLE_LIMIT_PATTERNS.join("|"), "i");
const RETRYABLE_TRANSPORT = new RegExp(RETRYABLE_TRANSPORT_PATTERNS.join("|"), "i");
/** pi-ai prefixes HTTP failures with the status: `400: {...}`. */
const LEADING_STATUS = /^\s*(\d{3})\b/;
const RETRYABLE_CLIENT_STATUSES = new Set(["408", "429"]);

export function isRetryableTransportError(message: string | undefined): boolean {
  if (!message) return false;
  if (isContextOverflowMessage(message)) return false;
  const status = LEADING_STATUS.exec(message)?.[1];
  if (status?.startsWith("4") && !RETRYABLE_CLIENT_STATUSES.has(status)) return false;
  if (NON_RETRYABLE_LIMIT.test(message)) return false;
  return RETRYABLE_TRANSPORT.test(message);
}

export interface TransportRetryEvent {
  /** 1-based retry number. */
  attempt: number;
  maxRetries: number;
  delayMs: number;
  error: string;
}

export interface TransportRetryOptions {
  policy?: TransportRetryPolicy;
  signal?: AbortSignal;
  /** Injectable for tests; the default is a setTimeout that the signal cancels. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Called before each backoff sleep, so the caller can log the retry as it happens. */
  onRetry?: (event: TransportRetryEvent) => void;
}

export interface TransportRetryResult {
  /** The accepted answer, or the last error answer once the budget is spent. */
  response: AssistantMessage;
  retries: number;
  /** Error text of every attempt that was retried, in order. */
  errors: string[];
}

class SleepAbortedError extends Error {}

function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new SleepAbortedError("aborted"));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new SleepAbortedError("aborted"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Runs produce() on the caller's behalf; a thrown transport error counts like an error answer. */
async function attempt(produce: () => Promise<AssistantMessage>): Promise<{ response?: AssistantMessage; thrown?: Error }> {
  try {
    return { response: await produce() };
  } catch (error) {
    const thrown = error instanceof Error ? error : new Error(String(error));
    if (!isRetryableTransportError(thrown.message)) throw thrown;
    return { thrown };
  }
}

/**
 * Run `produce` until it yields a non-error answer, a non-retryable error answer, an abort, or the
 * retry budget is spent. Like pi-ai's retryAssistantCall, an abort during the backoff sleep comes
 * back as an aborted AssistantMessage rather than an exception.
 */
export async function completeWithTransportRetry(
  produce: () => Promise<AssistantMessage>,
  options: TransportRetryOptions = {},
): Promise<TransportRetryResult> {
  const { policy = DEFAULT_TRANSPORT_RETRY_POLICY, signal, sleep = sleepUnlessAborted, onRetry } = options;
  const errors: string[] = [];
  for (let retries = 0; ; retries++) {
    const { response, thrown } = await attempt(produce);
    const errorText = thrown?.message ?? response?.errorMessage ?? "";
    if (response && response.stopReason !== "error") return { response, retries, errors };
    const retryable = thrown !== undefined || isRetryableTransportError(errorText);
    if (retries >= policy.maxRetries || !retryable) {
      if (thrown) throw thrown;
      return { response: response!, retries, errors };
    }
    errors.push(errorText);
    const delayMs = policy.baseDelayMs * 2 ** retries;
    onRetry?.({ attempt: retries + 1, maxRetries: policy.maxRetries, delayMs, error: errorText });
    try {
      await sleep(delayMs, signal);
    } catch {
      const aborted = response ?? { role: "assistant", content: [], api: "", provider: "", model: "", usage: emptyUsage(), stopReason: "aborted", timestamp: Date.now() };
      return { response: { ...aborted, errorMessage: undefined, stopReason: "aborted" } as AssistantMessage, retries: retries + 1, errors };
    }
  }
}

function emptyUsage(): AssistantMessage["usage"] {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}
