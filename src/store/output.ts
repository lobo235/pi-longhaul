/**
 * Exact recall: the raw tool result behind a ledger id, `recall what=output query=C12|E3`. Answered from the current
 * branch (every entry, compacted or not), byte-exact and paged, so a compacted output can be read again instead of
 * re-running the command to see it. A command id gives its latest run; an error id gives the newest run of its source
 * command (or, for a non-bash tool's error, the newest tool result) whose output carries the error. Not file contents
 * (re-read the file) and not assistant text. A command the ledger redacted is refused: the ledger never carried its
 * text, so recall does not either; a credential line in an output (the Learned values filter) is replaced on the page. Offsets count the
 * transcript's own characters.
 */
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import { containsSecret, normalizeCommand, REDACTED_COMMAND, redactCommand } from "../ledger/handoff-commands.ts";
import type { CommandRecord, ErrorRecord } from "../ledger/handoff.ts";
import { splitCredentialLines } from "../learned-secrets.ts";
import { isRec, type Rec, contentText as textOf } from "../message-text.ts";

export const OUTPUT_PAGE_CHARS = 8000;

export type OutputRecall =
  | { kind: "output"; ref: string; command?: string; text: string; offset: number; total: number; remaining: number; nextOffset?: number }
  | { kind: "refused"; reason: string };


interface Run {
  command?: string;
  output: string;
}


/**
 * Every tool output on the branch, oldest first: bash calls with their command, `!` executions, other tools without
 * one. A result resolves against the latest call with its id seen BEFORE it, so a provider that reuses tool-call ids
 * cannot pin a result to a later command (security.md T1).
 */
function runsOf(branch: SessionEntry[]): Run[] {
  const messages = branch.flatMap((entry) => (entry.type === "message" && isRec((entry as { message?: unknown }).message) ? [(entry as { message: Rec }).message] : []));
  const commands = new Map<string, string | undefined>();
  const runs: Run[] = [];
  for (const message of messages) {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (!isRec(block) || block.type !== "toolCall") continue;
        const command = block.name === "bash" && isRec(block.arguments) && typeof block.arguments.command === "string" ? block.arguments.command : undefined;
        commands.set(String(block.id), command);
      }
    } else if (message.role === "toolResult" && typeof message.toolCallId === "string") {
      const command = commands.get(message.toolCallId);
      // A bash result whose command cannot be resolved is no answer at all, never a "non-bash" one (security.md T3).
      if (message.toolName === "bash" && command === undefined) continue;
      runs.push({ command, output: textOf(message.content) });
    } else if (message.role === "bashExecution" && typeof message.command === "string" && !message.excludeFromContext) {
      runs.push({ command: message.command, output: typeof message.output === "string" ? message.output : "" });
    }
  }
  return runs;
}

const sameCommand = (run: Run, command: string) => run.command !== undefined && normalizeCommand(redactCommand(run.command)) === normalizeCommand(command);
/** A run whose command carried a secret is never an answer, whichever id led to it (security.md T3). */
const recallable = (run: Run) => run.command === undefined || !containsSecret(run.command);

export const REDACTED_LINE = "<line redacted: it carried a credential>";

/** Each private-key block in the whole output, BEGIN line to END line (or to the end): its body matches no line pattern. */
function keySpans(output: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (let at = output.indexOf("-----BEGIN "); at >= 0; at = output.indexOf("-----BEGIN ", at + 1)) {
    const headerEnd = output.indexOf("\n", at);
    if (!/PRIVATE KEY(?: BLOCK)?-----/.test(output.slice(at, headerEnd < 0 ? output.length : headerEnd))) continue;
    const footer = output.indexOf("-----END ", at);
    const footerEnd = footer < 0 ? -1 : output.indexOf("\n", footer);
    const stop = footer < 0 || footerEnd < 0 ? output.length : footerEnd;
    spans.push([at, stop]);
    at = stop;
  }
  return spans;
}

/**
 * The page `[start, end)` of `output` with every credential line replaced, by the filter Learned values use
 * (learned-secrets.ts): command-style secrets, credential-named keys in aligned tables, the lines under a YAML or
 * JSON credential key, bare JWTs and Vault tokens. Each line is judged WHOLE, on the full output, so neither a page
 * boundary nor a chosen offset can cut a credential line into harmless pieces; a private key's body goes with its
 * header. A line equal to a credential line anywhere in the output is masked too (security.md T3).
 */
function redactedPage(output: string, start: number, end: number): string {
  const keys = keySpans(output);
  const credentialLines = new Set(splitCredentialLines(output).credential);
  const pieces: string[] = [];
  for (let at = start; at < end; ) {
    const lineStart = output.lastIndexOf("\n", at - 1) + 1;
    const newline = output.indexOf("\n", at);
    const lineEnd = newline < 0 ? output.length : newline;
    const sliceEnd = Math.min(lineEnd, end);
    const flagged = keys.some(([from, to]) => from <= lineEnd && to >= lineStart) || credentialLines.has(output.slice(lineStart, lineEnd));
    // A run of redacted lines is one marker: one-character lines in a key body must not grow the page (security.md T4).
    const continuesRun = flagged && pieces.at(-1) === "\n" && pieces.at(-2) === REDACTED_LINE;
    if (continuesRun) pieces.pop(); // this line joins the marker before it
    else pieces.push(flagged ? REDACTED_LINE : output.slice(at, sliceEnd));
    if (sliceEnd < end) pieces.push("\n");
    at = sliceEnd + 1;
  }
  return pieces.join("");
}

function page(ref: string, command: string | undefined, output: string, offset: number): OutputRecall {
  const start = Math.min(Math.max(0, Math.trunc(offset)), output.length);
  const end = Math.min(output.length, start + OUTPUT_PAGE_CHARS);
  const text = redactedPage(output, start, end);
  return { kind: "output", ref, ...(command ? { command } : {}), text, offset: start, total: output.length, remaining: output.length - end, ...(end < output.length ? { nextOffset: end } : {}) };
}

function commandOutput(runs: Run[], record: CommandRecord, offset: number): OutputRecall {
  if (record.command === REDACTED_COMMAND) return { kind: "refused", reason: `${record.id}'s command carried a secret, so the ledger keeps neither its text nor its output.` };
  const run = [...runs].reverse().find((candidate) => recallable(candidate) && sameCommand(candidate, record.command));
  return run ? page(record.id, record.command, run.output, offset) : { kind: "refused", reason: `${record.id} has no output on this branch (it ran on another branch, or its result was never recorded).` };
}

function errorOutput(runs: Run[], record: ErrorRecord, offset: number): OutputRecall {
  if (record.sourceCommand === REDACTED_COMMAND) return { kind: "refused", reason: `${record.id} came from a command that carried a secret; its output is not recalled.` };
  // The signature is the matched lines byte-exact (ErrorRecord), so the run that produced it contains it whole.
  // An error with no source command came from a non-bash tool, so only a non-bash run can be its source (security.md T3).
  const source = record.sourceCommand;
  const fromSource = (run: Run) => (source === undefined ? run.command === undefined : sameCommand(run, source));
  const run = [...runs].reverse().find((candidate) => recallable(candidate) && fromSource(candidate) && candidate.output.includes(record.signature));
  // The header names the ledger's own (already redacted) text, never the raw transcript command.
  return run ? page(record.id, source, run.output, offset) : { kind: "refused", reason: `${record.id}'s output is not on this branch.` };
}

/** The output behind `ref` (C<n> or E<n>), one page from `offset`; refused with a reason when it cannot be given exactly. */
export function recallOutput(branch: SessionEntry[], ledger: { commands: CommandRecord[]; errors: ErrorRecord[] }, query: { ref: string; offset?: number }): OutputRecall {
  const ref = query.ref.trim().toUpperCase();
  if (!/^[CE]\d{1,6}$/.test(ref)) return { kind: "refused", reason: "output takes a command or error id (C12, E3). For a file's contents, read the file again." };
  const offset = query.offset ?? 0;
  if (ref.startsWith("C")) {
    const record = ledger.commands.find((candidate) => candidate.id === ref);
    return record ? commandOutput(runsOf(branch), record, offset) : { kind: "refused", reason: `There is no command ${ref} in this session's ledger.` };
  }
  const record = ledger.errors.find((candidate) => candidate.id === ref);
  return record ? errorOutput(runsOf(branch), record, offset) : { kind: "refused", reason: `There is no error ${ref} in this session's ledger.` };
}
