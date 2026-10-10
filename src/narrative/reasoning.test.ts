/**
 * How the diff call asks for reasoning (reasoning.ts), one fake per model class: the summary wants no reasoning,
 * and a model that cannot turn it off gets its lowest level with room left for the answer.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { LOWEST_REASONING_OUTPUT_TOKENS, planReasoning } from "./reasoning.ts";
import { modelWith } from "../test-support.ts";

const OFF_BUDGET = 3000;

for (const [name, model, expected] of [
  ["a non-reasoning model is asked for off", modelWith({ reasoning: false }), { reasoning: "off", maxTokens: OFF_BUDGET, path: "off" }],
  ["a reasoning model with no level map can be turned off", modelWith({ reasoning: true, thinkingLevelMap: undefined }), { reasoning: "off", maxTokens: OFF_BUDGET, path: "off" }],
  ["a reasoning model that maps off can be turned off", modelWith({ reasoning: true, thinkingLevelMap: { off: "none" } }), { reasoning: "off", maxTokens: OFF_BUDGET, path: "off" }],
  ["the off budget never exceeds the model's own output limit", modelWith({ reasoning: false, maxTokens: 2048 }), { reasoning: "off", maxTokens: 2048, path: "off" }],
  ["a model whose off is unsupported gets its lowest level and a larger budget", modelWith({ reasoning: true, maxTokens: 64_000, thinkingLevelMap: { off: null } }), { reasoning: "minimal", maxTokens: LOWEST_REASONING_OUTPUT_TOKENS, path: "lowest" }],
  ["the lowest level is the lowest the model supports", modelWith({ reasoning: true, maxTokens: 64_000, thinkingLevelMap: { off: null, minimal: null } }), { reasoning: "low", maxTokens: LOWEST_REASONING_OUTPUT_TOKENS, path: "lowest" }],
  ["the larger budget never exceeds the model's own output limit", modelWith({ reasoning: true, maxTokens: 6000, thinkingLevelMap: { off: null } }), { reasoning: "minimal", maxTokens: 6000, path: "lowest" }],
] as const) test(`planReasoning: ${name}`, () => {
  assert.deepEqual(planReasoning(model, OFF_BUDGET), expected);
});

test("planReasoning: a configured budget above the larger one is kept", () => {
  assert.equal(planReasoning(modelWith({ reasoning: true, maxTokens: 64_000, thinkingLevelMap: { off: null } }), 12_000).maxTokens, 12_000);
});
