import test from "node:test";
import assert from "node:assert/strict";

import { baseTokensOf, warmFits, type WarmBase } from "./warm.ts";

const usage = (input: number, cacheRead: number, output: number) => ({ input, output, cacheRead, cacheWrite: 0, totalTokens: input + cacheRead + output, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
const assistant = (text: string, used?: ReturnType<typeof usage>) => ({ role: "assistant" as const, content: [{ type: "text" as const, text }], api: "openai-completions", provider: "p", model: "m", stopReason: "stop" as const, timestamp: 2, ...(used ? { usage: used } : {}) });

test("baseTokensOf: the provider-reported size of the last answered request, plus an estimate for what came after it", () => {
  const messages = [{ role: "user" as const, content: "start", timestamp: 1 }, assistant("done", usage(1000, 9000, 500)), { role: "user" as const, content: "x".repeat(300), timestamp: 3 }];
  const tokens = baseTokensOf(messages as never);
  assert.ok(tokens !== undefined && tokens >= 10_500 + 100 && tokens < 10_500 + 200, `got ${tokens}`);
  assert.equal(baseTokensOf([{ role: "user" as const, content: "no answer yet", timestamp: 1 }] as never), undefined, "nothing measured: the char estimate decides");
});

test("warmFits: a measured base decides the fit, so a near-full session is not refused on JSON overhead", () => {
  const messages = [{ role: "user" as const, content: "y".repeat(285_000), timestamp: 1 }];
  const base: WarmBase = { systemPrompt: "", messages: messages as never, tools: [] };
  assert.equal(warmFits(base, 6000, 3000, 100_000), false, "285k chars / 3 = 95k tokens + output + safety > 100k");
  assert.equal(warmFits({ ...base, tokens: 70_000 }, 6000, 3000, 100_000), true, "measured 70k + 2k instruction + 3k output + 4k safety fits");
  assert.equal(warmFits({ ...base, tokens: 95_000 }, 6000, 3000, 100_000), false);
});

test("baseTokensOf (security.md T7): a usage field that is not a finite non-negative number is no measurement, and a measurement never undercuts a floor from the JSON", () => {
  const big = { role: "user" as const, content: "z".repeat(60_000), timestamp: 1 };
  for (const bad of [{ input: -5 }, { input: "100" }, { input: Number.NaN }]) {
    const tokens = baseTokensOf([big, assistant("x", { ...usage(0, 0, 0), ...bad } as never)] as never);
    assert.equal(tokens, undefined, JSON.stringify(bad));
  }
  const tiny = baseTokensOf([big, assistant("x", usage(1, 0, 0))] as never);
  assert.ok(tiny !== undefined && tiny >= 10_000, `an under-reported usage is floored, got ${tiny}`);
});
