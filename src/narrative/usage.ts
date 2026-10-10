/**
 * What a pass's summarizer calls cost, summed in pi's own Usage shape. pi adds a compaction entry's usage into
 * the session totals, so a pass that reported token counts with a zero cost made its calls vanish from pi's
 * cost display -- invisible on a free local model, the first thing a paying user notices on a bill.
 */
import type { Usage } from "@earendil-works/pi-ai";

export type Cost = Usage["cost"];

/** One call's usage as its trace records it. `reasoning` is a subset of `output`, as in pi-ai; zero fields are left out. */
export interface CallUsage {
  input: number;
  output: number;
  reasoning: number;
  /** Prompt tokens the provider served from its prefix cache. */
  cacheRead?: number;
  cacheWrite?: number;
  /** The provider's priced cost, as pi-ai computed it from the model's pricing. */
  cost?: Cost;
}

/** Every call of one pass, summed; `calls` counts calls that reported no usage too. */
export interface PassUsage {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  cost: Cost;
  calls: number;
}

const ZERO_COST: Cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

export const EMPTY_PASS_USAGE: PassUsage = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: ZERO_COST, calls: 0 };

export function callUsageOf(usage: Partial<Usage> | undefined): CallUsage | undefined {
  if (!usage) return undefined;
  return {
    input: usage.input ?? 0,
    output: usage.output ?? 0,
    reasoning: usage.reasoning ?? 0,
    ...(usage.cacheRead ? { cacheRead: usage.cacheRead } : {}),
    ...(usage.cacheWrite ? { cacheWrite: usage.cacheWrite } : {}),
    ...(usage.cost && usage.cost.total > 0 ? { cost: usage.cost } : {}),
  };
}

export function addCallUsage(total: PassUsage, call: CallUsage | undefined): PassUsage {
  const cost = call?.cost ?? ZERO_COST;
  return {
    input: total.input + (call?.input ?? 0),
    output: total.output + (call?.output ?? 0),
    reasoning: total.reasoning + (call?.reasoning ?? 0),
    cacheRead: total.cacheRead + (call?.cacheRead ?? 0),
    cacheWrite: total.cacheWrite + (call?.cacheWrite ?? 0),
    cost: {
      input: total.cost.input + cost.input,
      output: total.cost.output + cost.output,
      cacheRead: total.cost.cacheRead + cost.cacheRead,
      cacheWrite: total.cost.cacheWrite + cost.cacheWrite,
      total: total.cost.total + cost.total,
    },
    calls: total.calls + 1,
  };
}

export const sumCallUsage = (calls: ReadonlyArray<{ usage?: CallUsage }>): PassUsage => calls.reduce((sum, call) => addCallUsage(sum, call.usage), EMPTY_PASS_USAGE);

/** The pass total as the compaction entry's usage. `totalTokens` follows pi-ai: input + output + cache reads and writes. */
export function compactionUsageOf(total: PassUsage): Usage {
  return {
    input: total.input,
    output: total.output,
    cacheRead: total.cacheRead,
    cacheWrite: total.cacheWrite,
    ...(total.reasoning > 0 ? { reasoning: total.reasoning } : {}),
    totalTokens: total.input + total.output + total.cacheRead + total.cacheWrite,
    cost: { ...total.cost },
  };
}
