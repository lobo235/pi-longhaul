/**
 * One State pass (CONTEXT.md *Pass*): ledger + workspace + fold the store, run the narrative call,
 * close the span, render the state, and hand pi a CompactionResult whose details carry the
 * checkpoint. Pure with respect to pi: everything it needs arrives in PassInput/PassDeps, and the
 * span record is returned as `pending` for index.ts to append once the compaction entry exists.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type { CompactionResult, SessionBeforeCompactEvent, SessionEntry } from "@earendil-works/pi-coding-agent";

import { carryFileOps, latestStateDetails, narrativeTraceOf, previousFileLists, previousLearnedValues, type StateDetails } from "./carry.ts";
import { readConfigFile, resolveNarrativeRoute, resolveStateConfig, type ColdSliceCaps, type ReadFileFn, type StateConfig } from "./config.ts";
import { buildMessageIndex, earlierOtherMessages, earlierRuleMessages, normalizeWs, type IndexedUserMessage, type MessageIndex } from "./intent.ts";
import { carryLearnedValues, learnedValues, type LearnedValue } from "./learned.ts";
import { collectHandoff, finishHandoff, type CommandRecord, type ErrorRecord, type WorkspaceSnapshot } from "./ledger/handoff.ts";
import { captureWorkspace, type ExecFn, type WorkspaceCapture } from "./ledger/handoff-workspace.ts";
import type { ModelCall } from "./narrative/call.ts";
import { carryUnlabeled, prepareSpan, type SpanInput } from "./narrative/prepare.ts";
import { NARRATIVE_PROMPT_REVISION, promptStateOf, seedOf, type PromptState } from "./narrative/prompt.ts";
import { shouldAttemptRoute, type RouteHealthState } from "./narrative/route-health.ts";
import { resolveSummarizationModel, type ModelLookup, type ResolvedSummarizationModel } from "./narrative/routing.ts";
import { routeProvidersFor, type ResolvedSummarizationRoute } from "./narrative/route-config.ts";
import { turnTextsOf, type SpanTexts } from "./narrative/named-values.ts";
import { runNarrativeCall, type NarrativeInput } from "./narrative/run.ts";
import { TURNS_PROMPT_REVISION } from "./narrative/turns/conversation.ts";
import { runSectionTurns, type TurnsContext } from "./narrative/turns/run.ts";
import type { NarrativeOutcome } from "./narrative/types.ts";
import type { WarmBase } from "./narrative/warm.ts";
import { render } from "./render.ts";
import type { RunningTask } from "./tasks.ts";
import type { CapFitResult } from "./store/capfit.ts";
import { closeSpan, type ClosedSpan } from "./store/close.ts";
import { closedWhole, STATE_FORMAT, type FoldAnomaly, type SpanRecord, type StateEvent, type StateLog, type World } from "./store/events.ts";
import { readLog } from "./store/log.ts";
import { acceptedRemembers, applyEvent, project, type SessionState } from "./store/project.ts";
import { applyProposals, verify } from "./store/verify.ts";
import { deriveClaims, isDirty, observeWrites } from "./world.ts";
import { openErrors, renderWorldLines } from "./world-render.ts";
import { compactionUsageOf } from "./narrative/usage.ts";
import { logOptionsOf, logSafeNarrative, logSafeRejected, logSafeRemoved, logSafeSkipped } from "./log-safe.ts";

export interface PassInput {
  preparation: SessionBeforeCompactEvent["preparation"];
  branchEntries: SessionEntry[];
  customInstructions?: string;
  reason: "manual" | "threshold" | "overflow";
  signal?: AbortSignal;
  sessionModel?: Model<any>;
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** The session's own last request, for narrativeMode `warm` (narrative/warm.ts); ignored by the other modes. */
  warmBase?: WarmBase;
}

export interface PassDeps {
  readConfig: ReadFileFn;
  exec: ExecFn;
  call: ModelCall;
  find: ModelLookup;
  routeHealth: RouteHealthState;
  now: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** The background tasks running now (tasks.ts); undefined = unknown. Absent: no task line. */
  runningTasks?: () => Promise<RunningTask[] | undefined>;
}

export interface PendingSpan {
  span: number;
  events: StateEvent[];
  ledger: { commands: CommandRecord[]; errors: ErrorRecord[] };
  snapshot?: WorkspaceSnapshot;
  usage: SpanRecord["usage"];
  caps: ColdSliceCaps;
}

export interface PassResult {
  compaction: CompactionResult<StateDetails>;
  pending: PendingSpan;
  outcome: NarrativeOutcome;
  routeHealth: RouteHealthState;
  route: { spec?: string; rule: string; model?: string; fallbackReason?: string; routeIgnored?: string; routeAvailable: boolean };
  capFit: CapFitResult;
  anomalies: FoldAnomaly[];
  notice: string;
  log: Record<string, unknown>;
}

export { readConfigFile };

interface Fold {
  handoff: ReturnType<typeof collectHandoff>;
  workspace: Promise<WorkspaceCapture>;
  tasks: Promise<RunningTask[] | undefined>;
  index: MessageIndex;
  log: StateLog;
  span: number;
  state: SessionState;
  spanInput: SpanInput;
  route: ResolvedSummarizationRoute;
  resolved?: ResolvedSummarizationModel;
  routeAvailable: boolean;
  /** The switchover seed, derived once: the rules the prompt offers are the rules the floor records. */
  seed: Pick<PromptState, "seed" | "seedRules" | "seedContext">;
  /** What the pass derives once the workspace capture answers; turns mode needs it before the call, every mode at the close. */
  settled: () => Promise<Settled>;
}

interface Settled {
  capture: WorkspaceCapture;
  snapshot?: WorkspaceSnapshot;
  ledger: { commands: CommandRecord[]; errors: ErrorRecord[] };
  /** The pass's own goal/objective events (defaultObjectiveEvents), not yet numbered. */
  objectiveEvents: StateEvent[];
  world: World;
  files: ReturnType<typeof carryFileOps>;
}

interface Closed {
  closed: ClosedSpan;
  summary: string;
  capture: WorkspaceCapture;
  snapshot?: WorkspaceSnapshot;
  ledger: { commands: CommandRecord[]; errors: ErrorRecord[] };
  files: ReturnType<typeof carryFileOps>;
  learned: LearnedValue[];
}

function resolveRoute(input: PassInput, config: StateConfig, deps: PassDeps): { route: ResolvedSummarizationRoute; resolved?: ResolvedSummarizationModel; routeAvailable: boolean } {
  const route = resolveNarrativeRoute({ env: input.env, config, cwd: input.cwd });
  if (!input.sessionModel) return { route, resolved: undefined, routeAvailable: false };
  const resolved = resolveSummarizationModel(input.sessionModel, route.spec, deps.find, routeProvidersFor(route, config.routeProviders, input.sessionModel.provider));
  const crossProvider = resolved.model !== input.sessionModel;
  return { route, resolved, routeAvailable: !crossProvider || shouldAttemptRoute(deps.routeHealth, deps.now().getTime()) };
}

/**
 * What the pass sets on its own. The /goal pi-goal names as active is the
 * Goal, set whenever it differs from the state's (goal mode re-states it every turn, so a changed goal
 * is the user's newest word on it) and cleared once pi-goal no longer names it (security.md T2); it
 * never touches the Request, which is the summarizer's. Outside a /goal the first stated goal is the
 * default Request while none is set; a diff objective.set lands after it and wins. (Setting the goal
 * AS the objective made it ping-pong with the summarizer's Request, one move per pass.)
 */
function defaultObjectiveEvents(state: SessionState, index: MessageIndex, span: number, at: string, config: StateConfig): StateEvent[] {
  const candidate = index.defaultObjective();
  const cleared: StateEvent[] = state.goal && !candidate?.goal ? [{ kind: "goal.clear", source: "pass", span, at, seq: 0 }] : [];
  if (!candidate) return cleared;
  const same = (quote: { text: string } | undefined) => quote !== undefined && normalizeWs(candidate.text) === normalizeWs(quote.text);
  if (candidate.goal ? same(state.goal?.quote) : state.objective !== undefined) return cleared;
  const verdict = verify({ kind: "objective", ref: candidate.ordinal, text: candidate.text }, { resolver: index, state, provenance: { source: "pass", span, at }, caps: config.caps, nearDuplicateThreshold: 1, acceptedThisSpan: 0, rememberCap: 0 });
  if (!verdict.ok || verdict.event.kind !== "objective.set") return cleared;
  if (!candidate.goal) return [...cleared, verdict.event];
  const { doneWhen: _none, ...goal } = verdict.event;
  return [{ ...goal, kind: "goal.set" }];
}

function worldOf(input: { commands: CommandRecord[]; errors: ErrorRecord[]; previous: World | undefined; pass: number; snapshot?: WorkspaceSnapshot; messages: Parameters<typeof observeWrites>[0]; config: StateConfig; at: string }): World {
  const claims = deriveClaims({ commands: input.commands, previous: input.previous?.claims ?? [], pass: input.pass, snapshot: input.snapshot, writes: observeWrites(input.messages), patterns: input.config.claimPatterns, now: input.at });
  return { branch: input.snapshot?.branch, commit: input.snapshot?.commit, dirty: isDirty(input.snapshot), claims, openErrorIds: openErrors(input.errors, input.config.caps.openErrors).map((record) => record.id) };
}

function previousWorldOf(log: StateLog): World | undefined {
  return [...log.events].reverse().find((event): event is Extract<StateEvent, { kind: "span.close" }> => event.kind === "span.close")?.world;
}

function noticeOf(span: number, outcome: NarrativeOutcome, chars: number): string {
  if (outcome.kind === "narrative-less") return `longhaul: span ${span} closed narrative-less (${outcome.reason ?? "unknown"})`;
  return `longhaul: span ${span} closed (${outcome.events.length} accepted, ${outcome.rejected.filter((item) => item.final).length} dropped, ${chars} chars) via ${outcome.model ?? "?"}`;
}

/** Diff events come from applyProposals numbered from the projected state's seq; renumber after the log's last seq. */
function renumber(events: StateEvent[], from: number): StateEvent[] {
  return events.map((event, offset) => ({ ...event, seq: from + offset }));
}

function foldAndPrepare(input: PassInput, config: StateConfig, deps: PassDeps, at: string): Fold {
  const { preparation, branchEntries } = input;
  const handoff = collectHandoff({ branchEntries, messages: preparation.messagesToSummarize, turnPrefixMessages: preparation.turnPrefixMessages });
  const workspace = captureWorkspace({ exec: deps.exec, cwd: input.cwd, commands: handoff.commands, now: deps.now });
  const tasks = deps.runningTasks ? deps.runningTasks().catch(() => undefined) : Promise.resolve(undefined);
  const index = buildMessageIndex(branchEntries, { commandIds: new Set(handoff.commands.map((record) => record.id)), errorIds: new Set(handoff.errors.map((record) => record.id)) });
  const log = readLog(branchEntries, index);
  const span = log.openSpan;
  const state = project(log, config.caps);
  const closes = log.events.flatMap((event) => (event.kind === "span.close" ? [event] : []));
  const spanInput = carryUnlabeled(prepareSpan({ messagesToSummarize: preparation.messagesToSummarize, turnPrefixMessages: preparation.turnPrefixMessages, index }), closes, index);
  const { route, resolved, routeAvailable } = resolveRoute(input, config, deps);
  let settled: Promise<Settled> | undefined;
  const fold: Fold = {
    handoff, workspace, tasks, index, log, span, state, spanInput, route, resolved, routeAvailable,
    seed: switchoverSeed(input, { log, index, spanInput }),
    settled: () => (settled ??= settle(input, fold, config, at)),
  };
  return fold;
}

async function settle(input: PassInput, fold: Fold, config: StateConfig, at: string): Promise<Settled> {
  const capture = await fold.workspace;
  const snapshot = "snapshot" in capture ? capture.snapshot : undefined;
  const { commands, errors } = finishHandoff({ ...fold.handoff, workspace: snapshot });
  const world = worldOf({ commands, errors, previous: previousWorldOf(fold.log), pass: fold.handoff.pass, snapshot, messages: fold.spanInput.messages, config, at });
  const files = carryFileOps(previousFileLists(input.branchEntries), input.preparation.fileOps);
  return { capture, snapshot, ledger: { commands, errors }, objectiveEvents: defaultObjectiveEvents(fold.state, fold.index, fold.span, at, config), world, files };
}

/** The switchover seed (narrative/prompt.ts seedOf): only when the newest compaction on the branch is not a state one. */
function switchoverSeed(input: PassInput, fold: Pick<Fold, "log" | "index" | "spanInput">): Fold["seed"] {
  if (latestStateDetails(input.branchEntries)) return {};
  const seed = seedOf(input.preparation.previousSummary);
  if (!seed) return {};
  const unjudged = sinceLastJudged(fold);
  const seedRules = earlierRuleMessages(unjudged, fold.spanInput.fromRef);
  const seedContext = earlierOtherMessages(unjudged, fold.spanInput.fromRef, new Set(seedRules.map((rule) => rule.ordinal)));
  return { seed, seedRules, seedContext };
}

/**
 * The user's messages after the newest span Longhaul's own pass closed whole. A switchover that follows a fallback (a
 * failed pass, then pi's own compaction) already has a state that judged everything up to there: offering those
 * messages again would record a rule the state had lifted or named a one-off. A span that closed narrative-less or
 * with missing chunks labeled none or only some of its messages, so the bound stays before it.
 */
function sinceLastJudged(fold: Pick<Fold, "log" | "index">): IndexedUserMessage[] {
  const whole = fold.log.events.filter((event) => event.kind === "span.close" && closedWhole(event));
  const last = whole.at(-1);
  if (!last || last.kind !== "span.close") return fold.index.messages;
  const at = fold.index.messages.findIndex((message) => message.ordinal === last.toRef);
  return at < 0 ? fold.index.messages : fold.index.messages.slice(at + 1);
}

/**
 * The switchover floor: every earlier rule the pass offered (switchoverSeed) is recorded verbatim by code, after the
 * model's own events, unless the model named it a one-off. Left to the model, the rules were almost never carried: in
 * one replay 29 of 31 dropped earlier corrections had been offered word for word. A rule the model already
 * recorded is a near-duplicate and is skipped; ids continue from the state the model's events leave.
 */
function seedRuleEvents(fold: Fold, outcome: NarrativeOutcome, diffEvents: StateEvent[], config: StateConfig, at: string): StateEvent[] {
  const oneOffs = new Set(outcome.oneOffs ?? []);
  const rules = (fold.seed.seedRules ?? []).filter((rule) => !oneOffs.has(rule.ordinal));
  if (rules.length === 0) return [];
  const after = diffEvents.reduce((state, event) => applyEvent(state, event, config.caps), fold.state);
  const proposals = rules.map((rule) => ({ kind: "correction" as const, ref: rule.ordinal, text: rule.text }));
  return applyProposals(proposals, { resolver: fold.index, state: after, provenance: { source: "pass", span: fold.span, at }, caps: config.caps, nearDuplicateThreshold: config.nearDuplicateThreshold, acceptedThisSpan: 0, rememberCap: 0 }).events;
}

/**
 * A switchover's turns before the span, each opened by its user message's ordinal: the previous summary is another
 * compactor's, so a value it records can be kept only where one of these shows it (named-values.ts withEarlierTurns).
 */
function earlierTurnsOf(branchEntries: SessionEntry[], index: MessageIndex, fromRef: string): SpanTexts | undefined {
  const end = index.messages.find((message) => message.ordinal === fromRef)?.position;
  if (end === undefined) return undefined;
  const ordinalAt = new Map(index.messages.map((message) => [message.position, message.ordinal]));
  const turns = branchEntries.slice(0, end).flatMap((entry, position) => (entry.type === "message" ? [{ message: entry.message as AgentMessage, ordinal: ordinalAt.get(position) }] : []));
  return turnTextsOf(turns);
}

function narrativeInputOf(input: PassInput, fold: Fold, config: StateConfig, deps: PassDeps, at: string, state: SessionState): NarrativeInput {
  const earlierTurns = fold.seed.seed ? earlierTurnsOf(input.branchEntries, fold.index, fold.spanInput.fromRef) : undefined;
  return {
    ...(earlierTurns ? { earlierTurns } : {}),
    span: fold.spanInput,
    state,
    promptState: { ...promptStateOf(state, acceptedRemembers(fold.log, fold.span)), ...fold.seed },
    verify: { resolver: fold.index, provenance: { source: "diff", span: fold.span, at }, caps: config.caps, nearDuplicateThreshold: config.nearDuplicateThreshold, acceptedThisSpan: 0, rememberCap: 0 },
    customInstructions: input.customInstructions,
    model: fold.resolved?.model,
    fallbackModel: fold.resolved && fold.resolved.model !== input.sessionModel ? input.sessionModel : undefined,
    routeHealth: deps.routeHealth,
    routeConfig: config.routeHealth,
    routeAvailable: fold.routeAvailable,
    policy: config.narrativePolicy,
    signal: input.signal,
    ...(config.narrativeMode === "warm" && input.warmBase ? { warm: input.warmBase } : {}),
  };
}

/** Turns mode needs before the call what the single call only needs after it: the ledger, World and files for the Digest and the checks, and the default objective in the state the turns see. */
async function turnsContextOf(fold: Fold, input: PassInput, config: StateConfig, at: string): Promise<{ state: SessionState; context: TurnsContext }> {
  const { snapshot, ledger: { commands, errors }, objectiveEvents, world, files } = await fold.settled();
  const fileOps = input.preparation.fileOps;
  return {
    state: objectiveEvents.reduce((current, event) => applyEvent(current, event, config.caps), fold.state),
    context: {
      commands, errors, files,
      filesChars: config.caps.filesChars,
      worldLines: renderWorldLines({ snapshot, claims: world.claims, commands, errors, pass: fold.handoff.pass, caps: config.caps, compactedAt: at }),
      openErrorIds: world.openErrorIds,
      unresolvedSpanErrorIds: errors.filter((record) => !record.resolved && record.lastSeenPass === fold.handoff.pass).map((record) => record.id),
      spanModifiedFiles: [...new Set([...fileOps.written, ...fileOps.edited])],
      textOf: (ordinal) => fold.index.textOf(ordinal),
    },
  };
}

async function callNarrative(input: PassInput, fold: Fold, config: StateConfig, deps: PassDeps, at: string): Promise<NarrativeOutcome> {
  const narrativeDeps = { call: deps.call, sleep: deps.sleep, now: () => deps.now().getTime() };
  if (config.narrativeMode !== "turns") return runNarrativeCall(narrativeInputOf(input, fold, config, deps, at, fold.state), narrativeDeps);
  const { state, context } = await turnsContextOf(fold, input, config, at);
  return runSectionTurns({ ...narrativeInputOf(input, fold, config, deps, at, state), turns: config.narrativeTurns, context }, narrativeDeps);
}

async function closeAndRender(input: PassInput, fold: Fold, outcome: NarrativeOutcome, config: StateConfig, at: string): Promise<Closed> {
  const { preparation, branchEntries } = input;
  const { capture, snapshot, ledger, objectiveEvents, world, files } = await fold.settled();
  const modelEvents = [...objectiveEvents.map((event) => ({ ...event, seq: 0 })), ...outcome.events];
  const diffEvents = [...modelEvents, ...seedRuleEvents(fold, outcome, modelEvents, config, at)];
  // Ids from the whole merged ledger, not the fitted slice: a value's source must not vanish with a low-ranked record.
  // The values the summarizer named come first: each was checked against its turn, and its name says what it is.
  const picked = learnedValues([...preparation.messagesToSummarize, ...(preparation.turnPrefixMessages ?? [])], fold.handoff.commands);
  const learned = carryLearnedValues(previousLearnedValues(branchEntries), [...(outcome.values ?? []), ...picked]);
  const tasks = (await fold.tasks) ?? [];
  const measure = (candidate: SessionState) => render({ state: candidate, tokensBefore: preparation.tokensBefore, ledger, snapshot, caps: config.caps, files, learned, tasks, compactedAt: at }).length;
  const closed = closeSpan({ log: fold.log, caps: config.caps, diffEvents: renumber(diffEvents, fold.log.nextSeq), close: { fromRef: fold.spanInput.fromRef, toRef: fold.spanInput.toRef, narrative: outcome.narrative, narrativeLess: outcome.kind === "narrative-less", world, ...(outcome.missingChunks.length ? { missingChunks: outcome.missingChunks } : {}) }, at, measure });
  return { closed, summary: render({ state: closed.state, tokensBefore: preparation.tokensBefore, ledger, snapshot, caps: config.caps, files, learned, tasks, compactedAt: at }), capture, snapshot, ledger, files, learned };
}

function assembleResult(input: PassInput, config: StateConfig, fold: Fold, outcome: NarrativeOutcome, built: Closed, deps: PassDeps, startedAt: Date, at: string): PassResult {
  const { preparation } = input;
  const { closed, summary, capture, snapshot, ledger, files, learned } = built;
  const usage = { input: outcome.usage.input, output: outcome.usage.output, calls: outcome.usage.calls };
  const details: StateDetails = { compactor: "state", stateFormat: STATE_FORMAT, promptRevision: outcome.sections ? TURNS_PROMPT_REVISION : NARRATIVE_PROMPT_REVISION, state: closed.state, caps: config.caps, ledger, snapshot, narrative: narrativeTraceOf(outcome), readFiles: files.readFiles, modifiedFiles: files.modifiedFiles, learnedValues: learned };
  const pending: PendingSpan = { span: fold.span, events: closed.log.events.filter((event) => event.span === fold.span), ledger, snapshot, usage, caps: config.coldSliceCaps };
  const route = { spec: fold.route.spec, rule: fold.route.rule, model: fold.resolved ? `${fold.resolved.model.provider}/${fold.resolved.model.id}` : undefined, fallbackReason: fold.resolved?.fallbackReason, routeIgnored: fold.resolved?.routeIgnored, routeAvailable: fold.routeAvailable };
  const logOptions = logOptionsOf(input.env);
  const log = { event: "compaction", at, reason: input.reason, span: fold.span, tokensBefore: preparation.tokensBefore, summaryChars: summary.length, narrative: logSafeNarrative(details.narrative, logOptions), rejected: logSafeRejected(outcome.rejected, logOptions), route, routeHealth: outcome.routeHealth, capFit: closed.capFit.retired, capExhausted: closed.capFit.exhausted, anomalies: fold.log.anomalies, world: { claims: closed.state.world?.claims.length ?? 0, openErrors: closed.state.world?.openErrorIds.length ?? 0, dirty: closed.state.world?.dirty }, carried: { readFiles: files.readFiles.length, modifiedFiles: files.modifiedFiles.length, removed: logSafeRemoved(files.removed, logOptions), learnedValues: learned.length }, workspace: "skipped" in capture ? { skipped: logSafeSkipped(capture.skipped, logOptions) } : { captured: true }, durationMs: deps.now().getTime() - startedAt.getTime() };
  return {
    compaction: { summary, firstKeptEntryId: preparation.firstKeptEntryId, tokensBefore: preparation.tokensBefore, usage: compactionUsageOf(outcome.usage), details },
    pending, outcome, routeHealth: outcome.routeHealth, route, capFit: closed.capFit, anomalies: fold.log.anomalies, notice: noticeOf(fold.span, outcome, summary.length), log,
  };
}

export async function runStatePass(input: PassInput, deps: PassDeps): Promise<PassResult> {
  const startedAt = deps.now();
  const at = startedAt.toISOString();
  const config = resolveStateConfig(deps.readConfig);
  const fold = foldAndPrepare(input, config, deps, at);
  const outcome = await callNarrative(input, fold, config, deps, at);
  const built = await closeAndRender(input, fold, outcome, config, at);
  return assembleResult(input, config, fold, outcome, built, deps, startedAt, at);
}
