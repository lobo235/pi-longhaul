/**
 * JSONL logging shared by the compaction hook and the per-message instrumentation.
 *
 * Always on by default -- an opt-in log is one you never have on when you need it -- with a
 * size-based rotation so it never grows without bound, and writes that never throw so logging
 * can never break a compaction or a turn.
 */
import fs from "node:fs";
import path from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Per-compaction records (hook-enter, success, fallback, ...): `<agent dir>/logs/compaction-state.jsonl`. */
export const defaultLogPath = (agentDir: string = getAgentDir()): string => path.join(agentDir, "logs", "compaction-state.jsonl");

/** Rotate a log at this size (keeps one .1 backup). */
export const LOG_MAX_BYTES = 5 * 1024 * 1024;

/** Sentinels (case-insensitive) that turn a log off. */
const LOG_OFF_SENTINELS = new Set(["", "off", "none", "0", "false", "no"]);

/**
 * Resolve where a log is written. An unset env var yields the default path; an explicit path
 * overrides it; an off-sentinel disables the log (returns undefined).
 */
export function resolveLogPath(envValue: string | undefined, defaultPath: string): string | undefined {
  if (envValue === undefined) return defaultPath;
  const trimmed = envValue.trim();
  if (LOG_OFF_SENTINELS.has(trimmed.toLowerCase())) return undefined;
  return trimmed;
}

const PRIVATE_FILE = 0o600;

/**
 * Never follow a symlink; never block on a FIFO with no reader (ENXIO instead). Windows has neither flag, so there
 * a symlink is refused by `lstat` before the open: a symlink planted between the two calls is followed (security.md T6).
 */
const NO_FOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const SAFE_OPEN = NO_FOLLOW | (fs.constants.O_NONBLOCK ?? 0);

/** Whether `logPath` is a symlink, where the open cannot refuse one itself. */
function symlinkWithoutNoFollow(logPath: string): boolean {
  if (NO_FOLLOW) return false;
  try {
    return fs.lstatSync(logPath).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Make a log directory this user owns readable by its owner only. Meant for the default directory, which is
 * the extension's own; a directory the user chose -- by path, or by making `logs/` a symlink -- keeps its
 * mode. Never throws.
 */
export function privateLogDir(dir: string): void {
  try {
    const stat = fs.lstatSync(dir);
    if (stat.isDirectory() && stat.uid === process.getuid?.()) fs.chmodSync(dir, 0o700);
  } catch {
    // a missing directory is created 0700 on the first write
  }
}

/** Run `use` on `logPath` opened with `flags`, only if it is a regular file; otherwise do nothing. */
export function withRegularFile(logPath: string, flags: number, use: (fd: number, stat: fs.Stats) => void): void {
  if (symlinkWithoutNoFollow(logPath)) return;
  const fd = fs.openSync(logPath, flags | SAFE_OPEN, PRIVATE_FILE);
  try {
    const stat = fs.fstatSync(fd);
    if (stat.isFile()) use(fd, stat);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Rotate an over-size log to `.1`, tightened first (on the open file, not the path) so the backup is never
 * looser than the log. A file another session rotated away first is not an error: the append goes on.
 */
function rotate(logPath: string): void {
  let oversize = false;
  try {
    withRegularFile(logPath, fs.constants.O_RDONLY, (fd, stat) => {
      oversize = stat.size > LOG_MAX_BYTES;
      if (oversize) fs.fchmodSync(fd, PRIVATE_FILE);
    });
    if (oversize) fs.renameSync(logPath, `${logPath}.1`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/**
 * Append one JSONL record with an `at` timestamp. Rotates at LOG_MAX_BYTES. Never throws. The log names the
 * user's working directories and models, so it is readable by its owner only: created 0600, tightened on every
 * write (a log from before this rule, or a looser umask), and never written through a symlink. A path that is
 * not a regular file (a FIFO, a device such as /dev/null) is left untouched and the record dropped.
 */
export function appendJsonl(logPath: string, record: Record<string, unknown>): void {
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
    rotate(logPath);
    withRegularFile(logPath, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT, (fd) => {
      fs.fchmodSync(fd, PRIVATE_FILE);
      fs.writeSync(fd, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`);
    });
  } catch {
    // logging must never break compaction or a turn
  }
}
