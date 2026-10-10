/**
 * Learned values (CONTEXT.md *Learned values*; ADR 0005): the fact-shaped values a Span learned from tool output and
 * went on to use, copied by code, verbatim, with where they came from. The summarizer paraphrases identifiers, and
 * the learned-facts probe found the state kept few of them without this section; a value the agent already used once
 * is the cheapest one to lose and the costliest to look up again.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { factMatches, type FactMatch } from "./fact-shapes.ts";
import { CREDENTIAL_NAME, secretStoreOutputs, splitCredentialLines } from "./learned-secrets.ts";
import { oneLine } from "./one-line.ts";
import { normalizeCommand, PRIVATE_KEY, REDACTED_COMMAND, redactCommand } from "./ledger/handoff-commands.ts";
import type { CommandRecord } from "./ledger/handoff.ts";
import { isRec, type Rec, contentText as textOf } from "./message-text.ts";

export interface LearnedValue {
  /** What the value is, for one the summarizer named from a turn (narrative/named-values.ts); absent for one code picked. */
  name?: string;
  value: string;
  /** Where it was first seen: a command id (`C12`), `read <path>`, or the tool's name. */
  source: string;
}

const callsOf = (message: Rec): Rec[] => (Array.isArray(message.content) ? message.content.filter((block): block is Rec => isRec(block) && block.type === "toolCall") : []);

/** The ledger's command ids by normalized command text, the first record winning, as the ledger merges runs. */
type CommandIds = ReadonlyMap<string, string>;

function commandIdsOf(commands: Array<Pick<CommandRecord, "id" | "command">>): CommandIds {
  const ids = new Map<string, string>();
  for (const record of commands) {
    const key = normalizeCommand(record.command);
    if (!ids.has(key)) ids.set(key, record.id);
  }
  return ids;
}

/** The command id the ledger gave `command`; none for a redacted one. */
function commandIdOf(command: string, ids: CommandIds): string | undefined {
  const key = normalizeCommand(redactCommand(command));
  return key === REDACTED_COMMAND ? undefined : ids.get(key);
}


/** The tools whose output can teach: local, and run by the session itself. A web page or another agent is not a source. */
export const TRUSTED_TOOLS: ReadonlySet<string> = new Set(["bash", "read", "grep", "find", "ls"]);
/** A hex value longer than a short commit hash is as likely a token as a hash: learned only from git. */
const SHORT_HASH_CHARS = 12;
/** A mixed-case, digit-bearing identifier this long is a random token far more often than a name. */
const RANDOM_LOOKING_CHARS = 16;

/** Whether a value could be a credential whatever line it stood on (security.md T3). */
function looksRandom({ raw, kind }: FactMatch, fromGit: boolean): boolean {
  if (kind === "hash" && raw.length > SHORT_HASH_CHARS) return !fromGit;
  return raw.length >= RANDOM_LOOKING_CHARS && /[a-z]/.test(raw) && /[A-Z]/.test(raw) && /\d/.test(raw);
}

/**
 * Code names are not values: an identifier (`assertEqual`) or a dotted name with no directory (`lines.append`,
 * `unittest.main`) is in the source for the agent to read again, and they crowded out the values that are not.
 */
/** A name with no directory reads as code (process.exit), unless a <placeholder> makes it a name format. */
const isCodeName = ({ raw, kind }: FactMatch): boolean => kind === "identifier" || (kind === "path" && !raw.includes("/") && !/<[\w-]{1,30}>/.test(raw));

/** At most this many `<placeholders>` in a name format code picks from output. */
const PLACEHOLDERS_OFFERED = 2;

/**
 * A `<placeholder>` makes a file name format (`<base>-YYYYMMDD.tar.gz`), one name, never a path: tool output can be a
 * fetched page, and a path of tag-like words (`<system-reminder>/<obey-this>/x.md`) would be shown on every request.
 */
const isPlantedPlaceholders = ({ raw }: FactMatch): boolean => raw.includes("<") && (raw.includes("/") || (raw.match(/</g) ?? []).length > PLACEHOLDERS_OFFERED);

/**
 * The values an output offers: none from a credential line (learned-secrets.ts), nothing at all from an output
 * holding a private key (a key body's lines match no line pattern), none that look random, none too long to show,
 * no code names, and placeholders only in one file name format.
 */
function offeredBy(output: string, fromGit: boolean): string[] {
  if (PRIVATE_KEY.test(output)) return [];
  return factMatches(splitCredentialLines(output).clean.join("\n"))
    .filter((match) => match.raw.length <= VALUE_CHARS && !looksRandom(match, fromGit) && !isCodeName(match) && !isPlantedPlaceholders(match))
    .map((match) => match.raw);
}

/** Where a tool result came from; undefined when its output must not be learned from. */
function sourceOf(tool: string, args: Rec, commands: CommandIds): string | undefined {
  if (!TRUSTED_TOOLS.has(tool)) return undefined;
  if (tool === "bash") return typeof args.command === "string" ? commandIdOf(args.command, commands) : undefined;
  if (tool === "read") return typeof args.path === "string" ? cut(`read ${args.path}`, SOURCE_CHARS) : undefined;
  return tool;
}

/** One plain git command: a chain, pipe, substitution or redirect could print anything (security.md T3). */
const isGit = (command: unknown) => typeof command === "string" && /^\s*git\s[^;&|`$()<>\n]*$/.test(command);

interface Seen {
  source: string;
  /** Position of the latest assistant message that used it; -1 until one does. */
  usedAt: number;
}

/** What the assistant said in `message`, its text and its call arguments, as one string. */
const saidBy = (message: Rec): string => [textOf(message.content), ...callsOf(message).map((block) => JSON.stringify(block.arguments ?? {}))].join("\n");

/** A tool output in `message` with its source, or undefined when the message is not one, or teaches nothing. */
function outputOf(message: Rec, calls: Map<string, Rec>, commands: CommandIds): { source: string; text: string; fromGit: boolean } | undefined {
  if (message.role === "bashExecution") {
    if (message.excludeFromContext === true || typeof message.command !== "string") return undefined;
    const source = commandIdOf(message.command, commands);
    return source ? { source, text: String(message.output ?? ""), fromGit: isGit(message.command) } : undefined;
  }
  if (message.role !== "toolResult") return undefined;
  const call = calls.get(String(message.toolCallId));
  const args = isRec(call?.arguments) ? call.arguments : {};
  const source = sourceOf(String(message.toolName ?? call?.name ?? ""), args, commands);
  return source ? { source, text: textOf(message.content), fromGit: isGit(args.command) } : undefined;
}

/** Every string in a call's arguments, so a value inside a multi-line argument is read line by line. */
export const stringsIn = (value: unknown, depth = 0): string[] =>
  typeof value === "string" ? [value] : depth < 8 && isRec(value) ? Object.values(value).flatMap((inner) => stringsIn(inner, depth + 1)) : [];

/** Everything `message` carries as text, whoever wrote it: tool output, prose, every call argument, a `!` command and its output. */
function allTextOf(message: Rec): string[] {
  const own = [textOf(message.content), ...callsOf(message).flatMap((block) => stringsIn(block.arguments))];
  if (message.role === "bashExecution") own.push(String(message.command ?? ""), String(message.output ?? ""));
  return own;
}

/**
 * The values that stood on a credential line anywhere in the Span, or that a secret store printed. Never learned: a
 * value used in a secret-bearing command (`CLUSTER_TOKEN=<uuid> cluster ...`) is a credential, however clean the
 * output that first showed it, and so is one `pass show` printed, however it is used later.
 */
function taintedValues(messages: Rec[]): Set<string> {
  const tainted = new Set<string>();
  for (const text of messages.flatMap(allTextOf)) {
    for (const line of splitCredentialLines(text).credential) for (const match of factMatches(line)) tainted.add(match.raw);
  }
  for (const output of secretStoreOutputs(messages)) for (const match of factMatches(output)) tainted.add(match.raw);
  return tainted;
}

/** What `message` says in the session's own words: user text, assistant text and call arguments, a `!` command. */
function wordsOf(message: Rec): string {
  if (message.role === "assistant") return saidBy(message);
  if (message.role === "bashExecution") return typeof message.command === "string" ? message.command : "";
  return message.role === "toolResult" ? "" : textOf(message.content);
}

/**
 * The Learned values of one Span, newest use first: values first seen in a tool output (and in nothing the session
 * said before it) that a later assistant message of the same Span used.
 */
export function learnedValues(messages: AgentMessage[], commands: Array<Pick<CommandRecord, "id" | "command">>): LearnedValue[] {
  const records = messages as unknown as Rec[];
  const tainted = taintedValues(records);
  const said = new Set<string>();
  const seen = new Map<string, Seen>();
  const calls = new Map<string, Rec>();
  const commandIds = commandIdsOf(commands);
  records.forEach((message, position) => {
    for (const raw of factMatches(wordsOf(message)).map((match) => match.raw)) {
      said.add(raw);
      const value = seen.get(raw);
      if (value && message.role === "assistant") value.usedAt = position;
    }
    for (const block of callsOf(message)) calls.set(String(block.id), block);
    const output = outputOf(message, calls, commandIds);
    for (const raw of output ? offeredBy(output.text, output.fromGit) : []) if (!said.has(raw) && !seen.has(raw)) seen.set(raw, { source: output!.source, usedAt: -1 });
  });
  return [...seen.entries()]
    .filter(([value, { usedAt }]) => usedAt >= 0 && !tainted.has(value))
    .sort((a, b) => b[1].usedAt - a[1].usedAt)
    .map(([value, { source }]) => ({ value, source }));
}

/** How many Learned values a state entry carries forward; the render budget decides how many are shown. */
export const LEARNED_CARRY_CAP = 100;
/** A source is a command id or a read path; a longer one is cut, so one forged argument cannot fill the budget. */
const SOURCE_CHARS = 80;
/** A named value's name is at most this long: a label, not a sentence. */
export const NAME_CHARS = 40;
/**
 * A name the summarizer gave a value: a short printable label, never `key: value`, never a rule or a credential's
 * name. It is shown as the summarizer's label, but a rule-shaped one would still read as an instruction (security.md T2).
 */
export function isValueName(name: string): boolean {
  return name.length > 0 && name.length <= NAME_CHARS && /^[\x20-\x7e]+$/.test(name) && !/[:=]/.test(name)
    && !/\b(?:never|always|must|should|shall|don'?t|do not|rule|rules|user|instruction|ignore)\b/i.test(name)
    && !CREDENTIAL_NAME.test(name);
}
/** A named value may hold one space, between a number and its unit ("166 ms", "13,157 req/s"); nothing else with a space is a value. */
const UNIT = "(?:ns|us|\u00b5s|ms|s|secs?|min|m|h|hrs?|d|b|kb|mb|gb|tb|kib|mib|gib|k|x|%|rows|lines|files|tests|bytes|tokens|requests|req/s|ops/s|rps|qps|fps)";
export const NUMBER_WITH_UNIT = new RegExp(`^[-+]?\\d[\\d.,]*\\s${UNIT}$`, "i");

/**
 * The shapes a named value may take: what the section is for (ADR 0006), a measurement, a total, a count, a port, a
 * version, a short hash, a path or file name, a host and port, a date. Nothing word-like, so a password is not a value
 * however the session described it (security.md T3).
 */
const NAMED_VALUE_SHAPES = [
  new RegExp(`^[-+]?\\d[\\d,]*(?:\\.\\d+)?${UNIT}?$`, "i"), // 2768.48, 13,157, 8090, 16ms, 99%
  NUMBER_WITH_UNIT, // 166 ms, 13,157 req/s
  /^v?\d+(?:\.\d+){1,3}(?:-[0-9A-Za-z.]{1,20})?$/, // v1.4.2, 5.9.3, 3.12.0-rc1
  /^[0-9a-f]{7,12}$/, // 2eab582
  /^(?:<[\w-]{1,30}>|[\w.~-])*\/(?:<[\w-]{1,30}>|[\w./~-])*$/, // src/parse.ts, logs/<host>.log
  /^(?:<[\w-]{1,30}>|[\w-])+(?:\.[a-z0-9]{1,6}){1,3}$/, // <source-basename>-YYYYMMDD-HHMMSS.tar.gz (a lowercase extension)
  /^(?:localhost|[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+):\d{2,5}$/, // localhost:8090, example.com:8090
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?Z?)?$/, // 2026-10-07
];
export const isNamedValueShape = (value: string) => NAMED_VALUE_SHAPES.some((shape) => shape.test(value));
/** A value longer than this is not a value a resumed model will retype: it is not shown. */
export const VALUE_CHARS = 160;

const cut = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

/** A stored value: printable ASCII with no spaces, as every fact shape is; anything else was forged. */
const STORED_VALUE = /^[\x21-\x7e]+$/;
const STORED_SOURCE = /^[\x20-\x7e]+$/;

/**
 * Learned values read back from a transcript (security.md T1): at most LEARNED_CARRY_CAP, each a well-formed value no
 * longer than VALUE_CHARS with a printable source cut to SOURCE_CHARS. A forged entry cannot grow what every later
 * compaction entry re-persists.
 */
export function sanitizeLearnedValues(values: unknown[]): LearnedValue[] {
  return values.slice(0, LEARNED_CARRY_CAP).flatMap((item) => {
    if (!isRec(item) || typeof item.value !== "string" || typeof item.source !== "string") return [];
    // A name is re-checked on read-back: a forged one is dropped, the value kept only if it stands on its own.
    const named = typeof item.name === "string" && isValueName(item.name.trim());
    // A named value has a named value's shape; one that lost its name stands only as a code-picked value would.
    if (item.value.length > VALUE_CHARS || !(named ? isNamedValueShape(item.value) : STORED_VALUE.test(item.value)) || !STORED_SOURCE.test(item.source)) return [];
    return [{ ...(named ? { name: (item.name as string).trim() } : {}), value: item.value, source: cut(item.source, SOURCE_CHARS) }];
  });
}

/** This Span's values first (each once: the first copy, a named one when the pass puts those first), then the carried ones it did not repeat, up to LEARNED_CARRY_CAP. */
export function carryLearnedValues(previous: LearnedValue[], current: LearnedValue[]): LearnedValue[] {
  const once = current.filter((learned, index) => current.findIndex((other) => other.value === learned.value) === index);
  const fresh = new Set(once.map((learned) => learned.value));
  return [...once, ...previous.filter((learned) => !fresh.has(learned.value))].slice(0, LEARNED_CARRY_CAP);
}

/**
 * The `## Learned values` section: one value per line with its source, newest use first, cut as a newest-first
 * prefix under `budgetChars` (every line costs its length plus a newline). A zero budget turns the section off.
 */
export function renderLearnedSection(values: LearnedValue[], budgetChars: number): string[] {
  if (budgetChars <= 0) return [];
  const lines = values
    .map((learned) => ({ name: learned.name ? cut(oneLine(learned.name), NAME_CHARS) : "", value: oneLine(learned.value), source: cut(oneLine(learned.source), SOURCE_CHARS) }))
    .filter((learned) => learned.value && learned.value.length <= VALUE_CHARS)
    .map((learned) => `- ${learned.value} (${learned.source}${learned.name ? `; ${learned.name}` : ""})`);
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > budgetChars) break;
    kept.push(line);
    used += line.length + 1;
  }
  const omitted = lines.length - kept.length;
  const heading = `## Learned values (verbatim; where each came from, then any label the summarizer gave it; newest first${omitted ? `; ${omitted} more not shown` : ""})`;
  return [heading, ...(kept.length ? kept : lines.length ? [] : ["(none recorded)"])];
}
