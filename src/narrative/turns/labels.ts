/**
 * Section 3, the user-message labels: the model CLASSIFIES every user message of the span as a
 * standing rule, a lift of one, or not a rule, and code copies the words into the correction or
 * lift. A misquote is impossible for the default case; only a long message labelled a rule needs
 * the model's exact words, and those still pass the store's verify gate. On a switchover the
 * offered earlier messages are kept unless the answer lists them in `oneOffs`, the single call's
 * contract (prompt.ts SEED_RULES_GUIDANCE): the pass records the rest (pass.ts seedRuleEvents). A
 * forced label per earlier message made "not a rule" the cheap answer and dropped half the earlier
 * rules in a replay; opt-out keeps the default safe.
 */
import { SPAN_EXCERPT_CHARS, spanExcerpt as excerpt } from "../prepare.ts";
import { LABEL_FORMS, LIFT_GUIDANCE, labelProposals, RULE_DEFINITION, ruleLabelProblem, readLabels, RULE_WHOLE_CHARS, type Label } from "../message-labels.ts";
import type { Proposal } from "../../store/verify.ts";
import type { Complaint, Facts, Parsed, Section } from "./section.ts";

export type Labels = Map<string, Label>;
interface LabelsAnswer { labels: Labels; invalid: Map<string, string>; oneOffs: string[] }

export { RULE_WHOLE_CHARS };

/** The earlier messages are listed cut to their start (excerpt above); a span message is in the Digest whole. */
const shownOf = (facts: Facts) => (ordinal: string): number | undefined => (facts.contextOrdinals?.includes(ordinal) ? SPAN_EXCERPT_CHARS : undefined);

function instruction(facts: Facts): string {
  const span = facts.spanOrdinals.map((ordinal) => `${ordinal}: ${excerpt(facts.textOf(ordinal) ?? "")}`);
  const seed = facts.seedOrdinals.map((ordinal) => `${ordinal}: ${excerpt(facts.textOf(ordinal) ?? "")}`);
  const context = (facts.contextOrdinals ?? []).map((ordinal) => `${ordinal}: ${excerpt(facts.textOf(ordinal) ?? "")}`);
  const rules = facts.activeCorrections.map((rule) => `${rule.id} [${rule.ordinal}] ${excerpt(rule.text)}`);
  return [
    "Section 3 of 5: the user's messages. Label EVERY message listed under Messages in this span with one of:",
    `${LABEL_FORMS}. ${RULE_DEFINITION} ${LIFT_GUIDANCE} "not a rule" is a request, question, answer, approval or one-off.`,
    `Code copies the user's words. A message longer than ${RULE_WHOLE_CHARS} characters that you label a rule must come with the rule's exact words instead of "rule": {"u7": {"rule": "<the user's exact words>"}}.`,
    'Answer: {"labels": {"u3": "not a rule", "u4": "rule", "u5": "lifts R1"}}',
    `Standing rules already recorded:\n${rules.length ? rules.join("\n") : "(none)"}`,
    `Messages in this span:\n${span.length ? span.join("\n") : "(none)"}`,
    ...(seed.length ? [`Earlier messages that read like standing rules. Each one is kept as a rule automatically; do not label them. Only if one was a one-off request, an answer or a question rather than a rule still in force, list its id in a top-level "oneOffs" array, e.g. "oneOffs": ["u3"]; list none when all of them still hold:\n${seed.join("\n")}`] : []),
    ...(context.length ? [`The user's other earlier messages, each cut to its start. Label every one of these too: "rule" when it is a standing rule still in force, however it is worded ("tests go under tests/", "our servers run Node 22"), "not a rule" otherwise:\n${context.join("\n")}`] : []),
  ].join("\n\n");
}

function oneOffsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim()) : [];
}

function parse(value: Record<string, unknown>, facts: Facts): Parsed<LabelsAnswer> {
  const raw = value.labels;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, error: 'expected {"labels": {"u<n>": "<label>", ...}}' };
  const { labels, invalid } = readLabels(raw as Record<string, unknown>, (ordinal) => !facts.seedOrdinals.includes(ordinal));
  return { ok: true, answer: { labels, invalid, oneOffs: oneOffsOf(value.oneOffs) } };
}

function integrity(answer: LabelsAnswer, facts: Facts): Complaint[] {
  const listed = new Set([...(facts.contextOrdinals ?? []), ...facts.spanOrdinals]);
  const complaints: Complaint[] = [...answer.invalid].map(([ordinal, message]) => ({ check: "labels.value", message: `${ordinal}: ${message}`, excusable: false, path: `labels.${ordinal}` }));
  const missing = [...listed].filter((ordinal) => !answer.labels.has(ordinal) && !answer.invalid.has(ordinal));
  if (missing.length) complaints.push({ check: "labels.unlabelled", message: `label every listed message; missing: ${missing.join(", ")}`, excusable: false });
  for (const [ordinal, label] of answer.labels) {
    const path = `labels.${ordinal}`;
    if (!listed.has(ordinal)) complaints.push({ check: "labels.unknown", message: `${ordinal} is not one of the listed messages`, excusable: false, path });
    else {
      const long = ruleLabelProblem(ordinal, label, facts.textOf(ordinal), shownOf(facts)(ordinal));
      if (long) complaints.push({ check: "labels.rule-words", message: long, excusable: false, path });
    }
  }
  return complaints;
}

function proposals(answer: { labels: Labels }, facts: Facts): Array<{ path: string; proposal: Proposal }> {
  return labelProposals(answer.labels, [...(facts.contextOrdinals ?? []), ...facts.spanOrdinals], facts.textOf, shownOf(facts));
}

export const labelsSection: Section<LabelsAnswer> = {
  id: "labels",
  applies: (facts) => facts.spanOrdinals.length + facts.seedOrdinals.length + (facts.contextOrdinals?.length ?? 0) > 0,
  instruction,
  parse,
  integrity,
  expectations: () => [],
  proposals,
  oneOffs: (answer, facts) => facts.seedOrdinals.filter((ordinal) => answer.oneOffs.includes(ordinal)),
};
