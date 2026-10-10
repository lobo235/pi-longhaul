import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";

import { drive } from "./drive.ts";

/** A pi stand-in: stdin commands are collected; `emit` writes RPC events on stdout. */
function fakePi() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const commands: Array<{ id?: string; type: string }> = [];
  stdin.on("data", (chunk) => { for (const line of String(chunk).split("\n").filter(Boolean)) commands.push(JSON.parse(line)); });
  const emit = (event: object) => stdout.write(JSON.stringify(event) + "\n");
  return { child: { stdin, stdout }, commands, emit };
}

const settleAfterPrompt = (pi: ReturnType<typeof fakePi>, hang: Set<string>) => {
  pi.child.stdin.on("data", (chunk) => {
    for (const line of String(chunk).split("\n").filter(Boolean)) {
      const command = JSON.parse(line) as { id?: string; type: string };
      if (command.type === "prompt" && !hang.has(command.id ?? "")) setImmediate(() => pi.emit({ type: "agent_settled" }));
      if (command.type === "abort") setImmediate(() => pi.emit({ type: "agent_settled" }));
    }
  });
};

test("drive: a turn that goes quiet (a tool call that never returns) is aborted, as a user would press Esc, and the next turn runs", async () => {
  const pi = fakePi();
  settleAfterPrompt(pi, new Set(["t1"]));
  const lines: string[] = [];
  await drive(pi.child, ["one", "two", "three"], (line) => lines.push(line), { idleMs: 30, turnMs: 5000 });
  assert.deepEqual(pi.commands.map((command) => command.type), ["prompt", "prompt", "abort", "prompt"]);
  assert.ok(lines.includes("turn 2/3: aborted after 0 min with no event"), lines.join(" | "));
  assert.ok(lines.at(-1)?.startsWith("done: 3 turns, 0 compactions, 1 aborted"), lines.at(-1));
});

test("drive: a slow turn that keeps emitting events is never aborted", async () => {
  const pi = fakePi();
  settleAfterPrompt(pi, new Set(["t0"]));
  const ticker = setInterval(() => pi.emit({ type: "message_update" }), 10);
  setTimeout(() => { clearInterval(ticker); pi.emit({ type: "agent_settled" }); }, 120);
  const lines: string[] = [];
  await drive(pi.child, ["slow"], (line) => lines.push(line), { idleMs: 50, turnMs: 5000 });
  assert.deepEqual(pi.commands.map((command) => command.type), ["prompt"]);
  assert.ok(lines.at(-1)?.startsWith("done: 1 turns, 0 compactions, 0 aborted"), lines.at(-1));
});

test("drive: a turn still busy at the overall limit fails the recording", async () => {
  const pi = fakePi();
  settleAfterPrompt(pi, new Set(["t0"]));
  const ticker = setInterval(() => pi.emit({ type: "message_update" }), 10);
  await assert.rejects(drive(pi.child, ["endless"], () => {}, { idleMs: 50, turnMs: 120 }), /turn 1 did not settle/);
  clearInterval(ticker);
});
