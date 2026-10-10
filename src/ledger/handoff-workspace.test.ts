import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { EXACT_HALF_BUDGET, collectHandoff, finishHandoff, type CommandRecord } from "./handoff.ts";
import { WORKSPACE_DEADLINE_MS, WORKSPACE_STATUS_CHARS, captureWorkspace, type ExecFn, type ExecResult } from "./handoff-workspace.ts";
import { bashCall } from "./test-support.ts";

const CAPTURED = new Date("2026-09-15T18:00:00.000Z");
/** The config keys the capture lists before reading any file: filter drivers and partial-clone settings. */
const CONFIG_KEYS_RE = "^(filter\\.|extensions\\.partialclone$|remote\\..*\\.(promisor|partialclonefilter)$)";

/** A git that answers like a repo with two dirty files. `calls` records every invocation. */
function fakeGit(overrides: Partial<Record<string, Partial<ExecResult>>> = {}, delayMs = 0): { exec: ExecFn; calls: string[][] } {
  const calls: string[][] = [];
  const answers: Record<string, ExecResult> = {
    "rev-parse": { stdout: "main\n", stderr: "", code: 0, killed: false },
    "--short": { stdout: "ab12cd\n", stderr: "", code: 0, killed: false },
    status: { stdout: " M a.ts\n?? b.ts\n", stderr: "", code: 0, killed: false },
    diff: { stdout: " a.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n", stderr: "", code: 0, killed: false },
    // `git config --get-regexp` exits 1 when nothing matches: no filter driver or partial clone anywhere.
    config: { stdout: "", stderr: "", code: 1, killed: false },
  };
  const exec: ExecFn = async (command, args) => {
    calls.push([command, ...args]);
    // Both `status` and `rev-parse` take --short, and GIT_OPTIONS prefix the args, so key the commit
    // output by the subcommand AND the flag, never by the flag alone or by args[0].
    const key = args.includes("rev-parse") && args.includes("--short") ? "--short" : (args.find((arg) => arg in answers) ?? "");
    const answer = { ...answers[key], ...overrides[key] };
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    return answer;
  };
  return { exec, calls };
}

const commands: CommandRecord[] = [
  { id: "C1", command: "npm test", runs: 2, lastExitCode: 1, failedThenSucceeded: false, lastSeenPass: 1 },
  { id: "C2", command: "node --test index.test.ts", runs: 1, lastExitCode: 0, failedThenSucceeded: false, lastSeenPass: 2 },
  { id: "C3", command: "ls", runs: 1, lastExitCode: 0, failedThenSucceeded: false, lastSeenPass: 2 },
];

test("captureWorkspace: the read-only git commands, hardened, in the session's cwd, become a snapshot", async () => {
  const { exec, calls } = fakeGit();
  const result = await captureWorkspace({ exec, cwd: "/repo", commands, now: () => CAPTURED });
  assert.deepEqual(result, {
    snapshot: {
      capturedAt: "2026-09-15T18:00:00.000Z",
      cwd: "/repo",
      branch: "main",
      commit: "ab12cd",
      statusShort: " M a.ts\n?? b.ts",
      diffStat: " 1 file changed, 1 insertion(+), 1 deletion(-)",
      lastTestCommand: "node --test index.test.ts",
      lastTestExitCode: 0,
    },
  });
  assert.deepEqual(calls, [
    ["git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "--no-optional-locks", "rev-parse", "--abbrev-ref", "HEAD"],
    ["git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "--no-optional-locks", "config", "--show-scope", "--includes", "--name-only", "--get-regexp", CONFIG_KEYS_RE],
    ["git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "--no-optional-locks", "status", "--short", "--ignore-submodules=all", "--", "."],
    ["git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "--no-optional-locks", "diff", "--stat", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all", "--", "."],
    ["git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "--no-optional-locks", "rev-parse", "--short", "HEAD"],
  ]);
});

test("captureWorkspace: outside a git repo the snapshot is skipped after the first command; a failing command skips with its stderr", async () => {
  const notRepo = fakeGit({ "rev-parse": { code: 128, stderr: "fatal: not a git repository (or any of the parent directories): .git\n" } });
  assert.deepEqual(await captureWorkspace({ exec: notRepo.exec, cwd: "/tmp/x", commands: [] }), { skipped: "not-a-git-repo" });
  assert.equal(notRepo.calls.length, 1);

  const broken = fakeGit({ status: { code: 129, stderr: "error: unknown option\n" } });
  assert.deepEqual(await captureWorkspace({ exec: broken.exec, cwd: "/repo", commands: [] }), { skipped: "git status --short --ignore-submodules=all -- . exited 129: error: unknown option" });

  const thrown: ExecFn = async () => {
    throw new Error("spawn git ENOENT");
  };
  assert.deepEqual(await captureWorkspace({ exec: thrown, cwd: "/repo", commands: [] }), { skipped: "git rev-parse --abbrev-ref HEAD failed: spawn git ENOENT" });
});

test("captureWorkspace: the deadline covers all the commands together; a slow git drops the snapshot", async () => {
  const slow = fakeGit({}, 30);
  const result = await captureWorkspace({ exec: slow.exec, cwd: "/repo", commands: [], deadlineMs: 50 });
  assert.deepEqual(result, { skipped: "timeout after 50 ms" });
  assert.ok(slow.calls.length <= 3, `${slow.calls.length} commands started`);
  // Each call is handed the time left, never the whole deadline again.
  const timed: number[] = [];
  const exec: ExecFn = async (command, args, options) => {
    timed.push(options.timeout);
    return fakeGit().exec(command, args, options);
  };
  await captureWorkspace({ exec, cwd: "/repo", commands: [], deadlineMs: 5000 });
  assert.equal(timed.length, 5);
  assert.ok(timed.every((t) => t > 0 && t <= 5000));
  assert.equal(WORKSPACE_DEADLINE_MS, 5000);
});

test("captureWorkspace: status is cut to 40 lines, diff stat to its last line, the last test command is the most recently seen match", async () => {
  const longStatus = Array.from({ length: 60 }, (_, i) => ` M f${i}.ts`).join("\n");
  const { exec } = fakeGit({ status: { stdout: `${longStatus}\n` }, diff: { stdout: "" } });
  const tests: CommandRecord[] = [
    { id: "C1", command: "pytest -x", runs: 1, lastExitCode: 1, failedThenSucceeded: false, lastSeenPass: 3 },
    { id: "C2", command: "make check", runs: 1, lastExitCode: 0, failedThenSucceeded: false, lastSeenPass: 3 },
    { id: "C3", command: "go test ./...", runs: 1, lastExitCode: null, failedThenSucceeded: false, lastSeenPass: 2 },
  ];
  const result = await captureWorkspace({ exec, cwd: "/repo", commands: tests, now: () => CAPTURED });
  assert.ok("snapshot" in result);
  assert.equal(result.snapshot.statusShort?.split("\n").length, 40);
  assert.equal(result.snapshot.diffStat, undefined);
  assert.equal(result.snapshot.lastTestCommand, "make check");
  assert.equal(result.snapshot.lastTestExitCode, 0);
  const clean = await captureWorkspace({ exec: fakeGit({ status: { stdout: "" }, diff: { stdout: "" } }).exec, cwd: "/repo", commands: [] });
  assert.ok("snapshot" in clean && clean.snapshot.statusShort === undefined && clean.snapshot.lastTestCommand === undefined);
});

test("finishHandoff renders the <workspace> block last, in its format, and reports it captured", () => {
  const state = collectHandoff({ branchEntries: [], messages: [...bashCall("make check")] });
  state.workspace = {
    capturedAt: "2026-09-15T18:00:00.000Z",
    cwd: "/repo",
    branch: "main",
    statusShort: " M a.ts\n?? b.ts",
    diffStat: " 1 file changed, 1 insertion(+), 1 deletion(-)",
    lastTestCommand: "node --test index.test.ts",
    lastTestExitCode: 0,
  };
  const finished = finishHandoff(state);
  assert.equal(
    finished.exactHalf,
    "\n\n<commands>\nC1 [runs:1 exit:0] make check\n</commands>" +
      '\n\n<workspace branch="main" captured="2026-09-15T18:00:00.000Z">\n M a.ts\n?? b.ts\n 1 file changed, 1 insertion(+), 1 deletion(-)\nlast test: node --test index.test.ts (exit 0)\n</workspace>',
  );
  assert.equal(finished.workspace, state.workspace);
  assert.ok(finished.exactHalf.length <= EXACT_HALF_BUDGET);

  const bare = finishHandoff({ ...state, workspace: { capturedAt: "t", cwd: "/repo", lastTestCommand: "npm test", lastTestExitCode: null } });
  assert.match(bare.exactHalf, /\n\n<workspace captured="t">\nlast test: npm test \(exit \?\)\n<\/workspace>$/);
  const none = finishHandoff({ ...state, workspace: { capturedAt: "t", cwd: "/repo" } });
  assert.equal(none.exactHalf.includes("<workspace"), false, "a snapshot with nothing to say renders nothing");
  assert.deepEqual(none.workspace, { capturedAt: "t", cwd: "/repo" }, "the snapshot is still handed back");
});

test("a workspace snapshot is never carried forward: the next pass captures its own", () => {
  const previous = { readFiles: [], modifiedFiles: [], commands: [], errors: [], workspace: { capturedAt: "old", cwd: "/repo", branch: "old-branch" } };
  const entry = [{ type: "compaction", id: "c0", parentId: null, timestamp: "t", summary: "s", firstKeptEntryId: "x", tokensBefore: 1, details: previous, fromHook: true }];
  const state = collectHandoff({ branchEntries: entry as never, messages: [] });
  assert.equal(state.workspace, undefined);
  assert.equal(finishHandoff(state).workspace, undefined);
});

test("captureWorkspace: the short status is cut to whole lines within WORKSPACE_STATUS_CHARS, so the block can never outgrow the exact half", async () => {
  const line = ` M ${"a".repeat(97)}`;
  const { exec } = fakeGit({ status: { stdout: `${Array.from({ length: 40 }, () => line).join("\n")}\n` } });
  const result = await captureWorkspace({ exec, cwd: "/repo", commands: [], now: () => CAPTURED });
  assert.ok("snapshot" in result);
  const status = result.snapshot.statusShort ?? "";
  assert.ok(status.length <= WORKSPACE_STATUS_CHARS, `${status.length} chars`);
  assert.equal(status.split("\n").length, 19);
  assert.ok(status.split("\n").every((kept) => kept === line), "whole lines only");
});

test("captureWorkspace: an unborn branch (rev-parse --short HEAD fails) keeps the snapshot without a commit", async () => {
  const unborn = fakeGit({ "--short": { code: 128, stdout: "", stderr: "fatal: ambiguous argument 'HEAD': unknown revision\n" } });
  const result = await captureWorkspace({ exec: unborn.exec, cwd: "/repo", commands: [], now: () => CAPTURED });
  assert.ok("snapshot" in result);
  assert.equal(result.snapshot.commit, undefined);
  assert.equal(result.snapshot.branch, "main");
  assert.equal(unborn.calls.length, 5);
});

test("captureWorkspace: a status with a long whitespace run inside it is cut in linear time (security.md T4)", async () => {
  const { exec } = fakeGit({ status: { stdout: ` M a.ts${" ".repeat(200_000)}x\n M b.ts\n  \n` } });
  const started = performance.now();
  const result = await captureWorkspace({ exec, cwd: "/repo", commands: [], now: () => CAPTURED });
  const elapsedMs = performance.now() - started;
  assert.ok(elapsedMs < 500, `took ${Math.round(elapsedMs)} ms`);
  assert.ok("snapshot" in result);
  assert.equal(result.snapshot.statusShort, undefined, "a first line over the budget keeps nothing");
});

test("captureWorkspace: a filter driver from the repository's own config, or a partial clone, skips the snapshot before status or diff can run anything; the user's own filters run (table)", async () => {
  const cases: Array<[string, Partial<ExecResult>, string | undefined]> = [
    ["no filter driver anywhere (exit 1)", { stdout: "", code: 1 }, undefined],
    ["the user's git-lfs, globally", { stdout: "global\tfilter.lfs.clean\nglobal\tfilter.lfs.process\nsystem\tfilter.x.smudge\n", code: 0 }, undefined],
    ["one in .git/config", { stdout: "global\tfilter.lfs.clean\nlocal\tfilter.x.clean\n", code: 0 }, "repo-filter-driver"],
    ["one in the worktree's config", { stdout: "worktree\tfilter.x.process\n", code: 0 }, "repo-filter-driver"],
    ["a line with no scope fails closed", { stdout: "filter.x.clean\n", code: 0 }, "repo-filter-driver"],
    ["a partial clone, from .git/config", { stdout: "local\textensions.partialclone\nlocal\tremote.origin.promisor\n", code: 0 }, "partial-clone"],
    ["a promisor remote alone", { stdout: "local\tremote.origin.promisor\n", code: 0 }, "partial-clone"],
    ["a partial-clone filter alone", { stdout: "worktree\tremote.backup.partialclonefilter\n", code: 0 }, "partial-clone"],
    ["a promisor remote in the user's own config still skips: the fetch goes to the repository's remote", { stdout: "global\tremote.origin.promisor\n", code: 0 }, "partial-clone"],
    ["a partial clone with the user's git-lfs", { stdout: "global\tfilter.lfs.clean\nlocal\textensions.partialclone\n", code: 0 }, "partial-clone"],
    ["a git without --show-scope", { stdout: "", stderr: "error: unknown option `show-scope'\n", code: 129 }, `git config --show-scope --includes --name-only --get-regexp ${CONFIG_KEYS_RE} exited 129: error: unknown option \`show-scope'`],
  ];
  for (const [name, config, skipped] of cases) {
    const { exec, calls } = fakeGit({ config });
    const result = await captureWorkspace({ exec, cwd: "/repo", commands: [], now: () => CAPTURED });
    if (skipped === undefined) {
      assert.ok("snapshot" in result, name);
      continue;
    }
    assert.deepEqual(result, { skipped }, name);
    assert.ok(!calls.some((call) => call.includes("status") || call.includes("diff")), `${name}: status or diff ran`);
  }
});

test("captureWorkspace: GIT_CONFIG in the environment skips the snapshot before any git runs, since `git config` would read only that file (security.md T8)", async () => {
  for (const [name, env, skipped] of [
    ["set", { GIT_CONFIG: "/home/user/other.gitconfig" }, "git-config-env"],
    ["set but empty", { GIT_CONFIG: "" }, "git-config-env"],
    ["unset", {}, undefined],
  ] as const) {
    const { exec, calls } = fakeGit();
    const result = await captureWorkspace({ exec, cwd: "/repo", commands: [], env, now: () => CAPTURED });
    if (skipped === undefined) {
      assert.ok("snapshot" in result, name);
      continue;
    }
    assert.deepEqual(result, { skipped }, name);
    assert.deepEqual(calls, [], `${name}: git ran`);
  }
});

/** A real git in `home`, with no system config and `globalConfig` as the user's: nothing from the machine running the test. */
function realGit(home: string, globalConfig: string): ExecFn {
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
  Object.assign(env, { HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: globalConfig });
  return (command, args, options) =>
    new Promise((resolve) => {
      execFile(command, args, { cwd: options.cwd, timeout: options.timeout, env }, (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({ stdout, stderr, code, killed: error?.killed ?? false });
      });
    });
}

test("captureWorkspace with a real git: a filter driver planted in .git/config never runs; the user's own still does (security.md T8)", async (t) => {
  try {
    execFileSync("git", ["--version"]);
  } catch {
    t.skip("git is not installed");
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "longhaul-workspace-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  const marker = path.join(root, "MARK");
  const globalConfig = path.join(root, "gitconfig");
  fs.writeFileSync(globalConfig, "");
  const exec = realGit(root, globalConfig);
  const git = async (...args: string[]) => assert.equal((await exec("git", args, { cwd: repo, timeout: 10_000 })).code, 0, `git ${args.join(" ")}`);
  fs.mkdirSync(repo);
  await git("init", "-q");
  fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
  await git("add", "a.txt");
  await git("-c", "user.name=example", "-c", "user.email=dev@example.com", "commit", "-qm", "init");
  fs.writeFileSync(path.join(repo, ".gitattributes"), "* filter=planted\n");
  fs.writeFileSync(path.join(repo, "a.txt"), "two\n");
  await git("config", "filter.planted.clean", `touch '${marker}'; cat`);

  assert.deepEqual(await captureWorkspace({ exec, cwd: repo, commands: [] }), { skipped: "repo-filter-driver" });
  assert.equal(fs.existsSync(marker), false, "the planted filter ran");

  await git("config", "--unset", "filter.planted.clean");
  fs.writeFileSync(globalConfig, `[filter "planted"]\n\tclean = touch '${marker}'; cat\n`);
  const trusted = await captureWorkspace({ exec, cwd: repo, commands: [] });
  assert.ok("snapshot" in trusted, JSON.stringify(trusted));
  assert.match(trusted.snapshot.statusShort ?? "", /a\.txt/);
});

test("captureWorkspace with a real git: a partial clone's missing object never makes git run the remote's upload-pack (security.md T8)", async (t) => {
  try {
    execFileSync("git", ["--version"]);
  } catch {
    t.skip("git is not installed");
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "longhaul-promisor-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const repo = path.join(root, "repo");
  const marker = path.join(root, "MARK");
  const globalConfig = path.join(root, "gitconfig");
  fs.writeFileSync(globalConfig, "");
  const exec = realGit(root, globalConfig);
  const gitIn = async (cwd: string, ...args: string[]) => {
    const result = await exec("git", args, { cwd, timeout: 10_000 });
    assert.equal(result.code, 0, `git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  };
  const commit = ["-c", "user.name=example", "-c", "user.email=dev@example.com", "commit", "-qam"];
  fs.mkdirSync(source);
  await gitIn(source, "init", "-q");
  await gitIn(source, "config", "uploadpack.allowFilter", "true");
  fs.writeFileSync(path.join(source, "a.txt"), "one\n");
  await gitIn(source, "add", "a.txt");
  await gitIn(source, ...commit, "one");
  const oldBlob = await gitIn(source, "rev-parse", "HEAD:a.txt");
  fs.writeFileSync(path.join(source, "a.txt"), "two\n");
  await gitIn(source, ...commit, "two");
  // The clone checks out "two"; the blob for "one" stays on the remote, fetched only on demand.
  await gitIn(root, "clone", "-q", "--filter=blob:none", `file://${source}`, repo);
  // What a planted checkout would carry: an upload-pack that runs a program, and an index entry
  // naming an object the clone does not have, so `diff` must fetch it.
  await gitIn(repo, "config", "remote.origin.uploadpack", `touch '${marker}'; git-upload-pack`);
  await gitIn(repo, "update-index", "--cacheinfo", `100644,${oldBlob},a.txt`);

  assert.deepEqual(await captureWorkspace({ exec, cwd: repo, commands: [] }), { skipped: "partial-clone" });
  assert.equal(fs.existsSync(marker), false, "the remote's upload-pack ran");

  // The control: the vector is real, so the skip above is what stopped it.
  await exec("git", ["diff", "--stat"], { cwd: repo, timeout: 10_000 });
  assert.equal(fs.existsSync(marker), true, "git diff did not lazy-fetch; this test no longer exercises the vector");
});
