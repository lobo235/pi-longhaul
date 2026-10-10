/**
 * What every scorer arm shares, and the baseline arm: pi's own compaction (`compact()`, pi's public export) over the
 * same preparation, with the auth and thinking level pi's own compaction would use, so the comparison is with what a
 * session without Longhaul gets. It has no recall tool, so a need counts as covered only in its rendered text.
 */
import type { Model } from "@earendil-works/pi-ai";
import type { compact } from "@earendil-works/pi-coding-agent";

import type { Candidate } from "./candidates.ts";
import type { ArmCompaction } from "./chain.ts";
import { factCoverage, factsAt, isCodeNameFact } from "./facts.ts";
import { labeledMeasures } from "./labels.ts";
import { correctionRetention, earlierCorrections, nameCoverage, nameNeeds, needCoverage, needWindow, ruleSections, userCorrections, type ScoreRow } from "./measures.ts";

/** `compaction` is what the arm wrote, for a chained replay to continue from (chain.ts). */
export type Scored = { row: ScoreRow; rendered: string; compaction: ArmCompaction; trace?: unknown; unlearned?: { row: ScoreRow; rendered: string } };

/** The measures every arm shares, from the candidate and the rendered text. */
export function sharedMeasures(candidate: Candidate, firstKeptEntryId: string, rendered: string, recallable: (needle: string) => boolean): Pick<ScoreRow, "need" | "corrections" | "names" | "earlierCorrections" | "facts" | "reused" | "labeled"> {
  const names = nameNeeds(candidate.after);
  // A correction is kept only when a rules section holds it (ruleSections), in either compactor's layout.
  const rules = ruleSections(rendered);
  return {
    need: needCoverage(needWindow(candidate.after), rendered, recallable),
    corrections: correctionRetention(userCorrections(candidate.spanUserTexts), rules),
    names: { files: nameCoverage(names.files, rendered, recallable), artifacts: nameCoverage(names.artifacts, rendered, recallable) },
    earlierCorrections: correctionRetention(earlierCorrections(candidate.pathUserTexts, candidate.spanUserTexts), rules),
    // `kept` in the rendered text alone, for every arm; `keptWithRecall` also credits longhaul_recall, as need and names do.
    facts: factCoverage(factsAt(candidate.pathEntries, firstKeptEntryId, candidate.after), rendered, recallable),
    // In the rendered text alone: what the Learned values section is for. Code names are left out (facts.ts isCodeNameFact).
    reused: factCoverage(factsAt(candidate.pathEntries, firstKeptEntryId, candidate.after, 10, true).filter((fact) => !isCodeNameFact(fact)), rendered),
    ...(candidate.labels ? { labeled: labeledMeasures(candidate.labels, candidate, firstKeptEntryId, rendered) } : {}),
  };
}

type Auth = { ok: true; apiKey?: string; headers?: Record<string, string | null> } | { ok: false; error: string };

export interface PiDefaultDeps {
  compact: typeof compact;
  /** The model registry's request auth (`getApiKeyAndHeaders`). */
  auth: (model: Model<any>) => Promise<Auth>;
  /** The session's thinking level, which pi's own compaction passes to its summarizer. */
  thinkingLevel: Parameters<typeof compact>[6];
}

/** A header pi's registry marks deleted (null) is not sent. */
function sentHeaders(headers: Record<string, string | null> | undefined): Record<string, string> | undefined {
  if (!headers) return undefined;
  return Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== null));
}

export async function scorePiDefault(candidate: Candidate, prep: Record<string, any>, model: Model<any>, deps: PiDefaultDeps): Promise<Scored> {
  const auth = await deps.auth(model);
  if (!auth.ok) throw new Error(`pi-default: no request auth for provider ${model.provider}: ${auth.error}`);
  const result = await deps.compact(prep as never, model, auth.apiKey, sentHeaders(auth.headers), undefined, undefined, deps.thinkingLevel);
  const rendered = result.summary;
  const row: ScoreRow = {
    arm: "pi-default", at: candidate.at, session: candidate.session, renderedChars: rendered.length,
    ...sharedMeasures(candidate, prep.firstKeptEntryId, rendered, () => false),
    objective: null,
    claims: null,
    // Prompt tokens include those read from a cache, as the state arms count them.
    ...(result.usage ? { tokens: { input: result.usage.input + (result.usage.cacheRead ?? 0), output: result.usage.output } } : {}),
  };
  return { row, rendered, compaction: { summary: rendered, ...(result.details !== undefined ? { details: result.details } : {}), fromHook: false } };
}
