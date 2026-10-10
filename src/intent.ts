/**
 * Verbatim intent (CONTEXT.md *Objective*, *User correction*, *Quote*): user messages on the branch
 * get display ordinals u1, u2, ...; every quote binds to pi's entry id; verification is a
 * whitespace-normalised substring test against the cited message. The two hands name messages
 * differently: the diff hand by ordinal (the prompt shows the u-index), falling back to the words
 * when the ordinal is wrong, the tool hand by the user's words alone, resolved newest-first. In a
 * /goal-mode message only the objective is the user's; pi's template around it is never quotable. Only user messages can be quoted, so text injected
 * through a tool result cannot mint or lift a standing rule, and only a goal pi-goal recorded on the branch can set the objective on its own.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import { MIN_QUOTE_CHARS, type Quote, type Rejection } from "./store/events.ts";
import type { QuoteChecker } from "./store/log.ts";
import type { QuoteResolution, QuoteResolver } from "./store/verify.ts";
import { NEGATED, WITHDRAWAL_CUE } from "./store/lift-vocabulary.ts";

export interface IndexedUserMessage {
  ordinal: string;
  messageId: string;
  /** Index into the branch entries, for lift ordering. */
  position: number;
  /** The message's text blocks joined with "\n"; "" when it has none (an image alone). */
  text: string;
  timestamp: number;
}

export interface EvidenceRefs {
  commandIds: ReadonlySet<string>;
  errorIds: ReadonlySet<string>;
}

export interface MessageIndex extends QuoteResolver, QuoteChecker {
  messages: IndexedUserMessage[];
  textOf(ordinal: string): string | undefined;
  recent(count: number): Array<{ ordinal: string; excerpt: string }>;
  /**
   * The objective a pass sets when nothing set one: the newest message of the /goal pi-goal names as active (`goal: true`),
   * else the first stated goal.
   */
  defaultObjective(): { ordinal: string; text: string; goal: boolean } | undefined;
  spanRefs(messages: AgentMessage[]): { fromRef: string; toRef: string };
}

export const EXCERPT_CHARS = 80;
export const KNOWN_REFS_SHOWN = 5;
export const RECENT_SHOWN = 3;
export const DEFAULT_OBJECTIVE_MIN_CHARS = 40;

export function userText(message: AgentMessage): string {
  if (message.role !== "user") return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.filter((block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string").map((block) => block.text).join("\n");
}

export function normalizeWs(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

const excerpt = (text: string) => normalizeWs(text).slice(0, EXCERPT_CHARS);

/**
 * pi-goal's objective block exactly as it renders it (0.54.x prompts.ts goalContextBlock): the objective,
 * XML-escaped so it can hold no angle bracket, then its goal_id block. Anything looser is not pi-goal's.
 */
const GOAL_BLOCK_RE = /(?:^|\n)<goal_objective>\n([^<>]*)\n<\/goal_objective>\n\n<goal_id>\n([^<>\n]+)\n<\/goal_id>(?:\n|$)/;
/** The custom entry pi-goal appends whenever its goal changes ({ goal: { id, text, ... } | null }). */
export const PI_GOAL_STATE_ENTRY_TYPE = "goal-state";

/** A pi-goal objective block, by shape alone: exactly one block, in pi-goal's own layout. */
export function goalBlockOf(text: string): { objective: string; goalId: string } | undefined {
  if (text.split("<goal_objective>").length !== 2) return undefined;
  const match = GOAL_BLOCK_RE.exec(text);
  const objective = match?.[1]?.trim();
  return match && objective ? { objective, goalId: match[2].trim() } : undefined;
}

/**
 * The user's own objective inside a pi /goal-mode message, or undefined for any other message.
 * Goal mode wraps the user's words in a ~3.5 kB template on every continuation turn; the template
 * is pi's, the text between the tags is the user's, so only that text is ever an objective. This is
 * the SHAPE test only -- what may be quoted or listed. Setting the objective needs the goal recorded too.
 */
export function goalObjectiveOf(text: string): string | undefined {
  return goalBlockOf(text)?.objective;
}

const escapeXmlText = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Goals pi-goal itself recorded on the branch, by id, as their rendered (escaped, whitespace-normalised)
 * objective. A custom entry is written by extension code, never by message text, so a user-role message
 * that copies the template -- an MCP prompt result, text relayed from another agent -- cannot add one
 * (security.md T2).
 */
export function recordedGoals(branchEntries: SessionEntry[]): Map<string, string> {
  const goals = new Map<string, string>();
  for (const entry of branchEntries) {
    if (entry.type !== "custom" || entry.customType !== PI_GOAL_STATE_ENTRY_TYPE) continue;
    const goal = (entry.data as { goal?: { id?: unknown; text?: unknown } | null } | undefined)?.goal;
    if (goal && typeof goal.id === "string" && typeof goal.text === "string") goals.set(goal.id, normalizeWs(escapeXmlText(goal.text)));
  }
  return goals;
}

/**
 * The goal pi-goal's LATEST goal-state entry names as running, or undefined: pi-goal reads only that
 * entry back (persistence.ts), and writes `goal: null` on clear and a non-active status when the goal
 * completes or stops (security.md T2). An entry with no status predates statuses and counts as active.
 */
export function activeGoalId(branchEntries: SessionEntry[]): string | undefined {
  const latest = [...branchEntries].reverse().find((entry) => entry.type === "custom" && entry.customType === PI_GOAL_STATE_ENTRY_TYPE);
  if (!latest || latest.type !== "custom") return undefined;
  const goal = (latest.data as { goal?: { id?: unknown; status?: unknown } | null } | undefined)?.goal;
  if (!goal || typeof goal.id !== "string") return undefined;
  return goal.status === undefined || goal.status === "active" ? goal.id : undefined;
}

/** The part of a user message a quote may bind to: the objective of a /goal-mode message, else all of it. */
export function quotableText(text: string): string {
  return goalObjectiveOf(text) ?? text;
}

/** Words that make a user message read as a standing rule. A pointer for the model, never a verdict: quotes are still verified. */
export const RULE_SHAPE_RE = /\b(never|always|don'?t|do not|must|stop|only)\b/i;
const RULE_WORDS = new RegExp(RULE_SHAPE_RE.source, "gi");
/** Words that say a rule holds from here on: "from now on every option gets a row". */
const STANDING_RE = /\b(?:from (?:now|here|this point) on|going forward)\b/i;
/** Words that say a request is for now only: "don't commit yet", "stop the watcher for the moment". */
const FOR_NOW_RE = /\b(?:yet|for now|right now|for the moment|at the moment|this time|just this once)\b/i;
/** A rule word that only describes a thing: "an option that keeps only lines", "never mind". */
const DESCRIBES_RE = /\b(?:that|which)\s+\w+s\s+$/i;
const IDIOM_RE = /^never\s+mind\b/i;
/** A tag that asks for no answer: "never force-push to main, ok?" is a statement; "do we always ..., right?" is not. */
const TAG_RE = /,\s*(?:ok(?:ay)?|right|alright|all right|got it|understood|clear|agreed|yes)\W*$/i;
const ASKS_RE = /^(?:(?:do|does|did)\b(?!\s+not\b)|(?:is|are|was|were|should|shall|can|could|will|would|may|might|must|have|has|had)\b)/i;

/** A withdrawal word no negation takes back: "forget it" withdraws, "don't forget it" and "never ignore" do not. */
function withdraws(clause: string): boolean {
  return [...clause.matchAll(WITHDRAWAL_CUE)].some((match) => !NEGATED.test(clause.slice(Math.max(0, match.index - 80), match.index)));
}

/**
 * Whether a user message says what holds from now on. A sentence that is not a question holds a standing rule when a
 * clause of it has a rule word outside a request for now, a withdrawal, "never mind" and a description of a thing
 * ("an option that keeps only lines"); or when the sentence says "from now on" and withdraws nothing ("the rule is
 * lifted; anything is fine from now on" is a lift, which the model labels). A closing "ok?" asks nothing unless the
 * sentence opens as a question ("do we always ..., right?"). Clause by clause, so "never deploy on a Friday, not
 * even this time" keeps its rule. "Instead" is no rule word: "skip bad lines instead of throwing" asks for one
 * change. Nor is a scope: "in this repo", even beside "every", is how a one-off bulk job is asked for too
 * ("force-push every branch in this repo"). A message this rejects is still shown to the model, which can label it a
 * rule (earlierOtherMessages); one it accepts is recorded unless the model calls it a one-off. Bounded: longer text
 * is a paste, never a rule (EARLIER_RULE_MAX_CHARS).
 */
export function readsAsStandingRule(text: string): boolean {
  if (text.length > EARLIER_RULE_MAX_CHARS) return false;
  return text.split(/(?<=[.!?])\s+/).some((sentence) => {
    const body = sentence.trim();
    if (body.endsWith("?") && (!TAG_RE.test(body) || ASKS_RE.test(body))) return false;
    const clauses = body.split(/[,;:]/);
    if (clauses.some((clause) => STANDING_RE.test(clause) && !FOR_NOW_RE.test(clause)) && !withdraws(body)) return true;
    return clauses.some((clause) => !FOR_NOW_RE.test(clause) && !withdraws(clause) && [...clause.matchAll(RULE_WORDS)].some((match) => !IDIOM_RE.test(clause.slice(match.index)) && !DESCRIBES_RE.test(clause.slice(0, match.index))));
  });
}

export const EARLIER_RULE_MAX_CHARS = 600;
export const EARLIER_RULES_TOTAL_CHARS = 6000;

/**
 * The user's own rule-shaped messages before `fromOrdinal`, oldest first, bounded: what a switchover
 * pass shows so a correction the previous compactor only paraphrased can be quoted verbatim again.
 * Newest win the budget; a message over EARLIER_RULE_MAX_CHARS is a paste, not a rule.
 */
export function earlierRuleMessages(messages: IndexedUserMessage[], fromOrdinal: string): Array<{ ordinal: string; text: string }> {
  const start = messages.findIndex((message) => message.ordinal === fromOrdinal);
  const before = start < 0 ? messages : messages.slice(0, start);
  const picked: Array<{ ordinal: string; text: string }> = [];
  let used = 0;
  for (const message of [...before].reverse()) {
    const text = normalizeWs(quotableText(message.text));
    if (text.length < 12 || text.length > EARLIER_RULE_MAX_CHARS || !readsAsStandingRule(text)) continue;
    if (used + text.length > EARLIER_RULES_TOTAL_CHARS) break;
    used += text.length;
    picked.unshift({ ordinal: message.ordinal, text });
  }
  return picked;
}

export const EARLIER_OTHER_EXCERPT_CHARS = 240;
export const EARLIER_OTHER_TOTAL_CHARS = 6000;

/**
 * The user's other earlier messages before `fromOrdinal` (those `earlierRuleMessages` did not pick), oldest first, each
 * cut to its start, newest winning the budget: what a switchover shows so that a withdrawal no rule word marks ("the
 * DRY: prefix rule is lifted") is seen, and a rule worded without one can still be labeled. Carries the whole text,
 * which a "rule" label records; the prompt shows the excerpt.
 */
export function earlierOtherMessages(messages: IndexedUserMessage[], fromOrdinal: string, picked: ReadonlySet<string>): Array<{ ordinal: string; text: string }> {
  const start = messages.findIndex((message) => message.ordinal === fromOrdinal);
  const before = start < 0 ? messages : messages.slice(0, start);
  const out: Array<{ ordinal: string; text: string }> = [];
  let used = 0;
  for (const message of [...before].reverse()) {
    const text = quotableText(message.text).trim();
    if (picked.has(message.ordinal) || text.length === 0) continue;
    const shown = Math.min(normalizeWs(text).length, EARLIER_OTHER_EXCERPT_CHARS);
    if (used + shown > EARLIER_OTHER_TOTAL_CHARS) break;
    used += shown;
    out.unshift({ ordinal: message.ordinal, text });
  }
  return out;
}

function firstStatedGoal(messages: IndexedUserMessage[]): IndexedUserMessage | undefined {
  const usable = (message: IndexedUserMessage) => message.text.trim().length > 0 && !message.text.trim().startsWith("/");
  return messages.find((message) => usable(message) && message.text.trim().length >= DEFAULT_OBJECTIVE_MIN_CHARS) ?? messages.find(usable);
}

function defaultObjectiveOf(messages: IndexedUserMessage[], recorded: ReadonlyMap<string, string>, active: string | undefined): { ordinal: string; text: string; goal: boolean } | undefined {
  for (let at = active === undefined ? -1 : messages.length - 1; at >= 0; at--) {
    const block = goalBlockOf(messages[at].text);
    if (block && block.goalId === active && recorded.get(block.goalId) === normalizeWs(block.objective)) return { ordinal: messages[at].ordinal, text: block.objective, goal: true };
  }
  const first = firstStatedGoal(messages);
  return first ? { ordinal: first.ordinal, text: first.text, goal: false } : undefined;
}

/**
 * The window of `needle`'s length in `haystack` aligned on the longest token of `needle` found
 * there (so "use fakes here" against "...; use fakes." yields "use fakes."); undefined when no
 * token of three or more characters occurs in the haystack.
 */
export function closestWindow(haystack: string, needle: string): string | undefined {
  const hay = normalizeWs(haystack);
  const wanted = normalizeWs(needle);
  const tokens = wanted.split(" ").filter((token) => token.length > 2).sort((a, b) => b.length - a.length);
  for (const token of tokens) {
    const at = hay.toLowerCase().indexOf(token.toLowerCase());
    if (at < 0) continue;
    const start = Math.max(0, at - wanted.indexOf(token));
    return hay.slice(start, start + wanted.length);
  }
  return undefined;
}

function indexUserMessages(branchEntries: SessionEntry[]): IndexedUserMessage[] {
  const messages: IndexedUserMessage[] = [];
  branchEntries.forEach((entry, position) => {
    if (entry.type !== "message" || entry.message.role !== "user") return;
    messages.push({ ordinal: `u${messages.length + 1}`, messageId: entry.id, position, text: userText(entry.message), timestamp: entry.message.timestamp });
  });
  return messages;
}

/** Evidence refs a proposal may cite: a ledger command/error id, a user ordinal, or the two literals. */
function evidenceChecker(evidence: EvidenceRefs, byOrdinal: ReadonlyMap<string, IndexedUserMessage>): (value: string) => boolean {
  return (value) => {
    const trimmed = value.trim();
    if (trimmed === "last command" || trimmed === "last error") return true;
    if (/^C\d+$/.test(trimmed)) return evidence.commandIds.has(trimmed);
    if (/^E\d+$/.test(trimmed)) return evidence.errorIds.has(trimmed);
    if (/^u\d+$/.test(trimmed)) return byOrdinal.has(trimmed);
    return false;
  };
}

/**
 * How quotes are checked against the user's messages: resolve finds the message that holds a proposed quote, holds
 * re-checks a stored one. Each message's quotable text is normalised once, on first use.
 */
function quoteChecks(messages: IndexedUserMessage[], byOrdinal: ReadonlyMap<string, IndexedUserMessage>, byId: ReadonlyMap<string, IndexedUserMessage>) {
  const known = () => messages.slice(-KNOWN_REFS_SHOWN).map((message) => message.ordinal);
  const recent = (count: number) => [...messages].reverse().slice(0, count).map((message) => ({ ordinal: message.ordinal, excerpt: excerpt(message.text) }));

  const notSubstring = (ref: string, candidates: IndexedUserMessage[], wanted: string): QuoteResolution => {
    const first = candidates[0];
    const closest = candidates.map((candidate) => closestWindow(quotableText(candidate.text), wanted)).find((window) => window !== undefined);
    const rejection: Extract<Rejection, { code: "not-substring" }> = { code: "not-substring", ref, excerpt: first ? excerpt(first.text) : "", closest, recent: recent(RECENT_SHOWN) };
    return { ok: false, rejection };
  };

  const flat = new Map<IndexedUserMessage, string>();
  const flatOf = (message: IndexedUserMessage) => {
    let text = flat.get(message);
    if (text === undefined) flat.set(message, (text = normalizeWs(quotableText(message.text))));
    return text;
  };
  const bound = (message: IndexedUserMessage, wanted: string): QuoteResolution => ({ ok: true, quote: { messageId: message.messageId, ordinal: message.ordinal, text: wanted }, position: message.position });
  const holdsWords = (message: IndexedUserMessage, wanted: string) => flatOf(message).includes(wanted);
  const newestHolding = (wanted: string) => [...messages].reverse().find((message) => holdsWords(message, wanted));

  /**
   * The cited message first; when it does not hold the words, the newest user message that does.
   * The words are what is verified -- an ordinal is the model's pointer to them, and a wrong pointer
   * to the user's real words is still the user's real words. Text nobody wrote still rejects.
   */
  const resolve = (text: string, ref?: string): QuoteResolution => {
    const wanted = normalizeWs(text);
    if (wanted.length < MIN_QUOTE_CHARS) return { ok: false, rejection: { code: "empty" } };
    const cited = ref === undefined ? undefined : byOrdinal.get(ref);
    if (cited && holdsWords(cited, wanted)) return bound(cited, wanted);
    const hit = newestHolding(wanted);
    if (hit) return bound(hit, wanted);
    if (ref === undefined) return notSubstring("any user message", [...messages].reverse(), wanted);
    if (!cited) return { ok: false, rejection: { code: "unknown-ref", ref, known: known() } };
    return notSubstring(ref, [cited], wanted);
  };

  const holds = (quote: Quote): boolean => {
    const message = byId.get(quote.messageId);
    if (!message) return false;
    // The cut marker the renderer appends; `recall` is the tool's name before the rename, kept for older summaries.
    const text = normalizeWs(quote.text.replace(/… \((?:longhaul_)?recall message u\d+\)$/, ""));
    return text.length > 0 && holdsWords(message, text);
  };

  return { resolve, holds, recent };
}

export function buildMessageIndex(branchEntries: SessionEntry[], evidence: EvidenceRefs): MessageIndex {
  const messages = indexUserMessages(branchEntries);
  const goals = recordedGoals(branchEntries);
  const active = activeGoalId(branchEntries);
  const byOrdinal = new Map(messages.map((message) => [message.ordinal, message]));
  const byId = new Map(messages.map((message) => [message.messageId, message]));
  const { resolve, holds, recent } = quoteChecks(messages, byOrdinal, byId);

  return {
    messages,
    resolve,
    holds,
    hasEvidence: evidenceChecker(evidence, byOrdinal),
    position: (messageId) => byId.get(messageId)?.position,
    messageText: (messageId) => { const message = byId.get(messageId); return message && quotableText(message.text); },
    textOf: (ordinal) => byOrdinal.get(ordinal)?.text,
    recent,
    defaultObjective: () => defaultObjectiveOf(messages, goals, active),
    spanRefs: (span) => {
      const stamps = new Set(span.filter((message) => message.role === "user").map((message) => message.timestamp));
      const inSpan = messages.filter((message) => stamps.has(message.timestamp));
      return inSpan.length === 0 ? { fromRef: "?", toRef: "?" } : { fromRef: inSpan[0].ordinal, toRef: inSpan[inSpan.length - 1].ordinal };
    },
  };
}
