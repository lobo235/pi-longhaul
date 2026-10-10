/**
 * The diff hand of the state store's verify gate: every diff item becomes a Proposal, the store's
 * applyProposals verifies them in order against the state as it grows, and each rejection comes
 * back as a field error with a JSON-pointer-ish path so the retry note can name it.
 */
import { describeRejection, type Rejection, type StateEvent } from "../store/events.ts";
import { activeCorrections, type SessionState } from "../store/project.ts";
import { applyProposals, type Proposal, type VerifyContext } from "../store/verify.ts";
import type { LearnedValue } from "../learned.ts";
import { normalizeWs, quotableText } from "../intent.ts";
import { labelProposals, liftNamesRule, ruleLabelProblem, ruleWordsUsed, readLabels, type Label } from "./message-labels.ts";
import { checkNamedValues, type SpanTexts } from "./named-values.ts";
import type { NarrativeDiff } from "./types.ts";

export interface FieldError {
  path: string;
  rejection: Rejection;
  /** Fixable = the model can answer differently; the error rides the retry note. */
  fixable: boolean;
}

export interface ValidatedDiff {
  events: StateEvent[];
  errors: FieldError[];
  state: SessionState;
  /** The named values that stand verbatim in the turn they cite (named-values.ts). */
  values?: LearnedValue[];
  /** Earlier messages a label lifted that are neither in the span nor a rule in the state: switchover seeds not to carry. */
  withdrawn?: string[];
  /** Plain "rule" labels whose message reads as withdrawing an earlier rule still in force: asked, never an error. */
  questions?: LabelQuestion[];
}

/** A rule label the model may have meant as a replacement: `text` is the line the retry note shows. */
export interface LabelQuestion { ordinal: string; target: string; text: string }

export const FIXABLE_CODES: ReadonlySet<Rejection["code"]> = new Set(["not-substring", "unknown-ref", "too-long", "empty", "unknown-evidence", "unknown-target", "not-user-message", "unlabelled", "bad-label", "value-not-in-turn", "lift-unnamed", "lift-replaced"]);

/**
 * The span's user messages, for the labels: `required` are those this answer must label (the ones in its
 * chunk), `known` every message of the span, `textOf` the user's whole words that a "rule" label records.
 */
export interface Labelling {
  required: readonly string[];
  known?: readonly string[];
  textOf: (ordinal: string) => string | undefined;
  /** The span's turn texts and credential tokens (named-values.ts spanTextsOf), which a named value is checked against; absent = no values kept. */
  spanTexts?: SpanTexts;
  /** How many characters of a message the model was shown, when it saw only the start (a switchover's earlier messages). */
  shownChars?: (ordinal: string) => number | undefined;
}

export function proposalsOf(diff: NarrativeDiff): Array<{ path: string; proposal: Proposal }> {
  const out: Array<{ path: string; proposal: Proposal }> = [];
  if (diff.objective) out.push({ path: "objective", proposal: { kind: "objective", ref: diff.objective.messageRef, text: diff.objective.text, doneWhen: diff.objective.doneWhen ? { ref: diff.objective.doneWhen.messageRef, text: diff.objective.doneWhen.text } : undefined } });
  diff.corrections.forEach((item, i) => out.push({ path: `corrections[${i}]`, proposal: { kind: "correction", ref: item.messageRef, text: item.text } }));
  diff.lifts.forEach((item, i) => out.push({ path: `lifts[${i}]`, proposal: { kind: "lift", target: item.target, ref: item.messageRef, text: item.text } }));
  diff.decisions.forEach((item, i) => out.push({ path: `decisions[${i}]`, proposal: { kind: "decision", text: item.text, evidence: item.evidence } }));
  diff.deadEnds.forEach((item, i) => out.push({ path: `deadEnds[${i}]`, proposal: { kind: "dead-end", text: item.text, evidence: item.evidence } }));
  out.push({ path: "now", proposal: { kind: "now", now: diff.now } });
  return out;
}

/**
 * Decisions and dead ends are the model's own records; evidence is an optional pointer into the
 * ledger. A pointer the ledger does not know is removed rather than costing the record and a retry:
 * the model never sees the ledger's ids, so a guessed "C1" is common and says nothing about the record.
 */
function withKnownEvidence(diff: NarrativeDiff, ctx: VerifyContext): NarrativeDiff {
  const known = <T extends { text: string; evidence?: string }>(item: T): T => (item.evidence === undefined || ctx.resolver.hasEvidence(item.evidence) ? item : { ...item, evidence: undefined });
  return { ...diff, decisions: diff.decisions.map(known), deadEnds: diff.deadEnds.map(known) };
}

/** The labels as proposals, placed before the diff's own corrections, and what is wrong with them. */
function labelEntries(diff: NarrativeDiff, labelling: Labelling, state: SessionState): { entries: Array<{ path: string; proposal: Proposal }>; errors: FieldError[]; withdrawn: string[]; labels: Map<string, Label> } {
  const known = labelling.known ?? labelling.required;
  const { labels, invalid } = readLabels(diff.labels, (ordinal) => known.includes(ordinal));
  const errors: FieldError[] = [];
  const withdrawn = earlierLifts(labels, known, state, labelling, errors);
  const bad = (ref: string, detail: string) => errors.push({ path: `labels.${ref}`, rejection: { code: "bad-label", ref, detail }, fixable: true });
  for (const [ordinal, detail] of invalid) bad(ordinal, detail);
  errors.push(...unknownLiftTargets(labels, state));
  for (const [ordinal, label] of labels) {
    const long = ruleLabelProblem(ordinal, label, labelling.textOf(ordinal), labelling.shownChars?.(ordinal));
    if (long) {
      bad(ordinal, long);
      labels.delete(ordinal);
    }
  }
  const missing = labelling.required.filter((ordinal) => !labels.has(ordinal) && !invalid.has(ordinal) && !errors.some((error) => error.path === `labels.${ordinal}`));
  if (missing.length) errors.push({ path: "labels", rejection: { code: "unlabelled", refs: missing }, fixable: true });
  return { entries: labelProposals(labels, known, labelling.textOf, labelling.shownChars), errors, withdrawn, labels };
}

/** Every rule a label withdraws. */
const liftTargets = (label: Label): string[] => (label.kind === "lift" ? label.targets : label.kind === "rule" ? label.lifts ?? [] : []);

/** `label` without the `dropped` targets: a rule stays a rule; a lift left with no target is "not a rule". */
function withoutTargets(label: Label, dropped: ReadonlySet<string>): Label {
  if (label.kind === "rule") {
    const lifts = (label.lifts ?? []).filter((target) => !dropped.has(target));
    return { kind: "rule", ...(label.words ? { words: label.words } : {}), ...(lifts.length ? { lifts } : {}) };
  }
  if (label.kind !== "lift") return label;
  const targets = label.targets.filter((target) => !dropped.has(target));
  return targets.length ? { kind: "lift", targets } : { kind: "none" };
}

/**
 * A lift of an R id the state never had. In a rule that replaces another, the rule is what matters: it is kept and the
 * lift dropped, with no retry; so is a lift that also names a known rule. A lift of nothing but unknown ids is asked
 * again, saying that a new rule is labeled "rule": told only that the id was unknown, a model answered by dropping the
 * rule instead.
 */
function unknownLiftTargets(labels: Map<string, Label>, state: SessionState): FieldError[] {
  const ids = new Set(state.corrections.map((item) => item.id));
  const known = activeCorrections(state).map((item) => item.id).join(", ") || "none";
  const errors: FieldError[] = [];
  for (const [ordinal, label] of labels) {
    const targets = liftTargets(label);
    const unknownIds = targets.filter((target) => /^R\d+$/.test(target) && !ids.has(target));
    if (unknownIds.length === 0) continue;
    const unknown = `${unknownIds.join(", ")} ${unknownIds.length === 1 ? "is not a rule" : "are not rules"} in the state (known: ${known})`;
    if (label.kind === "rule" || unknownIds.length < targets.length) {
      labels.set(ordinal, withoutTargets(label, new Set(unknownIds)));
      errors.push({ path: `labels.${ordinal}`, rejection: { code: "bad-label", ref: ordinal, detail: `${unknown}; ${label.kind === "rule" ? "the rule is kept, " : ""}that lift dropped.` }, fixable: false });
    } else {
      labels.delete(ordinal);
      errors.push({ path: `labels.${ordinal}`, rejection: { code: "bad-label", ref: ordinal, detail: `${unknown}. Label a message that gives a new rule "rule"; "lifts R<n>" only withdraws one of the known rules.` }, fixable: true });
    }
  }
  return errors;
}

/** Takes `target` out of `ordinal`'s label (a rule that replaces another stays a rule) and says why, showing the rule it named. */
function refuseLift(labels: Map<string, Label>, ordinal: string, target: string, rule: string): FieldError {
  labels.set(ordinal, withoutTargets(labels.get(ordinal)!, new Set([target])));
  const shown = rule.replace(/\s+/g, " ").slice(0, 100);
  return { path: `labels.${ordinal}`, rejection: { code: "bad-label", ref: ordinal, detail: `${target} is "${shown}"; ${ordinal} does not say it withdraws that rule. Lift a rule only when the message withdraws it in words that name it; otherwise label the message "not a rule" (or "rule").` }, fixable: true };
}

/**
 * A lift of u<n> where u<n> is neither a labeled message nor a rule in the state can only mean an earlier message the
 * switchover offers as a rule (pass.ts seedRuleEvents), which code records after the diff: it is taken out of the
 * labels and reported, so that rule is not carried, instead of failing as an unknown target.
 */
function earlierLifts(labels: Map<string, Label>, known: readonly string[], state: SessionState, labelling: Labelling, errors: FieldError[]): string[] {
  const inState = new Set(activeCorrections(state).map((item) => item.quote.ordinal));
  const earlier = (target: string) => /^u\d+$/.test(target) && !known.includes(target) && !inState.has(target);
  const withdrawn: string[] = [];
  for (const [ordinal, label] of labels) {
    const handled = new Set<string>();
    for (const target of liftTargets(label).filter(earlier)) {
      // The same check as a lift of a recorded rule (security.md T2): a seed rule is withdrawn only by a message that says so.
      const rule = labelling.textOf(target);
      const text = labelling.textOf(ordinal);
      // Nothing to check it against: no seed rule by that id, so there is nothing to withdraw either.
      if (rule !== undefined && text !== undefined && !liftNamesRule(text, rule)) {
        errors.push(refuseLift(labels, ordinal, target, rule));
        continue;
      }
      if (rule !== undefined && text !== undefined) withdrawn.push(target);
      handled.add(target);
    }
    if (handled.size) labels.set(ordinal, withoutTargets(labels.get(ordinal)!, handled));
  }
  return withdrawn;
}

/** `labelling` absent (a caller that predates labels): labels are neither required nor read. */
export function validateNarrativeDiff(diff: NarrativeDiff, ctx: VerifyContext, labelling?: Labelling): ValidatedDiff {
  const own = proposalsOf(withKnownEvidence(diff, ctx));
  const labelled = labelling ? labelEntries(diff, labelling, ctx.state) : { entries: [], errors: [], withdrawn: [], labels: new Map<string, Label>() };
  // After the objective, before the diff's own corrections: a rule labeled here wins over the same rule restated there.
  const entries = [...own.slice(0, diff.objective ? 1 : 0), ...labelled.entries, ...own.slice(diff.objective ? 1 : 0)];
  const applied = applyProposals(entries.map((entry) => entry.proposal), ctx);
  const errors = applied.rejected.map(({ index, rejection }) => ({ path: entries[index].path, rejection, fixable: FIXABLE_CODES.has(rejection.code) }));
  const named = labelling?.spanTexts && diff.values?.length ? checkNamedValues(diff.values, labelling.spanTexts) : { values: [], errors: [] };
  const questions = labelling ? replacementQuestions(labelled.labels, applied.state, labelling) : [];
  return { events: applied.events, errors: [...labelled.errors, ...errors, ...named.errors], state: applied.state, ...(named.values.length ? { values: named.values } : {}), ...(labelled.withdrawn.length ? { withdrawn: labelled.withdrawn } : {}), ...(questions.length ? { questions } : {}) };
}

const ordinalNumber = (ordinal: string) => Number(ordinal.slice(1));

/**
 * A new rule that cannot hold beside one in the state replaces it, but a model labeling without reasoning sometimes
 * labels it plain "rule", and both then stand ("keep tabs" beside "switch to two-space indentation"). A rule label
 * whose rule would pass the lift check against an earlier rule still in force is asked about (run.ts askReplacements),
 * so the model decides with that rule in front of it. A question changes nothing by itself, and only the user's own
 * words raise one (ownWords): the store's gate cannot tell a pasted withdrawal from the user's, so a question on one
 * would put a lift the user never asked for in front of the model as one of two answers (security.md T4). The text
 * judged is what the rule records (labelProposals): the whole message, or for a long one the rule's words, and those
 * only where they stand outside what the message quotes.
 */
function replacementQuestions(labels: ReadonlyMap<string, Label>, state: SessionState, labelling: Labelling): LabelQuestion[] {
  const questions: LabelQuestion[] = [];
  for (const [ordinal, label] of labels) {
    const message = label.kind === "rule" ? labelling.textOf(ordinal) : undefined;
    if (label.kind !== "rule" || message === undefined) continue;
    const quotable = quotableText(message).slice(0, OWN_WORDS_CHARS);
    const own = normalizeWs(ownWords(quotable));
    // What labelProposals records for this label.
    const used = ruleWordsUsed(label, quotableText(message).trim(), labelling.shownChars?.(ordinal));
    const words = used === undefined ? undefined : normalizeWs(used);
    const text = words === undefined ? own : own.includes(words) ? words : undefined;
    if (!text) continue;
    // Asked only when what the gate will judge passes too: the message's whole raw text (store/verify.ts), which
    // liftNamesRule bounds itself, so a "yes" is never one the gate refuses.
    const judged = quotableText(message);
    // A rule already lifted (a replaced rule stays listed, marked lifted) has nothing left to replace.
    for (const rule of activeCorrections(state)) {
      if (rule.liftedBy || ordinalNumber(rule.quote.ordinal) >= ordinalNumber(ordinal) || label.lifts?.some((target) => target === rule.id || target === rule.quote.ordinal)) continue;
      if (!liftNamesRule(text, rule.quote.text) || !liftNamesRule(judged, rule.quote.text)) continue;
      const shown = rule.quote.text.replace(/\s+/g, " ").slice(0, 100);
      // A rule given in this span has an R id only in this answer's state: a retry names it by its message.
      const inSpan = (labelling.known ?? labelling.required).includes(rule.quote.ordinal);
      const target = inSpan ? rule.quote.ordinal : rule.id;
      const named = inSpan ? `the rule ${target} gave` : target;
      questions.push({ ordinal, target, text: `${ordinal} is labeled "rule" and may replace ${named} ("${shown}"): answer "rule and lifts ${target}" or "rule".` });
    }
  }
  return questions;
}

/** A quoted passage this many words long or more is someone else's text; a shorter one names a thing ("the "tabs" rule"). */
const QUOTED_PASSAGE_WORDS = 6;

/** A message is masked on this many characters: a rule's words past it are not asked about (security.md T4). */
const OWN_WORDS_CHARS = 32_000;

/**
 * A message with what it quotes blanked: fenced blocks, blockquoted lines, and quoted passages in straight, curly,
 * German or guillemet marks, or inline code. A heuristic, not a boundary: a stray mark shifts the pairing. Each quoted
 * class excludes its own opening mark, so an unmatched one fails at the next and the scan stays linear.
 */
function ownWords(text: string): string {
  return text
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    .replace(/^[ \t]*>.*$/gm, " ")
    .replace(/"[^"]*"|\u201c[^\u201c\u201d]*\u201d|\u201e[^\u201e\u201c\u201d]*[\u201c\u201d]|\u00ab[^\u00ab\u00bb]*\u00bb|`[^`]*`/g, (quoted) => (quoted.trim().split(/\s+/).length >= QUOTED_PASSAGE_WORDS ? " " : quoted));
}

/** One line per fixable error, path first: the whole note is what the retry prompt shows. */
export function retryNoteOf(errors: FieldError[], maxChars: number): string {
  const note = errors.filter((error) => error.fixable).map((error) => `${error.path}: ${describeRejection(error.rejection)}`).join("\n");
  return note.length <= maxChars ? note : `${note.slice(0, Math.max(0, maxChars - 1))}…`;
}
