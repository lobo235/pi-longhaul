/**
 * The span as the narrative call sees it: pi's cut (messagesToSummarize) with the turn prefix
 * folded after it, thinking blocks stripped (the summarizer summarizes the conversation, not the
 * previous reasoning), and every user message prefixed with its ordinal so the diff can cite
 * "u12". Input messages are never mutated: the same objects are on the session branch.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { EXCERPT_CHARS, goalObjectiveOf, normalizeWs, skillInvocationOf, type IndexedUserMessage, type MessageIndex } from "../intent.ts";
import { closedWhole } from "../store/events.ts";

/**
 * How much of each user message the prompt's message list shows. The model copies a rule's words from this list,
 * so a message of this length is shown whole and a longer one ends in "…" where it is cut.
 */
export const SPAN_EXCERPT_CHARS = 240;

export function spanExcerpt(text: string): string {
  const flat = normalizeWs(text);
  return flat.length <= SPAN_EXCERPT_CHARS ? flat : `${flat.slice(0, SPAN_EXCERPT_CHARS - 1).trimEnd()}…`;
}

export interface SpanInput {
  messages: AgentMessage[];
  fromRef: string;
  toRef: string;
  /** `text`: the message's whole words, which a "rule" label records (message-labels.ts); absent in older fixtures. */
  ordinals: Array<{ ordinal: string; excerpt: string; text?: string }>;
  /** Ordinals listed first because the pass that held them closed narrative-less (carryUnlabeled); not in `messages`. */
  carried?: string[];
  strippedThinkingBlocks: number;
  strippedThinkingChars: number;
}

/** Drop thinking blocks from assistant messages. */
export function stripThinkingBlocks(messages: AgentMessage[]): { messages: AgentMessage[]; strippedBlocks: number; strippedChars: number } {
  let strippedBlocks = 0;
  let strippedChars = 0;
  const out = messages.map((message) => {
    if (message.role !== "assistant" || !Array.isArray(message.content)) return message;
    const kept = message.content.filter((block) => {
      if (block.type !== "thinking") return true;
      strippedBlocks++;
      strippedChars += (block as { thinking?: string }).thinking?.length ?? 0;
      return false;
    });
    return kept.length === message.content.length ? message : ({ ...message, content: kept } as AgentMessage);
  });
  return { messages: out, strippedBlocks, strippedChars };
}

function prefixed(message: AgentMessage, ordinal: string): AgentMessage {
  if (message.role !== "user") return message;
  const tag = `[${ordinal}] `;
  if (typeof message.content === "string") return { ...message, content: `${tag}${message.content}` } as AgentMessage;
  if (!Array.isArray(message.content)) return message;
  const content = [...message.content];
  const first = content.findIndex((block) => block.type === "text");
  if (first < 0) content.unshift({ type: "text", text: tag } as (typeof content)[number]);
  else content[first] = { ...content[first], text: `${tag}${(content[first] as { text: string }).text}` } as (typeof content)[number];
  return { ...message, content } as AgentMessage;
}

/** How a skill invocation is named wherever the summarizer is shown it: the skill's text is not the user's. */
export const skillTag = (name: string): string => `[/skill:${normalizeWs(name).slice(0, 40)}]`;

/** What the message list shows: a /goal by its objective, a skill invocation by its name and the user's own words. */
export function listedExcerpt(text: string): string {
  const skill = skillInvocationOf(text);
  const goal = goalObjectiveOf(skill?.words ?? text);
  if (goal) return `[/goal] ${normalizeWs(goal)}`.slice(0, EXCERPT_CHARS + 8);
  if (skill) return `${skillTag(skill.name)} ${skill.words ? spanExcerpt(skill.words) : "(no words of the user's own)"}`;
  return spanExcerpt(text);
}

function ordinalEntry(indexed: IndexedUserMessage): SpanInput["ordinals"][number] {
  return { ordinal: indexed.ordinal, excerpt: listedExcerpt(indexed.text), text: indexed.text };
}

export function prepareSpan(input: { messagesToSummarize: AgentMessage[]; turnPrefixMessages: AgentMessage[]; index: MessageIndex }): SpanInput {
  const all = [...input.messagesToSummarize, ...input.turnPrefixMessages];
  const stripped = stripThinkingBlocks(all);
  const byStamp = new Map(input.index.messages.map((message) => [message.timestamp, message]));
  const ordinals: SpanInput["ordinals"] = [];
  const messages = stripped.messages.map((message) => {
    if (message.role !== "user") return message;
    const indexed = byStamp.get(message.timestamp);
    if (!indexed) return message;
    ordinals.push(ordinalEntry(indexed));
    return prefixed(message, indexed.ordinal);
  });
  return { messages, ...input.index.spanRefs(all), ordinals, strippedThinkingBlocks: stripped.strippedBlocks, strippedThinkingChars: stripped.strippedChars };
}

/** Carried messages are bounded: a long run of failed passes must not grow every later prompt without limit. */
export const CARRIED_MAX_MESSAGES = 30;

/** A closed span as the carry reads it (store/events.ts span.close). */
export interface ClosedSpan { fromRef: string; toRef: string; narrativeLess: boolean; missingChunks?: number[]; foreign?: unknown }

/**
 * A pass that closes narrative-less labels none of its user messages, and no later span holds them, so a rule given
 * there would never be recorded; a chunk that never verified leaves its messages the same way, and the close does not
 * say which they were. The span after one lists that span's messages first (oldest first, at most
 * CARRIED_MAX_MESSAGES) and marks them carried, back to the last span that closed whole; a foreign compaction ends
 * the walk, since the switchover seed offers what came before it. A message labeled again is harmless: the store
 * refuses a rule it already holds, a rule lifted since from the message that gave it, and a lift of a rule already
 * lifted.
 */
export function carryUnlabeled(span: SpanInput, closes: readonly ClosedSpan[], index: Pick<MessageIndex, "messages">): SpanInput {
  let from: string | undefined;
  for (const close of [...closes].reverse()) {
    if (close.foreign || closedWhole(close)) break;
    if (close.fromRef !== "?") from = close.fromRef;
  }
  if (!from) return span;
  const listed = new Set(span.ordinals.map((entry) => entry.ordinal));
  const start = index.messages.findIndex((message) => message.ordinal === from);
  const end = span.ordinals.length ? index.messages.findIndex((message) => listed.has(message.ordinal)) : index.messages.length;
  if (start < 0 || end <= start) return span;
  const entries = index.messages.slice(start, end).filter((message) => !listed.has(message.ordinal)).slice(0, CARRIED_MAX_MESSAGES).map(ordinalEntry);
  if (entries.length === 0) return span;
  return { ...span, ordinals: [...entries, ...span.ordinals], carried: entries.map((entry) => entry.ordinal) };
}
