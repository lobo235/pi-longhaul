/**
 * The kept-window thinking strip (CONTEXT.md *Kept window*): after a compaction, pi re-sends the kept window -- the
 * recent messages the compaction did not summarize -- verbatim after the summary, thinking blocks included. A chat
 * template that renders reasoning for every assistant message after the last user message (the summary is one, on
 * the wire) then re-reads all of that old reasoning on every request. Measured on a reasoning model over 20
 * compactions: a mean 57k characters of old thinking against 2.2k of assistant text in the first request after a
 * compaction. Stripping it hands over what a fresh prompt would: the state, plus recent tool input and output.
 *
 * The cutoff is pi's own rule: the LAST compaction summary's timestamp, and an assistant message at or before it is
 * kept window (`assistantIsFromBeforeCompaction` uses the same `<=`). The stripped set is fixed until the next
 * compaction, so every later request renders the same prefix and a prompt cache keeps working.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";

export interface KeptWindowStripResult {
  /** The input array itself when nothing was stripped; a new array otherwise. */
  messages: AgentMessage[];
  strippedBlocks: number;
  strippedChars: number;
  /** The latest compaction summary's timestamp, or undefined when the context has no compaction. */
  cutoff: number | undefined;
}

export interface StripOptions {
  /**
   * Leave the active tool turn alone: every assistant message after the last message that is neither an assistant
   * message nor a tool result. An API that signs its thinking (Anthropic) rejects a tool-use turn whose thinking
   * blocks are not sent back complete, and after a mid-run compaction that turn can be the whole kept window.
   */
  protectActiveTurn: boolean;
}

/** The timestamp of the LAST compaction summary in the context, which is the cutoff of the kept window. */
function keptWindowCutoff(messages: AgentMessage[]): number | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as { role?: string; timestamp?: unknown };
    if (message.role === "compactionSummary" && typeof message.timestamp === "number") return message.timestamp;
  }
  return undefined;
}

/** Index of the first message of the active tool turn: just past the last message that is neither assistant nor tool result. */
function activeTurnStart(messages: AgentMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const role = (messages[i] as { role?: string }).role;
    if (role !== "assistant" && role !== "toolResult") return i + 1;
  }
  return 0;
}

export function stripKeptWindowThinking(messages: AgentMessage[], options: StripOptions): KeptWindowStripResult {
  const cutoff = keptWindowCutoff(messages);
  if (cutoff === undefined) return { messages, strippedBlocks: 0, strippedChars: 0, cutoff };
  const protectedFrom = options.protectActiveTurn ? activeTurnStart(messages) : messages.length;
  let strippedBlocks = 0;
  let strippedChars = 0;
  const out: AgentMessage[] = [];
  messages.forEach((message, index) => {
    if (index >= protectedFrom || message.role !== "assistant" || !Array.isArray(message.content) || typeof message.timestamp !== "number" || message.timestamp > cutoff) {
      out.push(message);
      return;
    }
    const kept = message.content.filter((block: (typeof message.content)[number]) => {
      if (block.type !== "thinking") return true;
      strippedBlocks++;
      strippedChars += block.thinking.length;
      return false;
    });
    if (kept.length === message.content.length) out.push(message);
    // A thinking-only message carried nothing but reasoning: pi-ai skips it on the wire anyway (no content, no
    // tool calls), so the context drops it rather than send a husk.
    else if (kept.length > 0) out.push({ ...message, content: kept });
  });
  return strippedBlocks === 0 ? { messages, strippedBlocks, strippedChars, cutoff } : { messages: out, strippedBlocks, strippedChars, cutoff };
}

/** The Longhaul config's `keptWindowThinking`: unset = strip only on a verified API. */
export type KeptWindowThinking = "strip" | "keep";

/**
 * APIs on which the strip is verified: pi-ai replays each kept assistant message's thinking in the field it
 * streamed in, the server needs none of it back, and stripping it was measured to work. Others keep their thinking
 * by default until verified; an explicit `strip` there still leaves the active tool turn whole.
 */
const VERIFIED_STRIP_APIS: ReadonlySet<string> = new Set(["openai-completions"]);

export interface KeptWindowContextOutcome {
  /** What the `context` handler returns to pi. */
  result: { messages: AgentMessage[] };
  strippedBlocks: number;
  strippedChars: number;
  cutoff: number;
}

/**
 * The `context` handler's whole decision: a result only when something was stripped (undefined lets pi keep its own
 * array), and never a throw -- a malformed message leaves the context to pi rather than failing the request.
 */
export function stripKeptWindowContext(event: { messages: AgentMessage[] }, model: { api?: string } | undefined, setting: KeptWindowThinking | undefined): KeptWindowContextOutcome | undefined {
  try {
    if (!model || setting === "keep" || !Array.isArray(event.messages)) return undefined;
    const verified = typeof model.api === "string" && VERIFIED_STRIP_APIS.has(model.api);
    if (setting === undefined && !verified) return undefined;
    const stripped = stripKeptWindowThinking(event.messages, { protectActiveTurn: !verified });
    if (stripped.cutoff === undefined || stripped.strippedBlocks === 0) return undefined;
    return { result: { messages: stripped.messages }, strippedBlocks: stripped.strippedBlocks, strippedChars: stripped.strippedChars, cutoff: stripped.cutoff };
  } catch {
    return undefined;
  }
}
