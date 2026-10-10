/**
 * The warm-cache narrative request: instead of re-encoding the span into a fresh prompt, repeat the
 * session's own request -- its system prompt, messages and tools, exactly as pi sent them -- and
 * append ONE instruction. The server has that prefix cached, so the summarizer prefills only the
 * instruction. Reasoning stays off and the tools stay declared (dropping them would change the
 * prefix); a tool call instead of an answer is a failed attempt the retry ladder handles (never
 * `tool_choice: none`: some servers drop the call). A base that would not fit the summarizer's window
 * falls back to the re-encoded transcript.
 *
 * Interface choice (design it twice): an optional `warm` base on the existing driver, not a second
 * driver. The alternative duplicated routing, the retry ladder and validation for one different
 * request shape; this keeps them shared and the difference to two places (the prompt and the context).
 * Behind config `narrativeMode: "warm"` and the scorer's `state-warm` arm; it ships only if that arm
 * matches `state`.
 */
import type { Message, Tool } from "@earendil-works/pi-ai";

import { CHARS_PER_TOKEN, fitsWindow } from "./fit.ts";
import { renderNarrativePrompt } from "./prompt.ts";

export interface WarmBase {
  systemPrompt: string;
  messages: Message[];
  tools: Tool[];
  /** Measured size (baseTokensOf); absent = estimated from the JSON, which over-counts a near-full session into the fallback. */
  tokens?: number;
}

const USAGE_FIELDS = ["input", "output", "cacheRead", "cacheWrite"] as const;
/** A floor from the JSON (which over-counts ~1.5-2x at CHARS_PER_TOKEN): a measurement below it is not believed (security.md T7). */
const FLOOR_CHARS_PER_TOKEN = 6;

/** The usage total, or undefined unless every present field is a finite non-negative number (security.md T7). */
export function usedTokens(usage: unknown): number | undefined {
  if (typeof usage !== "object" || usage === null) return undefined;
  let total = 0;
  for (const field of USAGE_FIELDS) {
    const value = (usage as Record<string, unknown>)[field];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
    total += value;
  }
  return total;
}

/**
 * The provider-reported size of the last answered request (its input and answer) plus a char estimate of every
 * message after it, never below a floor from the whole JSON; undefined when nothing valid was measured.
 */
export function baseTokensOf(messages: Message[]): number | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant" || message.usage === undefined) continue;
    const used = usedTokens(message.usage);
    if (used === undefined) return undefined;
    if (used === 0) continue;
    const measured = used + Math.ceil(JSON.stringify(messages.slice(index + 1)).length / CHARS_PER_TOKEN);
    return Math.max(measured, Math.ceil(JSON.stringify(messages).length / FLOOR_CHARS_PER_TOKEN));
  }
  return undefined;
}

export const WARM_HEAD = "STOP: the conversation above is a coding session being compacted. Do not continue it. Do not call tools. Answer only with the session-state update described below.";
const WARM_CONVERSATION = "<conversation>\nThe conversation being compacted is the session above this message; the user messages are listed with their ordinals in <user-messages>.\n</conversation>";

export function renderWarmPrompt(input: Omit<Parameters<typeof renderNarrativePrompt>[0], "conversation" | "chunk">): string {
  return `${WARM_HEAD}\n\n${renderNarrativePrompt({ ...input, conversation: WARM_CONVERSATION, chunk: { index: 1, total: 1 } })}`;
}

/** Whether the base (measured when it can be) plus the instruction (with room for a retry note) and the answer fit the window; JSON length over-counts, so this errs toward the fallback. */
export function warmFits(base: WarmBase, instructionChars: number, outputBudget: number, contextWindow: number): boolean {
  if (base.tokens !== undefined) return fitsWindow({ promptChars: base.tokens * CHARS_PER_TOKEN + instructionChars, outputBudget, contextWindow });
  const baseChars = base.systemPrompt.length + JSON.stringify(base.messages).length + JSON.stringify(base.tools).length;
  return fitsWindow({ promptChars: baseChars + instructionChars, outputBudget, contextWindow });
}
