/**
 * The learned-facts probe over recorded compactions: for every compaction on each
 * transcript's current branch, how many of the facts the session learned from tool output and used
 * again did the recorded summary keep, pooled by the compactor that wrote it. No model call: the
 * recorded summary is that compactor's output. Prints counts only, never a fact or a path.
 *
 *   npm run facts                       # every transcript under ~/.pi/agent/sessions
 *   FACTS_SESSIONS=DIR FACTS_K=10 npm run facts
 */
import os from "node:os";
import path from "node:path";

import { listTranscripts, pathTo, readTranscript } from "./candidates.ts";
import { positiveIntEnv } from "./env.ts";
import { recordedFacts, type FactKind } from "./facts.ts";

type Pool = { compactions: number; withFacts: number; kept: number; total: number; byKind: Partial<Record<FactKind, { kept: number; total: number }>> };

function main(): void {
  const dir = process.env.FACTS_SESSIONS ?? path.join(os.homedir(), ".pi", "agent", "sessions");
  const k = positiveIntEnv("FACTS_K", 10);
  const pools = new Map<string, Pool>();
  let transcripts = 0;
  for (const file of listTranscripts(dir)) {
    const entries = readTranscript(file);
    const leaf = entries.at(-1);
    if (!leaf || !entries.some((entry) => entry.type === "compaction")) continue;
    transcripts += 1;
    for (const { compactor, coverage } of recordedFacts(pathTo(entries, leaf.id), k)) {
      const pool = pools.get(compactor) ?? { compactions: 0, withFacts: 0, kept: 0, total: 0, byKind: {} };
      pool.compactions += 1;
      if (coverage.total > 0) pool.withFacts += 1;
      pool.kept += coverage.kept;
      pool.total += coverage.total;
      for (const [kind, slot] of Object.entries(coverage.byKind) as Array<[FactKind, { kept: number; total: number }]>) {
        const into = (pool.byKind[kind] ??= { kept: 0, total: 0 });
        into.kept += slot.kept;
        into.total += slot.total;
      }
      pools.set(compactor, pool);
    }
  }
  const share = (kept: number, total: number) => (total ? Number((kept / total).toFixed(3)) : null);
  for (const [compactor, pool] of pools) {
    const byKind = Object.fromEntries(Object.entries(pool.byKind).map(([kind, slot]) => [kind, { ...slot, share: share(slot.kept, slot.total) }]));
    console.log(JSON.stringify({ compactor, ...pool, share: share(pool.kept, pool.total), byKind }));
  }
  console.log(JSON.stringify({ total: { transcripts, k } }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) main();
