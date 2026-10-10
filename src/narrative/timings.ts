/**
 * Where a compaction's wall time went (observability only: nothing here can change a summary).
 *
 * Two levels of measurement:
 *
 * 1. **Transport** (`timedTransport`): pi-ai accepts a `fetch` per request (`RequestOptions.fetch`,
 *    pi-ai types.d.ts), so wrapping it timestamps the response headers and the first body chunk of
 *    a streaming answer. That splits a call's wall time into waiting for the prompt to be
 *    processed (prefill: request -> first chunk) and generating the answer (decode: first chunk ->
 *    end), which is what tells a slow compaction from a slow *model*. The response is handed
 *    through untouched — chunk timestamps ride a TransformStream, so streaming, backpressure,
 *    status codes and errors behave exactly as they did without the wrapper.
 *
 * 2. **Phases** (`sinceLastAssistantMessage`, and the timers in index.ts): the hook's own steps,
 *    which turn "the compaction took 13 s" into "12.9 s of it was the model, 40 ms the handoff,
 *    3 ms the merge, ~10 ms pi's own preparation".
 *
 * Safety: the wrapper is installed ONLY for adapters proven to read the option. The google
 * adapters throw outright on a custom fetch ("Custom fetch is not supported by the Google …
 * adapter"), so wrapping unconditionally would break compaction for every google session; a
 * deny-by-default allow-list means an unknown adapter loses timings, never a call.
 */

/** Timestamps for one logical call's transport activity, in ms since its last fetch was issued. */
export interface TransportTimings {
  /** Fetches issued for the call: a transport retry (transport-retry.ts) issues another. */
  requests: number;
  /** Response headers received. */
  headersMs?: number;
  /**
   * First body chunk received: approximately the first token on a streaming provider, the whole
   * body on a buffered one. `firstChunkMs - headersMs` is the prefill wait, the remainder is
   * generation.
   */
  firstChunkMs?: number;
  /** Body complete: nothing of this call's transport is left. */
  endedMs?: number;
}

export interface TimedTransport {
  timings: TransportTimings;
  fetch: typeof globalThis.fetch;
}

/**
 * Adapters that read `options.fetch` (verified against pi-ai 0.85.x, `dist/api/*.js`): every
 * adapter except `google-generative-ai` and `google-vertex`, which reject it, and
 * `bedrock-converse-stream`, whose client is not fetch-based.
 */
export const TIMED_TRANSPORT_APIS: ReadonlySet<string> = new Set([
  "openai-completions",
  "openai-responses",
  "azure-openai-responses",
  "openai-codex-responses",
  "anthropic-messages",
  "mistral-conversations",
  "pi-messages",
]);

/**
 * A fetch wrapper that records transport timings for `model`, or `undefined` when its adapter does
 * not honor a custom fetch (the caller then makes the call exactly as before).
 */
export function timedTransport(
  model: { api?: string } | undefined,
  base: typeof globalThis.fetch = globalThis.fetch,
  now: () => number = () => performance.now(),
): TimedTransport | undefined {
  if (!model?.api || !TIMED_TRANSPORT_APIS.has(model.api)) return undefined;
  const timings: TransportTimings = { requests: 0 };
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const startedAt = now();
    const at = () => now() - startedAt;
    timings.requests++;
    const response = await base(input, init);
    // Assign, never accumulate: after a transport retry the numbers describe the answer that was
    // actually used, which is the one the caller keeps.
    timings.headersMs = at();
    // A null-body status (204/205/304) has no stream, and constructing a Response with a body for
    // one throws — hand those through as they are.
    if (!response.body || response.status === 204 || response.status === 205 || response.status === 304) {
      timings.firstChunkMs = timings.headersMs;
      timings.endedMs = at();
      return response;
    }
    let first = true;
    const body = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform: (chunk, controller) => {
          if (first) {
            first = false;
            timings.firstChunkMs = at();
          }
          controller.enqueue(chunk);
        },
        flush: () => {
          timings.endedMs = at();
        },
      }),
    );
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
  return { timings, fetch: fetchImpl };
}

/**
 * Milliseconds from a session's last assistant message to `now`. pi checks the trigger right after
 * an assistant message is recorded and only then prepares and calls the hook, so for a threshold
 * compaction this is pi's own cost; for one that fires mid-tool-loop it also includes the loop.
 */
export function sinceLastAssistantMessage(
  branchEntries: readonly unknown[],
  now: number = Date.now(),
): number | undefined {
  for (let i = branchEntries.length - 1; i >= 0; i--) {
    const entry = branchEntries[i] as { message?: { role?: string }; timestamp?: string } | undefined;
    if (entry?.message?.role !== "assistant" || !entry.timestamp) continue;
    const at = Date.parse(entry.timestamp);
    if (!Number.isNaN(at)) return Math.max(0, now - at);
  }
  return undefined;
}
