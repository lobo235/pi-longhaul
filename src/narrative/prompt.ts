/**
 * The narrative prompt: a fixed system prompt (cacheable prefix), the state so far with ids and
 * ordinals, what `remember` already recorded this span (so the model does not restate it), the
 * user-message index, one conversation chunk, /compact instructions as Now guidance only, and, on a
 * retry, the verbatim field errors as a trailing note.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { CREDENTIAL_RULE, scrubCredentials } from "../credential-scrub.ts";
import { normalizeWs } from "../intent.ts";
import { quoteText } from "../render.ts";
import { DEFAULT_CAPS, type Now, type Quote, type StateEvent } from "../store/events.ts";
import { activeCorrections, activeDeadEnds, activeDecisions, GOAL_SOURCE_LABEL, goalLine, type GoalSource, type SessionState } from "../store/project.ts";
import { fitFirstChunk } from "./fit.ts";
import { EARLIER_REQUEST, LABEL_FORMS, LIFT_GUIDANCE, NOT_A_RULE, RULE_DEFINITION, RULE_WHOLE_CHARS } from "./message-labels.ts";

/**
 * state-2: the switchover seed (previous summary + the user's earlier rule-shaped messages) and /goal excerpts in the user-message index.
 * state-3: the earlier rules are recorded by the pass unless the model lists them in "oneOffs" (pass.ts seedRuleEvents).
 * state-5: every user message of the span is labeled (message-labels.ts); code copies a rule's words. No word list decides.
 *   A switchover also shows the other earlier messages, so a withdrawal is seen and lifts the earlier rule it names.
 *   "values": named values, each checked against the turn it cites (named-values.ts).
 * state-7: a plain withdrawal is a lift even when it says what is fine instead; "rule and lifts" only for a new
 *   rule in the old one's place, kept whole; the message list shows up to 240 characters with "…" when cut.
 * state-8: a file-name format the user chose is a value, <placeholders> and all.
 * state-9: a message of at most 300 characters labeled a rule is kept whole; a requirement on a feature's output
 *   that later changes must keep is a rule.
 * state-10: state-9's feature-output sentence is withdrawn (it made feature specs rules: 55 stray lines on the five
 *   scored sessions, against 12).
 * state-11: messages carried from a pass that closed narrative-less are shown whole in <unsummarized-messages> and
 *   must be labeled (prepare.ts carryUnlabeled).
 * state-12: a description of what is being built is not a rule unless stated as standing over later work; how to
 *   carry out a withdrawal is not a new rule.
 * state-15: an earlier message recorded as a rule still takes a label when it replaces or withdraws an earlier rule
 *   (the seed floor now records "from now on" replacements, which "they need no label" left lifting nothing).
 * state-16: outside a /goal, the session's opening request is the goal line once the Request has moved from it
 *   (store/project.ts goalLine), so the project's purpose survives every compaction; never quoted as the objective.
 * state-18: a rule is what still binds once the work asked for now is done; "not a rule" names the kinds that filled
 *   rule slots on real sessions (a firm request for the task at hand, a question, a report, an idea under discussion).
 * state-19: at a switchover, an earlier request is not a rule even when it says how the result must behave.
 */
export const NARRATIVE_PROMPT_REVISION = "state-19";

export const NARRATIVE_SYSTEM_PROMPT = `You maintain the SESSION STATE of a coding session that is being compacted. You are given the state so far, the user's messages with their ordinals (u1, u2, ...), and the conversation being compacted. Answer with ONE fenced json block and nothing else:

\`\`\`json
{
  "narrative": "one paragraph: what happened in this span, in the past tense, naming commands and files",
  "objective": { "messageRef": "u1", "text": "<verbatim words of the request the work is answering now>", "doneWhen": { "messageRef": "u1", "text": "<verbatim acceptance, if the user stated one>" } },
  "labels": { "u1": "not a rule", "u2": "rule", "u3": "lifts R1" },
  "corrections": [],
  "values": [ { "name": "the first benchmark time", "value": "166 ms", "ref": "u10" } ],
  "decisions": [ { "text": "<one sentence, past tense>", "evidence": "C3" } ],
  "deadEnds": [ { "text": "<what was tried and why it failed>", "evidence": "E1" } ],
  "now": { "inProgress": ["..."], "next": ["..."], "blocked": ["..."], "resume": "<the first thing to do on resume>" }
}
\`\`\`

Rules. "objective" is the request the work is answering now. It is optional: include it only when none is set or the user moved to a different request in this span, and quote the user's own message verbatim. The goal line, when present, is the active /goal or the session's opening request: code keeps it, so never quote it as the objective; under a goal the objective is the specific ask. "labels": Label EVERY message in <user-messages> with one of ${LABEL_FORMS}. ${RULE_DEFINITION} ${LIFT_GUIDANCE} The target is R<n> from the state, or u<n> for a rule given earlier in this span. ${NOT_A_RULE} Code copies the user's words into the state, so a short message labeled a rule needs no quote; a message longer than ${RULE_WHOLE_CHARS} characters labeled a rule must come with the rule's exact words: {"u7": {"rule": "<exact words>"}}. "corrections" is only for a standing rule that an earlier summary records and no listed message gives; quote the user's exact words. "values": values a later turn may need again that no file will give back: a measurement, a total, a port or a count a turn reported, a hash it named, a file-name format the user chose ("<name>-YYYYMMDD.tar.gz"). Copy each exactly as it appears in the turn "ref" names (the user's message, your replies and the tool output up to the next user message); a value is a number with or without its unit ("166 ms"), a version, a short commit hash, a path or file name (with <placeholders> if the format has them), a host:port or a date; nothing else is kept. "name" is a short label (at most 40 characters, no colon) saying what it is. At most 12, never a password, key or token. "decisions" and "deadEnds" are your own one-sentence records with evidence: a command id C<n>, an error id E<n>, a message u<n>, or the words "last command" / "last error". "now" replaces the previous Now entirely. Never write "done" unless the state's Done gate line says met. ${CREDENTIAL_RULE} Empty arrays are fine. No prose outside the fence.`;

export interface PromptState {
  /** The Goal line (store/project.ts goalLine), shown so the summarizer never re-picks it as the Request. */
  goal?: { ordinal: string; text: string; source: GoalSource };
  objective?: { ordinal: string; text: string; doneWhen?: { ordinal: string; text: string } };
  corrections: Array<{ id: string; ordinal: string; text: string; lifted?: string }>;
  decisions: Array<{ id: string; text: string }>;
  deadEnds: Array<{ id: string; text: string }>;
  now?: Now;
  remembered: Array<{ kind: string; text: string }>;
  /** Another compactor's summary, on the first state span after it (the switchover): see seedOf. */
  seed?: string;
  /** With a seed: the user's earlier rule-shaped messages, verbatim (intent.ts earlierRuleMessages). */
  seedRules?: Array<{ ordinal: string; text: string }>;
  /** With a seed: the user's other earlier messages, whole (intent.ts earlierOtherMessages); the prompt shows their start. */
  seedContext?: Array<{ ordinal: string; text: string }>;
}

/** Head and tail of a foreign summary kept as the seed: its goal leads, its corrections and next steps trail. */
export const SEED_HEAD_CHARS = 12_000;
export const SEED_TAIL_CHARS = 12_000;

/**
 * The previous summary as the switchover seed, bounded: another compactor's summary can average ~27k
 * chars, and the fit maths counts the seed in the fixed prompt, so a larger one costs chunk room.
 */
export function seedOf(previousSummary: string | undefined): string | undefined {
  const text = previousSummary?.trim();
  if (!text) return undefined;
  if (text.length <= SEED_HEAD_CHARS + SEED_TAIL_CHARS) return text;
  return `${text.slice(0, SEED_HEAD_CHARS)}\n[… ${text.length - SEED_HEAD_CHARS - SEED_TAIL_CHARS} chars elided …]\n${text.slice(-SEED_TAIL_CHARS)}`;
}

const SEED_RULES_GUIDANCE = 'The user\'s own earlier messages that read like standing rules, verbatim, with their ordinals. Each one is recorded as corrections automatically, word for word: do not copy them into "corrections", and they need no label unless one replaces or withdraws an earlier rule: label that one "rule and lifts u<n>" or "lifts u<n>". List the ordinal of any that was a one-off request, an answer or a question rather than a rule still in force in a top-level "oneOffs" array, e.g. "oneOffs": ["u3"]; list none when all of them still hold. A rule a later message withdrew or replaced is not in force either: label that later message "lifts u<n>" (or "rule and lifts u<n>"), whether it is listed here or among the other messages.';

const SEED_CONTEXT_GUIDANCE = `The user's other earlier messages, each cut to its start. A later message may withdraw or replace an earlier rule: label it "lifts u<n>" (or "rule and lifts u<n>") with the earlier rule\'s ordinal, and that rule is not carried. Label every one of these too: "rule" when it is a standing rule still in force, however it is worded ("tests go under tests/", "our servers run Node 22"), "not a rule" otherwise. ${EARLIER_REQUEST}`;

export const SEED_CONTEXT_EXCERPT_CHARS = 240;

/** A carried message (prepare.ts carryUnlabeled) is shown whole up to this, so a long rule's words can be copied. */
export const CARRIED_MESSAGE_CHARS = 1200;
const CARRIED_GUIDANCE = 'These user messages came before the conversation below. The pass that held them could not be summarized, so they were never labeled; their work is done or superseded unless the conversation says otherwise. Label each of them in "labels" like the others.';

function carriedBlock(carried: ReadonlyArray<{ ordinal: string; text: string }>): string {
  const lines = carried.map(({ ordinal, text }) => {
    const flat = normalizeWs(text);
    return `[${ordinal}] ${flat.length <= CARRIED_MESSAGE_CHARS ? flat : `${flat.slice(0, CARRIED_MESSAGE_CHARS - 1).trimEnd()}…`}`;
  });
  return `${CARRIED_GUIDANCE}\n<unsummarized-messages>\n${lines.join("\n")}\n</unsummarized-messages>`;
}

const SEED_GUIDANCE = "This session was compacted before by a different compactor; its summary is below. The state above is empty because of that, not because nothing happened. Carry forward from it what is still in force: decisions and dead ends as your own records, the user's standing corrections (quote the user's exact words; a quote is checked against every user message, so copy it verbatim), and next steps that are not yet done into now. Do not carry steps the conversation below shows done. A value it records that a later turn may need (a measurement, a hash, a port, a file-name format) goes in \"values\" with the u<n> of the earlier turn that showed it; code keeps it only where that turn shows it verbatim.";

const rememberedText = (event: StateEvent): { kind: string; text: string } | undefined => {
  switch (event.kind) {
    case "correction.add": return { kind: "correction", text: `${event.id} [${event.quote.ordinal}] ${event.quote.text}` };
    case "correction.lift": return { kind: "lift", text: `${event.target} lifted by ${event.by.ordinal}` };
    // Written by a tool call this span: the projection has not seen it, so it is scrubbed here (credential-scrub.ts).
    case "decision.add": return { kind: "decision", text: `${event.id} ${scrubCredentials(event.text).text}` };
    case "deadEnd.add": return { kind: "dead-end", text: `${event.id} ${scrubCredentials(event.text).text}` };
    case "objective.set": return { kind: "objective", text: `${event.quote.ordinal} ${event.quote.text}` };
    case "objective.doneWhen": return { kind: "done-when", text: `${event.quote.ordinal} ${event.quote.text}` };
    default: return undefined;
  }
};

/** The Goal line as the summarizer sees it; the turns runner shows the same one. */
function goalOf(state: SessionState, quoteChars: number): { goal?: PromptState["goal"] } {
  const goal = goalLine(state);
  return goal ? { goal: { ordinal: goal.quote.ordinal, text: quoteText(goal.quote, quoteChars), source: goal.source } } : {};
}

/**
 * The state as the summarizer sees it. The goal, the Request and its acceptance are cut at `quoteChars` (the
 * state's own quote cap) as the rendered state cuts them: the goal stays for the session's life, so a pasted first
 * message must not fill every later prompt. The summarizer answers with message refs, never with these words.
 */
export function promptStateOf(state: SessionState, remembered: StateEvent[], quoteChars = DEFAULT_CAPS.objectiveQuoteChars): PromptState {
  const cut = (quote: Quote) => ({ ordinal: quote.ordinal, text: quoteText(quote, quoteChars) });
  return {
    ...goalOf(state, quoteChars),
    objective: state.objective ? { ...cut(state.objective.quote), doneWhen: state.objective.doneWhen ? cut(state.objective.doneWhen) : undefined } : undefined,
    corrections: activeCorrections(state).map((item) => ({ id: item.id, ordinal: item.quote.ordinal, text: quoteText(item.quote, quoteChars), lifted: item.liftedBy?.ordinal })),
    decisions: activeDecisions(state).map((item) => ({ id: item.id, text: item.text })),
    deadEnds: activeDeadEnds(state).map((item) => ({ id: item.id, text: item.text })),
    now: state.now ? { inProgress: state.now.inProgress, next: state.now.next, blocked: state.now.blocked, resume: state.now.resume } : undefined,
    remembered: remembered.map(rememberedText).filter((entry): entry is { kind: string; text: string } => entry !== undefined),
  };
}

export interface ChunkPlan {
  chunks: Array<{ index: number; conversation: string; messageCount: number; capped: boolean }>;
  total: number;
  /** Messages remained after maxChunks; the last chunk's diff should say so in its narrative. */
  truncated: boolean;
}

/** Chunks are planned up front with fitFirstChunk over the remaining messages, up to maxChunks. */
export function planChunks(input: { messages: AgentMessage[]; fixedChars: number; outputBudget: number; contextWindow: number; maxChunks: number }): ChunkPlan {
  const chunks: ChunkPlan["chunks"] = [];
  let rest = input.messages;
  while (rest.length > 0 && chunks.length < input.maxChunks) {
    const step = fitFirstChunk({ messages: rest as never, fixedChars: input.fixedChars, outputBudget: input.outputBudget, contextWindow: input.contextWindow });
    if (!step || step.messageCount === 0) break;
    chunks.push({ index: chunks.length + 1, conversation: step.conversation, messageCount: step.messageCount, capped: step.capped });
    rest = rest.slice(step.messageCount);
  }
  return { chunks, total: chunks.length, truncated: rest.length > 0 && chunks.length > 0 };
}

export function stateBlock(state: PromptState): string {
  const lines = [
    ...(state.goal ? [`goal: [${state.goal.ordinal}] ${state.goal.text} (${GOAL_SOURCE_LABEL[state.goal.source]}; kept by code)`] : []),
    `objective: ${state.objective ? `[${state.objective.ordinal}] ${state.objective.text}` : "(not set: set it from the first user message that states the goal)"}`,
    ...(state.objective?.doneWhen ? [`doneWhen: [${state.objective.doneWhen.ordinal}] ${state.objective.doneWhen.text}`] : []),
    "corrections:",
    ...(state.corrections.length ? state.corrections.map((c) => `  ${c.id} [${c.ordinal}] ${c.text}${c.lifted ? ` (lifted by ${c.lifted})` : ""}`) : ["  (none)"]),
    "decisions:",
    ...(state.decisions.length ? state.decisions.map((d) => `  ${d.id} ${d.text}`) : ["  (none)"]),
    "deadEnds:",
    ...(state.deadEnds.length ? state.deadEnds.map((x) => `  ${x.id} ${x.text}`) : ["  (none)"]),
    `now: ${state.now ? JSON.stringify(state.now) : "(none)"}`,
  ];
  return `<state>\n${lines.join("\n")}\n</state>`;
}

function excerptOf(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= SEED_CONTEXT_EXCERPT_CHARS ? flat : `${flat.slice(0, SEED_CONTEXT_EXCERPT_CHARS - 1)}…`;
}

/** `carried` is shown in the first chunk only: one chunk labels them (run.ts labellingOf). */
export function renderNarrativePrompt(input: { state: PromptState; ordinals: Array<{ ordinal: string; excerpt: string }>; carried?: ReadonlyArray<{ ordinal: string; text: string }>; conversation: string; chunk: { index: number; total: number }; customInstructions?: string; retryNote?: string }): string {
  const remembered = input.state.remembered.length ? input.state.remembered.map((r) => `${r.kind}: ${r.text}`).join("\n") : "(nothing)";
  const ordinals = input.ordinals.length ? input.ordinals.map((o) => `${o.ordinal}: ${o.excerpt}`).join("\n") : "(none in this span)";
  const parts = [
    NARRATIVE_SYSTEM_PROMPT,
    stateBlock(input.state),
    ...(input.state.seed ? [`${SEED_GUIDANCE}\n<previous-summary>\n${input.state.seed}\n</previous-summary>`] : []),
    ...(input.state.seed && input.state.seedRules?.length ? [`${SEED_RULES_GUIDANCE}\n<earlier-user-messages>\n${input.state.seedRules.map((rule) => `[${rule.ordinal}] ${rule.text}`).join("\n")}\n</earlier-user-messages>`] : []),
    ...(input.state.seed && input.state.seedContext?.length ? [`${SEED_CONTEXT_GUIDANCE}\n<earlier-other-messages>\n${input.state.seedContext.map((message) => `${message.ordinal}: ${excerptOf(message.text)}`).join("\n")}\n</earlier-other-messages>`] : []),
    `<remembered-this-span>\n${remembered}\n</remembered-this-span>`,
    `<user-messages>\n${ordinals}\n</user-messages>`,
    ...(input.carried?.length && input.chunk.index === 1 ? [carriedBlock(input.carried)] : []),
    input.conversation,
    `This is chunk ${input.chunk.index} of ${input.chunk.total}${input.chunk.total > 1 ? "; narrate this chunk only, the chunks are merged in order" : ""}.`,
    ...(input.customInstructions ? [`<now-guidance>\n${input.customInstructions}\n</now-guidance>`] : []),
    ...(input.retryNote ? [`<retry-note>\nYour previous answer had these field errors; fix exactly these and answer again in full:\n${input.retryNote}\n</retry-note>`] : []),
  ];
  return `${parts.join("\n\n")}\n`;
}

export function fixedPromptChars(input: { state: PromptState; ordinals: Array<{ ordinal: string; excerpt: string }>; carried?: ReadonlyArray<{ ordinal: string; text: string }>; customInstructions?: string }, retryNoteChars: number): number {
  return renderNarrativePrompt({ ...input, conversation: "", chunk: { index: 1, total: 1 } }).length + retryNoteChars;
}
