/**
 * The turns mode of the narrative call: build the Digest once, then ask for the five sections in
 * code's order within one continuing conversation, gate each answer (section.ts), and send up to
 * `repairTurns` follow-up turns naming what failed. Returns the same NarrativeOutcome as the single
 * call, plus one SectionTrace per section, so the pass and the replay scorer branch only on
 * `narrativeMode`. Never throws, and the gate never fails a compaction: a section that runs out of
 * time or transport is skipped, which carries the previous state's.
 *
 * Interface (designed twice): three designs were sketched -- one entry point with
 * constants inside; sections as data with a pure judge; a pure reducer with a driver shell. Picked:
 * the single entry point outside (callers see runSectionTurns and NarrativeOutcome.sections only),
 * sections as typed data inside (labels.ts, sections.ts), and a pure judgeAnswer so every check is
 * tested without a model. The reducer's tape was not worth its vocabulary at five sections.
 */
import type { Message, Model } from "@earendil-works/pi-ai";

import { capped, planReasoning } from "../reasoning.ts";

import type { FileLists } from "../../carry.ts";
import type { CommandRecord, ErrorRecord } from "../../ledger/handoff.ts";
import type { StateEvent } from "../../store/events.ts";
import { activeCorrections, type SessionState } from "../../store/project.ts";
import { isAbort } from "../call.ts";
import { CHARS_PER_TOKEN, CONTEXT_SAFETY_TOKENS } from "../fit.ts";
import { onRouteFailure, routedRetryPolicy } from "../route-health.ts";
import type { NarrativeDeps, NarrativeInput } from "../run.ts";
import type { CallTrace, NarrativeOutcome, SectionTrace } from "../types.ts";
import { runTurn, type TurnResult } from "./conversation.ts";
import { buildDigest, type Digest } from "./digest.ts";
import type { TurnsPolicy } from "./policy.ts";
import { normalizeCommand } from "../../ledger/handoff-commands.ts";
import { judgeAnswer, repairNote, type Facts, type Judgement, type Section, type SectionId } from "./section.ts";
import { SECTIONS } from "./sections.ts";
import { condenseTranscript } from "./transcript.ts";
import { EMPTY_PASS_USAGE, sumCallUsage } from "../usage.ts";

/** What code computed before the turns: the ledger, files and World the digest shows and the checks read. */
export interface TurnsContext {
  commands: CommandRecord[];
  errors: ErrorRecord[];
  files: FileLists;
  filesChars: number;
  worldLines: string[];
  openErrorIds: string[];
  unresolvedSpanErrorIds: string[];
  spanModifiedFiles: string[];
  textOf: (ordinal: string) => string | undefined;
}

export interface TurnsInput extends NarrativeInput {
  turns: TurnsPolicy;
  context: TurnsContext;
}

interface Run {
  input: TurnsInput;
  deps: NarrativeDeps;
  now: () => number;
  started: number;
  model: Model<any>;
  usedFallback: boolean;
  health: NarrativeOutcome["routeHealth"];
  messages: Message[];
  calls: CallTrace[];
  callsMs: number;
}

/**
 * Tokens kept free for the conversation after the digest: every turn's answer and a few show() results, plus the
 * extra output budget a request asks for when its model cannot turn reasoning off (reasoning.ts).
 */
const conversationReserve = (policy: TurnsPolicy, model: Model<any> | undefined) => policy.outputTokens * 10 + 8000 + (model ? Math.max(0, planReasoning(model, policy.outputTokens).maxTokens - policy.outputTokens) : 0);

function digestOf(input: TurnsInput): Digest {
  const base = { userMessages: input.span.ordinals.map((entry) => ({ ordinal: entry.ordinal, text: input.context.textOf(entry.ordinal) ?? entry.excerpt })), textOf: input.context.textOf, commands: input.context.commands, errors: input.context.errors, files: input.context.files, filesChars: input.context.filesChars, worldLines: input.context.worldLines, promptState: input.promptState };
  const window = input.model?.contextWindow ?? 0;
  const fixed = buildDigest({ ...base, transcript: { text: "", outputs: new Map() } }).text.length;
  const budget = window > 0 ? Math.max(2000, (window - CONTEXT_SAFETY_TOKENS - conversationReserve(input.turns, input.model)) * CHARS_PER_TOKEN - fixed) : Number.POSITIVE_INFINITY;
  const ids = new Map(input.context.commands.map((record) => [normalizeCommand(record.command), record.id]));
  return buildDigest({ ...base, transcript: condenseTranscript(input.span.messages, budget, (command) => ids.get(normalizeCommand(command))) });
}

function factsOf(input: TurnsInput): Facts {
  const objective = input.promptState.objective ? { ordinal: input.promptState.objective.ordinal, text: input.promptState.objective.text } : undefined;
  return {
    spanOrdinals: input.span.ordinals.map((entry) => entry.ordinal),
    seedOrdinals: input.promptState.seed ? (input.promptState.seedRules ?? []).map((rule) => rule.ordinal) : [],
    contextOrdinals: input.promptState.seed ? (input.promptState.seedContext ?? []).map((message) => message.ordinal) : [],
    textOf: input.context.textOf,
    objective,
    ...(input.promptState.goal ? { goal: input.promptState.goal } : {}),
    activeCorrections: activeCorrections(input.state).map((item) => ({ id: item.id, ordinal: item.quote.ordinal, text: item.quote.text })),
    openErrorIds: input.context.openErrorIds,
    unresolvedSpanErrorIds: input.context.unresolvedSpanErrorIds,
    spanModifiedFiles: input.context.spanModifiedFiles,
    itemChars: input.verify.caps.itemChars,
    customInstructions: input.customInstructions,
  };
}

/** One turn on the conversation's model; a transport failure on the route moves the rest of the pass to the fallback once. */
async function turn(run: Run, section: SectionId, text: string, chunk: number, attempt: number, digest: Digest): Promise<TurnResult> {
  const policy = run.input.turns;
  const configured = policy.reasoning[section] ?? "off";
  const turnMs = run.messages.length === 0 ? policy.digestTurnMs : policy.turnMs;
  const deadline = Math.min(run.now() + turnMs, run.started + policy.passMs);
  // Planned per request, on the model it goes to: a fallback model may differ in what it can turn off. With the
  // session model waiting, the route retries its transport only `routeMaxRetries` times (routedRetryPolicy).
  const go = () => {
    const transportRetry = run.input.fallbackModel && !run.usedFallback ? routedRetryPolicy(run.input.routeConfig, run.input.policy.transportRetry.baseDelayMs) : run.input.policy.transportRetry;
    const plan = configured === "low" ? { reasoning: "low" as const, maxTokens: capped(run.model, policy.reasoningOutputTokens) } : planReasoning(run.model, policy.outputTokens);
    return runTurn({ model: run.model, messages: run.messages, text, show: digest.show, showCap: policy.showCap, outputTokens: plan.maxTokens, reasoning: plan.reasoning, deadline, chunk, attempt, transportRetry, signal: run.input.signal, sleep: run.deps.sleep, now: run.now }, run.deps.call);
  };
  const begun = run.now();
  let result = await go();
  if (result.failure === "transport" && run.input.fallbackModel && !run.usedFallback) {
    run.calls.push(...result.traces);
    run.health = onRouteFailure(run.health, run.now(), run.input.routeConfig);
    run.model = run.input.fallbackModel;
    run.usedFallback = true;
    result = await go();
  }
  run.calls.push(...result.traces);
  run.callsMs += run.now() - begun;
  if (!result.failure) run.messages = result.messages;
  return result;
}

const fewer = <A>(a: Judgement<A>, b: Judgement<A> | undefined) => !b || (a.answer !== undefined && a.complaints.length <= b.complaints.length) || b.answer === undefined;

interface SectionResult { judged?: Judgement<any>; trace: SectionTrace }

/** The first turn and up to repairTurns follow-ups; keeps the parsed answer with the fewest complaints. */
async function runSection(run: Run, section: Section<any>, index: number, facts: Facts, digest: Digest, state: SessionState): Promise<SectionResult> {
  const started = run.now();
  const trace: SectionTrace = { section: section.id, turns: 0, shows: 0, outcome: "skipped", unresolved: [], excused: [], durationMs: 0 };
  if (section.applies && !section.applies(facts)) return { trace: { ...trace, outcome: "accepted" } };
  const disabled = new Set(run.input.turns.disabledChecks);
  // The digest rides the first turn that lands in the conversation, not section 1's: a failed turn leaves no trace in it.
  let text = `${run.messages.length === 0 ? `${digest.text}\n\n` : ""}${section.instruction(facts)}`;
  let best: Judgement<any> | undefined;
  // A lift-replaced refusal first raised on the last turn gets one more turn, as in the single call (run.ts).
  let turns = 1 + run.input.turns.repairTurns;
  let asked = new Set<string>();
  for (let attempt = 1; attempt <= turns; attempt++) {
    if (run.now() - run.started >= run.input.turns.passMs) { trace.skipped ??= "budget"; break; }
    const result = await turn(run, section.id, text, index + 1, attempt, digest);
    trace.turns++;
    trace.shows += result.shows;
    if (result.failure) { trace.skipped = result.failure; break; }
    const judged = judgeAnswer(section, result.text, facts, { ...run.input.verify, state });
    judged.complaints = judged.complaints.filter((complaint) => !(complaint.excusable && disabled.has(complaint.check)));
    if (judged.unparsed) trace.unparsed = judged.unparsed;
    if (fewer(judged, best)) best = judged;
    if (judged.answer !== undefined && judged.complaints.length === 0) break;
    const replaced = judged.complaints.filter((complaint) => complaint.code === "lift-replaced").map((complaint) => complaint.path ?? "");
    if (attempt === turns && turns === 1 + run.input.turns.repairTurns && replaced.some((path) => !asked.has(path))) turns++;
    asked = new Set(replaced);
    if (attempt >= turns) break;
    (trace.repairs ??= []).push([...new Set(judged.complaints.map((complaint) => (complaint.code ? `${complaint.check}:${complaint.code}` : complaint.check)))]);
    text = repairNote(judged.complaints);
  }
  trace.durationMs = run.now() - started;
  if (!best?.answer) return { trace: { ...trace, outcome: "skipped", skipped: trace.skipped ?? "unparsed", unresolved: best?.complaints.map((c) => `${c.check}: ${c.message}`) ?? [] } };
  const unresolved = best.complaints.map((complaint) => `${complaint.check}: ${complaint.message}`);
  if (best.complaints.some((complaint) => !complaint.excusable && complaint.path === section.id)) return { trace: { ...trace, outcome: "skipped", skipped: "integrity", unparsed: undefined, unresolved } };
  return { judged: best, trace: { ...trace, outcome: unresolved.length ? "partial" : "accepted", skipped: undefined, unparsed: undefined, unresolved, excused: best.excused } };
}

function outcomeOf(run: Run, results: SectionResult[], prepareMs: number): NarrativeOutcome {
  const landed = results.filter((result) => result.judged?.answer !== undefined);
  const narrative = results.find((result) => result.trace.section === "narrative")?.judged;
  const usage = sumCallUsage(run.calls);
  const events: StateEvent[] = landed.flatMap((result) => result.judged!.events);
  const rejected = landed.flatMap((result, i) => result.judged!.rejected.map((item) => ({ chunk: i + 1, path: item.path, rejection: item.rejection, final: true })));
  const labels = results.find((result) => result.trace.section === "labels");
  const labelSection = SECTIONS.find((section) => section.id === "labels")!;
  const oneOffs = labels?.judged?.answer !== undefined ? labelSection.oneOffs!(labels.judged.answer, factsOf(run.input)) : [];
  return {
    kind: landed.length ? "diff" : "narrative-less",
    ...(landed.length ? {} : { reason: "empty" as const }),
    events, rejected,
    narrative: narrative?.answer !== undefined ? SECTIONS[0].narrative!(narrative.answer) : undefined,
    routeHealth: run.health, usage, calls: run.calls, missingChunks: [],
    timings: { prepareMs, callsMs: run.callsMs, validateMs: 0, totalMs: run.now() - run.started },
    model: `${run.model.provider}/${run.model.id}`, oneOffs, sections: results.map((result) => result.trace),
  };
}

export async function runSectionTurns(input: TurnsInput, deps: NarrativeDeps): Promise<NarrativeOutcome> {
  const now = deps.now ?? Date.now;
  const started = now();
  const empty = (reason: NarrativeOutcome["reason"]): NarrativeOutcome => ({ kind: "narrative-less", events: [], rejected: [], reason, routeHealth: input.routeHealth, usage: EMPTY_PASS_USAGE, calls: [], missingChunks: [], timings: { prepareMs: 0, callsMs: 0, validateMs: 0, totalMs: now() - started } });
  if (!input.model) return empty("no-model");
  if (!input.routeAvailable && !input.fallbackModel) return empty("route-skipped");
  const model = !input.routeAvailable && input.fallbackModel ? input.fallbackModel : input.model;
  const run: Run = { input, deps, now, started, model, usedFallback: model !== input.model, health: input.routeHealth, messages: [], calls: [], callsMs: 0 };
  try {
    const digest = digestOf(input);
    const facts = factsOf(input);
    const prepareMs = now() - started;
    const results: SectionResult[] = [];
    let state = input.state;
    for (const [index, section] of SECTIONS.entries()) {
      const result = await runSection(run, section, index, facts, digest, state);
      results.push(result);
      if (result.judged) state = result.judged.state;
    }
    return outcomeOf(run, results, prepareMs);
  } catch (error) {
    const aborted = input.signal?.aborted || isAbort(error);
    return { ...empty(aborted ? "aborted" : "schema"), calls: run.calls, routeHealth: run.health };
  }
}
