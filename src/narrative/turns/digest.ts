/**
 * The Digest (CONTEXT.md *Digest*): what code knows about the span, built once and sent whole at the
 * start of the turn conversation -- the state so far, on a switchover the previous summary and the
 * user's earlier rule-shaped messages, the span's user messages verbatim with ordinals (a skill
 * invocation by its name and the user's own words), the ledger's commands and errors with outcomes,
 * the file lists, World, and the condensed transcript. `show(ref)` answers the one read-only tool: a
 * user message, command or error record, or a whole tool output.
 */
import { renderCommandLine, renderErrorLine } from "../../ledger/handoff-render.ts";
import type { CommandRecord, ErrorRecord } from "../../ledger/handoff.ts";
import type { FileLists } from "../../carry.ts";
import { renderFilesSection } from "../../files-render.ts";
import { skillInvocationOf } from "../../intent.ts";
import { skillTag } from "../prepare.ts";
import { stateBlock, type PromptState } from "../prompt.ts";
import type { CondensedTranscript } from "./transcript.ts";

export interface DigestInput {
  /** The span's user messages, whole. */
  userMessages: Array<{ ordinal: string; text: string }>;
  /** Any user message on the branch by ordinal, for show(uN). */
  textOf: (ordinal: string) => string | undefined;
  commands: CommandRecord[];
  errors: ErrorRecord[];
  files: FileLists;
  filesChars: number;
  worldLines: string[];
  promptState: PromptState;
  transcript: CondensedTranscript;
}

export interface Digest {
  text: string;
  show(ref: string): string | undefined;
}

/** A user message over this is a paste: head and tail in the digest, the whole of it behind show(uN). */
export const USER_MESSAGE_CAP = { head: 3000, tail: 1000 };
/** One show() answer, at most. */
export const SHOW_CHARS = 8000;

/** A skill invocation is shown by its name and the user's own words; the skill's text is behind show(uN). */
function userMessageLine(message: { ordinal: string; text: string }): string {
  const skill = skillInvocationOf(message.text);
  const text = skill ? `${skillTag(skill.name)} ${skill.words || "(no words of the user's own)"}` : message.text;
  const pointer = skill ? `\n[the skill's text: show ${message.ordinal}]` : "";
  const { head, tail } = USER_MESSAGE_CAP;
  if (text.length <= head + tail) return `[${message.ordinal}] ${text}${pointer}`;
  return `[${message.ordinal}] ${text.slice(0, head)}\n[… ${text.length - head - tail} chars, show ${message.ordinal} …]\n${text.slice(-tail)}${pointer}`;
}

const block = (tag: string, lines: string[], empty = "(none)") => `<${tag}>\n${lines.length ? lines.join("\n") : empty}\n</${tag}>`;

function seedBlocks(state: PromptState): string[] {
  if (!state.seed) return [];
  const rules = state.seedRules?.length ? [block("earlier-user-messages", state.seedRules.map((rule) => `[${rule.ordinal}] ${rule.text}`))] : [];
  return [`<previous-summary>\n${state.seed}\n</previous-summary>`, ...rules];
}

const capShow = (text: string) => (text.length <= SHOW_CHARS ? text : `${text.slice(0, SHOW_CHARS)}\n[… ${text.length - SHOW_CHARS} more chars not shown]`);

export function buildDigest(input: DigestInput): Digest {
  const parts = [
    stateBlock(input.promptState),
    ...seedBlocks(input.promptState),
    block("user-messages", input.userMessages.map(userMessageLine), "(none in this span)"),
    block("commands", input.commands.map(renderCommandLine)),
    block("errors", input.errors.map((record) => renderErrorLine(record, input.commands))),
    renderFilesSection(input.files, input.filesChars).join("\n"),
    block("world", input.worldLines),
    block("transcript", input.transcript.text ? [input.transcript.text] : [], "(empty)"),
  ];
  const show = (ref: string): string | undefined => {
    if (/^u\d+$/.test(ref)) return mapDefined(input.textOf(ref), capShow);
    if (/^C\d+$/.test(ref)) return mapDefined(input.commands.find((record) => record.id === ref), renderCommandLine);
    if (/^E\d+$/.test(ref)) return mapDefined(input.errors.find((record) => record.id === ref), (record) => renderErrorLine(record, input.commands));
    if (/^T\d+$/.test(ref)) return mapDefined(input.transcript.outputs.get(ref), capShow);
    return undefined;
  };
  return { text: parts.join("\n\n"), show };
}

function mapDefined<T, U>(value: T | undefined, fn: (value: T) => U): U | undefined {
  return value === undefined ? undefined : fn(value);
}
