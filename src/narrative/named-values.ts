/**
 * Named values: values the summarizer names from the span (CONTEXT.md *Learned values*), a measurement, a total, a
 * port a turn reported, with the turn they came from. Code keeps one only when it stands verbatim in that turn's own
 * text (the user's message, the replies, the call arguments, a `!` command and the local tools' output up to the next
 * user message), so a name can be wrong but a value cannot be invented. Only the shapes the section is for (a number,
 * a version, a short hash, a path, a host and port, a date: learned.ts isNamedValueShape), so nothing word-like;
 * never anything that stood on a credential line anywhere in the span, however it is wrapped or whichever turn is
 * cited; nothing random-looking; and the name only a short label (learned.ts isValueName). A Learned value is printed into
 * every later request (security.md T3).
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { secretStoreOutputs, splitCredentialLines } from "../learned-secrets.ts";
import { isNamedValueShape, isValueName, stringsIn, TRUSTED_TOOLS, VALUE_CHARS, type LearnedValue } from "../learned.ts";
import type { FieldError } from "./validate.ts";
import { isRec, type Rec } from "../message-text.ts";

export interface NamedValueAnswer { name: string; value: string; ref: string }

/** At most this many named values per span; the schema bounds the answer the same way. */
export const NAMED_VALUES_PER_SPAN = 12;
/** A credential token is split out of its line on these, and a value on the same, so wrapping it in words does not hide it. */
const TOKEN_SPLIT = /[\s=:"'`,;{}[\]()<>]+/;
const TOKEN_CHARS = 4;
/**
 * A credential named in prose ("the sudo password is ...") or as a key part (`ADMIN_PIN`, `cvv2`): the words after it
 * on its line are as tainted as a key's value. Letters end the name, `_` and digits do not.
 */
const PROSE_CREDENTIAL = /(?<![A-Za-z])(?:passw(?:or)?d|pwd?|passphrase|passcode|secret|api[_ -]?key|credentials?|pin|otp|2fa|cvv|login|card(?: number)?|(?:2fa|otp|auth|verification|security|access|one-time) code|pass(?=\s+(?:is|was)\b))(?![A-Za-z])/gi;
const PROSE_REACH = 40;
const USER_AT = /(?<![\w.~/:-])([\w.~-]+[/:][^\s@/:]{1,64})@/g;
/** A hex run longer than a short commit hash, a long mixed-case run with digits, or a bare run of 13+ digits (a card number) is as likely a secret as a value. */
const RANDOM_LOOKING = [/^\d{13,}$/, /(?<![0-9a-f])(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{13,}(?![0-9a-f])/i, /(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{16,}/];

const flat = (text: string) => text.replace(/\s+/g, " ").trim();

/** The roles a value may come from; a custom message (another extension, a relayed agent) is not a source. */
const SOURCE_ROLES = new Set(["user", "assistant", "bashExecution", "toolResult"]);

function textsIn(message: Rec): string[] {
  if (!SOURCE_ROLES.has(String(message.role))) return [];
  // As for the values code picks: a web page or another agent is not a source (security.md T3).
  if (message.role === "toolResult" && !TRUSTED_TOOLS.has(String(message.toolName ?? ""))) return [];
  return everyTextIn(message);
}

/** Everything a message carries as text, call arguments string by string (so a written file is read line by line). */
function everyTextIn(message: Rec): string[] {
  const out: string[] = [];
  if (typeof message.content === "string") out.push(message.content);
  if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (!isRec(block)) continue;
      if (block.type === "text" && typeof block.text === "string") out.push(block.text);
      if (block.type === "toolCall") out.push(...stringsIn(block.arguments));
    }
  }
  if (message.role === "bashExecution") out.push(String(message.command ?? ""), String(message.output ?? ""));
  return out;
}

const tokensOf = (text: string) => text.split(TOKEN_SPLIT).filter((token) => token.length >= TOKEN_CHARS);
/** After a credential word, three characters with a digit are a secret too: a CVV, a short PIN. */
const proseTokensOf = (text: string) => text.split(TOKEN_SPLIT).filter((token) => token.length >= TOKEN_CHARS || (token.length === 3 && /\d/.test(token)));

/** Every token on a credential line of `text`, and the words that follow a credential named in prose. */
function credentialTokensOf(text: string): string[] {
  const out = splitCredentialLines(text).credential.flatMap(tokensOf);
  // A user and password before an @ (scott/tiger@orcl, app:pw@host) is a login, however the line reads.
  for (const match of text.matchAll(USER_AT)) out.push(match[1]);
  for (const line of text.split("\n")) {
    for (const match of line.matchAll(PROSE_CREDENTIAL)) out.push(...proseTokensOf(line.slice(match.index + match[0].length, match.index + match[0].length + PROSE_REACH)));
  }
  return out;
}

/**
 * Whether `value` holds a tainted token or sits inside one. Both ways, because a password is glued to whatever stands
 * next to it: `Summer2024x.` holds it, `-pSummer2024x` and `app:Summer2024x@db/app` hold the value. That over-refuses
 * (a port on a connection string's line), which is the safe direction.
 */
const isTainted = (value: string, tainted: ReadonlySet<string>) => [...tainted].some((token) => value.includes(token) || (value.length >= TOKEN_CHARS && token.includes(value)));

/** What a value is checked against: each turn's text, and every token that stood on a credential line anywhere in the span. */
export interface SpanTexts {
  turnTextOf: (ordinal: string) => string | undefined;
  tainted: ReadonlySet<string>;
  /** On a switchover, the newest earlier turn whose text shows `value` (withEarlierTurns): a wrong pointer to a real value. */
  holderOf?: (value: string) => string | undefined;
}

/**
 * Each turn's text, by the ordinal tag prepare.ts puts on its user message (thinking was stripped before), and the
 * span's credential tokens. Those are taken from every message, sources or not: a password a web page showed is no
 * more a value than one the user typed.
 */
export function spanTextsOf(messages: AgentMessage[]): SpanTexts {
  return turnTextsOf((messages as unknown as Rec[]).map((message) => {
    const tag = message.role === "user" ? /^\[(u\d+)\] /.exec(textsIn(message)[0] ?? "")?.[1] : undefined;
    return { message: message as unknown as AgentMessage, ...(tag ? { ordinal: tag } : {}) };
  }));
}

/** Each turn's text and the credential tokens of `messages`, where a user message that opens a turn carries its ordinal. */
export function turnTextsOf(messages: ReadonlyArray<{ ordinal?: string; message: AgentMessage }>): SpanTexts {
  const turns = new Map<string, string[]>();
  const tainted = new Set<string>();
  let current: string[] | undefined;
  for (const { ordinal, message } of messages as unknown as ReadonlyArray<{ ordinal?: string; message: Rec }>) {
    for (const text of everyTextIn(message)) for (const token of credentialTokensOf(text)) tainted.add(token);
    if (ordinal) turns.set(ordinal, (current = []));
    current?.push(...textsIn(message));
  }
  for (const output of secretStoreOutputs(messages.map((entry) => entry.message) as unknown as Rec[])) for (const token of tokensOf(output)) tainted.add(token);
  const joined = new Map([...turns].map(([ordinal, texts]) => [ordinal, texts.join("\n")]));
  const newestFirst = [...joined].reverse();
  const holderOf = (value: string) => newestFirst.find(([, text]) => flat(splitCredentialLines(text).clean.join("\n")).includes(flat(value)))?.[0];
  return { turnTextOf: (ordinal) => joined.get(ordinal), tainted, holderOf };
}

/**
 * The span's turns, then on a switchover the turns before it (pass.ts earlierTurnsOf): the previous summary came from
 * another compactor, so the values it records were never carried as Learned values. The summary only points at one;
 * a value is kept only where an earlier turn shows it verbatim, and every credential token of either taints both.
 */
export function withEarlierTurns(span: SpanTexts, earlier: SpanTexts | undefined): SpanTexts {
  if (!earlier) return span;
  return { turnTextOf: (ordinal) => span.turnTextOf(ordinal) ?? earlier.turnTextOf(ordinal), tainted: new Set([...span.tainted, ...earlier.tainted]), ...(earlier.holderOf ? { holderOf: earlier.holderOf } : {}) };
}

type Verdict = { ok: true; value: LearnedValue } | { ok: false; error: Omit<FieldError, "path"> };

const rejected = (ref: string, reason: "credential" | "random" | "shape" | "name"): Verdict => ({ ok: false, error: { rejection: { code: "value-rejected", ref, reason }, fixable: false } });

function checkOne(answer: NamedValueAnswer, span: SpanTexts): Verdict {
  const verdict = checkAt(answer, span);
  if (verdict.ok || !span.holderOf || (verdict.error.rejection.code !== "value-not-in-turn" && verdict.error.rejection.code !== "unknown-ref")) return verdict;
  // A wrong pointer to an earlier turn's real words is still that turn's value, checked there in full.
  const holder = span.holderOf(answer.value.trim());
  return holder && holder !== answer.ref ? checkAt({ ...answer, ref: holder }, span) : verdict;
}

function checkAt(answer: NamedValueAnswer, span: SpanTexts): Verdict {
  const value = answer.value.trim();
  const name = flat(answer.name);
  if (!value || value.length > VALUE_CHARS || !isNamedValueShape(value)) return rejected(answer.ref, "shape");
  if (!isValueName(name)) return rejected(answer.ref, "name");
  if (RANDOM_LOOKING.some((shape) => shape.test(value))) return rejected(answer.ref, "random");
  const text = span.turnTextOf(answer.ref);
  // A turn outside the span: an earlier span's values are carried already, and the kept window is still in view.
  if (text === undefined) return { ok: false, error: { rejection: { code: "unknown-ref", ref: answer.ref, known: [] }, fixable: false } };
  const lines = splitCredentialLines(text);
  const onCredentialLine = lines.credential.some((line) => flat(line).includes(flat(value)));
  if (onCredentialLine || isTainted(value, span.tainted) || splitCredentialLines(`${name}: ${value}`).credential.length) return rejected(answer.ref, "credential");
  if (!flat(lines.clean.join("\n")).includes(flat(value))) return { ok: false, error: { rejection: { code: "value-not-in-turn", ref: answer.ref, value: value.slice(0, 40) }, fixable: true } };
  return { ok: true, value: { name, value, source: answer.ref } };
}

/** The named values that stand verbatim in the turn they cite, in answer order, each value once, and why each other one did not. */
export function checkNamedValues(answers: readonly NamedValueAnswer[], span: SpanTexts): { values: LearnedValue[]; errors: FieldError[] } {
  const values: LearnedValue[] = [];
  const errors: FieldError[] = [];
  answers.slice(0, NAMED_VALUES_PER_SPAN).forEach((answer, index) => {
    const verdict = checkOne(answer, span);
    if (!verdict.ok) errors.push({ path: `values[${index}]`, ...verdict.error });
    else if (!values.some((kept) => kept.value === verdict.value.value)) values.push(verdict.value);
  });
  return { values, errors };
}
