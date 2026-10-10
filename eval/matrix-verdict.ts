/**
 * The verdict on one model-matrix cell (eval/matrix.ts), from what pi answered to the compact command, the
 * records Longhaul logged during the cell, and the session's answer to the recall question after it.
 *
 * A cell passes when the compaction went through Longhaul: a `compaction` record, its diff accepted, no
 * `fallback`, and no turn before it ended in a provider error. What it carried is reported beside the verdict, not judged, because one short session is one
 * sample: whether the state holds the rule the user gave verbatim (`carriedRule`), and whether the session's
 * answer after the compaction still names the value it read and the rule (`recalledValue`, `recalledRule`).
 */
export interface MatrixRecord {
  event?: string;
  reason?: string;
  durationMs?: number;
  narrative?: { kind?: string; model?: string; calls?: number; reasoning?: string; usage?: { input?: number; output?: number; reasoning?: number } };
}

export interface MatrixInput {
  compact: { success?: boolean; error?: string };
  /** The summary pi got back from the compaction: the rendered state. */
  summary: string;
  records: readonly MatrixRecord[];
  recall: string;
  expect: { value: string; rule: RegExp; ruleQuote: string };
  /** The cell's model, `provider/id`: a compaction record naming another model is not this cell's. */
  model?: string;
  /** The provider error of every turn before the compaction that ended in one (an exhausted quota, a model the login cannot use). */
  turnErrors?: readonly string[];
}

export interface MatrixCell {
  verdict: "pass" | "fail";
  failure?: string;
  /** The reasoning level the diff call asked for: `off`, or the model's lowest level. */
  reasoning?: string;
  calls?: number;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  passMs?: number;
  carriedRule?: boolean;
  recalledValue?: boolean;
  recalledRule?: boolean;
}

function failed(failure: string): MatrixCell {
  return { verdict: "fail", failure };
}

function mechanicsFailure(input: MatrixInput, compaction: MatrixRecord | undefined): string | undefined {
  const turnErrors = input.turnErrors ?? [];
  if (turnErrors.length > 0) return `${turnErrors.length} of the session's turns failed at the provider before the compaction: ${turnErrors[0]}`;
  if (input.compact.success !== true) return `pi did not compact: ${input.compact.error ?? "no error given"}`;
  const fallback = input.records.find((record) => record.event === "fallback");
  if (fallback) return `Longhaul fell back to pi's own compaction: ${fallback.reason ?? "no reason given"}`;
  if (!compaction) return `no compaction record in the log (events: ${input.records.map((record) => record.event).join(", ") || "none"})`;
  if (compaction.narrative?.kind !== "diff") return `the diff was not accepted (narrative kind ${compaction.narrative?.kind ?? "missing"})`;
  return undefined;
}

export function matrixVerdict(input: MatrixInput): MatrixCell {
  const mine = (record: MatrixRecord) => input.model === undefined || record.narrative?.model === undefined || record.narrative.model === input.model;
  const compaction = [...input.records].reverse().find((record) => record.event === "compaction" && mine(record));
  const failure = mechanicsFailure(input, compaction);
  if (failure) return failed(failure);
  const narrative = compaction!.narrative!;
  return {
    verdict: "pass", reasoning: narrative.reasoning ?? "off", calls: narrative.calls, inputTokens: narrative.usage?.input,
    outputTokens: narrative.usage?.output, reasoningTokens: narrative.usage?.reasoning, passMs: compaction!.durationMs,
    carriedRule: input.summary.includes(input.expect.ruleQuote), recalledValue: input.recall.includes(input.expect.value),
    recalledRule: input.expect.rule.test(input.recall),
  };
}
