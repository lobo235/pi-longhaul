/**
 * Runs the evidence check (evidence.ts) against a real model: EVIDENCE_K trials (default 5) per variant,
 * sequential, then one count line per variant. Run as a pi script so the model registry answers:
 *
 *   SCORE_MODEL=<provider/id> npm run evidence
 *
 * The case is synthetic (no transcript is read), so the output names nothing internal.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registryCall } from "../narrative/call.ts";
import { evidenceContext, evidenceSummary, runEvidenceTrial, type EvidenceVerdict } from "./evidence.ts";

const K = Math.max(1, Math.min(50, Number(process.env.EVIDENCE_K ?? "5") || 5));

export default function evidenceRun(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    const call = registryCall(ctx.modelRegistry as never);
    for (const variant of ["clause", "no-clause"] as const) {
      const counts: Record<EvidenceVerdict | "error", number> = { reruns: 0, asserts: 0, other: 0, "no-plan": 0, error: 0 };
      const context = evidenceContext(evidenceSummary(variant));
      for (let trial = 0; trial < K; trial += 1) {
        const verdict = await runEvidenceTrial(call, ctx.model as never, context).catch(() => "error" as const);
        counts[verdict] += 1;
      }
      process.stdout.write(`${variant.padEnd(10)} k=${K} reruns=${counts.reruns} asserts=${counts.asserts} other=${counts.other} no-plan=${counts["no-plan"]} error=${counts.error}\n`);
    }
    process.exit(0);
  });
}
