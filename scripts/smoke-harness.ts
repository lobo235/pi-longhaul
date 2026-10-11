/**
 * What the smokes share: a fake OpenAI-compatible model on loopback, a fresh agent dir and transcript, Longhaul as
 * the packed package, the vendored pi's entry script, and Longhaul's log. No network, no key, no state of the person
 * running it is read or written: HOME and the agent dir are a new temporary directory, and pi gets an allowlisted
 * environment (child-env.ts).
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";

export const repo = path.join(import.meta.dirname, "..");
export const PROVIDER = "example";
export const MODEL = "example-model";
export const TIMEOUT_MS = 120_000;

/** Every request gets this answer: a valid Longhaul diff, which a normal prompt simply shows as text. */
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

export function startFakeModel(): Promise<{ server: http.Server; port: number; requests: () => number }> {
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

/** The agent dir: the fake model's provider, and pi settings when a smoke needs some (`settings.json`). */
export function writeAgentDir(root: string, port: number, settings?: object): string {
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(agentDir, { mode: 0o700 });
  const model = { id: MODEL, name: MODEL, contextWindow: 131072, maxTokens: 4096, input: ["text"], reasoning: false };
  const models = { providers: { [PROVIDER]: { baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "unused", models: [model] } } };
  fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify(models, null, 2));
  if (settings) fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify(settings, null, 2));
  return agentDir;
}

/** The fixture transcript, its working directory moved to a fresh `project` directory under root. */
export function writeSession(root: string): { cwd: string; file: string } {
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

/**
 * npm without a shell, which would re-parse arguments such as a temporary path: the npm-cli.js that started this
 * script (`npm_execpath`), else on Windows the one installed next to node, else `npm` on the search path.
 */
export function runNpm(args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  const started = process.env.npm_execpath;
  const besideNode = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  const cli = started && /npm-cli\.c?js$/.test(started) ? started : process.platform === "win32" && fs.existsSync(besideNode) ? besideNode : undefined;
  return cli ? execFileSync(process.execPath, [cli, ...args], { cwd, env, encoding: "utf8" }) : execFileSync("npm", args, { cwd, env, encoding: "utf8" });
}

/** The package as npm would publish it, unpacked where an install puts it; returns its directory. */
export function unpackedPackage(root: string): string {
  const packed = JSON.parse(runNpm(["pack", "--json", "--ignore-scripts", "--pack-destination", root], repo)) as Array<{ filename: string }>;
  // Relative operands, run from root: a tar that reads `C:` in an absolute Windows path as a remote host never sees one.
  execFileSync("tar", ["-xzf", packed[0].filename], { cwd: root });
  const dir = path.join(root, "node_modules", "pi-longhaul");
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.renameSync(path.join(root, "package"), dir);
  return dir;
}

/**
 * The entry script of the pi installed under `nodeModules` (this tree's own by default), from its package.json
 * `bin`. pi is started as `node <entry>` rather than through `node_modules/.bin/pi`: on Windows npm installs that
 * bin as a .cmd shim, which spawn() cannot start without a shell.
 */
export function piCli(nodeModules = path.join(repo, "node_modules")): string {
  const pkg = path.join(nodeModules, "@earendil-works", "pi-coding-agent");
  return path.join(pkg, (JSON.parse(fs.readFileSync(path.join(pkg, "package.json"), "utf8")) as { bin: { pi: string } }).bin.pi);
}

export type LogRecord = { event?: string; piVersion?: string; narrative?: { kind?: string }; errorClass?: string; error?: string };

export function readLog(agentDir: string): LogRecord[] {
  const file = path.join(agentDir, "logs", "compaction-state.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as LogRecord);
}

/** Why Longhaul's records from one compaction are not a success, or null when they are. */
export function compactionFailure(records: LogRecord[]): string | null {
  if (records.some((record) => record.event === "fallback")) return "Longhaul fell back to pi's own compaction (a fallback record)";
  const compaction = records.find((record) => record.event === "compaction");
  if (!compaction) return `no compaction record in the log (events: ${records.map((record) => record.event).join(", ") || "none"})`;
  if (compaction.narrative?.kind !== "diff") return `the diff was not accepted (narrative kind ${compaction.narrative?.kind ?? "missing"})`;
  return null;
}
