/**
 * Sizing the summarizer's input against the summarizer's real context window.
 *
 * pi routes compaction by declared windows and never checks whether the prompt it built fits the
 * model it sends it to; pi-ai then clamps max_tokens to
 * `contextWindow - estimate(context) - CONTEXT_SAFETY_TOKENS` (api/simple-options.js), so an
 * oversized prompt does not overflow at once: it silently loses the summary's output budget and
 * dies at a "length" stop, or overflows on the server. This module decides, before the call,
 * whether `estimate(prompt) + outputBudget + safety <= contextWindow`, and if not, which of the
 * reductions in fitFirstChunk to apply.
 */
import type { Message } from "@earendil-works/pi-ai";
import { serializeConversation } from "@earendil-works/pi-coding-agent";

/**
 * Chars per provider-reported input token. Calibrated on 26 recorded compactions joined with
 * their `success` log entries: p10 3.07, p50 3.27, min 2.72. pi's own estimate uses
 * 4 and under-counts these prompts by 20-30 %; 3 keeps the check on the safe side of pi's clamp
 * (a prompt that fits here is never clamped there) and of the server.
 */
export const CHARS_PER_TOKEN = 3;

/** pi-ai's CONTEXT_SAFETY_TOKENS: the room its max_tokens clamp insists on. Mirrored, not imported. */
export const CONTEXT_SAFETY_TOKENS = 4096;

/** Elision caps for the overflow path: head keeps the intent, tail keeps the outcome. */
export interface Cap {
  head: number;
  tail: number;
}

/**
 * User text, assistant text and each tool-call argument string: pi never truncates these, and
 * after thinking is stripped tool-call arguments are ~40 % of the serialized conversation (a
 * `write` of a whole file, an `edit` with both texts).
 */
export const TEXT_CAP: Cap = { head: 3000, tail: 1000 };

/**
 * Tool results: pi already renders at most 2 000 chars of each (head only). The overflow path
 * keeps that size but splits it head/tail so the end of the output -- the error line, the exit
 * status -- survives instead of the middle of a listing.
 */
export const TOOL_RESULT_CAP: Cap = { head: 1500, tail: 500 };

export function estimatePromptTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

export interface FitCheck {
  promptChars: number;
  outputBudget: number;
  contextWindow: number;
}

/** True when the whole prompt, its output budget and pi's safety margin fit the window. */
export function fitsWindow({ promptChars, outputBudget, contextWindow }: FitCheck): boolean {
  if (contextWindow <= 0) return true; // unknown window: nothing to check against
  return estimatePromptTokens(promptChars) + outputBudget + CONTEXT_SAFETY_TOKENS <= contextWindow;
}

/** Largest serialized conversation (chars) that fits next to the fixed prompt parts and the budget. */
export function conversationCharsThatFit(fixedChars: number, outputBudget: number, contextWindow: number): number {
  if (contextWindow <= 0) return Number.POSITIVE_INFINITY;
  const tokensForPrompt = contextWindow - outputBudget - CONTEXT_SAFETY_TOKENS;
  return tokensForPrompt * CHARS_PER_TOKEN - fixedChars;
}

/** Keep the head and the tail of a long text, with a marker saying how much was elided. */
export function elideMiddle(text: string, cap: Cap): string {
  if (text.length <= cap.head + cap.tail) return text;
  const elided = text.length - cap.head - cap.tail;
  return `${text.slice(0, cap.head)}\n\n[... ${elided} characters elided ...]\n\n${text.slice(text.length - cap.tail)}`;
}

/** pi-ai contentText, mirrored: pi-ai is not resolvable outside pi's extension loader. */
function contentText(content: string | Array<{ type: string; text?: string; thinking?: string }>, separator: string): string {
  if (typeof content === "string") return content;
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join(separator);
}

/**
 * pi's serializeConversation format (dist/core/compaction/utils.js), with every text part elided
 * past its cap. Used only when the normal serialization does not fit, so the normal path stays
 * byte-identical to pi's.
 */
export function serializeConversationCapped(messages: Message[], text: Cap = TEXT_CAP, toolResult: Cap = TOOL_RESULT_CAP): string {
  const parts: string[] = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      const content = elideMiddle(contentText(msg.content, ""), text);
      if (content) parts.push(`[User]: ${content}`);
    } else if (msg.role === "assistant") {
      const thinking: string[] = [];
      const toolCalls: string[] = [];
      for (const block of msg.content) {
        if (block.type === "thinking") {
          thinking.push(elideMiddle(block.thinking, text));
        } else if (block.type === "toolCall") {
          const argsStr = Object.entries(block.arguments)
            .map(([k, v]) => `${k}=${JSON.stringify(typeof v === "string" ? elideMiddle(v, text) : v)}`)
            .join(", ");
          toolCalls.push(`${block.name}(${argsStr})`);
        }
      }
      if (thinking.length > 0) parts.push(`[Assistant thinking]: ${thinking.join("\n")}`);
      if (msg.content.some((block) => block.type === "text")) {
        parts.push(`[Assistant]: ${elideMiddle(contentText(msg.content, "\n"), text)}`);
      }
      if (toolCalls.length > 0) parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
    } else if (msg.role === "toolResult") {
      const content = contentText(msg.content, "");
      if (content) parts.push(`[Tool result]: ${elideMiddle(content, toolResult)}`);
    }
  }
  return parts.join("\n\n");
}

export interface FitFirstChunkInput {
  /** LLM messages, thinking already stripped. */
  messages: Message[];
  /** Chars of everything in the prompt that is not the conversation: system prompt, instructions, carried summary, wrappers. */
  fixedChars: number;
  outputBudget: number;
  contextWindow: number;
}

export interface FitStep {
  conversation: string;
  /** How many messages from the front of the input this step consumes. */
  messageCount: number;
  /** Whether the capped serialization had to be used. */
  capped: boolean;
}

/**
 * The next summarizer call's conversation text, applying reductions only as far as needed:
 *   1. pi's own serialization, when it fits;
 *   2. the capped serialization (TEXT_CAP / TOOL_RESULT_CAP) of every message, when that fits;
 *   3. the capped serialization of the largest prefix that fits, leaving the rest for the next
 *      call (the caller carries this call's summary into it as <previous-summary>).
 * Returns undefined when not even one capped message fits -- the caller then tries a model with
 * a larger window. Thinking blocks are stripped upstream (prepare.ts) before any of this.
 */
export function fitFirstChunk({ messages, fixedChars, outputBudget, contextWindow }: FitFirstChunkInput): FitStep | undefined {
  const limit = conversationCharsThatFit(fixedChars, outputBudget, contextWindow);
  const full = serializeConversation(messages);
  if (full.length <= limit) return { conversation: full, messageCount: messages.length, capped: false };
  const capped = serializeConversationCapped(messages);
  if (capped.length <= limit) return { conversation: capped, messageCount: messages.length, capped: true };
  // Serialized size is monotonic in the prefix length, so binary-search the largest prefix that fits.
  let best = 0;
  let low = 1;
  let high = messages.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (serializeConversationCapped(messages.slice(0, mid)).length <= limit) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  if (best === 0) return undefined;
  return { conversation: serializeConversationCapped(messages.slice(0, best)), messageCount: best, capped: true };
}

/**
 * Whether a provider error message means the prompt overflowed the model's context. A subset of
 * pi-ai's OVERFLOW_PATTERNS (utils/overflow.js) covering common OpenAI-compatible servers plus the
 * generic forms; pi-ai's own isContextOverflow is not resolvable outside pi's extension loader, so
 * it is mirrored here.
 */
const OVERFLOW_PATTERNS = [
  /exceeds the context window/i,
  /maximum context length/i,
  /context[_ ]length[_ ]exceeded/i,
  /too many tokens/i,
  /token limit exceeded/i,
  /prompt is too long/i,
  /exceeds the available context size/i,
  /reduce the length of the messages/i,
  /range of input length should be/i,
];
const NOT_OVERFLOW_PATTERNS = [/throttl/i, /rate.?limit/i];

export function isContextOverflowMessage(message: string | undefined): boolean {
  if (!message) return false;
  if (NOT_OVERFLOW_PATTERNS.some((re) => re.test(message))) return false;
  return OVERFLOW_PATTERNS.some((re) => re.test(message));
}
