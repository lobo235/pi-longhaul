/**
 * Priming for the scorer's `state-warm` arm. Live, the server already holds the session's request when the compaction
 * fires; in the scorer it has never seen it, so an unprimed warm call pays a cold prefill of the whole conversation
 * (197 s p50 against 42 s for the re-encoded call, in a first replay). The arm therefore sends the base request once,
 * asking for one token, then times the warm call on the same server (the caller keeps one session-affinity key across
 * both). What is left is the warm call's own cost, and its cache-read count says how much of the prefix hit.
 */
import type { Model } from "@earendil-works/pi-ai";

import type { ModelCall } from "../narrative/call.ts";
import type { WarmBase } from "../narrative/warm.ts";

export interface Primed {
  ms: number;
  error?: string;
}

/** Send `base` as the warm narrative call will extend it (same system prompt, messages and tools); never throws. */
export async function primeWarmBase(call: ModelCall, model: Model<any>, base: WarmBase, options: { timeoutMs?: number; now?: () => number } = {}): Promise<Primed> {
  const now = options.now ?? Date.now;
  const started = now();
  try {
    const timeout = options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs };
    const response = await call.complete(model, { systemPrompt: base.systemPrompt, messages: base.messages, tools: base.tools }, { maxTokens: 1, reasoning: "off", ...timeout });
    const error = response.stopReason === "error" ? (response.errorMessage ?? "provider error") : undefined;
    return { ms: now() - started, ...(error ? { error } : {}) };
  } catch (error) {
    return { ms: now() - started, error: error instanceof Error ? error.message : String(error) };
  }
}
