/**
 * Fakes for the ledger tests: bash calls and results, `!commands`, user messages, and the branch
 * as the next compaction sees it.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import type { FinishedHandoff, HandoffDetails } from "./handoff.ts";

let nextCall = 0;

export function bashCall(command: string, exit: number | "timeout" | "pending" = 0, output = "ok"): AgentMessage[] {
  const id = `call-${++nextCall}`;
  const call = {
    role: "assistant",
    content: [{ type: "toolCall", id, name: "bash", arguments: { command } }],
    api: "openai-completions",
    provider: "test",
    model: "m",
    stopReason: "toolUse",
    timestamp: nextCall,
  } as unknown as AgentMessage;
  if (exit === "pending") return [call];
  const text = exit === "timeout" ? `${output}\n\nCommand timed out after 30 seconds` : exit === 0 ? output : `${output}\n\nCommand exited with code ${exit}`;
  return [call, toolResult(id, "bash", text, exit !== 0)];
}

/** A result for any tool (a `read` that failed, say), with no bash call in front of it. */
export function toolResult(toolCallId: string, toolName: string, text: string, isError: boolean): AgentMessage {
  return { role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], isError, timestamp: ++nextCall } as unknown as AgentMessage;
}

/** A `!command` the user ran from the TUI. */
export function bashExecution(command: string, exitCode: number | undefined = 0, extra: Record<string, unknown> = {}): AgentMessage {
  return { role: "bashExecution", command, output: "", exitCode, cancelled: false, truncated: false, timestamp: ++nextCall, ...extra } as unknown as AgentMessage;
}

export function userMsg(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: ++nextCall } as AgentMessage;
}

/** The branch as the next compaction sees it: one earlier compaction entry per `detailsList` item. */
export function branchWith(...detailsList: HandoffDetails[]): SessionEntry[] {
  return detailsList.map(
    (details, index) =>
      ({ type: "compaction", id: `c${index}`, parentId: null, timestamp: "2026-09-15T00:00:00.000Z", summary: "s", firstKeptEntryId: "x", tokensBefore: 1, details, fromHook: true }) as unknown as SessionEntry,
  );
}

/** What a compactor that carries the ledger at the top level stores in the entry's details from a finished handoff. */
export function handoffDetailsOf(finished: FinishedHandoff): HandoffDetails {
  return { readFiles: [], modifiedFiles: [], commands: finished.commands, errors: finished.errors, workspace: finished.workspace };
}
