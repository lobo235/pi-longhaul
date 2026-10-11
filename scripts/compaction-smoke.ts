/**
 * Compaction smoke: one real compaction by the pi this tree vendors, in a fresh agent dir, against a fake
 * OpenAI-compatible model on loopback (smoke-harness.ts: no network, no key, no state of the person running it).
 *
 * Longhaul is loaded the way an install loads it: `npm pack`, unpacked to `node_modules/pi-longhaul`, and handed
 * to pi as a directory, so pi resolves the entry through the package's `pi.extensions` manifest and only the files
 * `files` publishes exist. A file the package forgets fails here, not after publishing.
 *
 * Passes when pi answers the compact command successfully and Longhaul logged a `compaction` record whose
 * diff was accepted. Exits 1 with the reason otherwise. CI runs it on every push and against the newest pi
 * nightly; `--keep` leaves the temporary directory for inspection.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";

import { childEnv } from "./child-env.ts";
import { MODEL, PROVIDER, TIMEOUT_MS, compactionFailure, piCli, readLog, startFakeModel, unpackedPackage, writeAgentDir, writeSession } from "./smoke-harness.ts";

/** Runs pi in RPC mode, sends one compact command and resolves with pi's response to it. */
function compactOnce(session: { cwd: string; file: string }, env: NodeJS.ProcessEnv, extension: string): Promise<{ success?: boolean; error?: string }> {
  const args = ["--mode", "rpc", "--session", session.file, "--model", `${PROVIDER}/${MODEL}`, "-ne", "-e", extension];
  const child = spawn(process.execPath, [piCli(), ...args], { cwd: session.cwd, env, stdio: ["pipe", "pipe", "inherit"] });
  return new Promise((resolve, reject) => {
    // Settle only once pi has exited: Windows refuses to delete a directory a running process works in.
    const settleAfterExit = (settle: () => void) => {
      child.removeAllListeners("exit");
      child.once("exit", settle);
      child.stdin.end();
      child.kill();
    };
    const timer = setTimeout(() => settleAfterExit(() => reject(new Error(`no answer to compact within ${TIMEOUT_MS / 1000} s`))), TIMEOUT_MS);
    child.on("error", reject);
    child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`pi exited (${code}) before answering compact`)); });
    readline.createInterface({ input: child.stdout }).on("line", (line) => {
      let message: { type?: string; id?: string; success?: boolean; error?: string };
      try { message = JSON.parse(line); } catch { return; }
      if (message.type !== "response" || message.id !== "smoke") return;
      clearTimeout(timer);
      settleAfterExit(() => resolve(message));
    });
    child.stdin.write(JSON.stringify({ id: "smoke", type: "compact" }) + "\n");
  });
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
    const failure = answer.success !== true ? `pi did not compact: ${answer.error ?? "no error given"}` : compactionFailure(records);
    console.log(`compaction smoke: pi ${loaded?.piVersion ?? "?"}, the packed package, ${fake.requests()} model request(s): ${failure ?? "ok"}`);
    return failure ? 1 : 0;
  } finally {
    fake.server.close();
    if (keep) console.log(`kept ${root}`);
    else fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  }
}

main().then((code) => process.exit(code), (error: unknown) => {
  console.error(`compaction smoke: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
