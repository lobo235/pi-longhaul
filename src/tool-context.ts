/**
 * What a tool call sees: the store folded from the branch as it is now (the open span's remember
 * entries included), the user-message index, and the live ledger = the last state entry's carried
 * records plus the commands and errors observed since. Built per call: cheap (one pass over the
 * branch), and never stale.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import { previousFileLists, type FileLists } from "./carry.ts";
import { buildMessageIndex, type MessageIndex } from "./intent.ts";
import { collectHandoff, type CommandRecord, type ErrorRecord } from "./ledger/handoff.ts";
import type { StateLog } from "./store/events.ts";
import { readLog } from "./store/log.ts";

export interface ToolContext {
  log: StateLog;
  index: MessageIndex;
  ledger: { commands: CommandRecord[]; errors: ErrorRecord[] };
  /** The latest compaction's carried file lists; empty before the first compaction. */
  files: FileLists;
}

export function messagesSinceLastCompaction(branch: SessionEntry[]): AgentMessage[] {
  let start = 0;
  for (let index = branch.length - 1; index >= 0; index--) {
    if (branch[index].type === "compaction") { start = index + 1; break; }
  }
  return branch.slice(start).filter((entry) => entry.type === "message").map((entry) => (entry as { message: AgentMessage }).message);
}

/** The live ledger alone, for a caller that needs no index, log or files (recall what=output). */
export function liveLedger(branch: SessionEntry[]): ToolContext["ledger"] {
  const handoff = collectHandoff({ branchEntries: branch, messages: messagesSinceLastCompaction(branch) });
  return { commands: handoff.commands, errors: handoff.errors };
}

export function buildToolContext(branch: SessionEntry[]): ToolContext {
  const ledger = liveLedger(branch);
  const index = buildMessageIndex(branch, { commandIds: new Set(ledger.commands.map((record) => record.id)), errorIds: new Set(ledger.errors.map((record) => record.id)) });
  return { log: readLog(branch, index), index, ledger, files: previousFileLists(branch) ?? { readFiles: [], modifiedFiles: [] } };
}
