/**
 * Dry replay: a scripted session driven turn by turn through a REAL pi session -- pi's own
 * AgentSession, agent loop, compaction preparation and transcript -- with the real compaction-state
 * extension loaded and only the model faked. The model answers from the script; the summarizer
 * answers from a deterministic stand-in; tools are stand-ins that return the scripted output, so
 * nothing touches the host. Compactions happen where the script says, through pi's own `compact()`,
 * so what the extension sees is what pi hands it in production.
 *
 * Unit tests prove each piece of the pass on hand-built entries; this proves the pieces as pi
 * composes them, across several compactions and a restart.
 */
import { RECALL_TOOL, REMEMBER_TOOL } from "../tool-names.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { fauxAssistantMessage, fauxProvider, fauxToolCall, type AssistantMessage } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionAPI,
  type ExtensionFactory,
  type SessionEntry,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import compactionState from "../index.ts";
import { REQUEST_CHANNEL, RESPONSE_CHANNEL } from "../tasks.ts";

/**
 * One tool call the scripted model makes. bash/read/edit/write are stand-ins that answer `output`;
 * any other name is the real registered tool (remember, recall), which runs as it would live.
 */
export interface ScriptCall {
  tool: string;
  args: Record<string, unknown>;
  output?: string;
  /** The tool fails (pi records an error result). */
  error?: boolean;
}

/** One assistant message: tool calls (the loop continues) or, with none, the run's final text. */
export interface ScriptTurn {
  text?: string;
  calls?: ScriptCall[];
}

/** A notice with no turns is display-only (it triggers no run); an `entry` re-appends another extension's custom entry. */
export type ReplayStep =
  | { kind: "user"; text: string; turns: ScriptTurn[] }
  | { kind: "notice"; text: string; turns: ScriptTurn[] }
  | { kind: "entry"; customType: string; data: unknown }
  | { kind: "compact" }
  | { kind: "restart" };

export interface ScriptTask {
  id: string;
  name: string;
  startTime: number;
}

export interface ReplayOptions {
  /** The summarizer's answer to one narrative request (its prompt text); default: a quiet, valid diff. */
  summarizer?: (prompt: string) => string;
  /** What the background-task service reports running; undefined = no service on the bus. */
  tasks?: () => ScriptTask[];
  /** Extra extensions loaded beside compaction-state (pi-goal stand-ins and the like). */
  extensions?: ExtensionFactory[];
  /**
   * A recording, not a script: pi's run boundaries need not match the recorded ones, so a turn the
   * model is asked for beyond a run's recorded turns is a stub, and turns a run leaves unused are
   * dropped; both are counted instead of failing the replay.
   */
  lenient?: boolean;
}

export interface ReplayCompaction {
  summary: string;
  /** The state compactor wrote it (its details carry `compactor: "state"`), not pi's fallback. */
  byState: boolean;
  details: Record<string, unknown> | undefined;
}

export interface ReplayResult {
  compactions: ReplayCompaction[];
  /** Model requests the conversation made (summarizer requests excluded). */
  requests: number;
  summarizerRequests: number;
  /** Lenient replays: turns the model was asked for beyond the recording, and recorded turns left unused. */
  missingTurns: number;
  leftoverTurns: number;
  /** Lenient replays: recorded compactions pi refused here (nothing to compact, already compacted). */
  refusedCompactions: number;
  /** Extension handler errors pi reported. */
  errors: string[];
  /** The final transcript, as pi persisted it. */
  entries: SessionEntry[];
}

/** The quiet model labels every message "not a rule"; labels for messages outside the span are ignored (validate.ts). */
const NOT_RULES = Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`u${i + 1}`, "not a rule"]));
export const QUIET_DIFF = JSON.stringify({ narrative: "replayed span", labels: NOT_RULES, corrections: [], lifts: [], decisions: [], deadEnds: [], now: { inProgress: [], next: [], blocked: [], resume: "continue" } });

/** The narrative call's prompt opens with this (narrative/prompt.ts NARRATIVE_SYSTEM_PROMPT); conversation requests never do. */
const SUMMARIZER_MARK = "You maintain the SESSION STATE";

const textOf = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => (part && typeof part === "object" && "text" in part ? String(part.text) : "")).join("") : "";

const isSummarizerRequest = (messages: Array<{ role: string; content?: unknown }>): boolean =>
  messages.length === 1 && messages[0].role === "user" && textOf(messages[0].content).includes(SUMMARIZER_MARK);

/** Tools the replay runs for real: this extension's own. Every other name a step calls gets a stand-in. */
const REAL_TOOLS = new Set([REMEMBER_TOOL, RECALL_TOOL]);

function standInNames(steps: ReplayStep[]): string[] {
  const called = steps.flatMap((step) => ("turns" in step ? step.turns.flatMap((turn) => (turn.calls ?? []).map((call) => call.tool)) : []));
  return [...new Set(["bash", "read", "edit", "write", ...called])].filter((name) => !REAL_TOOLS.has(name));
}

function standInTools(names: string[], outputs: Map<string, ScriptCall>): ToolDefinition[] {
  return names.map((name) => ({
    name,
    label: name,
    description: `Replay stand-in for ${name}.`,
    parameters: Type.Object({}, { additionalProperties: true }),
    execute: async (toolCallId: string) => {
      const call = outputs.get(toolCallId);
      if (!call) throw new Error(`replay: no scripted output for ${toolCallId}`);
      if (call.error) throw new Error(call.output ?? "failed");
      return { content: [{ type: "text" as const, text: call.output ?? "" }], details: {} };
    },
  })) as unknown as ToolDefinition[];
}

/** Stands in for pi-background-tasks on pi's event bus: answers `status` with the scripted tasks. */
function taskService(tasks: () => ScriptTask[]): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    pi.events.on(REQUEST_CHANNEL, (data) => {
      const request = data as { request_id?: string; operation?: string };
      if (request.operation !== "status") return;
      const result = { tasks: tasks().map((task) => ({ ...task, command: task.name, status: "running", isAgent: false })) };
      queueMicrotask(() => pi.events.emit(RESPONSE_CHANNEL, { request_id: request.request_id, operation: "status", ok: true, result }));
    });
  };
}

/** The model's script, consumed in order; the summarizer's requests are answered out of band. */
class Script {
  readonly outputs = new Map<string, ScriptCall>();
  private queue: AssistantMessage[] = [];
  private calls = 0;
  requests = 0;
  summarizerRequests = 0;
  missingTurns = 0;
  leftoverTurns = 0;
  refusedCompactions = 0;

  private readonly summarizer: (prompt: string) => string;
  private readonly lenient: boolean;

  constructor(summarizer: (prompt: string) => string, lenient: boolean) {
    this.summarizer = summarizer;
    this.lenient = lenient;
  }

  load(turns: ScriptTurn[]): void {
    this.queue = turns.map((turn) => {
      if (!turn.calls?.length) return fauxAssistantMessage(turn.text ?? "done");
      const blocks = turn.calls.map((call) => {
        const id = `replay-call-${++this.calls}`;
        this.outputs.set(id, call);
        return fauxToolCall(call.tool, call.args as Parameters<typeof fauxToolCall>[1], { id });
      });
      return fauxAssistantMessage(blocks, { stopReason: "toolUse" });
    });
  }

  answer(messages: Array<{ role: string; content?: unknown }>): AssistantMessage {
    if (isSummarizerRequest(messages)) {
      this.summarizerRequests += 1;
      return fauxAssistantMessage("```json\n" + this.summarizer(textOf(messages[0].content)) + "\n```");
    }
    this.requests += 1;
    const next = this.queue.shift();
    if (next) return next;
    if (!this.lenient) throw new Error("replay: the model was asked for more turns than the script holds");
    this.missingTurns += 1;
    return fauxAssistantMessage("(replay: no recorded turn)");
  }

  /** A compaction pi refuses (its own preconditions) fails a script and is counted for a recording. */
  async compacting(compact: () => Promise<unknown>): Promise<void> {
    try {
      await compact();
    } catch (error) {
      const refused = error instanceof Error && /^(Nothing to compact|Already compacted)/.test(error.message);
      if (!this.lenient || !refused) throw error;
      this.refusedCompactions += 1;
    }
  }

  /** After a run: unused turns fail a script, and are counted and dropped for a recording. */
  settle(label: string): void {
    if (this.queue.length === 0) return;
    if (!this.lenient) throw new Error(`replay: the run ended with scripted turns left over (${label})`);
    this.leftoverTurns += this.queue.length;
    this.queue = [];
  }
}

interface Opened {
  session: AgentSession;
  /** The replay's own extension handle, for re-appending recorded custom entries. */
  pi: ExtensionAPI;
}

async function openSession(dir: string, sessionManager: SessionManager, script: Script, options: ReplayOptions & { standIns: string[] }, errors: string[]): Promise<Opened> {
  const faux = fauxProvider();
  faux.setResponses(Array.from({ length: 10_000 }, () => (context: { messages: unknown[] }) => script.answer(context.messages as never)));
  const modelRuntime = await ModelRuntime.create({ authPath: path.join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  // keepRecentTokens 1: a compaction always has a span to summarize, however short the script.
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 1 } });
  let handle: ExtensionAPI | undefined;
  const writer: ExtensionFactory = (pi) => {
    handle = pi;
  };
  const extensions = [compactionState, writer, ...(options.tasks ? [taskService(options.tasks)] : []), ...(options.extensions ?? [])];
  const resourceLoader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager, extensionFactories: extensions, noSkills: true, noPromptTemplates: true, noContextFiles: true });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd: dir, agentDir: dir, modelRuntime, model: faux.getModel(), thinkingLevel: "off", resourceLoader, settingsManager, sessionManager,
    noTools: "builtin", customTools: standInTools(options.standIns, script.outputs),
  });
  await session.bindExtensions({ onError: (error) => errors.push(`${error.event}: ${error.error}`) });
  if (!handle) throw new Error("replay: the writer extension was not loaded");
  return { session, pi: handle };
}

const isCompaction = (entry: SessionEntry): entry is Extract<SessionEntry, { type: "compaction" }> => entry.type === "compaction";

function compactionsOf(entries: SessionEntry[]): ReplayCompaction[] {
  return entries.filter(isCompaction).map((entry) => {
    const details = entry.details as Record<string, unknown> | undefined;
    return { summary: entry.summary, byState: details?.compactor === "state", details };
  });
}

async function runStep({ session, pi }: Opened, script: Script, step: Exclude<ReplayStep, { kind: "restart" }>): Promise<void> {
  if (step.kind === "compact") {
    await script.compacting(() => session.compact());
    return;
  }
  if (step.kind === "entry") {
    pi.appendEntry(step.customType, step.data);
    return;
  }
  script.load(step.turns);
  if (step.kind === "user") await session.prompt(step.text);
  else await session.sendCustomMessage({ customType: "replay-notice", content: step.text, display: false }, { triggerTurn: step.turns.length > 0 });
  script.settle(`${step.kind} step ${step.turns.length} turns`);
}

/** Set `values` in process.env; the returned function puts back what was there. */
function pinEnv(values: Record<string, string>): () => void {
  const previous = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  Object.assign(process.env, values);
  return () => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

/**
 * Run `steps` through a real pi session in a fresh temp directory (removed afterwards). The session
 * is persisted, so `restart` reopens the same transcript in a new session, as a relaunched pi would.
 */
export async function replay(steps: ReplayStep[], options: ReplayOptions = {}): Promise<ReplayResult> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "compaction-state-replay-"));
  const sessionDir = path.join(dir, "sessions");
  const script = new Script(options.summarizer ?? (() => QUIET_DIFF), options.lenient === true);
  const sessionOptions = { ...options, standIns: standInNames(steps) };
  const errors: string[] = [];
  // No debug log from a replay, and the state compactor selected whatever the user's shell says.
  const restoreEnv = pinEnv({ PI_COMPACT_STATE_DEBUG: "off", PI_COMPACTOR: "state" });
  // Inside the try, so a setup failure still restores the env and removes the copy of the transcript.
  let opened: Awaited<ReturnType<typeof openSession>> | undefined;
  try {
    opened = await openSession(dir, SessionManager.create(dir, sessionDir), script, sessionOptions, errors);
    for (const step of steps) {
      if (step.kind !== "restart") {
        await runStep(opened, script, step);
        continue;
      }
      const file = opened.session.sessionManager.getSessionFile();
      opened.session.dispose();
      if (!file) throw new Error("replay: restart needs a persisted session");
      opened = await openSession(dir, SessionManager.open(file, sessionDir), script, sessionOptions, errors);
    }
    const entries = opened.session.sessionManager.getEntries();
    const { requests, summarizerRequests, missingTurns, leftoverTurns, refusedCompactions } = script;
    return { compactions: compactionsOf(entries), requests, summarizerRequests, missingTurns, leftoverTurns, refusedCompactions, errors, entries };
  } finally {
    opened?.session.dispose();
    restoreEnv();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
