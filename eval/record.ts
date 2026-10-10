/**
 * Records one evaluation session: a real pi session, with a real model and real tools, driven by the scripted
 * user turns of a scenario (eval/scenarios/*.json), compacting with pi's own compaction (Longhaul is not loaded).
 *
 *   node eval/record.ts --scenario eval/scenarios/x.json --out DIR --profile PROFILE.json \
 *     --upstream-url https://host/v1 --upstream-model ID [--upstream-key-file FILE]
 *
 * pi runs under bubblewrap: a tmpfs HOME, the scratch project at /work/<scenario> and a throwaway agent dir
 * the only writable places, the caller's home directory not mounted. The sandbox holds no key: pi talks to a
 * proxy on loopback that adds the key and maps the label model id (the profile's `label`, e.g. example/local-27b)
 * to the upstream id in both directions, so the transcript never names the upstream deployment.
 *
 * The profile is the non-secret part of the model's pi entry: { label: "provider/id", contextWindow, maxTokens,
 * reasoning, input, compat, providerCompat, thinkingLevelMap, thinking, compaction? }, where `compaction` is pi's
 * { reserveTokens, keepRecentTokens } setting: a smaller window than the model's gives each session more compactions
 * from the same number of turns. The raw transcript is written to
 * OUT/<scenario>.raw.jsonl; eval/check-session.ts vets it before anything is committed.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";

import { drive } from "./drive.ts";
import { startProxy } from "./proxy.ts";
import { sandboxArgs } from "./sandbox.ts";

interface Scenario { name: string; turns: string[] }
interface Profile {
  label: string; contextWindow: number; maxTokens: number; reasoning: boolean; input: string[];
  compat?: object; providerCompat?: object; thinkingLevelMap?: object; thinking?: string;
  compaction?: { reserveTokens?: number; keepRecentTokens?: number };
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

function writeAgentDir(agentDir: string, profile: Profile, port: number): void {
  const [provider, id] = profile.label.split("/");
  const model = { id, name: id, reasoning: profile.reasoning, input: profile.input, contextWindow: profile.contextWindow,
    maxTokens: profile.maxTokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: profile.compat,
    thinkingLevelMap: profile.thinkingLevelMap };
  const models = { providers: { [provider]: { baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions",
    apiKey: "none", compat: profile.providerCompat, models: [model] } } };
  fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify(models, null, 2));
  const settings = { defaultProvider: provider, defaultModel: id, defaultThinkingLevel: profile.thinking ?? "low",
    ...(profile.compaction ? { compaction: profile.compaction } : {}) };
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify(settings, null, 2));
}

function newestTranscript(agentDir: string): string {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) walk(full);
      else if (item.isFile() && item.name.endsWith(".jsonl")) found.push(full);
    }
  };
  walk(path.join(agentDir, "sessions"));
  if (found.length !== 1) throw new Error(`expected one transcript, found ${found.length}`);
  return found[0];
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { scenario: { type: "string" }, out: { type: "string" }, profile: { type: "string" },
    "upstream-url": { type: "string" }, "upstream-model": { type: "string" }, "upstream-key-file": { type: "string" } } });
  if (!values.scenario || !values.out || !values.profile || !values["upstream-url"] || !values["upstream-model"]) {
    throw new Error("usage: record.ts --scenario FILE --out DIR --profile FILE --upstream-url URL --upstream-model ID [--upstream-key-file FILE]");
  }
  const scenario = readJson<Scenario>(values.scenario);
  if (!/^[a-z0-9-]+$/.test(scenario.name)) throw new Error(`scenario name must be [a-z0-9-]: ${scenario.name}`);
  const profile = readJson<Profile>(values.profile);
  const key = values["upstream-key-file"] ? fs.readFileSync(values["upstream-key-file"], "utf8").trim() : undefined;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `longhaul-record-${scenario.name}-`));
  fs.mkdirSync(path.join(root, "project"));
  const log = (line: string) => process.stderr.write(`[${new Date().toISOString().slice(11, 19)}] ${scenario.name}: ${line}\n`);
  const proxy = await startProxy({ upstreamUrl: values["upstream-url"], upstreamModel: values["upstream-model"],
    labelModel: profile.label.split("/")[1], key });
  try {
    writeAgentDir(path.join(root, "agent"), profile, proxy.port);
    const piArgs = ["/opt/pi/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js", "--mode", "rpc", "--model", profile.label];
    const child = spawn("bwrap", [...sandboxArgs(root, scenario.name), "/opt/node/bin/node", ...piArgs], { stdio: ["pipe", "pipe", "inherit"] });
    const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
    await Promise.race([drive(child, scenario.turns, log), exited.then((code) => { throw new Error(`pi exited (${code}) mid-scenario`); })]);
    child.stdin!.end();
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10_000))]);
    child.kill();
    fs.mkdirSync(values.out, { recursive: true });
    const target = path.join(values.out, `${scenario.name}.raw.jsonl`);
    fs.copyFileSync(newestTranscript(path.join(root, "agent")), target);
    log(`transcript: ${target} (scratch: ${root})`);
  } finally {
    proxy.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`record: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
