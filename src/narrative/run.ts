/**
 * The narrative driver: plan chunks, then per chunk render -> call -> parse -> validate -> decide,
 * with the retry ladder from call.ts and route health carried in and out as data. Never throws:
 * every failure is an outcome the pass logs as one record. Stages are injectable through
 * deps.stages so a test or the scorer can inject a fault or a candidate; override a stage to inject,
 * never to skip one.
 */
import { planReasoning } from "./reasoning.ts";
import type { Model } from "@earendil-works/pi-ai";

import type { StateEvent } from "../store/events.ts";
import type { SessionState } from "../store/project.ts";
import type { VerifyContext } from "../store/verify.ts";
import { callNarrativeModel, decideNextStep, isAbort, type ModelCall } from "./call.ts";
import { mergeChunkDiffs } from "./merge.ts";
import type { NarrativePolicy } from "./policy.ts";
import type { SpanInput } from "./prepare.ts";
import { fixedPromptChars, planChunks, renderNarrativePrompt, SEED_CONTEXT_EXCERPT_CHARS, type PromptState } from "./prompt.ts";
import { onRouteFailure, onRouteSuccess, routedRetryPolicy, type RouteHealthConfig, type RouteHealthState } from "./route-health.ts";
import type { CallTrace, NarrativeDiff, NarrativeOutcome, NotADiffReason } from "./types.ts";
import type { LearnedValue } from "../learned.ts";
import { quotableText } from "../intent.ts";
import { spanTextsOf, withEarlierTurns, type SpanTexts } from "./named-values.ts";
import { validateNarrativeDiff, type FieldError, type LabelQuestion, type Labelling } from "./validate.ts";
import { isContextOverflowMessage } from "./fit.ts";
import { renderWarmPrompt, WARM_HEAD, warmFits, type WarmBase } from "./warm.ts";
import { extractJsonCandidate } from "./parse.ts";
import { labelOf } from "./message-labels.ts";
import { addCallUsage, EMPTY_PASS_USAGE } from "./usage.ts";

export interface NarrativeInput {
  span: SpanInput;
  /** On a switchover, the turns before the span, where a value the previous summary carried can be checked (named-values.ts withEarlierTurns); built on first use. */
  earlierTurns?: () => SpanTexts | undefined;
  /** A user message's own words by ordinal (the message index). */
  userTextOf?: (ordinal: string) => string | undefined;
  state: SessionState;
  promptState: PromptState;
  verify: Omit<VerifyContext, "state">;
  customInstructions?: string;
  model?: Model<any>;
  fallbackModel?: Model<any>;
  routeHealth: RouteHealthState;
  routeConfig: RouteHealthConfig;
  routeAvailable: boolean;
  policy: NarrativePolicy;
  signal?: AbortSignal;
  /** The session's own last request (warm.ts): when it fits, the span is narrated from it in one call. */
  warm?: WarmBase;
}

export interface Stages {
  plan: typeof planChunks;
  render: typeof renderNarrativePrompt;
  call: typeof callNarrativeModel;
  validate: typeof validateNarrativeDiff;
  merge: typeof mergeChunkDiffs;
}

export interface NarrativeDeps {
  call: ModelCall;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  stages?: Partial<Stages>;
}

interface ChunkOutcome { values?: LearnedValue[]; withdrawn?: string[]; questions?: LabelQuestion[]; diff?: NarrativeDiff; events: StateEvent[]; rejected: NarrativeOutcome["rejected"]; state: SessionState; reason?: NotADiffReason; model?: string; warmOverflow?: true }

type Run = { input: NarrativeInput; stages: Stages; deps: NarrativeDeps; now: () => number; calls: CallTrace[]; health: RouteHealthState; usage: NarrativeOutcome["usage"]; callsMs: number; validateMs: number; warm?: WarmBase; started: number; prepareMs?: number; spanTexts?: () => SpanTexts };


function emptyOutcome(run: Run, kind: NarrativeOutcome["kind"], reason: NarrativeOutcome["reason"], started: number, prepareMs: number): NarrativeOutcome {
  return { kind, events: [], rejected: [], reason, routeHealth: run.health, usage: run.usage, calls: run.calls, missingChunks: [], timings: { prepareMs, callsMs: run.callsMs, validateMs: run.validateMs, totalMs: run.now() - started } };
}

/** One attempt on one model; returns the parse result and whether the transport threw. */
async function attemptOn(run: Run, model: Model<any>, prompt: string, chunk: number, attempt: number, raise: boolean, policy: NarrativeInput["policy"] = run.input.policy) {
  const started = run.now();
  const result = await run.stages.call({ model, prompt, chunk, attempt, raise, policy, signal: run.input.signal, sleep: run.deps.sleep, now: run.now, warm: run.warm }, run.deps.call);
  run.callsMs += run.now() - started;
  run.calls.push(result.trace);
  run.usage = addCallUsage(run.usage, result.trace.usage);
  return result;
}

const specOf = (model: Model<any>): string => `${model.provider}/${model.id}`;

/**
 * The routed model, falling back to the session model once when the route's transport fails. An
 * open breaker (`routeAvailable` false, route-health.ts) never tries the route: the session model
 * answers directly and the health stays as it was, since no attempt on the route was made. With the
 * session model waiting, the routed attempt retries its transport only `routeMaxRetries` times (routedRetryPolicy).
 */
async function callWithRoute(run: Run, prompt: string, chunk: number, attempt: number, raise: boolean) {
  const routed = run.input.model!;
  const fallback = run.input.fallbackModel;
  if (fallback && !run.input.routeAvailable) {
    const only = await attemptOn(run, fallback, prompt, chunk, attempt, raise);
    return { ...only, model: specOf(fallback) };
  }
  const first = await attemptOn(run, routed, prompt, chunk, attempt, raise, fallback ? { ...run.input.policy, transportRetry: routedRetryPolicy(run.input.routeConfig, run.input.policy.transportRetry.baseDelayMs) } : run.input.policy);
  if ("parsed" in first) {
    if (fallback) run.health = onRouteSuccess(run.health);
    return { ...first, model: specOf(routed) };
  }
  if (!fallback) return { ...first, model: specOf(routed) };
  run.health = onRouteFailure(run.health, run.now(), run.input.routeConfig);
  const second = await attemptOn(run, fallback, prompt, chunk, attempt, raise);
  return { ...second, model: specOf(fallback) };
}

/** The carried messages' words (prepare.ts carryUnlabeled), in order. */
function carriedOf(span: SpanInput): Array<{ ordinal: string; text: string }> {
  const carried = new Set(span.carried ?? []);
  return span.ordinals.filter((entry) => carried.has(entry.ordinal)).map((entry) => ({ ordinal: entry.ordinal, text: entry.text ?? entry.excerpt }));
}

/** The messages this chunk must label: those whose ordinal tag its conversation carries; a warm call sees the whole span. */
function labellingOf(run: Run, conversation: string, chunkIndex: number): Labelling {
  const span = run.input.span.ordinals.map((entry) => entry.ordinal);
  const context = run.input.promptState.seed ? run.input.promptState.seedContext ?? [] : [];
  const tagged = new Set([...conversation.matchAll(/\[(u\d+)\] /g)].map((match) => match[1]));
  // Seed rules need no label (validate.ts Labelling.seed), but may carry one; a withdrawal of one is checked against its words.
  const seedRules = run.input.promptState.seed ? run.input.promptState.seedRules ?? [] : [];
  // A seed rule's own text, not the whitespace-flattened one the prompt shows: a blockquote must still read as one (ownWords).
  const seedText = (entry: { ordinal: string; text: string }) => { const raw = run.input.userTextOf?.(entry.ordinal); return raw === undefined ? entry.text : quotableText(raw).trim(); };
  const texts = new Map([...seedRules.map((entry) => [entry.ordinal, seedText(entry)] as const), ...context.map((entry) => [entry.ordinal, entry.text] as const), ...run.input.span.ordinals.map((entry) => [entry.ordinal, entry.text ?? entry.excerpt] as const)]);
  const spanTexts = (run.spanTexts ??= lazySpanTexts(run));
  // Carried messages and the switchover's other earlier messages are in no chunk's conversation: the first chunk
  // labels them. An earlier rule with no rule word in it ("tests go under tests/") is carried only by its label.
  const first = chunkIndex === 1 || run.warm ? [...(run.input.span.carried ?? []), ...context.map((entry) => entry.ordinal)] : [];
  const cut = new Set(context.map((entry) => entry.ordinal));
  const seed = seedRules.map((entry) => entry.ordinal);
  // In message order, so a rule is recorded before a later message's label lifts it.
  const known = [...new Set([...seed, ...cut, ...span])].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  const seedOwned = chunkIndex === 1 || run.warm !== undefined;
  return { required: [...new Set([...first, ...(run.warm ? span : span.filter((ordinal) => tagged.has(ordinal)))])], known, textOf: (ordinal) => texts.get(ordinal), spanTexts, shownChars: (ordinal) => (cut.has(ordinal) ? SEED_CONTEXT_EXCERPT_CHARS : undefined), ...(seed.length ? { seed, seedOwned } : {}) };
}

/** The span's turn texts, and on a switchover the earlier turns, built only when an answer names a value. */
function lazySpanTexts(run: Run): () => SpanTexts {
  let built: SpanTexts | undefined;
  return () => (built ??= withEarlierTurns(spanTextsOf(run.input.span.messages), run.input.earlierTurns?.()));
}

function validateAttempt(run: Run, diff: NarrativeDiff, state: SessionState, chunk: { index: number; conversation: string }) {
  const started = run.now();
  const validated = run.stages.validate(diff, { ...run.input.verify, state }, labellingOf(run, chunk.conversation, chunk.index));
  run.validateMs += run.now() - started;
  return validated;
}

/** An answer that parsed, accepted as it stands: its fixable errors dropped and logged final. */
function acceptedOutcome(chunk: number, diff: NarrativeDiff, validated: ReturnType<typeof validateNarrativeDiff>, model: string | undefined): ChunkOutcome {
  const dropped = validated.errors.filter((error) => error.fixable);
  return { diff, events: validated.events, rejected: dropped.map((error) => ({ chunk, path: error.path, rejection: error.rejection, final: true })), state: validated.state, model, ...(validated.values ? { values: validated.values } : {}), ...(validated.withdrawn ? { withdrawn: validated.withdrawn } : {}), ...(validated.questions ? { questions: validated.questions } : {}) };
}

/**
 * The retry ladder for one chunk. An answer that parsed is kept as the fallback while a retry tries
 * to rescue its field errors, so a retry that fails to parse at all costs the rescue, never the
 * answer: the chunk lands with the earlier answer's errors dropped instead of going missing.
 */
async function runChunk(run: Run, chunk: { index: number; conversation: string }, total: number, state: SessionState): Promise<ChunkOutcome> {
  let retryNote: string | undefined;
  let previousErrors: FieldError[] = [];
  let lastReason: NotADiffReason = "empty";
  let fallback: { outcome: ChunkOutcome; trace: CallTrace } | undefined;
  // An answer cut off at the output limit with nothing usable: thinking the model config did not declare spent it.
  let ranOut = false;
  const used = (chosen: { outcome: ChunkOutcome; trace: CallTrace }): ChunkOutcome => { chosen.trace.dropped = chosen.outcome.rejected.length; return chosen.outcome; };
  // A lift-replaced refusal is a question back, not a mistake: the rule it aimed at was replaced, maybe by a label of
  // this same answer, and only the model can say whether the replacement goes too. One first raised on the last call
  // gets one more call, once per chunk, rather than being dropped unanswered.
  // A rule label that may replace an earlier rule (validate.ts replacementQuestions) is asked about once the chunk's
  // answer is settled, never in a retry note: a retry rewrites the whole answer, and a question there could cost a
  // long message its rule's words. Not after a call that threw: the route that just failed is not asked again.
  let lastThrew = false;
  const finish = async (chosen: { outcome: ChunkOutcome; trace: CallTrace }): Promise<ChunkOutcome> => used(lastThrew ? chosen : await askReplacements(run, chunk, total, state, chosen));
  let calls = 1 + run.input.policy.fixableRetries;
  for (let attempt = 1; attempt <= calls; attempt++) {
    const shared = { state: run.input.promptState, ordinals: run.input.span.ordinals, carried: carriedOf(run.input.span), customInstructions: run.input.customInstructions, retryNote };
    const prompt = run.warm ? renderWarmPrompt(shared) : run.stages.render({ ...shared, conversation: chunk.conversation, chunk: { index: chunk.index, total } });
    const result = await callWithRoute(run, prompt, chunk.index, attempt, ranOut);
    const trace = run.calls[run.calls.length - 1];
    if ("thrown" in result) trace.errors.push(String(result.thrown.message));
    // The base did not fit after all (an under-measured size): the same warm request would fail again (security.md T7).
    if (run.warm && trace.errors.some(isContextOverflowMessage)) return { events: [], rejected: [], state, reason: "empty", warmOverflow: true };
    lastThrew = "thrown" in result;
    if ("thrown" in result) { lastReason = "empty"; continue; }
    if (!result.parsed.ok) trace.errors.push(result.parsed.detail);
    ranOut = !result.parsed.ok && trace.stopReason === "length";
    const validated = result.parsed.ok ? validateAttempt(run, result.parsed.diff, state, chunk) : undefined;
    const fieldErrors = validated?.errors ?? [];
    trace.fieldErrors = fieldErrors.map((error) => `${error.path}: ${error.rejection.code}${"reason" in error.rejection ? ` (${error.rejection.reason})` : ""}`);
    trace.rescued = previousErrors.filter((previous) => !fieldErrors.some((error) => error.path === previous.path)).length;
    const replacedAsked = fieldErrors.some((error) => error.rejection.code === "lift-replaced" && !previousErrors.some((previous) => previous.path === error.path && previous.rejection.code === "lift-replaced"));
    if (attempt === calls && calls === 1 + run.input.policy.fixableRetries && replacedAsked) calls++;
    const next = decideNextStep({ parsed: result.parsed, fieldErrors, attempt, policy: { ...run.input.policy, fixableRetries: calls - 1 }, noteChars: run.input.policy.retryNoteChars });
    if (validated && result.parsed.ok) {
      const accepted = { outcome: acceptedOutcome(chunk.index, result.parsed.diff, validated, result.model), trace };
      if (next.step === "accept") return finish(accepted);
      fallback = accepted;
    }
    if (next.step === "give-up") return fallback ? finish(fallback) : { events: [], rejected: [], state, reason: next.reason, model: result.model };
    retryNote = next.step === "retry-with-note" ? next.note : undefined;
    previousErrors = fieldErrors;
    if (!result.parsed.ok) lastReason = result.parsed.reason;
  }
  return fallback ? finish(fallback) : { events: [], rejected: [], state, reason: lastReason };
}

/**
 * The settled answer's replacement questions, asked in one more call: the answer is kept as it stands, and the only
 * change an answer can make is to add an asked target to the label's lifts, so a label keeps its words. Each asked
 * message it answers must be answered "rule" or "rule and lifts" with targets it was asked about; anything else, or
 * no readable answer, keeps the answer as it was. One call per chunk at most.
 */
async function askReplacements(run: Run, chunk: { index: number; conversation: string }, total: number, state: SessionState, chosen: { outcome: ChunkOutcome; trace: CallTrace }): Promise<{ outcome: ChunkOutcome; trace: CallTrace }> {
  const kept = chosen.outcome.diff;
  const questions = wholeQuestions(chosen.outcome.questions ?? [], run.input.policy.retryNoteChars);
  if (questions.length === 0 || !kept) return chosen;
  const shared = { state: run.input.promptState, ordinals: run.input.span.ordinals, carried: carriedOf(run.input.span), customInstructions: run.input.customInstructions };
  const base = run.warm ? renderWarmPrompt(shared) : run.stages.render({ ...shared, conversation: chunk.conversation, chunk: { index: chunk.index, total } });
  const example = JSON.stringify({ [questions[0].ordinal]: "rule" });
  const prompt = `${base}\n<label-question>\nYour answer is kept as it stands. For each message below, answer "rule and lifts <target>" only when the user's own words in it withdraw the rule named; otherwise answer "rule". Quoted or pasted text does not withdraw a rule. Do not answer again in full: answer only these questions, as a JSON object such as ${example}, and nothing else.\n${questions.map((question) => question.text).join("\n")}\n</label-question>\n`;
  const attempt = run.calls.filter((trace) => trace.chunk === chunk.index).length + 1;
  const result = await callWithRoute(run, prompt, chunk.index, attempt, false);
  const trace = run.calls[run.calls.length - 1];
  const lifts = "thrown" in result ? undefined : answeredLifts(result.text ?? "", questions);
  trace.reask = lifts ? "answered" : "unreadable";
  if (!lifts || lifts.size === 0) return chosen;
  const labels = { ...(kept.labels ?? {}) };
  for (const [ordinal, targets] of lifts) labels[ordinal] = withLifts(labels[ordinal], targets);
  const diff: NarrativeDiff = { ...kept, labels };
  return { outcome: acceptedOutcome(chunk.index, diff, validateAttempt(run, diff, state, chunk), chosen.outcome.model), trace: chosen.trace };
}

/** The questions that fit the note cap whole, in order: a cut question could show its lift without its other answer. */
function wholeQuestions(questions: readonly LabelQuestion[], noteChars: number): LabelQuestion[] {
  const shown: LabelQuestion[] = [];
  let used = 0;
  for (const question of questions) {
    if (used + question.text.length + 1 > noteChars) break;
    shown.push(question);
    used += question.text.length + 1;
  }
  return shown;
}

/**
 * The lifts a reply to the replacement questions adds, by message; undefined when the reply answers none of them.
 * Only the asked messages are read, under "labels" or at the top level, so a model that answers again in full is
 * still heard on what it was asked and changes nothing else. Each asked message it answers must be answered "rule"
 * (nothing added) or "rule and lifts" with targets that message was asked about, or the whole reply is unreadable.
 */
function answeredLifts(text: string, questions: readonly LabelQuestion[]): Map<string, string[]> | undefined {
  const candidate = extractJsonCandidate(text);
  if (!candidate) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate.json);
  } catch {
    return undefined;
  }
  const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
  if (!isRecord(parsed)) return undefined;
  const replies = isRecord(parsed.labels) ? parsed.labels : parsed;
  const lifts = new Map<string, string[]>();
  let answered = 0;
  for (const ordinal of new Set(questions.map((question) => question.ordinal))) {
    if (!Object.hasOwn(replies, ordinal)) continue;
    const askable = new Set(questions.filter((question) => question.ordinal === ordinal).map((question) => question.target));
    const reply = replies[ordinal];
    const label = typeof reply === "string" ? labelOf(reply) : undefined;
    if (!label || typeof label === "string" || label.kind !== "rule") return undefined;
    if (!(label.lifts ?? []).every((target) => askable.has(target))) return undefined;
    answered++;
    if (label.lifts?.length) lifts.set(ordinal, label.lifts);
  }
  return answered > 0 ? lifts : undefined;
}

/** A kept rule label with lifts added: its words, when it gave them, stay. */
function withLifts(kept: unknown, targets: readonly string[]): unknown {
  // A seed rule left unlabeled was labeled "rule" by validation (validate.ts Labelling.seed).
  if (kept === undefined) return `rule and lifts ${[...new Set(targets)].join(", ")}`;
  const label = labelOf(kept);
  if (typeof label === "string" || label.kind !== "rule") return kept;
  const lifts = [...new Set([...(label.lifts ?? []), ...targets])];
  return label.words ? { rule: label.words, lifts } : `rule and lifts ${lifts.join(", ")}`;
}

/** Plan the chunks (one warm chunk, or the re-encoded ones) and narrate them in order. */
async function planAndRun(run: Run, fixedChars: number): Promise<{ plan: ReturnType<Stages["plan"]>; outcomes: ChunkOutcome[] }> {
  const { input, stages } = run;
  const contextWindow = input.model?.contextWindow ?? 0;
  const outputBudget = input.model ? planReasoning(input.model, input.policy.outputTokens).maxTokens : input.policy.outputTokens;
  const plan = run.warm ? { chunks: [{ index: 1, conversation: "", messageCount: input.span.messages.length, capped: false }], total: 1, truncated: false } : stages.plan({ messages: input.span.messages, fixedChars, outputBudget, contextWindow, maxChunks: input.policy.maxChunks });
  run.prepareMs ??= run.now() - run.started;
  const outcomes: ChunkOutcome[] = [];
  let state = input.state;
  for (const chunk of plan.chunks) {
    const outcome = await runChunk(run, chunk, plan.total, state);
    outcomes.push(outcome);
    state = outcome.state;
    if (outcome.warmOverflow) break;
  }
  return { plan, outcomes };
}

export async function runNarrativeCall(input: NarrativeInput, deps: NarrativeDeps): Promise<NarrativeOutcome> {
  const now = deps.now ?? Date.now;
  const started = now();
  const stages: Stages = { plan: planChunks, render: renderNarrativePrompt, call: callNarrativeModel, validate: validateNarrativeDiff, merge: mergeChunkDiffs, ...deps.stages };
  const run: Run = { input, stages, deps, now, calls: [], health: input.routeHealth, usage: EMPTY_PASS_USAGE, callsMs: 0, validateMs: 0, started };
  if (!input.model) return emptyOutcome(run, "narrative-less", "no-model", started, 0);
  if (!input.routeAvailable && !input.fallbackModel) return emptyOutcome(run, "narrative-less", "route-skipped", started, 0);
  try {
    const fixedChars = fixedPromptChars({ state: input.promptState, ordinals: input.span.ordinals, carried: carriedOf(input.span), customInstructions: input.customInstructions }, input.policy.retryNoteChars);
    run.warm = input.warm && warmFits(input.warm, fixedChars + WARM_HEAD.length, planReasoning(input.model, input.policy.outputTokens).maxTokens, input.model.contextWindow) ? input.warm : undefined;
    let { plan, outcomes } = await planAndRun(run, fixedChars);
    if (outcomes.some((outcome) => outcome.warmOverflow)) {
      run.warm = undefined;
      ({ plan, outcomes } = await planAndRun(run, fixedChars));
    }
    const prepareMs = run.prepareMs ?? 0;
    if (plan.chunks.length === 0) return emptyOutcome(run, "narrative-less", "truncated", started, prepareMs);
    const merged = stages.merge(outcomes.map((outcome) => outcome.diff));
    const base = { routeHealth: run.health, usage: run.usage, calls: run.calls, timings: { prepareMs, callsMs: run.callsMs, validateMs: run.validateMs, totalMs: now() - started }, model: outcomes.find((outcome) => outcome.diff)?.model ?? outcomes.at(-1)?.model };
    if (!merged) return { ...base, kind: "narrative-less", events: [], rejected: [], reason: outcomes.at(-1)?.reason ?? "empty", missingChunks: plan.chunks.map((chunk) => chunk.index) };
    return { ...base, kind: "diff", events: outcomes.flatMap((outcome) => outcome.events), rejected: outcomes.flatMap((outcome) => outcome.rejected), narrative: merged.diff.narrative, missingChunks: merged.missingChunks, oneOffs: outcomes.flatMap((outcome) => [...(outcome.diff?.oneOffs ?? []), ...(outcome.withdrawn ?? [])]), values: outcomes.flatMap((outcome) => outcome.values ?? []) };
  } catch (error) {
    if (isAbort(error) || input.signal?.aborted) return emptyOutcome(run, "narrative-less", "aborted", started, 0);
    const trace = run.calls[run.calls.length - 1];
    if (trace) trace.errors.push(String((error as Error).message ?? error));
    else run.calls.push({ chunk: 0, attempt: 0, verdict: "schema", fieldErrors: [], dropped: 0, rescued: 0, retries: 0, errors: [String((error as Error).message ?? error)], durationMs: 0 });
    return emptyOutcome(run, "narrative-less", "schema", started, 0);
  }
}
