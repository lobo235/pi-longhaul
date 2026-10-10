/**
 * One cell of the model matrix: a short real session on a real model, one compaction through Longhaul, and a
 * recall question after it. It answers "does Longhaul work on this provider and model?", which the scorer and
 * the evaluation sessions do not: they measure what a summary carries, on models already known to work.
 *
 *   node eval/matrix.ts --agent-dir DIR --model provider/id [--thinking LEVEL] [--installed] [--keep]
 *
 * DIR is an agent dir made for the matrix, never your own: it holds the models.json, and the auth.json of any
 * login, for the model under test, and Longhaul's log is read from DIR/logs. The session runs in a new temporary
 * directory holding a copy of this repository's src/narrative/ and README.md, with the read-only tools only
 * (read, grep, find, ls) and no other extension, so a cloud model sees nothing but this public code.
 * `--installed` loads Longhaul from DIR's own packages (`pi install` into DIR) instead of this checkout, with
 * whatever else DIR has installed: the check that the published package works in a fresh agent dir. The
 * project's own .pi/settings.json keeps a small window, so four short turns leave something to compact.
 *
 * Prints one JSON line: the model, the verdict (matrix-verdict.ts), the reasoning level the diff call asked
 * for, the pass's tokens and time, and what the state and the session kept. No message text. Exits 1 when
 * the cell fails. One cell per agent dir at a time.
 */
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { parseArgs } from "node:util";

import { matrixVerdict, type MatrixRecord } from "./matrix-verdict.ts";

const repo = path.join(import.meta.dirname, "..");
/** A hosted model can take minutes per turn (one turn on ollama.com took 8); 10 min failed slow cells that were working. */
const TURN_TIMEOUT_MS = 20 * 60_000;
/** Small enough that a terse model's four turns still leave the rule and the value to compact (gpt-oss kept 2000 whole). */
const KEEP_RECENT_TOKENS = 500;

const TURNS = [
  "Read src/narrative/reasoning.ts and tell me in two sentences what planReasoning decides.",
  "From now on, never suggest edits to anything under src/narrative/; only describe what the code does.",
  "Find where LOWEST_REASONING_OUTPUT_TOKENS is defined and tell me its value.",
  "List the files in src/narrative/ and name the three largest by line count.",
];
const RECALL = "Without using any tools: what value did you find for LOWEST_REASONING_OUTPUT_TOKENS, and what did I ask of you about src/narrative/?";
const EXPECT = { value: "8192", rule: /src\/narrative/, ruleQuote: "never suggest edits to anything under src/narrative/" };

type Event = {
  type?: string; id?: string; command?: string; success?: boolean; error?: string; data?: { text?: string | null; summary?: string };
  message?: { role?: string; stopReason?: string; errorMessage?: string };
};

/** A provider error is printed, so it is cut short: it names the cause, never a message. */
const ERROR_CHARS = 300;

/** pi in RPC mode: commands by id, and a wait for the run a prompt starts to settle. */
class Rpc {
  private listeners = new Set<(event: Event) => void>();
  private next = 0;
  private child: ChildProcess;

  constructor(child: ChildProcess) {
    this.child = child;
    readline.createInterface({ input: child.stdout! }).on("line", (line) => {
      let event: Event;
      try { event = JSON.parse(line) as Event; } catch { return; }
      for (const listener of this.listeners) listener(event);
    });
  }

  private until<T>(what: string, match: (event: Event) => T | undefined): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.listeners.delete(listener); reject(new Error(`${what}: no answer in ${TURN_TIMEOUT_MS / 60_000} min`)); }, TURN_TIMEOUT_MS);
      const listener = (event: Event) => {
        let found: T | undefined;
        try { found = match(event); } catch (error) { clearTimeout(timer); this.listeners.delete(listener); reject(error); return; }
        if (found === undefined) return;
        clearTimeout(timer);
        this.listeners.delete(listener);
        resolve(found);
      };
      this.listeners.add(listener);
    });
  }

  private send(command: object): string {
    const id = `m${this.next++}`;
    this.child.stdin!.write(JSON.stringify({ ...command, id }) + "\n");
    return id;
  }

  /** Sends a command and resolves with pi's response to it. */
  command(command: { type: string } & Record<string, unknown>): Promise<Event> {
    const id = `m${this.next}`;
    const answer = this.until(command.type, (event) => (event.type === "response" && event.id === id ? event : undefined));
    this.send(command);
    return answer;
  }

  /** Sends a prompt and resolves when pi settles, with the number of tool calls the run made and its provider errors. */
  async prompt(message: string): Promise<{ toolCalls: number; errors: string[] }> {
    const id = `m${this.next}`;
    let toolCalls = 0;
    const errors: string[] = [];
    const settled = this.until(`prompt ${id}`, (event) => {
      if (event.type === "tool_execution_start") toolCalls += 1;
      if (event.type === "message_end" && event.message?.role === "assistant" && event.message.stopReason === "error") {
        errors.push((event.message.errorMessage ?? "no error given").slice(0, ERROR_CHARS));
      }
      if (event.type === "response" && event.id === id && event.success === false) throw new Error(`prompt rejected: ${event.error}`);
      return event.type === "agent_settled" ? true : undefined;
    });
    this.send({ type: "prompt", message });
    await settled;
    return { toolCalls, errors };
  }
}

function makeProject(root: string): string {
  const project = path.join(root, "project");
  fs.mkdirSync(path.join(project, "src"), { recursive: true });
  fs.cpSync(path.join(repo, "src", "narrative"), path.join(project, "src", "narrative"), { recursive: true });
  fs.copyFileSync(path.join(repo, "README.md"), path.join(project, "README.md"));
  // A short session has less than pi's default kept window, and pi will not compact one; this project's own
  // settings keep less. The harness writes every file here, which is why the run may approve them.
  fs.mkdirSync(path.join(project, ".pi"));
  fs.writeFileSync(path.join(project, ".pi", "settings.json"), JSON.stringify({ compaction: { keepRecentTokens: KEEP_RECENT_TOKENS } }));
  return project;
}

function readLogFrom(agentDir: string, offset: number): MatrixRecord[] {
  const file = path.join(agentDir, "logs", "compaction-state.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file).subarray(offset).toString("utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as MatrixRecord);
}

function logSize(agentDir: string): number {
  try { return fs.statSync(path.join(agentDir, "logs", "compaction-state.jsonl")).size; } catch { return 0; }
}

/** One cell per agent dir at a time: two cells would append to one log. A crashed cell leaves the lock behind. */
function lockAgentDir(agentDir: string): () => void {
  const lock = path.join(agentDir, "matrix.lock");
  try { fs.closeSync(fs.openSync(lock, "wx", 0o600)); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`another cell is running in ${agentDir} (remove ${lock} if none is)`);
    throw error;
  }
  return () => fs.rmSync(lock, { force: true });
}

/** The matrix must never run in the agent dir of the person running it: it writes a log there and logs in. */
function checkedAgentDir(dir: string): string {
  const resolved = fs.realpathSync(dir);
  const own = [path.join(os.homedir(), ".pi", "agent"), process.env.PI_CODING_AGENT_DIR].filter((item): item is string => Boolean(item));
  if (own.some((item) => fs.existsSync(item) && fs.realpathSync(item) === resolved)) {
    throw new Error(`--agent-dir ${dir} is your own agent dir; make one for the matrix (see eval/README.md)`);
  }
  if (!fs.existsSync(path.join(resolved, "models.json")) && !fs.existsSync(path.join(resolved, "auth.json"))) {
    throw new Error(`--agent-dir ${dir} has neither models.json nor auth.json: no model to test`);
  }
  return resolved;
}

function childEnv(agentDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: agentDir };
  for (const name of Object.keys(env)) if (name.startsWith("PI_COMPACT") || name === "PI_COMPACTOR") delete env[name];
  return env;
}

async function runCell(rpc: Rpc): Promise<{ compact: Event; compactMs: number; recall: string; recallToolCalls: number; turnErrors: string[] }> {
  const turnErrors: string[] = [];
  for (const [index, turn] of TURNS.entries()) {
    process.stderr.write(`turn ${index + 1}/${TURNS.length}\n`);
    turnErrors.push(...(await rpc.prompt(turn)).errors);
  }
  process.stderr.write("compact\n");
  const started = Date.now();
  const compact = await rpc.command({ type: "compact" });
  const compactMs = Date.now() - started;
  process.stderr.write("recall\n");
  const recallToolCalls = (await rpc.prompt(RECALL)).toolCalls;
  const last = await rpc.command({ type: "get_last_assistant_text" });
  return { compact, compactMs, recall: last.data?.text ?? "", recallToolCalls, turnErrors };
}

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { "agent-dir": { type: "string" }, model: { type: "string" }, thinking: { type: "string" }, keep: { type: "boolean" }, installed: { type: "boolean" } } });
  if (!values["agent-dir"] || !values.model) throw new Error("usage: matrix.ts --agent-dir DIR --model provider/id [--thinking LEVEL] [--installed] [--keep]");
  const agentDir = checkedAgentDir(values["agent-dir"]);
  const unlock = lockAgentDir(agentDir);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "longhaul-matrix-"));
  const offset = logSize(agentDir);
  const pi = path.join(repo, "node_modules", ".bin", "pi");
  const args = ["--mode", "rpc", "--model", values.model, ...(values.thinking ? ["--thinking", values.thinking] : []),
    "--session-dir", path.join(root, "sessions"), "--approve", ...(values.installed ? [] : ["-ne", "-e", path.join(repo, "src", "index.ts")]), "--tools", "read,grep,find,ls"];
  const child = spawn(pi, args, { cwd: makeProject(root), env: childEnv(agentDir), stdio: ["pipe", "pipe", "inherit"] });
  try {
    const exited = new Promise<never>((_, reject) => child.on("exit", (code) => reject(new Error(`pi exited (${code}) mid-cell`))));
    const result = await Promise.race([runCell(new Rpc(child)), exited]);
    const cell = matrixVerdict({ compact: result.compact, summary: result.compact.data?.summary ?? "", records: readLogFrom(agentDir, offset),
      recall: result.recall, expect: EXPECT, model: values.model, turnErrors: result.turnErrors });
    console.log(JSON.stringify({ model: values.model, thinking: values.thinking ?? "default", ...cell, compactMs: result.compactMs, recallToolCalls: result.recallToolCalls }));
    return cell.verdict === "pass" ? 0 : 1;
  } finally {
    child.removeAllListeners("exit");
    child.stdin!.end();
    child.kill();
    unlock();
    if (values.keep) process.stderr.write(`kept ${root}\n`);
    else fs.rmSync(root, { recursive: true, force: true });
  }
}

main().then((code) => process.exit(code), (error: unknown) => {
  process.stderr.write(`matrix: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
