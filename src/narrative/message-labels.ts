/**
 * Message labels: how the summarizer classifies each user message of the span, in both narrative modes. A message is
 * a standing rule, a lift of one, both (a rule that replaces another), or not a rule. Code then copies the user's own
 * words into the correction, so a label can be wrong but a quote cannot be invented; only a long message, or one that
 * also asks for other things, needs the rule's exact words from the model, and those still pass the store's verify gate.
 * No word list decides what is a rule: every message is labeled, whatever words it uses.
 */
import { normalizeWs, quotableText } from "../intent.ts";
import { DEFAULT_CAPS } from "../store/events.ts";
import type { Proposal } from "../store/verify.ts";

/** `lifts` and `targets` name each rule withdrawn, once each: one message may replace a rule and its narrowing together. */
export type Label = { kind: "rule"; words?: string; lifts?: string[] } | { kind: "lift"; targets: string[] } | { kind: "none" };

/** A message longer than this labeled a rule must come with the rule's exact words: the whole of a paste is not a rule. */
export const RULE_WHOLE_CHARS = 600;

/**
 * A message this short labeled a rule is kept whole, even when the model gave the rule's words: a part can lean on
 * the rest ("don't hard-code it anywhere" names nothing without "the KV_PORT variable"), and the whole message fits
 * on a rule line uncut (the default `correctionChars`). Only a longer message is cut down to the given words.
 */
export const RULE_SHOWN_WHOLE_CHARS = DEFAULT_CAPS.correctionChars;

/** A rule to lift: its id in the state (R2), or the ordinal of the message that gave it (u7), for a rule given in this span. */
const TARGET = "(?:R\\d+|u\\d+)";
/** One target or several, joined by commas or "and": "R1", "R1, R6", "R1 and u4". */
const TARGETS = `(${TARGET}(?:\\s*(?:,|\\band\\b|,\\s*and\\b)\\s*${TARGET})*)`;
const LIFT_RE = new RegExp(`^lifts?\\s+${TARGETS}$`, "i");
const RULE_AND_LIFT_RE = new RegExp(`^rule\\s*(?:,|and|;)\\s*lifts?\\s+${TARGETS}$`, "i");
const TARGETS_RE = new RegExp(`^${TARGETS}$`, "i");
const NONE_RE = /^(not a rule|not-a-rule|none|no)$/i;

const targetOf = (raw: string): string => (raw[0] === "u" || raw[0] === "U" ? raw.toLowerCase() : raw.toUpperCase());
const targetsOf = (raw: string): string[] => [...new Set(raw.split(/\s*(?:,|\band\b)\s*/i).filter(Boolean).map(targetOf))];

/** The targets of an object's "lifts": "R1", "R1, R6" or ["R1", "R6"]; undefined when any of them is not a target. */
function objectTargets(value: unknown): string[] | undefined {
  const parts = typeof value === "string" ? [value] : Array.isArray(value) && value.length > 0 ? value : [];
  if (!parts.every((part) => typeof part === "string" && TARGETS_RE.test(part.trim()))) return undefined;
  const targets = [...new Set((parts as string[]).flatMap((part) => targetsOf(part.trim())))];
  return targets.length > 0 ? targets : undefined;
}

/** What a rule is, as both modes' prompts say it. */
export const RULE_DEFINITION = `A rule is a standing instruction that should keep holding for the rest of the session, however it is worded: a convention, a constraint, a fact about where the code must run. The test is whether it still binds once the work asked for now is done. A message that asks for work and also sets a constraint that must keep holding after that work is done is a rule too ("add an error handler; the API must never return a stack trace"). A description of what is being built (its options, defaults, limits, file names, messages, exit codes) is not a rule, though later changes must keep it working: the code and its tests keep it. Label such a requirement a rule only when the user states it as standing over later work ("every dry-run line must start with DRY:", "never ...", "always ...", "from now on ..."). Code keeps a message of at most ${RULE_SHOWN_WHOLE_CHARS} characters whole; for a longer one, give the constraint's exact words as {"u<n>": {"rule": "<exact words>"}}, words that make sense on their own.`;

/**
 * What is not a rule, as both modes' prompts say it: the classes that filled rule slots on real sessions (a request for
 * the work at hand worded firmly, a question, a report of what the user did, an idea under discussion).
 */
/** For a switchover's earlier messages: a feature asked for back then says how it must behave, which is no standing rule. */
export const EARLIER_REQUEST = 'An earlier request is the work asked for then, even when it says how the result must behave ("add an export button that saves the report as CSV", "make the import skip blank rows"): label it "not a rule"; a rule among them says what must hold for all later work too.';

export const NOT_A_RULE = '"not a rule" is everything else: a request for the work at hand, however firmly it is worded ("make sure the banner is blue", "be sure to mention the fix in the PR"); a question; an answer, an approval, or a report of what the user did or saw ("I ran the script", "it works now"); an idea or plan still under discussion ("I was thinking we could cache it"); a one-off.';

/** What a lift is, as both modes' prompts say it: a narrowed rule replaces the old one, so the part that still holds stays. */
export const LIFT_GUIDANCE = '"lifts" withdraws a standing rule. A message that only withdraws a rule is "lifts R<n>", even when it says what is fine instead ("the no-semicolons rule is lifted; either style is fine now"): what is fine is not a new rule, and how to carry out the withdrawal ("keep the existing tests passing") is not a new rule either. Use "rule and lifts R<n>" only when the message puts a new standing rule in the old one\'s place: it replaces the rule, or narrows it ("the type hint rule is lifted for test files; keep it for the package itself"), and the whole message then stands as the new rule; words that need the rest of the message to make sense ("keep it for ...") are not the rule. Use "lifts R<n>" alone only when the rule no longer holds anywhere. A new rule that cannot hold together with a rule in the state replaces it, even when it does not say so ("switch to two-space indentation" beside "use tabs"): label it "rule and lifts R<n>", and name every rule it replaces, a narrowing of it included ("rule and lifts R1, R6"). A permission for one occasion ("go ahead and push it this time") is not a lift: the rule still stands.';

export const LABEL_FORMS = '"rule", "not a rule", "lifts R<n>" (or "lifts u<n>" for a rule given in this span; several as "lifts R1, R6"), "rule and lifts R<n>", or {"rule": "<the rule\'s exact words>", "lifts": "R<n>"}';

/** One label value as the model wrote it, or what is wrong with it. */
export function labelOf(value: unknown): Label | string {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const words = typeof record.rule === "string" && record.rule.trim() ? record.rule : undefined;
    const lifts = objectTargets(record.lifts);
    if (words) return { kind: "rule", words, ...(lifts ? { lifts } : {}) };
    if (lifts) return { kind: "lift", targets: lifts };
    return `expected ${LABEL_FORMS}, got an object with neither a rule's words nor a lifts target`;
  }
  if (typeof value !== "string") return `expected ${LABEL_FORMS}, got ${JSON.stringify(value)?.slice(0, 60)}`;
  const text = value.trim();
  if (/^rule$/i.test(text)) return { kind: "rule" };
  if (NONE_RE.test(text)) return { kind: "none" };
  const both = RULE_AND_LIFT_RE.exec(text);
  if (both) return { kind: "rule", lifts: targetsOf(both[1]) };
  const lift = LIFT_RE.exec(text);
  return lift ? { kind: "lift", targets: targetsOf(lift[1]) } : `expected ${LABEL_FORMS}, got "${text.slice(0, 60)}"`;
}

/** What a model wrote under "labels", read: the labels it got right and why each other one is unreadable. */
export interface ReadLabels { labels: Map<string, Label>; invalid: Map<string, string> }

/** Entries whose ordinal `keep` refuses are skipped: a message outside the span has nothing to record. */
export function readLabels(raw: Record<string, unknown> | undefined, keep: (ordinal: string) => boolean): ReadLabels {
  const labels = new Map<string, Label>();
  const invalid = new Map<string, string>();
  for (const [ordinal, entry] of Object.entries(raw ?? {})) {
    if (!keep(ordinal)) continue;
    const label = labelOf(entry);
    if (typeof label === "string") invalid.set(ordinal, label);
    else labels.set(ordinal, label);
  }
  return { labels, invalid };
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;

/** Whether `words` stand in `text` as whole words at least once: no occurrence that starts or ends inside a word. */
function wholeWordsIn(text: string, words: string): boolean {
  const isWord = (char: string | undefined) => char !== undefined && WORD_CHAR.test(char);
  for (let at = text.indexOf(words); at !== -1; at = text.indexOf(words, at + 1)) {
    const startsClean = !isWord(words[0]) || !isWord(text[at - 1]);
    const endsClean = !isWord(words[words.length - 1]) || !isWord(text[at + words.length]);
    if (startsClean && endsClean) return true;
  }
  return false;
}

/**
 * What is wrong with a rule label, or undefined when nothing is: a message too long to be the rule as a whole
 * needs the rule's words, and words cut inside a word (copied from a cut excerpt, say) are refused. Words the
 * message does not hold at all are left to the store's quote check.
 */
export function ruleLabelProblem(ordinal: string, label: Label, text: string | undefined, shown?: number): string | undefined {
  if (label.kind !== "rule") return undefined;
  const message = normalizeWs(quotableText(text ?? ""));
  // A message the model saw only the start of (a switchover's earlier message) is not recorded whole on a bare label.
  if (!label.words && shown !== undefined && message.length > shown) return `${ordinal} was shown cut to its first ${shown} characters: give the rule's exact words from what was shown as {"${ordinal}": {"rule": "<exact words>"}}, or label it "not a rule"`;
  if (!label.words) return message.length <= RULE_WHOLE_CHARS ? undefined : `${ordinal} is ${message.length} characters: give the rule's exact words as {"${ordinal}": {"rule": "<exact words>"}}`;
  const words = normalizeWs(label.words);
  if (message.length <= RULE_SHOWN_WHOLE_CHARS || !message.includes(words) || wholeWordsIn(message, words)) return undefined;
  return `the rule's words for ${ordinal} start or end in the middle of a word ("${words.slice(-40)}"); give whole words from the message, or label it "rule" when the whole message is the rule`;
}

/**
 * The summarizer's words a rule label records instead of its message, or undefined when the whole message is the
 * rule: only for a message longer than it is recorded whole (RULE_SHOWN_WHOLE_CHARS, or what the model was shown).
 */
export function ruleWordsUsed(label: Extract<Label, { kind: "rule" }>, text: string, shown: number | undefined): string | undefined {
  return label.words && text.length > Math.min(RULE_SHOWN_WHOLE_CHARS, shown ?? Number.POSITIVE_INFINITY) ? label.words : undefined;
}

/**
 * The store proposals for labels, in message order. A rule that replaces another lifts it FIRST, so the
 * replacement is not rejected as a near-duplicate of the rule it replaces.
 */
export function labelProposals(labels: ReadonlyMap<string, Label>, ordinals: readonly string[], textOf: (ordinal: string) => string | undefined, shownOf: (ordinal: string) => number | undefined = () => undefined): Array<{ path: string; proposal: Proposal }> {
  const out: Array<{ path: string; proposal: Proposal }> = [];
  for (const ordinal of ordinals) {
    const label = labels.get(ordinal);
    if (!label || label.kind === "none") continue;
    const path = `labels.${ordinal}`;
    const text = quotableText(textOf(ordinal) ?? "").trim();
    if (label.kind === "lift") for (const target of label.targets) out.push({ path, proposal: { kind: "lift", target, ref: ordinal, text } });
    else {
      for (const target of label.lifts ?? []) out.push({ path, proposal: { kind: "lift", target, ref: ordinal, text } });
      out.push({ path, proposal: { kind: "correction", ref: ordinal, text: ruleWordsUsed(label, text, shownOf(ordinal)) ?? text } });
    }
  }
  return out;
}

export { liftNamesRule } from "../store/lift-words.ts";
