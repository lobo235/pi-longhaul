/**
 * How the diff call asks for reasoning. The State compactor's answer is a JSON diff that needs no chain of thought,
 * so it asks for reasoning off. A model whose level map marks off unsupported (`thinkingLevelMap.off === null`: some
 * hosted reasoning models cannot skip thinking) would reject or ignore that, and its thinking would then spend the
 * output budget the answer needed. Such a model is asked for its lowest supported level instead, with a larger
 * budget, and the trace records which path ran. Either budget is capped at the model's own output limit: a server
 * such as vLLM rejects a request whose max_tokens exceeds what it was configured for.
 */
import { getSupportedThinkingLevels, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";

/** The output budget for a model that must reason: room for its lowest level's thinking and the answer after it. */
export const LOWEST_REASONING_OUTPUT_TOKENS = 8192;

export interface ReasoningPlan {
  reasoning: ModelThinkingLevel;
  maxTokens: number;
  /** "off" = reasoning off, the configured budget; "lowest" = the model cannot turn it off. */
  path: "off" | "lowest";
}

export function planReasoning(model: Model<any>, offOutputTokens: number): ReasoningPlan {
  const levels = getSupportedThinkingLevels(model);
  if (levels.includes("off") || levels.length === 0) return { reasoning: "off", maxTokens: capped(model, offOutputTokens), path: "off" };
  return { reasoning: levels[0], maxTokens: capped(model, Math.max(offOutputTokens, LOWEST_REASONING_OUTPUT_TOKENS)), path: "lowest" };
}

/**
 * The budget for a retry after an answer ran out of output with nothing usable. A model whose config does not
 * declare its reasoning (or one that thinks at its "off" level) spends the planned budget thinking, and the same
 * budget again would fail the same way: double it, at least to the reasoning floor, within the model's limit.
 */
export function raisedBudget(model: Model<any>, planned: number): number {
  return capped(model, Math.max(2 * planned, LOWEST_REASONING_OUTPUT_TOKENS));
}

/** `wanted` output tokens, never more than the model declares it can produce. */
export function capped(model: Model<any>, wanted: number): number {
  return model.maxTokens > 0 ? Math.min(wanted, model.maxTokens) : wanted;
}
