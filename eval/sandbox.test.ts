import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { sandboxArgs } from "./sandbox.ts";

/** Runs `script` in the recording sandbox; undefined where bwrap is missing or cannot make its namespaces. */
function inSandbox(root: string, script: string): string | undefined {
  const result = spawnSync("bwrap", [...sandboxArgs(root, "probe"), "/usr/bin/sh", "-c", script], { encoding: "utf8" });
  return result.status === 0 ? result.stdout : undefined;
}

function scratchRoot(t: { after: (fn: () => void) => void }): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "longhaul-sandbox-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "agent"));
  fs.mkdirSync(path.join(root, "project"));
  return root;
}

test("no process in the sandbox shows the host paths of its mounts on its command line", (t) => {
  const root = scratchRoot(t);
  const listing = inSandbox(root, 'for p in /proc/[0-9]*; do tr "\\0" " " < "$p/cmdline"; echo; done');
  if (listing === undefined) return t.skip("bwrap is not usable here");
  // A model that runs `ps` while debugging reads every process's argv. bwrap's own, as the sandbox's PID 1,
  // named the scratch root, the repository and the node install: one recording had to be thrown away for it.
  assert.ok(!listing.includes(root), listing);
  assert.ok(!listing.includes(path.join(import.meta.dirname, "..")), listing);
  assert.ok(!listing.includes("bwrap"), listing);
});

test("the sandboxed command runs in the project directory with the sandbox's own environment only", (t) => {
  const root = scratchRoot(t);
  const out = inSandbox(root, 'pwd; echo "$HOME"; env | sort | cut -d= -f1 | tr "\\n" " "');
  if (out === undefined) return t.skip("bwrap is not usable here");
  const [cwd, home, names] = out.split("\n");
  assert.equal(cwd, "/work/probe");
  assert.equal(home, "/home/user");
  for (const name of names.trim().split(" ")) {
    assert.ok(/^(HOME|PATH|LANG|TERM|USER|PI_CODING_AGENT_DIR|TZ|GIT_(AUTHOR|COMMITTER)_(NAME|EMAIL)|PWD|SHLVL|_)$/.test(name), name);
  }
});

test("the sandbox's clock reads UTC, so file times in tool output do not name the host's timezone", (t) => {
  const root = scratchRoot(t);
  const out = inSandbox(root, "date +%z");
  if (out === undefined) return t.skip("bwrap is not usable here");
  assert.equal(out.trim(), "+0000");
});
