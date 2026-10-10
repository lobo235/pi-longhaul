/**
 * One narrative request: prompt in, parse verdict + trace out. Transport errors are retried by
 * the shared transport policy and reported in the trace, never thrown; an abort is rethrown so
 * the driver can stop the whole pass. decideNextStep is the retry ladder as a pure function.
 */
import type { AssistantMessage, Context, Model } from "@earendil-works/pi-ai";

import { parseNarrativeAnswer, type ParseResult } from "./parse.ts";
import { planReasoning, raisedBudget } from "./reasoning.ts";
import type { NarrativePolicy } from "./policy.ts";
import { timedTransport } from "./timings.ts";
import { completeWithTransportRetry } from "./transport-retry.ts";
import type { CallTrace, NotADiffReason } from "./types.ts";
import { callUsageOf } from "./usage.ts";
import { retryNoteOf, type FieldError } from "./validate.ts";
import type { WarmBase } from "./warm.ts";

export interface ModelCall {
  complete: (model: Model<any>, context: Context, options: Record<string, unknown>) => Promise<AssistantMessage>;
}

/** The part of pi's model registry the compactor calls. */
export interface RegistryCalls {
  complete: (model: Model<any>, context: Context, options: Record<string, unknown>) => Promise<AssistantMessage>;
  streamSimple: (model: Model<any>, context: Context, options: Record<string, unknown>) => { result: () => Promise<AssistantMessage> };
}

/**
 * pi's registry `complete` takes the non-simple stream, which ignores `reasoning` and sends the model's
 * off value whatever was asked (verified on pi 1.0.1): `reasoning: "off"` worked only because off is what
 * that path always sends. A request that asks for reasoning therefore goes through `streamSimple`, which
 * maps the level; every reasoning-off request keeps the long-proven `complete` path. `wrap` adds per-call
 * options (the Longhaul config's summarizerHeaders) to both.
 */
export function registryCall(registry: RegistryCalls, wrap: (options: Record<string, unknown>, model: Model<any>) => Record<string, unknown> = (options) => options): ModelCall {
  return {
    complete: (model, context, options) => {
      const wrapped = wrap(options, model);
      const reasoning = options.reasoning;
      return typeof reasoning === "string" && reasoning !== "off" ? registry.streamSimple(model, context, wrapped).result() : registry.complete(model, context, wrapped);
    },
  };
}

export interface CallInput {
  model: Model<any>;
  prompt: string;
  /** Repeat this request (warm.ts) and append the prompt as its last message, instead of sending the prompt alone. */
  warm?: WarmBase;
  chunk: number;
  attempt: number;
  /** The previous attempt ran out of output with nothing usable: ask for more room (reasoning.ts raisedBudget). */
  raise?: boolean;
  policy: NarrativePolicy;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** `text` is the answer's own words, for a caller that reads an answer other than a full diff (run.ts askReplacements). */
export type CallResult = { trace: CallTrace; parsed: ParseResult; text?: string } | { trace: CallTrace; thrown: Error };

export const isAbort = (error: unknown): boolean => error instanceof Error && (error.name === "AbortError" || /abort/i.test(error.message));

function textOf(message: AssistantMessage): string {
  return message.content.filter((block) => block.type === "text").map((block) => (block as { text: string }).text).join("");
}

export async function callNarrativeModel(input: CallInput, call: ModelCall): Promise<CallResult> {
  const now = input.now ?? Date.now;
  const started = now();
  const transport = timedTransport(input.model);
  // A warm request rides the session's cached prefix; a cold one is a one-off prompt nothing will reuse.
  const plan = planReasoning(input.model, input.policy.outputTokens);
  const maxTokens = input.raise ? raisedBudget(input.model, plan.maxTokens) : plan.maxTokens;
  const options = { maxTokens, reasoning: plan.reasoning, signal: input.signal, ...(input.warm ? {} : { cacheRetention: "none" }), timeoutMs: input.policy.timeoutMs, ...(transport ? { fetch: transport.fetch } : {}) };
  const instruction = { role: "user" as const, content: input.prompt, timestamp: started };
  const context: Context = input.warm
    ? { systemPrompt: input.warm.systemPrompt, messages: [...input.warm.messages, instruction], tools: input.warm.tools }
    : { systemPrompt: "", messages: [instruction] };
  const base = { chunk: input.chunk, attempt: input.attempt, fieldErrors: [], dropped: 0, rescued: 0, ...(input.warm ? { warm: true as const } : {}), ...(plan.path === "lowest" ? { reasoning: plan.reasoning } : {}), ...(input.raise ? { maxTokens } : {}) };
  try {
    const { response, retries, errors } = await completeWithTransportRetry(() => call.complete(input.model, context, options), { policy: input.policy.transportRetry, signal: input.signal, sleep: input.sleep });
    // A warm request declares the session's tools; an answer that calls one is not an answer, even beside valid JSON (security.md T2).
    const calledTool = input.warm !== undefined && response.content.some((block) => block.type === "toolCall");
    const parsed: ParseResult = calledTool ? { ok: false, reason: "empty", detail: "answered with a tool call instead of the state update" } : parseNarrativeAnswer(textOf(response), response.stopReason);
    if (response.stopReason === "error" && response.errorMessage) errors.push(response.errorMessage);
    const usage = callUsageOf(response.usage);
    return { parsed, text: textOf(response), trace: { ...base, verdict: parsed.ok ? "diff" : parsed.reason, stopReason: response.stopReason, usage, transport: transport?.timings, retries, errors: errors.map(String), durationMs: now() - started } };
  } catch (error) {
    if (isAbort(error) || input.signal?.aborted) throw error;
    const retried = error as { retries?: number; errors?: unknown[] };
    return { thrown: error as Error, trace: { ...base, verdict: "empty", transport: transport?.timings, retries: retried.retries ?? input.policy.transportRetry.maxRetries, errors: [String((error as Error).message ?? error)], durationMs: now() - started } };
  }
}

export type NextStep = { step: "accept" } | { step: "retry-same" } | { step: "retry-with-note"; note: string } | { step: "give-up"; reason: NotADiffReason };

export function decideNextStep(input: { parsed: ParseResult; fieldErrors: FieldError[]; attempt: number; policy: NarrativePolicy; noteChars: number }): NextStep {
  const last = input.attempt > input.policy.fixableRetries;
  if (!input.parsed.ok) {
    if (last) return { step: "give-up", reason: input.parsed.reason };
    if (input.parsed.reason === "schema" || input.parsed.reason === "wrong-type") return { step: "retry-with-note", note: input.parsed.detail.slice(0, input.noteChars) };
    return { step: "retry-same" };
  }
  const note = retryNoteOf(input.fieldErrors, input.noteChars);
  if (note === "" || last) return { step: "accept" };
  return { step: "retry-with-note", note };
}
