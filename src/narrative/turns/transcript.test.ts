import test from "node:test";
import assert from "node:assert/strict";

import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { assistantEntry, toolResultEntry, userEntry } from "../../test-support.ts";
import { condenseTranscript } from "./transcript.ts";

const msg = (entry: unknown) => (entry as { message: AgentMessage }).message;

function session(): AgentMessage[] {
  return [
    msg(userEntry("m1", "[u1] fix the failing test")),
    msg(assistantEntry("a1", "Looking at the test first.", [{ name: "bash", arguments: { command: "npm test" } }])),
    msg(toolResultEntry("r1", "a1-t0", "bash", `FAIL src/a.test.ts\n${"x".repeat(3000)}\nTests: 1 failed`, true)),
    msg(assistantEntry("a2", "", [{ name: "read", arguments: { path: "src/a.ts" } }])),
    msg(toolResultEntry("r2", "a2-t0", "read", "export const a = 1;")),
  ];
}

test("condenseTranscript: assistant text verbatim, one line per tool call, a user message as its ordinal only", () => {
  const { text } = condenseTranscript(session(), 100_000);
  const lines = text.split("\n");
  assert.equal(lines[0], "[u1] (user message: words in <user-messages>)");
  assert.equal(lines[1], "assistant: Looking at the test first.");
  assert.equal(lines[2], "T1 → bash: npm test");
  assert.ok(lines.includes("T2 → read src/a.ts"), text);
  assert.ok(lines.includes("  ← ok: export const a = 1;"), text);
});

test("condenseTranscript: a long tool result keeps its head and tail, the full output stays behind show(T<n>)", () => {
  const { text, outputs } = condenseTranscript(session(), 100_000);
  const result = text.split("\n").find((line) => line.startsWith("  ← error:"))!;
  assert.ok(result.startsWith("  ← error: FAIL src/a.test.ts"), result);
  assert.ok(result.endsWith("Tests: 1 failed"), result);
  assert.match(result, /… \d+ chars, show T1 …/);
  assert.ok(result.length < 1000);
  assert.ok(outputs.get("T1")!.includes("x".repeat(3000)));
});

test("condenseTranscript: over the budget the oldest tool output goes first, never the newest, never the user marker", () => {
  const full = condenseTranscript(session(), 100_000).text;
  const { text } = condenseTranscript(session(), full.length - 50);
  assert.ok(text.includes("  ← error: (output dropped: show T1)"), text);
  assert.ok(text.includes("  ← ok: export const a = 1;"), text);
  assert.ok(text.startsWith("[u1] (user message"));
});

test("condenseTranscript: an image in a tool result is a placeholder naming the file, never the bytes", () => {
  const image = { role: "toolResult", toolCallId: "a2-t0", toolName: "read", content: [{ type: "text", text: "Read image file" }, { type: "image", data: "QUJD".repeat(500), mimeType: "image/png" }], isError: false, timestamp: 1 } as unknown as AgentMessage;
  const messages = [msg(assistantEntry("a2", "", [{ name: "read", arguments: { path: "shot.png" } }])), image];
  const { text } = condenseTranscript(messages, 100_000);
  assert.ok(text.includes("[image: read shot.png]"), text);
  assert.ok(!text.includes("QUJD"));
});

test("condenseTranscript: a user ! command is a line with its output cut like a tool result", () => {
  const bang = { role: "bashExecution", command: "git status", output: "On branch main", exitCode: 0, timestamp: 1 } as unknown as AgentMessage;
  const { text } = condenseTranscript([bang], 100_000);
  assert.equal(text, "T1 → user ran: git status\n  ← ok: On branch main");
});

test("condenseTranscript: a bash call the ledger knows carries its command id, so the model cites C<n> rather than T<n>", () => {
  const { text } = condenseTranscript(session(), 100_000, (command) => (command === "npm test" ? "C3" : undefined));
  assert.ok(text.split("\n").includes("T1 → bash [C3]: npm test"), text);
});

test("condenseTranscript: a multi-line command is one line; each whitespace run holding a line end is one ⏎ (table)", () => {
  const cases: Array<[string, string, string]> = [
    ["blank lines and indentation collapse", "a \n\n  b\n \nc", "T1 → bash: a ⏎ b ⏎ c"],
    ["a run without a line end stays", "x   y\tz", "T1 → bash: x   y z"],
    ["CRLF and a control character", "p\r\nq\u0001r", "T1 → bash: p ⏎ q r"],
    ["leading and trailing line ends are kept as markers", "\n  cmd  \n", "T1 → bash: ⏎ cmd ⏎"],
  ];
  for (const [name, command, line] of cases) {
    const { text } = condenseTranscript([msg(assistantEntry("a1", "", [{ name: "bash", arguments: { command } }]))], 100_000);
    assert.equal(text.split("\n")[0], line, name);
  }
});

test("condenseTranscript: a long whitespace run in a command stays linear (security.md T4)", () => {
  for (const command of [`a${" ".repeat(200_000)}b`, `a${" \t".repeat(100_000)}\nb`]) {
    const started = performance.now();
    condenseTranscript([msg(assistantEntry("a1", "", [{ name: "bash", arguments: { command } }]))], 100_000);
    const elapsedMs = performance.now() - started;
    assert.ok(elapsedMs < 500, `took ${Math.round(elapsedMs)} ms`);
  }
});
