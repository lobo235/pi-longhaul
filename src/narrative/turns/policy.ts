/**
 * The turns mode's policy as data (longhaul.json `narrativeTurns`): repair turns per section, the
 * per-turn and per-pass time budgets, the show() cap, the per-turn output budget, and the expectation
 * checks config switched off. Config can only switch a check OFF, and only an expectation check: an
 * integrity check is never configurable, and no check can be added outside code. Reasoning is per
 * section and off unless config names a section: only `off` and `low` exist here, because medium is
 * where a measured model's decoding loop began.
 */
import { bounded } from "../policy.ts";
import type { SectionId } from "./section.ts";

export type SectionReasoning = "off" | "low";
const SECTION_IDS: readonly SectionId[] = ["narrative", "objective", "labels", "records", "now"];
export interface TurnsPolicy {
  repairTurns: number;
  turnMs: number;
  /** The turn that carries the Digest: the whole span is prefilled before the first token, so it gets longer. */
  digestTurnMs: number;
  passMs: number;
  showCap: number;
  outputTokens: number;
  disabledChecks: string[];
  reasoning: Partial<Record<SectionId, SectionReasoning>>;
  /** The output budget of a reasoning section's requests: thinking spends it before the answer does. */
  reasoningOutputTokens: number;
}

/** Every expectation check, by id. A new one is added here and in sections.ts together. */
export const EXPECTATION_CHECKS: readonly string[] = ["narrative.names-modified-file", "records.unfixed-failure", "now.open-errors", "now.resume"];

/**
 * 5 minutes a pass sits above a single-call compaction's measured p90 (4.4 min) and 2 a turn, the digest turn
 * included until a replay run alone on the server says otherwise (the first smoke shared it with another
 * replay: its 2-minute deadlines were queueing, not the ~20k-token digest's prefill).
 */
export const DEFAULT_TURNS_POLICY: TurnsPolicy = { repairTurns: 2, turnMs: 120_000, digestTurnMs: 120_000, passMs: 300_000, showCap: 3, outputTokens: 1500, disabledChecks: [], reasoning: {}, reasoningOutputTokens: 4096 };

const BOUNDS = { repairTurns: [0, 3], turnMs: [10_000, 600_000], digestTurnMs: [10_000, 900_000], passMs: [30_000, 1_800_000], showCap: [0, 8], outputTokens: [300, 8000], reasoningOutputTokens: [1000, 16_000] } as const;

function reasoningOf(value: unknown): Partial<Record<SectionId, SectionReasoning>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([id, level]) => SECTION_IDS.includes(id as SectionId) && (level === "off" || level === "low")));
}

export function resolveTurnsPolicy(configValue: unknown): TurnsPolicy {
  const raw = typeof configValue === "object" && configValue !== null ? (configValue as Record<string, unknown>) : {};
  const disabled = Array.isArray(raw.disabledChecks) ? raw.disabledChecks.filter((check): check is string => typeof check === "string" && EXPECTATION_CHECKS.includes(check)) : [];
  return {
    repairTurns: bounded(raw.repairTurns, DEFAULT_TURNS_POLICY.repairTurns, BOUNDS.repairTurns),
    turnMs: bounded(raw.turnMs, DEFAULT_TURNS_POLICY.turnMs, BOUNDS.turnMs),
    digestTurnMs: bounded(raw.digestTurnMs, DEFAULT_TURNS_POLICY.digestTurnMs, BOUNDS.digestTurnMs),
    passMs: bounded(raw.passMs, DEFAULT_TURNS_POLICY.passMs, BOUNDS.passMs),
    showCap: bounded(raw.showCap, DEFAULT_TURNS_POLICY.showCap, BOUNDS.showCap),
    outputTokens: bounded(raw.outputTokens, DEFAULT_TURNS_POLICY.outputTokens, BOUNDS.outputTokens),
    disabledChecks: [...new Set(disabled)],
    reasoning: reasoningOf(raw.reasoning),
    reasoningOutputTokens: bounded(raw.reasoningOutputTokens, DEFAULT_TURNS_POLICY.reasoningOutputTokens, BOUNDS.reasoningOutputTokens),
  };
}
