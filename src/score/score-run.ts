/**
 * The paired scorer: for each compaction in a transcript store, run every chosen arm over the same prepared span and
 * score the same measures (measures.ts). `pi-default` is pi's own compaction, the baseline. Run as a pi script so the
 * real model registry answers:
 *
 *   SCORE_SESSIONS=<dir> SCORE_MODEL=<provider/id[:thinking]> npm run score
 *
 * The thinking level in SCORE_MODEL is the session's: pi-default summarizes at it, as pi's own compaction does.
 * Chained by default (chain.ts): each arm continues from its own earlier compactions, every compaction of every session
 * in order. Knobs (score-options.ts): SCORE_SESSIONS (required), SCORE_ARMS (default state,pi-default), SCORE_CHAIN=0
 * (each compaction on its recorded path, which then takes SCORE_N, SCORE_AT and SCORE_CANDIDATES_FROM), SCORE_CAPS, SCORE_LABELS (default: labels.json beside the sessions), SCORE_PROBE=1, SCORE_WARM_PRIME=0, SCORE_INCLUDE_LOCAL_ONLY=1, SCORE_OUT.
 * The rows carry each arm's rendered text, so the output (score-out/, gitignored) holds pieces of the replayed
 * sessions: keep it out of any issue or commit unless the sessions were synthetic.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { compact, type ExtensionAPI, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";

import { readConfigFile, resolveStateConfig } from "../config.ts";
import { registryCall } from "../narrative/call.ts";
import { withSummarizerHeaders } from "../narrative/summarizer-headers.ts";
import { scoreState } from "./arm-state.ts";
import { scorePiDefault, type Scored } from "./arms.ts";
import { candidateKey, candidates, nothingToScore, type Candidate } from "./candidates.ts";
import { runChained } from "./chain.ts";
import { formatLabeledLine, parseLabels, summarizeLabeled, type SessionLabels } from "./labels.ts";
import { nameNeeds, summarize, type ScoreArm, type ScoreRow } from "./measures.ts";
import { probeContext, runProbe } from "./probe.ts";
import { prepareAsRecorded, type CompactionSettings, type Preparation } from "./recorded-cut.ts";
import { scoreOptionsOf, type ScoreOptions } from "./score-options.ts";
import { formatNotScored, formatSummaryLine, type NotScored } from "./score-report.ts";

const REPO_ROOT = path.join(import.meta.dirname, "..", "..");
const compactionModule = pathToFileURL(path.join(REPO_ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "core", "compaction", "compaction.js")).href;
const { DEFAULT_COMPACTION_SETTINGS, prepareCompaction } = (await import(compactionModule)) as {
  DEFAULT_COMPACTION_SETTINGS: CompactionSettings;
  prepareCompaction: (entries: SessionEntry[], settings: CompactionSettings) => Preparation | undefined;
};

/** The label file: SCORE_LABELS, else labels.json beside the sessions; a named file that cannot be read stops the run. */
function labelsFor(options: ScoreOptions): Record<string, SessionLabels> | undefined {
  const file = options.labels ?? path.join(options.sessions, "labels.json");
  if (!options.labels && !fs.existsSync(file)) return undefined;
  return parseLabels(fs.readFileSync(file, "utf8"));
}

/** The (session, at) pairs of a previous run's rows, for SCORE_CANDIDATES_FROM. */
function pairedKeys(rowsFile: string): Set<string> {
  const keys = new Set<string>();
  for (const line of fs.readFileSync(rowsFile, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as { session?: string; at?: string };
    if (row.session && row.at) keys.add(candidateKey(row.session, row.at));
  }
  return keys;
}

/** The state arms' calls carry the configured summarizer headers, as a live compaction's do; one score id per arm run. */
function stateCall(ctx: ExtensionContext) {
  const headers = resolveStateConfig(() => readConfigFile()).summarizerHeaders;
  const sessionId = `score-${randomUUID()}`;
  return registryCall(ctx.modelRegistry as never, (options, model) => withSummarizerHeaders(options, headers, { provider: model.provider, sessionId }));
}

function scoreArm(arm: ScoreArm, candidate: Candidate, prep: Record<string, any>, pi: ExtensionAPI, ctx: ExtensionContext, options: ScoreOptions): Promise<Scored> {
  const model = ctx.model!;
  if (arm === "pi-default") return scorePiDefault(candidate, prep, model, { compact, auth: (m) => ctx.modelRegistry.getApiKeyAndHeaders(m), thinkingLevel: pi.getThinkingLevel() });
  if (arm === "state-unlearned") throw new Error("state-unlearned is derived from the state arm");
  const find = (provider: string, id: string) => ctx.modelRegistry.find(provider, id);
  return scoreState(candidate, prep, arm, { model, call: stateCall(ctx), find, hostConfig: () => readConfigFile(), caps: options.caps, withUnlearned: options.arms.includes("state-unlearned"), warmPrime: options.warmPrime, env: process.env });
}

/** One arm at one compaction: prepared on the candidate's path (the arm's own, when chained), scored, and written. */
async function scoreOne(arm: ScoreArm, candidate: Candidate, pi: ExtensionAPI, ctx: ExtensionContext, options: ScoreOptions, write: (record: unknown) => void, rows: ScoreRow[]): Promise<Scored> {
  const prepared = prepareAsRecorded(candidate, { prepare: prepareCompaction, defaults: DEFAULT_COMPACTION_SETTINGS, ...(options.keepRecentTokens !== undefined ? { keepRecentTokens: options.keepRecentTokens } : {}) });
  if ("error" in prepared) throw new Error(prepared.error);
  const prep = prepared.prep;
  const started = Date.now();
  const scored = await scoreArm(arm, candidate, prep, pi, ctx, options);
  scored.row.durationMs = Date.now() - started - (scored.row.primeMs ?? 0);
  for (const one of [scored, ...(scored.unlearned ? [scored.unlearned] : [])]) {
    const probeError = options.probe ? await probe(ctx, candidate, prep, one) : undefined;
    rows.push(one.row);
    write({ ...one.row, ...(options.chain ? { chained: true } : {}), rendered: one.rendered, trace: "trace" in one ? one.trace : undefined, ...(probeError ? { probeError } : {}) });
  }
  return scored;
}

/** The arms that make a model call of their own (state-unlearned is derived from the state arm's result). */
const runArms = (options: ScoreOptions) => options.arms.filter((arm) => arm !== "state-unlearned");

/** Independent replay (SCORE_CHAIN=0): every arm on each compaction's recorded path. */
async function scoreIndependent(chosen: Candidate[], pi: ExtensionAPI, ctx: ExtensionContext, options: ScoreOptions, write: (record: unknown) => void, rows: ScoreRow[]): Promise<void> {
  for (const candidate of chosen) {
    for (const arm of runArms(options)) {
      try {
        await scoreOne(arm, candidate, pi, ctx, options, write, rows);
      } catch (error) {
        write({ arm, at: candidate.at, session: candidate.session, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
}

/** Chained replay (chain.ts): every arm continues from its own earlier compactions. */
function scoreChained(chosen: Candidate[], pi: ExtensionAPI, ctx: ExtensionContext, options: ScoreOptions, write: (record: unknown) => void, rows: ScoreRow[]): Promise<void> {
  return runChained(chosen, runArms(options), (arm, candidate) => scoreOne(arm as ScoreArm, candidate, pi, ctx, options, write, rows), {
    scored: () => {},
    failed: (arm, candidate, error) => write({ arm, at: candidate.at, session: candidate.session, chained: true, error }),
  });
}

/** The continuation probe (probe.ts): which of the next span's names the resumed model plans to touch. */
async function probe(ctx: ExtensionContext, candidate: Candidate, prep: Record<string, any>, scored: { row: ScoreRow; rendered: string }): Promise<string | undefined> {
  const context = probeContext(candidate.pathEntries, { summary: scored.rendered, firstKeptEntryId: prep.firstKeptEntryId, tokensBefore: prep.tokensBefore });
  try {
    scored.row.probe = await runProbe(registryCall(ctx.modelRegistry as never), ctx.model!, context, nameNeeds(candidate.after));
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export default function scoreRun(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    const options = scoreOptionsOf(process.env, REPO_ROOT);
    if (!ctx.model) throw new Error("score: no model; pass --model <provider/id>");
    fs.mkdirSync(options.out, { recursive: true, mode: 0o700 });
    const rowsPath = path.join(options.out, "rows.jsonl");
    const notScored: NotScored[] = [];
    const write = (record: unknown) => {
      if (typeof (record as NotScored).error === "string") notScored.push(record as NotScored);
      fs.appendFileSync(rowsPath, JSON.stringify(record) + "\n", { mode: 0o600 });
    };
    const only = options.candidatesFrom ? pairedKeys(options.candidatesFrom) : undefined;
    const config = resolveStateConfig(() => readConfigFile());
    const chosen = candidates(options.sessions, { n: options.chain ? Number.POSITIVE_INFINITY : only?.size ?? options.n, ...(options.at && !only ? { at: options.at } : {}), ...(only ? { only } : {}), includeLocalOnly: options.includeLocalOnly, localOnlyRoots: config.localOnlyRoots });
    if (chosen.length === 0) {
      process.stdout.write(`nothing to score: ${nothingToScore(options.sessions)}\n`);
      process.exit(1);
    }
    if (only && chosen.length < only.size) process.stdout.write(`paired: ${chosen.length} of ${only.size} compactions are still on disk\n`);
    const labels = labelsFor(options);
    for (const candidate of chosen) if (labels?.[candidate.session]) candidate.labels = labels[candidate.session];
    const rows: ScoreRow[] = [];
    await (options.chain ? scoreChained : scoreIndependent)(chosen, pi, ctx, options, write, rows);
    const summary = summarize(rows, options.arms);
    fs.writeFileSync(path.join(options.out, "summary.json"), JSON.stringify({ n: chosen.length, chained: options.chain, labeled: Object.fromEntries(options.arms.map((arm) => [arm, summarizeLabeled(rows.filter((row) => row.arm === arm))])), model: `${ctx.model.provider}/${ctx.model.id}`, thinkingLevel: pi.getThinkingLevel(), caps: options.caps, summary }, null, 2), { mode: 0o600 });
    for (const arm of options.arms) process.stdout.write(formatSummaryLine(arm, summary[arm], options.probe) + "\n");
    for (const arm of options.arms) {
      const labeled = summarizeLabeled(rows.filter((row) => row.arm === arm));
      if (labeled) process.stdout.write(formatLabeledLine(arm, labeled) + "\n");
    }
    const left = formatNotScored(notScored, chosen.length);
    if (left) process.stdout.write(left + "\n");
    process.stdout.write(`rows: ${rowsPath}\n`);
    process.exit(rows.length > 0 ? 0 : 1);
  });
}
