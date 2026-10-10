import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { appendJsonl, defaultLogPath, LOG_MAX_BYTES, privateLogDir } from "./log.ts";

function scratch(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "state-jsonl-"));
}

const mode = (file: string) => fs.statSync(file).mode & 0o777;
/** Windows has no POSIX modes, owners or FIFOs: a test about only those is skipped there, and mode checks are POSIX-only. */
const WINDOWS = process.platform === "win32";
const posixOnly = { skip: WINDOWS ? "Windows has no POSIX file modes, owners or FIFOs" : false };

test("appendJsonl: a log written under a looser mode is 0600 after the next write, and so is the backup a rotation makes of it", () => {
  const dir = scratch();
  try {
    const logPath = path.join(dir, "state.jsonl");
    fs.writeFileSync(logPath, "x".repeat(LOG_MAX_BYTES + 1), { mode: 0o664 });
    fs.chmodSync(logPath, 0o664);
    appendJsonl(logPath, { event: "after-rotation" });
    if (!WINDOWS) {
      assert.equal(mode(`${logPath}.1`), 0o600);
      assert.equal(mode(logPath), 0o600);
    }
    assert.ok(fs.statSync(`${logPath}.1`).size > LOG_MAX_BYTES, "the backup is the rotated log");
    assert.match(fs.readFileSync(logPath, "utf8"), /"event":"after-rotation"/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("appendJsonl: a symlink at the log path is not followed; nothing is written through it", () => {
  const dir = scratch();
  try {
    const target = path.join(dir, "elsewhere.txt");
    fs.writeFileSync(target, "untouched\n", { mode: 0o644 });
    fs.chmodSync(target, 0o644);
    const logPath = path.join(dir, "state.jsonl");
    fs.symlinkSync(target, logPath);
    appendJsonl(logPath, { event: "planted" });
    assert.equal(fs.readFileSync(target, "utf8"), "untouched\n");
    if (!WINDOWS) assert.equal(mode(target), 0o644);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("appendJsonl: a directory it creates is 0700; an existing directory the user chose keeps its mode", posixOnly, () => {
  const dir = scratch();
  try {
    appendJsonl(path.join(dir, "new", "state.jsonl"), { event: "first" });
    assert.equal(mode(path.join(dir, "new")), 0o700);
    fs.mkdirSync(path.join(dir, "shared"), { mode: 0o755 });
    fs.chmodSync(path.join(dir, "shared"), 0o755);
    appendJsonl(path.join(dir, "shared", "state.jsonl"), { event: "first" });
    assert.equal(mode(path.join(dir, "shared")), 0o755);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("privateLogDir: a directory this user owns is made 0700; a missing one is left alone", posixOnly, () => {
  const dir = scratch();
  try {
    fs.chmodSync(dir, 0o775);
    privateLogDir(dir);
    assert.equal(mode(dir), 0o700);
    assert.doesNotThrow(() => privateLogDir(path.join(dir, "missing")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("privateLogDir: a symlinked log directory is the user's and keeps its target's mode", posixOnly, () => {
  const dir = scratch();
  try {
    const shared = path.join(dir, "shared");
    fs.mkdirSync(shared, { mode: 0o755 });
    fs.chmodSync(shared, 0o755);
    fs.symlinkSync(shared, path.join(dir, "logs"));
    privateLogDir(path.join(dir, "logs"));
    assert.equal(mode(shared), 0o755);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Never pass a real system path here: privateLogDir chmods, and as root every directory is "owned".
test("privateLogDir: a directory another user owns is left alone", { skip: WINDOWS ? posixOnly.skip : process.getuid?.() === 0 ? "running as root" : false }, () => {
  const foreign = ["/usr", "/etc", "/"].find((candidate) => fs.statSync(candidate).uid !== process.getuid?.());
  if (!foreign) return;
  const before = mode(foreign);
  privateLogDir(foreign);
  assert.equal(mode(foreign), before);
});

test("appendJsonl: a log path that is not a regular file is neither blocked on, re-moded nor written", posixOnly, () => {
  const dir = scratch();
  try {
    const fifo = path.join(dir, "state.jsonl");
    execFileSync("mkfifo", ["-m", "0644", fifo]);
    appendJsonl(fifo, { event: "into-a-fifo" });
    assert.equal(mode(fifo), 0o644);
    assert.ok(fs.statSync(fifo).isFIFO());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("defaultLogPath: the log lives in pi's agent dir, logs/compaction-state.jsonl, not next to the code", () => {
  assert.equal(defaultLogPath("/somewhere/agent"), path.join("/somewhere/agent", "logs", "compaction-state.jsonl"));
});
