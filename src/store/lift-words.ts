import { findNearDuplicate } from "./near-duplicate.ts";
import {
  RULE_NOUN, NAMED_RULE, WITHDRAWAL_CUE, INSTEAD_OF, NEGATED, INTENSIFIER, CONDITIONAL, RETRACTION,
  RETRACTS_WITHDRAWAL, PART_CONDITION, SENTENCE_CONDITION, INTERJECTION, REAFFIRMS, STILL_SO, KEEPS_RULE,
  KEEPS_DOING, KEEPS_AWAY, SETS_APART, NEEDLESS_ACT, NEEDLESS, NOT_ALLOWED, REQUIRED, NEGATIVE_COMMAND,
  POSITIVE_COMMAND, NOT_WITHOUT, SKIPS, NAMES_A_RULE, SENTENCE_BREAK, PART_BREAK, DISCOURSE_MARKER, REQUEST,
  REPROACH, PROHIBITION, OPENS_WITH_PROHIBITION, REQUIREMENT,
} from "./lift-vocabulary.ts";

/**
 * The words a lift must carry (security.md T2): a lift retires a standing rule, the strongest content in the state, so
 * the store applies one only when the lifting words say they withdraw something and name something of that rule.
 * Every lift passes here, whoever proposes it: a label in either narrative mode, a summarizer `lifts` entry or the
 * agent's longhaul_remember, and always on the whole user message, never on the part a proposer quoted.
 *
 * It is a check against a wrong proposal, not proof of intent: words cannot settle what a user meant. It fails closed
 * by construction: every part of the message that mentions the rule must itself withdraw it, so a withdrawal of one
 * thing beside "never force-push", "keep the force-push rule" or the rule quoted again lifts nothing.
 */

/** Words that say nothing about which rule a message means: function words, words of withdrawal, and the names for a rule. */
const FILLER = new Set(["the", "and", "for", "from", "now", "rule", "rules", "lifted", "lift", "lifts", "lifting", "this", "that", "these", "those", "with", "any", "all", "not", "are", "you", "your", "one", "use", "must", "never", "always", "dont", "don", "only", "every", "each", "can", "will", "should", "longer", "apply", "applies", "anymore", "more", "also", "but", "fine", "keep", "okay", "about", "what", "said", "was", "were", "has", "have", "its", "into", "out", "per", "forget", "forgotten", "ignore", "ignored", "disregard", "disregarded", "scrap", "scrapped", "cancel", "canceled", "cancelled", "withdraw", "withdrawn", "revoke", "revoked", "rescind", "rescinded", "mind", "earlier", "previous", "before", "told", "after", "instruction", "instructions", "ban", "bans", "restriction", "restrictions", "policy", "prohibition", "constraint", "requirement", "itself", "could", "would", "able", "please", "just"]);
/**
 * A word's stems, each five letters at most: the word with its ending off (push, pushes, pushed, pushing; make,
 * makes), and, where "-ing", "-ed" or "-es" came off, also with an "e" put back, since the ending may have taken one
 * (merging, merge; forced, force; caches, cache). Two words match when any stem of one is a stem of the other, so
 * "past" is still not "paste", whose own stem keeps its "e".
 */
export const ENDING = /(?:(?<=sh|ch|x|ss|z)es|ing|ed|s)$/;
export function stemsOf(word: string): readonly string[] {
  const ending = ENDING.exec(word);
  if (ending === null || ending.index < 3) return [word.slice(0, 5)];
  const base = word.slice(0, ending.index);
  return ending[0] === "s" ? [base.slice(0, 5)] : [base.slice(0, 5), `${base}e`.slice(0, 5)];
}
export const wordsOf = (text: string) => (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((word) => word.length >= 3 && !FILLER.has(word));
/** The content words of a text, each by its first stem, with all of its stems. */
type Stems = Map<string, readonly string[]>;
const stems = (text: string): Stems => new Map(wordsOf(text).map((word) => { const forms = stemsOf(word); return [forms[0], forms]; }));

/** A message is judged on this many characters: a withdrawal is short, and a long paste must not stall a compaction. */
export const JUDGED_CHARS = 8000;

/** A rule: its words (`size` of them, every stem of each in `forms`), the stems of its first word, which way it points. */
interface Rule { text: string; size: number; forms: Set<string>; head: readonly string[]; forbids: boolean; requires: boolean }
interface Cue { start: number; end: number; negated: boolean }
export interface Part { text: string; start: number; stems: Stems; cues: Cue[]; withdraws: boolean; takesBack: boolean }
interface Sentence { text: string; inert: boolean; parts: Part[] }

function ruleOf(ruleText: string): Rule {
  const words = stems(ruleText);
  const first = wordsOf(ruleText)[0];
  return {
    text: ruleText, size: words.size, forms: new Set([...words.values()].flat()), head: first === undefined ? [] : stemsOf(first),
    forbids: PROHIBITION.test(ruleText), requires: REQUIREMENT.test(ruleText) || !OPENS_WITH_PROHIBITION.test(ruleText),
  };
}

/** How many words of a text are words of the rule, and whether one is the rule's first word. */
const shared = (words: Stems, rule: Rule) => [...words.values()].filter((forms) => forms.some((form) => rule.forms.has(form))).length;
const hasHead = (words: Stems, rule: Rule) => [...words.values()].some((forms) => forms.some((form) => rule.head.includes(form)));
const lastWords = (text: string, count: number) => text.trim().split(/\s+/).slice(-count).join(" ");
const firstWords = (text: string, count: number) => text.trim().split(/\s+/).slice(0, count).join(" ");

/**
 * The withdrawal words of a part, each with whether a negation, condition or retraction in the sentence before it
 * takes it back. They are looked for in the part alone, so "is banned, linting is no longer required" cannot read as
 * "banned ... no longer": the part that says "banned" keeps it.
 */
function cuesIn(sentence: string, start: number, end: number): Cue[] {
  return [...sentence.slice(start, end).matchAll(WITHDRAWAL_CUE)].map((match) => {
    const at = start + match.index;
    const before = sentence.slice(Math.max(0, at - 80), at).replace(INTENSIFIER, " ");
    return { start: at, end: at + match[0].length, negated: NEGATED.test(before) || CONDITIONAL.test(before) || RETRACTION.test(before) };
  });
}

export function sentencesOf(text: string): Sentence[] {
  const out: Sentence[] = [];
  let start = 0;
  const push = (end: number, question: boolean) => {
    const body = text.slice(start, end);
    if (body.trim() !== "") out.push(sentenceOf(body, question));
  };
  for (const match of text.matchAll(SENTENCE_BREAK)) {
    push(match.index, match[0].includes("?"));
    start = match.index + match[0].length;
  }
  push(text.length, false);
  return out;
}

/** A tag after a comma ("lift it, okay?") asks for no answer, unless what it ends asks one ("is it lifted, thanks?"); "right?" stays a question. */
const TAG = /,\s*(?:ok(?:ay)?|alright|all right|please|thanks|thank you|got it|understood)\W*$/i;

const ASKS_STATUS = /(?:^|[,:;(–—])\W*(?:am|is|are|was|were|has|have|had|does|do|did|will|should|who|what|when|where|why|how|which|since\s+when|(?:can|could|may)(?!\s+(?:you|we)\b))\s/i;

function isInert(body: string, question: boolean): boolean {
  if (!question) return false;
  const asked = body.replace(DISCOURSE_MARKER, "");
  if (TAG.test(body) && !ASKS_STATUS.test(asked.replace(TAG, ""))) return false;
  return !REQUEST.test(asked) || /\b(?:if|whether)\b/i.test(asked);
}

function sentenceOf(body: string, question: boolean): Sentence {
  const parts: Part[] = [];
  const sentenceCondition = body.search(SENTENCE_CONDITION);
  let start = 0;
  const push = (end: number, next: number) => {
    const text = body.slice(start, end);
    const partCondition = text.search(PART_CONDITION);
    const inPart = cuesIn(body, start, end).map((cue) => {
      const conditioned = (partCondition !== -1 && start + partCondition < cue.start) || (sentenceCondition !== -1 && sentenceCondition < cue.start);
      return conditioned ? { ...cue, negated: true } : cue;
    });
    const retracts = RETRACTS_WITHDRAWAL.test(text);
    parts.push({ text, start, stems: stems(text), cues: inPart, withdraws: !retracts && inPart.some((cue) => !cue.negated), takesBack: retracts || inPart.some((cue) => cue.negated) });
    start = next;
  };
  for (const match of body.matchAll(PART_BREAK)) push(match.index, match.index + match[0].length);
  push(body.length, body.length + 1);
  return { text: body, inert: isInert(body, question), parts };
}

/** The words that name a rule before its noun: after the last part break and the last article ("the review" -> "review"). */
const nameBefore = (text: string) => (text.split(/[,;:()]|\b(?:and|but|though|although|yet|then|while|since)\b/i).at(-1) ?? "").split(/\b(?:the|this|that|our|my|your|an?|its|actual|real|original|same|current|old|existing|whole|important|hard|standing|golden|strict)\b/i).at(-1) ?? "";

/**
 * What words of holding are said of: the rule named in the six words before them, by the words between its article
 * and its noun ("the review rule is different, it still applies"); with no rule named there, or a bare "the rule",
 * nothing, which is this one.
 */
function heldSubject(sentence: string, match: RegExpMatchArray & { index: number }): string {
  if (/^keep/i.test(match[0])) return firstWords(sentence.slice(match.index + match[0].length), 6);
  const window = lastWords(sentence.slice(0, match.index), 6);
  if (new RegExp(String.raw`^${RULE_NOUN}\b`, "i").test(match[0])) return nameBefore(window);
  const noun = [...window.matchAll(new RegExp(String.raw`\b${RULE_NOUN}\b`, "gi"))].at(-1);
  return noun === undefined ? "" : nameBefore(window.slice(0, noun.index));
}

/**
 * Whether a sentence says this rule, or a rule it does not name, still holds, at any of its words of holding. Words
 * of the rule in the same part come first: "drop the review rule, force-pushing still counts as a violation" holds
 * the force-push rule, not the review rule named before the comma.
 */
const MATCHES_JUDGED = 16;

function reaffirms(sentence: Sentence, rule: Rule): boolean {
  const partBefore = (match: RegExpExecArray) => {
    const part = [...sentence.parts].reverse().find((candidate) => candidate.start <= match.index);
    return part === undefined ? "" : part.text.slice(0, match.index - part.start);
  };
  const inPart = (match: RegExpExecArray) => !/^keep/i.test(match[0]) && shared(stems(partBefore(match)), rule) > 0;
  const strong = [...sentence.text.matchAll(new RegExp(REAFFIRMS.source, "gi"))].slice(0, MATCHES_JUDGED).some((match) => {
    if (inPart(match)) return true;
    const subject = stems(heldSubject(sentence.text, match));
    return subject.size === 0 || shared(subject, rule) > 0;
  });
  // A subject that is only a pronoun or an aside ("the force-push rule, as before, remains valid", "that one is
  // unchanged") is the one in the parts before it.
  const subjectBefore = (match: RegExpExecArray) => {
    const parts = sentence.parts.filter((candidate) => candidate.start <= match.index);
    const text = partBefore(match);
    if (stems(text).size > 0) return text;
    let i = parts.length - 2;
    while (i >= 0 && parts[i].stems.size === 0) i--;
    return sentence.text.slice(i >= 0 ? parts[i].start : 0, match.index);
  };
  // Each match re-reads the words before it; a sentence of nothing but "is unchanged" is not judged past the first few.
  return strong || [...sentence.text.matchAll(STILL_SO)].slice(0, MATCHES_JUDGED).some((match) => {
    if (inPart(match) || shared(stems(subjectBefore(match)), rule) > 0) return true;
    const window = lastWords(subjectBefore(match), 6);
    const noun = [...window.matchAll(new RegExp(String.raw`\b${RULE_NOUN}\b`, "gi"))].at(-1);
    if (noun === undefined) return false;
    // "The rule about reviews is unchanged" is named by what follows "about".
    const about = /^\s+(?:about|against|regarding)\s+(.+)$/i.exec(window.slice(noun.index + noun[0].length));
    const subject = stems(about === null ? nameBefore(window.slice(0, noun.index)) : about[1]);
    return subject.size === 0 || shared(subject, rule) > 0;
  });
}

const QUOTED = /(?<![\w])(['"\u201c\u2018])[^'"\u201c\u201d\u2018\u2019\n]{1,200}['"\u201d\u2019](?![\w])/g;

/** The part as insisting words are looked for in it: its withdrawal words blanked, and a rule it quotes to withdraw it. */
function insistingText(part: Part): string {
  let text = part.text;
  for (const cue of part.cues) text = text.slice(0, cue.start - part.start) + " ".repeat(cue.end - cue.start) + text.slice(cue.end - part.start);
  return part.withdraws ? text.replace(QUOTED, (quote) => " ".repeat(quote.length)) : text;
}

/**
 * How a part points the rule's way, if it does: keeping a rule (with the words between "keep" and its noun, the rule's
 * name), setting one apart, going on doing what it requires, or a command, "not allowed" or "required".
 */
interface Insisting { how: "keeps" | "commands"; name?: string }
function insists(part: Part, rule: Rule): Insisting | undefined {
  const text = insistingText(part);
  // What comes before an insisting word is read in the part as written: the blanked words are what can excuse it.
  const before = (index: number, length: number) => part.text.slice(Math.max(0, index - length), index);
  const keep = KEEPS_RULE.exec(text);
  if (keep !== null && !NEEDLESS.test(before(keep.index, 30))) {
    // "Keep the rule about rebasing" names it by what follows "about".
    const span = keep[1] ?? keep[3];
    const about = keep[2] ?? keep[4] ?? "";
    // "for" and "on" also say how long or how ("keep the rule for now", "for the moment", "on principle"): their words name a rule only if they are this one's.
    const aboutNames = /\b(?:about|against|regarding)\s+$/i.test(keep[0].slice(0, keep[0].length - about.length)) || shared(stems(about), rule) > 0;
    return { how: "keeps", name: span === undefined ? undefined : `${nameBefore(span)} ${aboutNames ? about : ""}` };
  }
  if (SETS_APART.test(text) || KEEPS_AWAY.test(text) || (!rule.forbids && KEEPS_DOING.test(text))) return { how: "keeps" };
  const commands = commandsIn(text, rule);
  const commanding = commands.some((match) => !((insideWithdrawal(part, match.index) || (part.withdraws && text[match.index + match[0].length] === "-")) && NAMES_A_RULE.test(part.text.slice(match.index + match[0].length, match.index + match[0].length + 80))) && !NEEDLESS.test(before(match.index, 30)));
  const held = [...text.matchAll(NOT_ALLOWED), ...(rule.requires ? text.matchAll(REQUIRED) : [])];
  const forbidden = held.some((match) => !/(?:\bno longer|\bnot|n't)\s+(?:be\s+)?$/i.test(before(match.index, 20)));
  const needless = rule.forbids ? NEEDLESS_ACT.exec(part.text) : null;
  const act = needless === null ? undefined : stems(firstWords(part.text.slice(needless.index + needless[0].length), 4));
  const needlessAct = act !== undefined && (shared(act, rule) >= Math.min(2, rule.size) || hasHead(act, rule));
  return commanding || forbidden || needlessAct ? { how: "commands" } : undefined;
}

/** The command words of a text that point the rule's way. */
function commandsIn(text: string, rule: Rule): RegExpExecArray[] {
  return [...(rule.forbids ? text.matchAll(NEGATIVE_COMMAND) : []), ...(rule.requires ? [...text.matchAll(POSITIVE_COMMAND), ...text.matchAll(NOT_WITHOUT)] : [])];
}

/** Words that may follow a command and still leave it nothing to point at in its part ("don't you dare, ever,"). */
const EMPHASIS = /\b(?:really|seriously|absolutely|please|ever|you|dare|repeat)\b/gi;

/** A part that is only a discourse marker ("Well, no - ...", "Ok, no, ..."): a "no" after it is still an answer. */
/** Of a rule that requires something, a part that opens with an act done without it ("ever commit without make check"). */
const OPENS_WITHOUT = /^\W*(?:[\w'-]{1,40}\s+){0,3}?without\b/i;
const MARKER_ONLY = /^\W*(?:(?:well|ok(?:ay)?|hmm+|so|oh|ah|um+|uh+|right|alright|yes|yeah)\W*)?$/i;

/** A refusal standing alone in a part after the first ("but no - force-pushing", "but absolutely not: ..."). */
const BARE_NO = /^\W*(?:no(?:\s+way)?|nope|absolutely\s+not|hell\s+no|not\s+a\s+chance)\W*$/i;

/** Whether a part ends in a negative command word with nothing after it but emphasis, whichever way the rule points. */
function trailingNegation(part: Part): boolean {
  const text = insistingText(part);
  const last = [...text.matchAll(NEGATIVE_COMMAND)].at(-1);
  return last !== undefined && stems(text.slice(last.index + last[0].length).replace(INTENSIFIER, " ").replace(EMPHASIS, " ")).size === 0;
}

/**
 * Whether a part ends in a command with nothing after it but emphasis ("you shouldn't (ever)", "seriously don't -",
 * "avoid (at all costs)"): its words are in a later part of the sentence.
 */
function trailingCommand(part: Part, rule: Rule): boolean {
  const text = insistingText(part);
  const last = commandsIn(text, rule).sort((a, b) => a.index - b.index).at(-1);
  return last !== undefined && stems(text.slice(last.index + last[0].length).replace(INTENSIFIER, " ").replace(EMPHASIS, " ")).size === 0;
}

/**
 * Whether a part mentions the rule so that it must be withdrawing it, whatever else it withdraws: keeping or setting
 * apart a rule named by one of its words ("keep the push rule"), or by none beside a message that names it ("keep
 * the rule intact", "leave the existing rule alone"); a command, "not allowed" or "required" with the rule's first
 * word or two of its words, or a command in an earlier part of its sentence with no words of its own ("don't (ever)
 * force-push"); or, in a part that withdraws nothing, most of a rule of four or more words quoted again.
 */
function mentions(part: Part, rule: Rule, messageNamesRule: boolean, own: Insisting | undefined, commanded: boolean): boolean {
  const insisting = own ?? (commanded ? { how: "commands" } : undefined);
  const sharedHere = shared(part.stems, rule);
  if (insisting?.how === "keeps") {
    const name = insisting.name === undefined ? undefined : stems(insisting.name);
    if (name !== undefined && (name.size === 0 ? messageNamesRule : shared(name, rule) > 0)) return true;
    if (part.stems.size === 0 ? messageNamesRule : sharedHere > 0) return true;
  }
  if (part.stems.size === 0) return false;
  if (insisting?.how === "commands" && (sharedHere >= Math.min(2, rule.size) || hasHead(part.stems, rule))) return true;
  return !part.withdraws && !insteadOf(part, rule) && rule.size >= 4 && sharedHere / rule.size >= 0.8;
}

/**
 * Whether a user message withdraws the rule given in `ruleText`. Every part that mentions the rule must withdraw it:
 * a part that insists on it (a command pointing its way followed by its words, "is forbidden", "keep", "except",
 * "other than") or quotes most of it, without a withdrawal word of its own, refuses the lift; so does a sentence
 * saying it still holds, and a withdrawal of it taken back ("don't forget it", "you tried to ignore it", "never mind
 * what I said about lifting it"). Otherwise one part must withdraw something (a withdrawal word nothing takes back, or
 * "instead of" the rule's own words) and name the rule by a shared word, or name nothing and stand beside words that
 * name it ("The force-push rule? Forget it."). A question that is not a request withdraws nothing. A replay once lifted
 * "never delete outside the destination" for "the DRY: prefix rule is lifted", because the DRY rule was never recorded.
 * A refused lift leaves the rule in force, which the user can see and say again.
 */
export function liftNamesRule(message: string, ruleText: string): boolean {
  const text = message.slice(0, JUDGED_CHARS).replace(/[ \t]+/g, " ").replace(INTERJECTION, (phrase) => " ".repeat(phrase.length));
  const rule = ruleOf(ruleText);
  const sentences = sentencesOf(text);
  if (findNearDuplicate(withoutWithdrawnNames(sentences), [{ id: "rule", text: ruleText }], 0.8)) return false;
  const messageNamesRule = sentences.some((sentence) => sentence.parts.some((part) => shared(part.stems, rule) > 0));
  if (sentences.some((sentence) => refuses(sentence, rule, messageNamesRule))) return false;
  const names = sentences.map((sentence) => namesRule(sentence, rule));
  return sentences.some((sentence, i) => !sentence.inert && sentence.parts.some((part) => withdrawsRule(part, rule, names[i], names[i - 1] === true || names[i + 1] === true)));
}

/**
 * Whether a sentence names the rule well enough for a withdrawal in it to be this rule's: a rule called by one of its
 * words in the four before "rule" or after "rule about" ("the push rule", "the DRY: prefix rule", "the rule about
 * pasting the summary"), the rule's first word, or two of its words. One word in common ("ignore the warnings from
 * past runs" for a rule to paste a summary) is not enough.
 */
function namesRule(sentence: Sentence, rule: Rule): boolean {
  const all: Stems = new Map(sentence.parts.flatMap((part) => [...part.stems]));
  if (shared(all, rule) >= Math.min(2, rule.size) || hasHead(all, rule)) return true;
  const nouns = [...sentence.text.matchAll(new RegExp(String.raw`\b${RULE_NOUN}(?:\s+(?:about|on|for|against|regarding)\s+((?:[\w'-]{1,40}\s*){1,4}))?`, "gi"))];
  return nouns.some((noun) => shared(stems(`${lastWords(sentence.text.slice(Math.max(0, noun.index - 200), noun.index), 4)} ${noun[1] ?? ""}`), rule) > 0);
}

/** Whether a sentence says the rule again: still holds, a withdrawal of it taken back, or a part that insists on it without withdrawing it. */
function refuses(sentence: Sentence, rule: Rule, messageNamesRule: boolean): boolean {
  if (reaffirms(sentence, rule)) return true;
  let commanded = false;
  let negated = false;
  let answered = false;
  let markersOnly = true;
  return sentence.parts.some((part, index) => {
    if (part.takesBack && (shared(part.stems, rule) > 0 || (stems(insistingText(part)).size === 0 && messageNamesRule))) return true;
    const own = insists(part, rule);
    if (mentions(part, rule, messageNamesRule, own, commanded || (answered && !part.withdraws) || (negated && rule.requires && (SKIPS.test(insistingText(part)) || OPENS_WITHOUT.test(insistingText(part)))))) return true;
    // A command with nothing after it in its part ("don't (ever) force-push", "but no - force-pushing") points at
    // the words after it in the sentence. A "no" alone in the first part is an answer ("No, the rule is lifted").
    if (own?.how === "commands" && trailingCommand(part, rule)) commanded = true;
    if (index > 0 && BARE_NO.test(part.text)) { if (markersOnly) answered = true; else commanded = true; }
    if (trailingNegation(part)) negated = true;
    markersOnly &&= MARKER_ONLY.test(part.text);
    return false;
  });
}

function insteadOf(part: Part, rule: Rule): boolean {
  const instead = INSTEAD_OF.exec(part.text);
  return instead !== null && !rule.forbids && !REPROACH.test(part.text) && shared(stems(instead[1]), rule) > 0;
}

/**
 * Whether a part withdraws this rule: a withdrawal word, and a word of the rule in its sentence ("the force-push rule
 * and the review rule no longer apply"), or no word of its own beside a sentence that names it ("The force-push
 * rule? Forget it."). Parts that insist on the rule have already refused the lift.
 */
function withdrawsRule(part: Part, rule: Rule, sentenceNamesRule: boolean, neighbourNamesRule: boolean): boolean {
  if (insteadOf(part, rule)) return true;
  if (!part.withdraws) return false;
  return sentenceNamesRule || (part.stems.size === 0 && neighbourNamesRule);
}

/** The message as the near-duplicate check reads it: a rule quoted or named in the part that withdraws it is not the rule said again. */
function withoutWithdrawnNames(sentences: readonly Sentence[]): string {
  return sentences.map((sentence) => sentence.parts.map((part) => (part.withdraws ? part.text.replace(QUOTED, " ").replace(NAMED_RULE, " ") : part.text)).join(" ")).join(" ");
}

/** Whether a command word sits in the object of a withdrawal in its part ("lift the never-force-push rule"). */
function insideWithdrawal(part: Part, index: number): boolean {
  const at = part.start + index;
  return part.cues.some((cue) => !cue.negated && cue.end <= at && /^\W*(?:about\W+)?(?:(?:the|this|that|your|my|our|an?|whole)\W+)?["'\u201c\u2018]?$/i.test(part.text.slice(cue.end - part.start, index)));
}
