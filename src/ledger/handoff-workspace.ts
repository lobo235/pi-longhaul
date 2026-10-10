/**
 * The workspace snapshot: the repository's state at compaction time, from the session's working
 * directory, never from history. Five read-only git commands (the last, the short commit, is
 * optional: an unborn branch has none), one shared deadline, and nothing else — ever. Read-only
 * means more than the subcommands: hooks are disabled (`core.hooksPath`), the fsmonitor, external
 * diff and textconv programs are switched off, submodules are not entered, and a filter driver the
 * repository's own config defines (`.git/config`, its includes, the worktree's config) skips the
 * snapshot before `status` or `diff` could run it, and so does a partial clone, whose on-demand
 * fetch runs the transport the repository names. The user's own git config (global and system,
 * git-lfs's filter for one) is trusted and runs as it would in their shell (security.md T8). `status`
 * never refreshes or locks the index (`--no-optional-locks`), and `status`/`diff` are scoped to the
 * session directory's subtree so a repository above it (a dotfiles checkout in $HOME) is not listed.
 * A failure or a timeout drops the whole snapshot; a directory outside a git repo is skipped after
 * the first command. The snapshot must never fail or delay a compaction.
 */
import type { CommandRecord, WorkspaceSnapshot } from "./handoff.ts";

/** pi's ExtensionAPI.exec, narrowed to what the capture needs (injectable for tests). */
export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

export interface ExecFn {
  (command: string, args: string[], options: { cwd: string; timeout: number; signal?: AbortSignal }): Promise<ExecResult>;
}

export interface CaptureWorkspaceInput {
  exec: ExecFn;
  /** The session's working directory (ExtensionContext.cwd); never guessed. */
  cwd: string;
  /** The merged command ledger, for the most recent test command. */
  commands: CommandRecord[];
  /** Total time for all commands together; 5 s by default. */
  deadlineMs?: number;
  signal?: AbortSignal;
  now?: () => Date;
  /** The environment git inherits from pi; `process.env` by default (injectable for tests). */
  env?: NodeJS.ProcessEnv;
}

export type WorkspaceCapture = { snapshot: WorkspaceSnapshot } | { skipped: string };

export const WORKSPACE_DEADLINE_MS = 5000;
/** `git status --short` lines kept (`head -40`). */
const STATUS_LINES = 40;
/** Chars of short status kept (whole lines), so the workspace block, which the exact-half fit cannot shrink, stays well inside the 6,000-char budget. */
export const WORKSPACE_STATUS_CHARS = 2000;
const TEST_COMMAND_RE = /(node --test|npm test|pytest|go test|cargo test|make (check|test))/;

/** Every git invocation gets these first: no hooks, no fsmonitor program, no optional index writes. */
const GIT_OPTIONS = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "--no-optional-locks"];

/** Config scopes that are the user's own. Any other (`local`, `worktree`) is the repository's, so untrusted. */
const USER_SCOPES = new Set(["system", "global", "command"]);

/** The keys listed before any file is read: filter drivers, and what makes a repository a partial clone. */
const CONFIG_KEYS_RE = "^(filter\\.|extensions\\.partialclone$|remote\\..*\\.(promisor|partialclonefilter)$)";
const PARTIAL_CLONE_KEY = /^(extensions\.partialclone|remote\..*\.(promisor|partialclonefilter))$/;

/**
 * Why a `--show-scope` listing of those keys forbids reading file contents, if it does.
 *
 * A partial clone, in any scope: `status` or `diff` that reaches an object the clone lacks fetches it from the
 * promisor remote, and that remote's transport is the repository's to name (`remote.*.uploadpack`,
 * `core.sshCommand`, an `ext::` URL), so the fetch runs the repository's program. `protocol.allow=never` does not
 * hold (a repository-local `protocol.<name>.allow` overrides it) and `--no-lazy-fetch` needs git 2.41.
 *
 * A filter driver from a scope the user did not write: it runs its program on every file `.gitattributes` assigns
 * it to as soon as `status` or `diff` reads it, and only the repository's config is planted with the checkout.
 * A line with no scope fails closed (security.md T8).
 */
function configRefusal(listing: string): string | undefined {
  const entries = listing.split("\n").filter((line) => line !== "").map((line) => line.split("\t"));
  if (entries.some((fields) => PARTIAL_CLONE_KEY.test(fields[fields.length - 1]))) return "partial-clone";
  return entries.some((fields) => fields.length < 2 || !USER_SCOPES.has(fields[0])) ? "repo-filter-driver" : undefined;
}

interface GitCommand {
  key: keyof GitOutputs;
  args: string[];
  optional?: boolean;
  /** An exit code that means "nothing found" (empty output), not a failure. */
  noMatchCode?: number;
  /** A skip reason when the output says the commands after it must not run. */
  refuse?: (stdout: string) => string | undefined;
}

/** The only commands the capture ever runs, in this order; `-- .` scopes status and diff to the session directory. */
const GIT_COMMANDS: GitCommand[] = [
  { key: "branch", args: ["rev-parse", "--abbrev-ref", "HEAD"] },
  // Reading config runs nothing; it must come before anything that reads file contents. Exit 1: no key matched.
  { key: "config", args: ["config", "--show-scope", "--includes", "--name-only", "--get-regexp", CONFIG_KEYS_RE], noMatchCode: 1, refuse: configRefusal },
  { key: "status", args: ["status", "--short", "--ignore-submodules=all", "--", "."] },
  { key: "diff", args: ["diff", "--stat", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all", "--", "."] },
  // Optional: fails on an unborn branch, which is a repo without a commit, not a reason to skip.
  { key: "commit", args: ["rev-parse", "--short", "HEAD"], optional: true },
];

interface GitOutputs {
  branch: string;
  config: string;
  status: string;
  diff: string;
  commit: string;
}

/** Thrown inside the capture to abandon it with a reason; never escapes captureWorkspace. */
class SkipCapture extends Error {}

/** The most recently seen test command in the ledger (latest pass, then highest id) and its exit code. */
function lastTest(commands: CommandRecord[]): Pick<WorkspaceSnapshot, "lastTestCommand" | "lastTestExitCode"> {
  const idNumber = (id: string) => Number(/^C(\d+)$/.exec(id)?.[1] ?? 0);
  const matching = commands.filter((record) => TEST_COMMAND_RE.test(record.command));
  if (matching.length === 0) return {};
  const latest = matching.reduce((best, record) =>
    record.lastSeenPass > best.lastSeenPass || (record.lastSeenPass === best.lastSeenPass && idNumber(record.id) > idNumber(best.id)) ? record : best,
  );
  return { lastTestCommand: latest.command, lastTestExitCode: latest.lastExitCode };
}

function lastLine(text: string): string | undefined {
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  return lines.length === 0 ? undefined : lines[lines.length - 1];
}

/** The first `count` non-empty lines, whole lines only, as many as fit in `maxChars` joined. */
function headLines(text: string, count: number, maxChars: number): string | undefined {
  const lines = text.trimEnd().split("\n").filter((line) => line !== "").slice(0, count);
  const kept: string[] = [];
  let length = 0;
  for (const line of lines) {
    const next = length + line.length + (kept.length > 0 ? 1 : 0);
    if (next > maxChars) break;
    kept.push(line);
    length = next;
  }
  return kept.length === 0 ? undefined : kept.join("\n");
}

async function runGit(input: CaptureWorkspaceInput, { args, noMatchCode }: GitCommand, deadlineAt: number): Promise<string> {
  const timeout = deadlineAt - Date.now();
  const label = `git ${args.join(" ")}`;
  if (timeout <= 0) throw new SkipCapture(`timeout after ${input.deadlineMs ?? WORKSPACE_DEADLINE_MS} ms`);
  let result: ExecResult;
  try {
    result = await input.exec("git", [...GIT_OPTIONS, ...args], { cwd: input.cwd, timeout, signal: input.signal });
  } catch (error) {
    throw new SkipCapture(`${label} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (result.killed || Date.now() > deadlineAt) throw new SkipCapture(`timeout after ${input.deadlineMs ?? WORKSPACE_DEADLINE_MS} ms`);
  if (result.code === noMatchCode) return "";
  if (result.code !== 0) {
    if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") throw new SkipCapture("not-a-git-repo");
    throw new SkipCapture(`${label} exited ${result.code}: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

/**
 * Capture the snapshot, or say why not. `skipped` is "not-a-git-repo" outside a repository (a
 * silent skip), "repo-filter-driver" when the repository's config defines a filter driver,
 * "partial-clone" when objects may be fetched on demand, "git-config-env" when GIT_CONFIG is set,
 * otherwise the failing command or the timeout, for the `workspace-skipped` log record.
 */
export async function captureWorkspace(input: CaptureWorkspaceInput): Promise<WorkspaceCapture> {
  // With GIT_CONFIG set, `git config` reads that one file and none of the repository's, so the check above would
  // pass a planted driver that `status` still runs.
  if ((input.env ?? process.env).GIT_CONFIG !== undefined) return { skipped: "git-config-env" };
  const deadlineAt = Date.now() + (input.deadlineMs ?? WORKSPACE_DEADLINE_MS);
  const outputs: Partial<GitOutputs> = {};
  try {
    for (const command of GIT_COMMANDS) {
      try {
        outputs[command.key] = await runGit(input, command, deadlineAt);
      } catch (error) {
        const timedOut = error instanceof SkipCapture && error.message.startsWith("timeout");
        if (!command.optional || timedOut) throw error;
      }
      const refused = command.refuse?.(outputs[command.key] ?? "");
      if (refused) throw new SkipCapture(refused);
    }
  } catch (error) {
    if (error instanceof SkipCapture) return { skipped: error.message };
    return { skipped: error instanceof Error ? error.message : String(error) };
  }
  const branch = outputs.branch?.trim();
  return {
    snapshot: {
      capturedAt: (input.now ?? (() => new Date()))().toISOString(),
      cwd: input.cwd,
      branch: branch ? branch : undefined,
      commit: outputs.commit?.trim() || undefined,
      statusShort: headLines(outputs.status ?? "", STATUS_LINES, WORKSPACE_STATUS_CHARS),
      diffStat: lastLine(outputs.diff ?? ""),
      ...lastTest(input.commands),
    },
  };
}
