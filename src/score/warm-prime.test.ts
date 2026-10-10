import test from "node:test";
import assert from "node:assert/strict";

import { callNarrativeModel, type ModelCall } from "../narrative/call.ts";
import { DEFAULT_NARRATIVE_POLICY } from "../narrative/policy.ts";
import type { WarmBase } from "../narrative/warm.ts";
import { primeWarmBase } from "./warm-prime.ts";

const model = { provider: "p", id: "m", api: "openai-completions", contextWindow: 200_000, maxTokens: 8000 } as never;
const answer = (text: string, usage?: Record<string, number>) => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", api: "openai-completions", provider: "p", model: "m", timestamp: 1, ...(usage ? { usage } : {}) });

const base: WarmBase = {
  systemPrompt: "You are a coding agent.",
  messages: [{ role: "user", content: "fix the parser", timestamp: 1 }, { role: "assistant", content: [{ type: "text", text: "Done." }], timestamp: 2 }] as never,
  tools: [{ name: "bash", description: "run", parameters: {} }] as never,
};

test("primeWarmBase sends exactly the prefix the warm narrative call extends, asking for almost no output", async () => {
  const seen: Array<{ context: any; options: any }> = [];
  const call: ModelCall = { complete: (async (_model: unknown, context: unknown, options: unknown) => { seen.push({ context, options }); return answer("{}"); }) as unknown as ModelCall["complete"] };
  const primed = await primeWarmBase(call, model, base, { timeoutMs: 5000 });
  assert.equal(primed.error, undefined);
  await callNarrativeModel({ model, prompt: "P", warm: base, chunk: 1, attempt: 1, policy: DEFAULT_NARRATIVE_POLICY, sleep: async () => {} }, call);
  const [prime, warm] = seen;
  assert.equal(prime.context.systemPrompt, warm.context.systemPrompt);
  assert.deepEqual(prime.context.tools, warm.context.tools);
  assert.deepEqual(prime.context.messages, warm.context.messages.slice(0, -1), "the warm call is the prime plus one instruction");
  assert.ok(prime.options.maxTokens <= 16 && prime.options.reasoning === "off" && prime.options.cacheRetention === undefined);
  assert.equal(prime.options.timeoutMs, 5000, "a hung provider cannot stall the scorer (security.md T4)");
});

test("primeWarmBase reports a provider error instead of throwing", async () => {
  const call: ModelCall = { complete: (async () => ({ ...answer(""), stopReason: "error", errorMessage: "context length exceeded" })) as unknown as ModelCall["complete"] };
  assert.match((await primeWarmBase(call, model, base)).error ?? "", /context length/);
  const throwing: ModelCall = { complete: (async () => { throw new Error("socket hang up"); }) as unknown as ModelCall["complete"] };
  assert.match((await primeWarmBase(throwing, model, base)).error ?? "", /socket hang up/);
});

test("callNarrativeModel's trace keeps the provider's cache-read count, so a warm call's hit can be measured", async () => {
  const call: ModelCall = { complete: (async () => answer("{}", { input: 300, output: 20, cacheRead: 90_000 })) as unknown as ModelCall["complete"] };
  const result = await callNarrativeModel({ model, prompt: "P", warm: base, chunk: 1, attempt: 1, policy: DEFAULT_NARRATIVE_POLICY, sleep: async () => {} }, call);
  assert.deepEqual(result.trace.usage, { input: 300, output: 20, reasoning: 0, cacheRead: 90_000 });
});
