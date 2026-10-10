/**
 * Compaction smoke: one real compaction by the pi this tree vendors, in a fresh agent dir, against a fake
 * OpenAI-compatible model on loopback. No network, no key, no state of the person running it is read or
 * written: HOME and the agent dir are both a new temporary directory, and pi gets an allowlisted environment
 * (child-env.ts), so no API key or git setting of theirs reaches it.
 *
 * Longhaul is loaded the way an install loads it: `npm pack`, unpacked to `node_modules/pi-longhaul`, and handed
 * to pi as a directory, so pi resolves the entry through the package's `pi.extensions` manifest and only the files
 * `files` publishes exist. A file the package forgets fails here, not after publishing.
 *
 * Passes when pi answers the compact command successfully and Longhaul logged a `compaction` record whose
 * diff was accepted. Exits 1 with the reason otherwise. CI runs it on every push and against the newest pi
 * nightly; `--keep` leaves the temporary directory for inspection.
 */
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";

import { childEnv } from "./child-env.ts";

const repo = path.join(import.meta.dirname, "..");
const PROVIDER = "example";
const MODEL = "example-model";
const TIMEOUT_MS = 120_000;

const DIFF = {
  narrative: "read src/report.ts and the tests around it",
  corrections: [],
  lifts: [],
  decisions: [],
  deadEnds: [],
  now: { inProgress: [], next: ["run the tests"], blocked: [], resume: "open src/report.ts" },
};

function sse(res: http.ServerResponse, content: string): void {
  const chunk = (fields: object) => `data: ${JSON.stringify({ id: "smoke", object: "chat.completion.chunk", model: MODEL, ...fields })}\n\n`;
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.write(chunk({ choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] }));
  res.write(chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050 } }));
  res.end("data: [DONE]\n\n");
}

function startFakeModel(): Promise<{ server: http.Server; port: number; requests: () => number }> {
  let count = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    // Only pi's completion calls count: anything else on this machine that probes loopback ports gets a 404.
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.writeHead(404).end();
      return;
    }
    req.on("end", () => {
      count += 1;
      sse(res, "```json\n" + JSON.stringify(DIFF) + "\n```");
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({ server, port, requests: () => count });
    });
  });
}

function writeAgentDir(root: string, port: number): string {
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(agentDir, { mode: 0o700 });
  const model = { id: MODEL, name: MODEL, contextWindow: 131072, maxTokens: 4096, input: ["text"], reasoning: false };
  const models = { providers: { [PROVIDER]: { baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "unused", models: [model] } } };
  fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify(models, null, 2));
  return agentDir;
}

function writeSession(root: string): { cwd: string; file: string } {
  const cwd = path.join(root, "project");
  fs.mkdirSync(cwd);
  const lines = fs.readFileSync(path.join(repo, "fixtures", "setup-check-session.jsonl"), "utf8").split("\n").filter(Boolean);
  const rewritten = lines.map((line) => {
    const entry = JSON.parse(line) as { type?: string; cwd?: string };
    return JSON.stringify(entry.type === "session" ? { ...entry, cwd } : entry);
  });
  const file = path.join(root, "session.jsonl");
  fs.writeFileSync(file, rewritten.join("\n") + "\n");
  return { cwd, file };
}

/** The package as npm would publish it, unpacked where an install puts it; returns its directory. */
function unpackedPackage(root: string): string {
  const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", root], { cwd: repo, encoding: "utf8" })) as Array<{ filename: string }>;
  const tarball = path.join(root, packed[0].filename);
  execFileSync("tar", ["-xzf", tarball, "-C", root]);
  const dir = path.join(root, "node_modules", "pi-longhaul");
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.renameSync(path.join(root, "package"), dir);
  return dir;
}

/** Runs pi in RPC mode, sends one compact command and resolves with pi's response to it. */
function compactOnce(session: { cwd: string; file: string }, env: NodeJS.ProcessEnv, extension: string): Promise<{ success?: boolean; error?: string }> {
  const pi = path.join(repo, "node_modules", ".bin", "pi");
  const args = ["--mode", "rpc", "--session", session.file, "--model", `${PROVIDER}/${MODEL}`, "-ne", "-e", extension];
  const child = spawn(pi, args, { cwd: session.cwd, env, stdio: ["pipe", "pipe", "inherit"] });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`no answer to compact within ${TIMEOUT_MS / 1000} s`)); }, TIMEOUT_MS);
    child.on("error", reject);
    child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`pi exited (${code}) before answering compact`)); });
    readline.createInterface({ input: child.stdout }).on("line", (line) => {
      let message: { type?: string; id?: string; success?: boolean; error?: string };
      try { message = JSON.parse(line); } catch { return; }
      if (message.type !== "response" || message.id !== "smoke") return;
      clearTimeout(timer);
      child.removeAllListeners("exit");
      child.stdin.end();
      child.kill();
      resolve(message);
    });
    child.stdin.write(JSON.stringify({ id: "smoke", type: "compact" }) + "\n");
  });
}

type LogRecord = { event?: string; piVersion?: string; narrative?: { kind?: string } };

function readLog(agentDir: string): LogRecord[] {
  const file = path.join(agentDir, "logs", "compaction-state.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as LogRecord);
}

function verdict(answer: { success?: boolean; error?: string }, records: LogRecord[]): string | null {
  if (answer.success !== true) return `pi did not compact: ${answer.error ?? "no error given"}`;
  if (records.some((record) => record.event === "fallback")) return "Longhaul fell back to pi's own compaction (a fallback record)";
  const compaction = records.find((record) => record.event === "compaction");
  if (!compaction) return `no compaction record in the log (events: ${records.map((record) => record.event).join(", ") || "none"})`;
  if (compaction.narrative?.kind !== "diff") return `the diff was not accepted (narrative kind ${compaction.narrative?.kind ?? "missing"})`;
  return null;
}

async function main(): Promise<number> {
  const keep = process.argv.includes("--keep");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "longhaul-smoke-"));
  const fake = await startFakeModel();
  try {
    const agentDir = writeAgentDir(root, fake.port);
    const answer = await compactOnce(writeSession(root), childEnv(process.env, root, agentDir), unpackedPackage(root));
    const records = readLog(agentDir);
    const loaded = records.find((record) => record.event === "extension-loaded");
    const failure = verdict(answer, records);
    console.log(`compaction smoke: pi ${loaded?.piVersion ?? "?"}, the packed package, ${fake.requests()} model request(s): ${failure ?? "ok"}`);
    return failure ? 1 : 0;
  } finally {
    fake.server.close();
    if (keep) console.log(`kept ${root}`);
    else fs.rmSync(root, { recursive: true, force: true });
  }
}

main().then((code) => process.exit(code), (error: unknown) => {
  console.error(`compaction smoke: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
