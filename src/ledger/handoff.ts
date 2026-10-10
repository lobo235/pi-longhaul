/**
 * The handoff: the exact half of a compaction.
 *
 * The exact half is mechanical: the shell commands the session ran, with their run counts and exit
 * codes, and the failure signatures its tool results carried, carried byte-exact from compaction
 * to compaction through the compaction entry's `details`, plus the repository's state captured at
 * compaction time (handoff-workspace.ts). No model produces or rewrites a record.
 *
 * Two calls. `collectHandoff` runs before the pass: it rehydrates the carried records and absorbs
 * every run and failure in the messages being compacted. `finishHandoff` runs after the workspace
 * capture has answered: it ranks the records, caps them, and fits them to EXACT_HALF_BUDGET (the
 * rendered `<commands>`, `<errors>` and `<workspace>` blocks are the size measure). The state
 * between them is a plain value, so a test needs no fakes.
 *
 * Interface (designed twice): a pipeline of a dozen exported pure functions and a stateful
 * `HandoffLedger` class whose call order was a footgun were sketched against this two-call module;
 * the two-call shape won. The pipeline's pieces live in handoff-observe.ts, handoff-commands.ts,
 * handoff-errors.ts, handoff-workspace.ts and handoff-render.ts. The workspace capture is the one
 * async, side-effecting piece; the caller runs it and hands the result to the state.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { mergeRuns, rankCommands, sortById } from "./handoff-commands.ts";
import { mergeErrors, rankErrors, sortErrorsById } from "./handoff-errors.ts";
import { observeEvents } from "./handoff-observe.ts";
import { renderExactHalf } from "./handoff-render.ts";

export interface CommandRecord {
  /** "C1", "C2", ... issued once per session branch and never reused. */
  id: string;
  /** The command text exactly as it ran (whitespace-normalized only for dedupe), or "<redacted>". */
  command: string;
  runs: number;
  /** Exit code of the last run; null when it timed out, was cancelled, or has no result yet. */
  lastExitCode: number | null;
  /** A non-zero exit was later followed by a zero exit of the same command. */
  failedThenSucceeded: boolean;
  /** The compaction pass (1-based, counted on the session branch) that last saw it run. */
  lastSeenPass: number;
  /** When it last ran (ISO), from the transcript; absent on records written before this field. */
  lastRanAt?: string;
  /** A one-line annotation an older compactor's summarizer wrote; carried and rendered, never written here. */
  note?: string;
  /** The text was cut to COMMAND_TEXT_CAP chars to fit the exact-half budget. */
  truncated?: boolean;
}

export interface ErrorRecord {
  /** "E1", "E2", ... issued once per session branch and never reused. */
  id: string;
  /** The first matching line of the tool result plus up to three following lines, byte-exact. */
  signature: string;
  /** The command whose result carried it; undefined for a non-bash tool's error. */
  sourceCommand?: string;
  /** Flipped by a later zero exit of the source command (or, on a record an older compactor wrote, by its note). */
  resolved: boolean;
  lastSeenPass: number;
  /** As on CommandRecord: carried and rendered, never written here. */
  note?: string;
}

/** The repository's state at compaction time (handoff-workspace.ts); captured fresh every pass, never carried. */
export interface WorkspaceSnapshot {
  capturedAt: string;
  cwd: string;
  branch?: string;
  /** `git rev-parse --short HEAD`; absent on an unborn branch. The World's claims bind to it (world.ts). */
  commit?: string;
  /** `git status --short`, at most 40 lines and WORKSPACE_STATUS_CHARS chars, whole lines. */
  statusShort?: string;
  /** The last line of `git diff --stat`. */
  diffStat?: string;
  /** The most recently seen test command in the ledger and its exit code. */
  lastTestCommand?: string;
  lastTestExitCode?: number | null;
}

/** What a compaction entry's `details` holds; pi's own entries carry only the file lists. */
export interface HandoffDetails {
  readFiles: string[];
  modifiedFiles: string[];
  commands: CommandRecord[];
  errors: ErrorRecord[];
  workspace?: WorkspaceSnapshot;
}

export const COMMAND_CAP = 15;
export const ERROR_CAP = 10;
/** Rendered size of the exact half, chars, that a summary never exceeds. */
export const EXACT_HALF_BUDGET = 6000;
/** A command text longer than this is cut, with "...", when the budget needs it. */
export const COMMAND_TEXT_CAP = 300;

/** The exact half between collection and finishing: a plain value, safe to inspect in tests. */
export interface HandoffState {
  pass: number;
  commands: CommandRecord[];
  errors: ErrorRecord[];
  /** Set by the hook once captureWorkspace has answered; undefined when it was skipped. */
  workspace?: WorkspaceSnapshot;
}

export interface CollectHandoffInput {
  /** The session branch as the compaction hook sees it: its compaction entries carry the details. */
  branchEntries: SessionEntry[];
  /** The messages being summarized (pi's messagesToSummarize). */
  messages: AgentMessage[];
  /** The prefix of a split turn (pi's turnPrefixMessages); chronologically after `messages`. */
  turnPrefixMessages?: AgentMessage[];
}

export interface FinishedHandoff {
  /** "" or "\n\n" + the rendered blocks: the size the budget was fitted against. */
  exactHalf: string;
  commands: CommandRecord[];
  errors: ErrorRecord[];
  workspace?: WorkspaceSnapshot;
}

/** The newest compaction entry on the branch, whichever compactor wrote it. */
function latestCompactionEntry(branchEntries: SessionEntry[]): SessionEntry | undefined {
  for (let index = branchEntries.length - 1; index >= 0; index--) {
    if (branchEntries[index].type === "compaction") return branchEntries[index];
  }
  return undefined;
}

function isCommandRecord(value: unknown): value is CommandRecord {
  const record = value as Partial<CommandRecord> | null;
  return typeof record === "object" && record !== null && typeof record.id === "string" && typeof record.command === "string" && typeof record.runs === "number" && typeof record.lastSeenPass === "number";
}

function isErrorRecord(value: unknown): value is ErrorRecord {
  const record = value as Partial<ErrorRecord> | null;
  return typeof record === "object" && record !== null && typeof record.id === "string" && typeof record.signature === "string" && typeof record.lastSeenPass === "number";
}

/**
 * The records the previous compaction entry carried. The state compactor nests them under
 * `details.ledger`; another compactor may put them at the top level (a session relaunched
 * under PI_COMPACTOR=state continues that ledger); a pi entry carries none.
 */
function carriedDetails(branchEntries: SessionEntry[]): { commands: CommandRecord[]; errors: ErrorRecord[] } {
  const previous = latestCompactionEntry(branchEntries);
  if (!previous || previous.type !== "compaction") return { commands: [], errors: [] };
  const details = previous.details as (Partial<HandoffDetails> & { ledger?: Partial<HandoffDetails> }) | undefined;
  const source = details?.ledger ?? details;
  return {
    commands: Array.isArray(source?.commands) ? source.commands.filter(isCommandRecord) : [],
    errors: Array.isArray(source?.errors) ? source.errors.filter(isErrorRecord) : [],
  };
}

/**
 * Rehydrate the carried records and absorb every command that ran and every failure that showed
 * in the messages being compacted.
 */
export function collectHandoff({ branchEntries, messages, turnPrefixMessages = [] }: CollectHandoffInput): HandoffState {
  const pass = branchEntries.filter((entry) => entry.type === "compaction").length + 1;
  const carried = carriedDetails(branchEntries);
  const observed = observeEvents([...messages, ...turnPrefixMessages]);
  const commands = mergeRuns(carried.commands, observed.runs, pass);
  const errors = mergeErrors(carried.errors, observed.errors, observed.runs, pass);
  return { pass, commands, errors };
}

function truncateLongest(records: CommandRecord[]): boolean {
  const candidates = records.filter((record) => !record.truncated && record.command.length > COMMAND_TEXT_CAP);
  if (candidates.length === 0) return false;
  const longest = candidates.reduce((best, record) => (record.command.length > best.command.length ? record : best));
  longest.command = `${longest.command.slice(0, COMMAND_TEXT_CAP - 3)}...`;
  longest.truncated = true;
  return true;
}

/**
 * Cut the ranked lists (best first) down to the budget: first cut the longest command texts to
 * COMMAND_TEXT_CAP, then drop the lowest-ranked commands, then the lowest-ranked errors. Returns
 * the survivors in id order with the rendered half.
 */
function fitExactHalf(rankedCommands: CommandRecord[], rankedErrors: ErrorRecord[], workspace?: WorkspaceSnapshot): Pick<FinishedHandoff, "commands" | "errors" | "exactHalf"> {
  const commands = rankedCommands.map((record) => ({ ...record }));
  const errors = rankedErrors.map((record) => ({ ...record }));
  const render = () => renderExactHalf(sortById(commands), sortErrorsById(errors), workspace);
  let exactHalf = render();
  while (exactHalf.length > EXACT_HALF_BUDGET) {
    if (!truncateLongest(commands) && commands.pop() === undefined && errors.pop() === undefined) break;
    exactHalf = render();
  }
  return { commands: sortById(commands), errors: sortErrorsById(errors), exactHalf };
}

/**
 * Rank, cap and fit the records to the budget, rendering the exact half as the size measure.
 * `commands` and `errors` go into the entry's details; the state is not mutated.
 */
export function finishHandoff(state: HandoffState): FinishedHandoff {
  const fitted = fitExactHalf(rankCommands(state.commands, state.pass).slice(0, COMMAND_CAP), rankErrors(state.errors).slice(0, ERROR_CAP), state.workspace);
  return { ...fitted, workspace: state.workspace };
}
