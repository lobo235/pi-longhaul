/**
 * Cross-version smoke: one transcript handed between pi versions, the way a person who upgrades (or downgrades) pi
 * mid-project hands it. Each version continues the transcript the previous one wrote: three prompts, then one
 * compaction by Longhaul, which must be accepted. Afterwards Longhaul's own reader must find one span per step and
 * no anomaly. Two chains (cross-version-plan.ts): every version oldest to newest, then newest to oldest.
 *
 *   npm run cross-version -- [--extra x.y.z]... [--keep]
 *
 * The versions are every pi listed in pi-compat.json, plus each `--extra` (the nightly passes the newest pi). Each
 * is installed from npm into the temporary directory with install scripts off and its dependency tree resolved as on
 * its release day (`--before`, cross-version-plan.ts), so a later release of a deep dependency never runs here; pi
 * and the model are as in smoke-harness.ts (fake model, fresh HOME and agent dir). Exits 1 naming each failed step.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";

import { readPiCompat } from "../src/pi-compat.ts";
import { pathTo, readTranscript } from "../src/score/candidates.ts";
import { buildToolContext } from "../src/tool-context.ts";
import { childEnv } from "./child-env.ts";
import { installCutoff, planChains, type Chain } from "./cross-version-plan.ts";
import { MODEL, PROVIDER, TIMEOUT_MS, compactionFailure, piCli, readLog, runNpm, startFakeModel, unpackedPackage, writeAgentDir, writeSession } from "./smoke-harness.ts";

/** Prompts per step before the compaction: enough new conversation that pi has something to compact. */
const PROMPTS = 3;
/** Each prompt's padding, so three of them outgrow the keep-recent window below. */
const FILLER = " Notes on src/report.ts: the renderer, its tests, the edge cases around empty input.".repeat(40);
const SETTINGS = { compaction: { keepRecentTokens: 200 } };

/**
 * The environment for installing a pi: without the `npm_config_*` variables `npm run` hands its children, which
 * would carry this repository's npm settings (or a setting npm refuses on a project install, such as
 * `allow-scripts`) into an install that is not this repository's. npm still reads the user's `.npmrc` itself.
 */
export function installEnv(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(parent).filter(([name]) => !/^npm_config_/i.test(name)));
}

const PI_PACKAGE = "@earendil-works/pi-coding-agent";

/** Every pi version's publish time, as npm reports it; each one is checked where it is used (installCutoff). */
function publishTimes(base: string): Record<string, string> {
  return JSON.parse(runNpm(["view", PI_PACKAGE, "time", "--json"], base, installEnv(process.env))) as Record<string, string>;
}

/** Installs one pi version under base and returns its node_modules, after checking npm installed that version. */
function installPi(base: string, version: string, before: string): string {
  const prefix = path.join(base, "pi", version);
  fs.mkdirSync(prefix, { recursive: true });
  runNpm(["install", "--prefix", prefix, "--no-save", "--no-audit", "--no-fund", "--ignore-scripts", "--before", before, `${PI_PACKAGE}@${version}`], prefix, installEnv(process.env));
  const nodeModules = path.join(prefix, "node_modules");
  const installed = (JSON.parse(fs.readFileSync(path.join(nodeModules, "@earendil-works", "pi-coding-agent", "package.json"), "utf8")) as { version: string }).version;
  if (installed !== version) throw new Error(`npm installed pi ${installed} for ${version}`);
  return nodeModules;
}

type StepAnswer = { prompts: number; compact?: { success?: boolean; error?: string } };

/** One step: that pi on the transcript, PROMPTS runs each to its end, then one compact command. */
function runStep(cli: string, session: { cwd: string; file: string }, env: NodeJS.ProcessEnv, extension: string, label: string): Promise<StepAnswer> {
  const args = ["--mode", "rpc", "--session", session.file, "--model", `${PROVIDER}/${MODEL}`, "-ne", "-e", extension];
  const child = spawn(process.execPath, [cli, ...args], { cwd: session.cwd, env, stdio: ["pipe", "pipe", "inherit"] });
  const send = (command: object) => child.stdin.write(JSON.stringify(command) + "\n");
  const prompt = (index: number) => send({ id: `prompt-${index}`, type: "prompt", message: `continue ${index} (${label})${FILLER}` });
  const answer: StepAnswer = { prompts: 0 };
  return new Promise((resolve, reject) => {
    // Settle only once pi has exited: Windows refuses to delete a directory a running process works in.
    const settleAfterExit = (settle: () => void) => {
      child.removeAllListeners("exit");
      child.once("exit", settle);
      child.stdin.end();
      child.kill();
    };
    const timer = setTimeout(() => settleAfterExit(() => reject(new Error(`${label}: no answer within ${TIMEOUT_MS / 1000} s (${answer.prompts} prompt(s) done)`))), TIMEOUT_MS);
    child.on("error", reject);
    child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`${label}: pi exited (${code}) after ${answer.prompts} prompt(s)`)); });
    readline.createInterface({ input: child.stdout }).on("line", (line) => {
      let message: { type?: string; id?: string; success?: boolean; error?: string };
      try { message = JSON.parse(line); } catch { return; }
      if (message.type === "agent_end") {
        answer.prompts += 1;
        if (answer.prompts < PROMPTS) prompt(answer.prompts);
        else send({ id: "compact", type: "compact" });
      } else if (message.type === "response" && message.id === "compact") {
        clearTimeout(timer);
        answer.compact = message;
        settleAfterExit(() => resolve(answer));
      }
    });
    prompt(0);
  });
}

/** What Longhaul's own reader makes of the finished transcript: one span per step, each closed, no anomaly. */
function transcriptFailure(file: string, steps: number): string | null {
  const entries = readTranscript(file);
  const leaf = entries.at(-1);
  if (!leaf) return "the transcript has no entries";
  const log = buildToolContext(pathTo(entries, leaf.id)).log;
  if (log.anomalies.length) return `${log.anomalies.length} anomaly(ies): ${JSON.stringify(log.anomalies[0])}`;
  if (log.spans.length !== steps) return `${log.spans.length} span(s) for ${steps} compaction(s)`;
  const open = log.spans.find((summary) => summary.foreign || !summary.record?.events.some((event) => event.kind === "span.close"));
  return open ? `span ${open.span} has no closed record of Longhaul's` : null;
}

async function runChain(chain: Chain, base: string, port: number, extension: string, pis: Map<string, string>): Promise<string[]> {
  const root = fs.mkdtempSync(path.join(base, `${chain.name}-`));
  const agentDir = writeAgentDir(root, port, SETTINGS);
  const session = writeSession(root);
  const env = childEnv(process.env, root, agentDir);
  const failures: string[] = [];
  for (const [index, version] of chain.versions.entries()) {
    const label = `${chain.name} step ${index + 1}/${chain.versions.length}, pi ${version}`;
    const before = readLog(agentDir).length;
    try {
      const nodeModules = pis.get(version);
      if (!nodeModules) throw new Error(`${label}: pi ${version} was not installed`);
      const answer = await runStep(piCli(nodeModules), session, env, extension, label);
      const records = readLog(agentDir).slice(before);
      const loaded = records.find((record) => record.event === "extension-loaded")?.piVersion;
      const failure = loaded !== version ? `Longhaul reported pi ${loaded ?? "?"}`
        : answer.compact?.success !== true ? `pi did not compact: ${answer.compact?.error ?? "no error given"}`
        : compactionFailure(records);
      console.log(`${label}: ${failure ?? "ok"}`);
      if (failure) failures.push(`${label}: ${failure}`);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
      console.log(failures.at(-1));
      return failures;
    }
  }
  const transcript = transcriptFailure(session.file, chain.versions.length);
  console.log(`${chain.name} transcript: ${transcript ?? `${chain.versions.length} spans, no anomaly`}`);
  if (transcript) failures.push(`${chain.name} transcript: ${transcript}`);
  return failures;
}

export function parseArgs(argv: string[]): { extras: string[]; keep: boolean } | { error: string } {
  const extras: string[] = [];
  let keep = false;
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--keep") keep = true;
    else if (argv[index] === "--extra" && argv[index + 1] !== undefined) extras.push(argv[++index]);
    else return { error: `unexpected argument: ${argv[index]}` };
  }
  return { extras, keep };
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  if ("error" in options) { console.error(`cross-version smoke: ${options.error}\nusage: npm run cross-version -- [--extra x.y.z]... [--keep]`); return 2; }
  const chains = planChains([...readPiCompat().verified.map((entry) => entry.pi), ...options.extras]);
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "longhaul-cross-version-"));
  const fake = await startFakeModel();
  try {
    const times = publishTimes(base);
    const pis = new Map(chains[0].versions.map((version) => [version, installPi(base, version, installCutoff(times, version))]));
    const extension = unpackedPackage(base);
    const failures: string[] = [];
    for (const chain of chains) failures.push(...await runChain(chain, base, fake.port, extension, pis));
    console.log(`cross-version smoke: pi ${chains[0].versions.join(", ")}; ${fake.requests()} model request(s): ${failures.length ? `${failures.length} failure(s)` : "ok"}`);
    return failures.length ? 1 : 0;
  } finally {
    fake.server.close();
    if (options.keep) console.log(`kept ${base}`);
    else fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main().then((code) => process.exit(code), (error: unknown) => {
    console.error(`cross-version smoke: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
