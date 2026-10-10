/**
 * The State compactor's arms: the pass itself (`runStatePass`) over a recorded or synthetic compaction, with the
 * narrative mode each arm measures forced over the host's longhaul.json. `state-unlearned` is derived from the state
 * arm's result (the same compaction with its Learned values section cut out), so the pair isolates that section from
 * the model's own variance.
 *
 * The pass never captures a workspace here: the scorer runs long after the compaction, from wherever it was started,
 * so a live `git status` would describe the scorer's checkout as the session's World.
 */
import type { Model } from "@earendil-works/pi-ai";

import { latestStateDetails, type StateDetails } from "../carry.ts";
import { resolveNarrativeRoute, resolveStateConfig, type ReadFileFn } from "../config.ts";
import type { ModelCall } from "../narrative/call.ts";
import { createRouteHealth } from "../narrative/route-health.ts";
import { resolveSummarizationModel, type ModelLookup } from "../narrative/routing.ts";
import { routeProvidersFor } from "../narrative/route-config.ts";
import type { CallTrace } from "../narrative/types.ts";
import { runStatePass } from "../pass.ts";
import { buildSpanRecord } from "../cold.ts";
import { render } from "../render.ts";
import { SPAN_ENTRY_TYPE } from "../store/events.ts";
import { recall } from "../store/recall.ts";
import { buildToolContext } from "../tool-context.ts";
import type { Candidate } from "./candidates.ts";
import { claimCorrectness, needCoverage, needWindow, objectiveStability, withoutSection, type ScoreRow } from "./measures.ts";
import { sessionRequestOf } from "./probe.ts";
import { sharedMeasures, type Scored } from "./arms.ts";
import { primeWarmBase } from "./warm-prime.ts";

export type StateArm = "state" | "state-turns" | "state-warm";

const ARM_MODE: Record<StateArm, string> = { state: "single", "state-turns": "turns", "state-warm": "warm" };

/** The host's longhaul.json with the arm's narrative mode forced, so an arm measures its mode whatever the host runs. */
export function armConfigText(arm: StateArm, hostText: string | undefined): string {
  let base: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(hostText ?? "{}");
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) base = parsed as Record<string, unknown>;
  } catch {
    // an unreadable longhaul.json is the defaults, as resolveStateConfig treats it
  }
  return JSON.stringify({ ...base, narrativeMode: ARM_MODE[arm] });
}

export interface StateArmDeps {
  /** The session model: the scorer's `--model`. */
  model: Model<any>;
  call: ModelCall;
  find: ModelLookup;
  hostConfig: ReadFileFn;
  /** Render caps to measure need coverage at, besides the configured one. */
  caps: readonly number[];
  withUnlearned: boolean;
  /** state-warm: prime the server with the session's request first, so the warm call is timed on its own. */
  warmPrime: boolean;
  env: NodeJS.ProcessEnv;
}

/** No workspace at replay time (see the header): every git probe answers "not a repository". */
async function noWorkspace(): Promise<{ stdout: string; stderr: string; code: number; killed: boolean }> {
  return { stdout: "", stderr: "replay: no workspace", code: 128, killed: false };
}

async function primeIfWarm(arm: StateArm, candidate: Candidate, deps: StateArmDeps, readConfig: ReadFileFn) {
  if (arm !== "state-warm") return {};
  const warmBase = sessionRequestOf(candidate.pathEntries);
  if (!deps.warmPrime) return { warmBase };
  const config = resolveStateConfig(readConfig);
  // Prime the model the warm call will use: a configured route can send the narrative off the session model.
  const route = resolveNarrativeRoute({ env: deps.env, config, cwd: candidate.cwd });
  const model = resolveSummarizationModel(deps.model, route.spec, deps.find, routeProvidersFor(route, config.routeProviders, deps.model.provider)).model;
  return { warmBase, primed: await primeWarmBase(deps.call, model, warmBase, { timeoutMs: config.narrativePolicy.timeoutMs }) };
}

/** Prompt tokens of the warm calls and how many the server read from its prefix cache; undefined when none reported usage. */
function warmTokensOf(calls: CallTrace[]): { cacheRead: number; prompt: number } | undefined {
  const used = calls.filter((call) => call.warm === true && call.usage);
  if (used.length === 0) return undefined;
  const cacheRead = used.reduce((sum, call) => sum + (call.usage?.cacheRead ?? 0), 0);
  return { cacheRead, prompt: used.reduce((sum, call) => sum + (call.usage?.input ?? 0), 0) + cacheRead };
}

/** The span record the extension appends after a state compaction (index.ts session_compact), so a chained replay carries the state on. */
function spanRecordOf(pending: Awaited<ReturnType<typeof runStatePass>>["pending"], compactionEntryId: string) {
  return buildSpanRecord({ span: pending.span, compactionEntryId, events: pending.events, ledger: pending.ledger, snapshot: pending.snapshot, usage: pending.usage, caps: pending.caps });
}

export async function scoreState(candidate: Candidate, prep: Record<string, any>, arm: StateArm, deps: StateArmDeps): Promise<Scored> {
  const text = armConfigText(arm, deps.hostConfig());
  const readConfig = () => text;
  const config = resolveStateConfig(readConfig);
  const { warmBase, primed } = await primeIfWarm(arm, candidate, deps, readConfig);
  const result = await runStatePass(
    { preparation: prep as never, branchEntries: candidate.pathEntries, reason: "manual", sessionModel: deps.model, cwd: candidate.cwd ?? "/", env: deps.env, ...(warmBase ? { warmBase } : {}) },
    { readConfig, exec: noWorkspace, call: deps.call, find: deps.find, routeHealth: createRouteHealth(), now: () => new Date() },
  );
  const rendered = result.compaction.summary;
  const details = result.compaction.details as StateDetails;
  const entry = { type: "compaction", id: "score", parentId: candidate.pathEntries.at(-1)?.id ?? null, timestamp: new Date().toISOString(), summary: rendered, firstKeptEntryId: prep.firstKeptEntryId, tokensBefore: prep.tokensBefore, fromHook: true, details } as never;
  const context = buildToolContext([...candidate.pathEntries, entry]);
  const files = { readFiles: details.readFiles, modifiedFiles: details.modifiedFiles };
  const recallable = (needle: string) => recall({ query: needle, limit: 5 }, { log: context.log, ledger: result.pending.ledger, messageText: (ordinal) => context.index.textOf(ordinal), caps: config.caps, files }).total > 0;
  const close = result.pending.events.find((event) => event.kind === "span.close");
  const coverageAtCap: Record<string, number | null> = {};
  for (const cap of deps.caps) {
    const atCap = render({ state: details.state, tokensBefore: prep.tokensBefore, ledger: result.pending.ledger, snapshot: result.pending.snapshot, caps: { ...config.caps, hardChars: cap }, files, learned: details.learnedValues });
    coverageAtCap[String(cap)] = needCoverage(needWindow(candidate.after), atCap.slice(0, cap), recallable).share;
  }
  const usage = result.outcome.usage;
  const row: ScoreRow = {
    arm, at: candidate.at, session: candidate.session, renderedChars: rendered.length,
    ...sharedMeasures(candidate, prep.firstKeptEntryId, rendered, recallable),
    objective: objectiveStability(latestStateDetails(candidate.pathEntries)?.state.objective?.quote, details.state.objective?.quote),
    claims: close && close.kind === "span.close" ? claimCorrectness(close.world.claims, result.pending.ledger.commands) : null,
    coverageAtCap,
    ...(usage.calls > 0 ? { tokens: { input: usage.input + usage.cacheRead, output: usage.output } } : {}),
    ...(arm === "state-warm" ? { warm: result.outcome.calls.some((trace) => trace.warm === true), warmTokens: warmTokensOf(result.outcome.calls) } : {}),
    ...(primed ? { primeMs: primed.ms } : {}),
  };
  const unlearnedText = withoutSection(rendered, "## Learned values");
  const unlearned = arm === "state" && deps.withUnlearned
    ? { rendered: unlearnedText, row: { ...row, arm: "state-unlearned", renderedChars: unlearnedText.length, ...sharedMeasures(candidate, prep.firstKeptEntryId, unlearnedText, recallable), coverageAtCap: undefined, tokens: undefined } }
    : undefined;
  return { row, rendered, compaction: { summary: rendered, details, fromHook: true, follow: [{ customType: SPAN_ENTRY_TYPE, data: spanRecordOf(result.pending, candidate.entryId) }] }, unlearned, trace: { ...(primed?.error ? { primeError: primed.error } : {}), narrative: result.log.narrative, calls: result.outcome.calls, rejected: result.log.rejected, route: result.log.route, sections: result.outcome.sections } };
}
