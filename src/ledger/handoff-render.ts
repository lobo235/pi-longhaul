/**
 * Rendering of the exact half: the `<commands>`, `<errors>` and `<workspace>` blocks, whose length
 * is the size handoff.ts fits to its budget. The renderer is the only place the line format is
 * known.
 */
import type { CommandRecord, ErrorRecord, WorkspaceSnapshot } from "./handoff.ts";
import { normalizeCommand } from "./handoff-commands.ts";

/**
 * A line that is nothing but a block or prompt-wrapper tag. Tool output is rendered into the
 * blocks byte-exact, so such a line inside it would read as the end of the block or as a prompt
 * wrapper. Only continuation lines can start a line: every record's first line is prefixed.
 */
const TAG_LINE_RE = /^([ \t]*)<(?=\/?(?:commands|errors|workspace|handoff-index|conversation|previous-summary|turn-context)\b[^>\n]*>[ \t]*$)/gm;

/** Tool output as rendered: byte-exact, except that a line which is only a tag gets its `<` written as `&lt;`. */
function neutralizeTagLines(text: string): string {
  return text.replace(TAG_LINE_RE, "$1&lt;");
}

function exitLabel(exitCode: number | null): string {
  return exitCode === null ? "?" : String(exitCode);
}

function withNote(line: string, note: string | undefined): string {
  return note ? `${line}\n    note: ${note}` : line;
}

/**
 * `C1 [runs:3 exit:0 failed-then-ok] make check` plus an indented `note:` line when the record
 * has one. The command text is rendered byte-exact, including any newlines it contains, except
 * for a tag-only continuation line (neutralizeTagLines).
 */
export function renderCommandLine(record: CommandRecord): string {
  const flags = record.failedThenSucceeded ? " failed-then-ok" : "";
  return withNote(`${record.id} [runs:${record.runs} exit:${exitLabel(record.lastExitCode)}${flags}] ${neutralizeTagLines(record.command)}`, record.note);
}

export function renderCommandsBlock(records: CommandRecord[]): string {
  return `<commands>\n${records.map(renderCommandLine).join("\n")}\n</commands>`;
}

/**
 * `E1 [resolved C3] <signature>` — the state, the id of the command record that produced it when
 * one is in the ledger, the signature byte-exact, then the note line when there is one.
 */
export function renderErrorLine(record: ErrorRecord, commands: CommandRecord[]): string {
  const source = record.sourceCommand === undefined ? undefined : normalizeCommand(record.sourceCommand);
  const from = source === undefined ? undefined : commands.find((command) => normalizeCommand(command.command) === source);
  const state = `${record.resolved ? "resolved" : "unresolved"}${from ? ` ${from.id}` : ""}`;
  return withNote(`${record.id} [${state}] ${neutralizeTagLines(record.signature)}`, record.note);
}

export function renderErrorsBlock(records: ErrorRecord[], commands: CommandRecord[]): string {
  return `<errors>\n${records.map((record) => renderErrorLine(record, commands)).join("\n")}\n</errors>`;
}

/**
 * An attribute value that cannot end the tag early: `>`, `<`, `"` and whitespace are replaced (git
 * accepts `>`, `<` and `"` in a ref name).
 */
function attributeValue(value: string): string {
  return value.replace(/["<>\s]/g, "_");
}

/**
 * `<workspace branch="main" captured="...">` holding the short status, the diff stat line and the
 * last test command with its exit code; undefined when the snapshot has nothing to show.
 */
export function renderWorkspaceBlock(snapshot: WorkspaceSnapshot): string | undefined {
  const lines: string[] = [];
  if (snapshot.statusShort) lines.push(snapshot.statusShort);
  if (snapshot.diffStat) lines.push(snapshot.diffStat);
  if (snapshot.lastTestCommand) lines.push(`last test: ${snapshot.lastTestCommand} (exit ${exitLabel(snapshot.lastTestExitCode ?? null)})`);
  if (lines.length === 0) return undefined;
  const attributes = [snapshot.branch ? `branch="${attributeValue(snapshot.branch)}"` : "", `captured="${attributeValue(snapshot.capturedAt)}"`].filter(Boolean);
  return `<workspace ${attributes.join(" ")}>\n${neutralizeTagLines(lines.join("\n"))}\n</workspace>`;
}

/**
 * The exact half as appended to a summary: "" when there is nothing to show, otherwise "\n\n"
 * followed by the blocks in order (commands, errors, workspace), "\n\n" between them.
 */
export function renderExactHalf(commands: CommandRecord[], errors: ErrorRecord[], workspace?: WorkspaceSnapshot): string {
  const blocks: string[] = [];
  if (commands.length > 0) blocks.push(renderCommandsBlock(commands));
  if (errors.length > 0) blocks.push(renderErrorsBlock(errors, commands));
  const workspaceBlock = workspace && renderWorkspaceBlock(workspace);
  if (workspaceBlock) blocks.push(workspaceBlock);
  return blocks.length > 0 ? `\n\n${blocks.join("\n\n")}` : "";
}
