/**
 * Observation for the handoff ledger: what ran and what failed in the messages a compaction
 * covers. Bash tool calls are paired with their results by tool call id; `!command` executions
 * carry their own exit code. Nothing here reads prose: a command the assistant merely mentioned
 * is not a run, and an error quoted in a reply is not an error.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { contentText as textOf } from "../message-text.ts";

/** One command that ran: a `bash` tool call with its result, or a `!command` from the TUI. */
export interface ObservedRun {
  command: string;
  /** Exit code when known; null for a timeout, a cancelled execution, or a result not yet seen. */
  exitCode: number | null;
  /** When it ran (epoch ms): its result's time, else the call's; undefined when the message has none. */
  at?: number;
}

/** One failure signature in a tool result, tied to the run (index into the runs) that produced it. */
export interface ObservedError {
  signature: string;
  /** The command whose result carried it; undefined for a non-bash tool's error. */
  sourceCommand?: string;
  /** Position of the source run among the pass's runs; -1 when there is none. */
  runIndex: number;
}

export interface ObservedEvents {
  runs: ObservedRun[];
  errors: ObservedError[];
}

/** pi's bash tool ends a non-zero result with this line (dist/core/tools/bash.js). */
const EXIT_CODE_RE = /\n?Command exited with code (\d+)\s*$/;

/** The error line pattern, at a line start, plus tsc's own `file(line,col): error TSnnnn` line. */
const ERROR_LINE_RE = /^(Error|error:|Traceback|Exception|FAILED|panic:|fatal:|npm ERR!|tsc.*error TS|\S+\(\d+,\d+\): error TS\d+)/;

/** A signature is the matching line plus up to this many following lines, capped in chars. */
const SIGNATURE_FOLLOWING_LINES = 3;
export const SIGNATURE_CAP = 400;

type Rec = Record<string, unknown>;

function asRecord(value: unknown): Rec | undefined {
  return typeof value === "object" && value !== null ? (value as Rec) : undefined;
}

/** A tool result's text split into the output and the exit code pi appended (null when absent). */
function splitExit(text: string): { output: string; exitCode: number | null } {
  const match = EXIT_CODE_RE.exec(text);
  if (!match) return { output: text, exitCode: null };
  return { output: text.slice(0, match.index), exitCode: Number(match[1]) };
}

/**
 * The failure signature of a tool result, or undefined when it holds none: the first line
 * matching the error pattern plus up to three following lines; for a non-zero exit with no such
 * line, the last lines of output.
 */
export function errorSignature(output: string, exitCode: number | null): string | undefined {
  const lines = output.trimEnd().split("\n");
  const at = lines.findIndex((line) => ERROR_LINE_RE.test(line));
  let picked: string[];
  if (at >= 0) picked = lines.slice(at, at + 1 + SIGNATURE_FOLLOWING_LINES);
  else if (exitCode !== null && exitCode !== 0) picked = lines.filter((line) => line.trim() !== "").slice(-(1 + SIGNATURE_FOLLOWING_LINES));
  else return undefined;
  const signature = picked.join("\n").trim();
  if (signature === "") return undefined;
  return signature.length > SIGNATURE_CAP ? `${signature.slice(0, SIGNATURE_CAP - 3)}...` : signature;
}

function bashToolCalls(message: Rec): { id: string; command: string }[] {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return [];
  const calls: { id: string; command: string }[] = [];
  for (const raw of message.content) {
    const block = asRecord(raw);
    const args = asRecord(block?.arguments);
    if (block?.type === "toolCall" && block.name === "bash" && typeof args?.command === "string") {
      calls.push({ id: String(block.id), command: args.command });
    }
  }
  return calls;
}

interface ToolOutcome {
  exitCode: number | null;
  signature: string | undefined;
  at?: number;
}

/** What a tool result amounts to: its exit code (0 unless pi flagged an error) and any failure signature. */
function toolOutcome(result: Rec): ToolOutcome {
  const { output, exitCode } = splitExit(textOf(result.content));
  const effective = exitCode ?? (result.isError ? null : 0);
  return { exitCode: effective, signature: errorSignature(output, effective ?? (result.isError ? 1 : 0)), at: timeOf(result) };
}

const timeOf = (message: Rec): number | undefined => (typeof message.timestamp === "number" && Number.isFinite(message.timestamp) ? message.timestamp : undefined);

function bashExecution(message: Rec): { run: ObservedRun; signature: string | undefined } | undefined {
  if (message.role !== "bashExecution" || typeof message.command !== "string") return undefined;
  if (message.excludeFromContext) return undefined;
  const exitCode = !message.cancelled && typeof message.exitCode === "number" ? message.exitCode : null;
  const output = typeof message.output === "string" ? message.output : "";
  return { run: { command: message.command, exitCode, at: timeOf(message) }, signature: message.cancelled ? undefined : errorSignature(output, exitCode) };
}

/**
 * Every shell command and every failure in `messages`, in order. A `!!` execution excluded from
 * the model's context is not recorded. A non-bash tool's error (a read of a missing file, say)
 * is an error with no source command.
 */
export function observeEvents(messages: AgentMessage[]): ObservedEvents {
  const records = messages.map((message) => message as unknown as Rec);
  const outcomes = new Map<string, ToolOutcome>();
  for (const message of records) {
    if (message.role === "toolResult" && typeof message.toolCallId === "string") outcomes.set(message.toolCallId, toolOutcome(message));
  }
  const runs: ObservedRun[] = [];
  const errors: ObservedError[] = [];
  const seenCalls = new Set<string>();
  for (const message of records) {
    const execution = bashExecution(message);
    if (execution) {
      runs.push(execution.run);
      if (execution.signature) errors.push({ signature: execution.signature, sourceCommand: execution.run.command, runIndex: runs.length - 1 });
    }
    for (const call of bashToolCalls(message)) {
      seenCalls.add(call.id);
      const outcome = outcomes.get(call.id);
      runs.push({ command: call.command, exitCode: outcome?.exitCode ?? null, at: outcome?.at ?? timeOf(message) });
      if (outcome?.signature) errors.push({ signature: outcome.signature, sourceCommand: call.command, runIndex: runs.length - 1 });
    }
    if (message.role === "toolResult" && typeof message.toolCallId === "string" && !seenCalls.has(message.toolCallId)) {
      // A result whose call is outside the range, or from another tool: an error, no source command.
      const signature = outcomes.get(message.toolCallId)?.signature;
      if (signature && message.toolName !== "bash") errors.push({ signature, runIndex: -1 });
    }
  }
  return { runs, errors };
}
