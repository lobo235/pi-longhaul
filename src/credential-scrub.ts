/**
 * Credential scrub (CONTEXT.md *Credential scrub*; security.md T3): text a model wrote into the state (the narrative,
 * Now, decisions, dead ends) and the open-error lines, with each credential value replaced by REDACTED_VALUE. The
 * state is rendered into every later request, so a password the summarizer copied out of a tool's output was sent
 * again at every turn. Only the value goes: the words around it stay, so a Resume line still says what to do next.
 *
 * A value is a credential when
 * - its shape is one wherever it stands: a JWT, a Vault token, an AWS, GitHub, OpenAI-style, Slack or age key;
 * - the text names it: the value of a credential key (`password=x`, `"api_key": "x"`), a Bearer value, the password
 *   of a `user:pass@` URL, or a random-looking value within CONTEXT_REACH characters after a credential word
 *   (`password (64-hex): <hex>`, `the gateway key (<uuid>)`);
 * - or it is one of the span's credentials (span-credentials.ts): a whole value the span itself showed as one
 *   (`DB_PASSWORD=Ab3$x;9Kq2`, symbols and all), wherever the model put it and however it wrapped it (quoted, bold,
 *   between dashes, glued to a flag or a login).
 * A digest (`sha256:<hex>`) is never one. Every pattern is linear: a summarizer's answer is untrusted (security.md T4).
 */

import type { StateEvent } from "./store/events.ts";

/** What a redacted value is replaced with. Holds no token character, so a second scrub leaves it alone. */
export const REDACTED_VALUE = "<redacted>";

/** The summarizer prompts' rule (narrative/prompt.ts, narrative/turns/conversation.ts); the scrub is what holds when a model ignores it. */
export const CREDENTIAL_RULE = 'Never copy a password, key, token or other credential\'s value into the state, in any field: say what it is and where it lives ("the gateway key from its Vault secret"), never the value itself.';

/** The span's credentials: whole values, each one judged a credential where the span showed it (span-credentials.ts). */
export type SpanCredentials = ReadonlySet<string>;

export interface Scrubbed {
  text: string;
  /** How many values were replaced; logged as a count, never the values. */
  redacted: number;
}

/** A token: what a value is cut on, as named-values.ts TOKEN_SPLIT cuts a credential line. */
const TOKEN = /[^\s=:"'`,;{}[\]()<>]+/g;
/** A word: what a whole value is cut on. Space, and the dashes and quotes prose puts around a value (`—x—`, `“x”`). */
export const WORD = /[^\s\u2013\u2014\u2018\u2019\u201c\u201d\u00ab\u00bb]+/g;
/** How far after a credential word a random-looking value counts as its value. */
const CONTEXT_REACH = 40;

/** Shapes that are credentials wherever they stand (ledger/handoff-commands.ts SECRET_PATTERNS, and learned-secrets.ts TOKEN_SHAPES). */
const CREDENTIAL_SHAPES = [
  /(?<![\w-])eyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]*/g,
  /(?<![\w-])hv[sbr]\.[\w-]{8,}/g,
  /\bAGE-SECRET-KEY-1[0-9A-Z]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,})/g,
  // GitLab, Google API, Stripe, npm and Hugging Face tokens; as ledger/handoff-commands.ts SECRET_PATTERNS, kept in step.
  /\b(?:glpat-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{35}|[sr]k_(?:live|test)_[A-Za-z0-9]{16,}|npm_[A-Za-z0-9]{36}|hf_[A-Za-z]{30,})/g,
];
const PEM_BEGIN = /-----BEGIN [A-Z ]{0,64}PRIVATE KEY(?: BLOCK)?-----/g;
const PEM_END = "-----END ";
/** A private key's body without an END line is cut here. */
const PEM_CHARS = 16_384;

/**
 * The key part names a credential. A password word may be glued to its prefix (`PGPASSWORD`, `MYSQL_PWD`: a lazy
 * bounded prefix from a word start, at most 48 tries per start, linear, security.md T4); any other word only after
 * `_` or `-` (`DB_PASS`, `client-secret`), so `compass` and `bypass` are no key. No plural `tokens` (a count). A bare
 * `pass` is one only before `=` or a quoted value (`pass=`, `pass: 'x'`): `--- PASS: TestName` is a test runner's status.
 */
const CREDENTIAL_KEY = String.raw`(?<![A-Za-z0-9])(?:[A-Za-z0-9_-]{0,48}?(?:passw(?:or)?ds?|passwd|pwd)|(?:[A-Za-z0-9]{1,32}[_-]){1,3}pass|pass(?=(?:\\{0,3}["'])?[ \t]{0,8}(?:=|:[ \t]{0,8}\\{0,3}["']))|(?:[A-Za-z0-9]{1,32}[_-]){0,3}(?:pw|passphrases?|passcodes?|secrets?|token|api[_-]?keys?|access[_-]?keys?|private[_-]?keys?|credentials?))`;
/**
 * A key that ends in a password word in full, whose value may be all digits (`ROOT_PASSWORD=48291375`); not `pass`
 * or `pw` (`e2e_pass: 1234567`), nor a key about passwords (`password_min_length: 123456`).
 */
const NUMERIC_PASSWORD_KEY = /(?:passw(?:or)?d|passwd|pwd|passphrase|passcode)s?$/i;
/** Whether `key` (a key part, its quotes and separator included or not) says password in full at its end. */
export const isNumericPasswordKey = (key: string) => NUMERIC_PASSWORD_KEY.test(withoutTrailing(key, "\"' \t=:\\"));
/** `key = value`, `key: value`, quoted as JSON or not, escaped quotes included; the value is group 2, up to a space or a quote, so symbols in it stay in it. */
const KEYED_VALUE = new RegExp(String.raw`(${CREDENTIAL_KEY}(?:\\{0,3}["'])?[ \t]{0,8}[=:][ \t]{0,8}(?:\\{0,3}["'])?)([^\s"'\x60\\]{3,})`, "gi");
const BEARER_VALUE = /(\b(?:bearer|basic)\s+)([^\s"'`,;{}[\]()<>]{8,})/gi;
/** A URL login's prefix, `scheme://user:` (the user may be empty); its password runs to the word's last `@` (urlPasswordSpans). */
const URL_LOGIN = /[a-z][a-z0-9+.-]{0,30}:\/\/[^\s/:@]{0,512}:/gi;
const URL_PASSWORD_CHARS = 512;
/** A credential named in prose: a random-looking value after it is its value. */
const CREDENTIAL_WORD = /(?<![A-Za-z])(?:passw(?:or)?ds?|passwd|pwd|passphrases?|passcodes?|secrets?|tokens?|api[_ -]?keys?|keys?|bearer|credentials?|auth)(?![A-Za-z])/gi;

/** A value the text points at rather than holds: a variable, a placeholder, a mask. */
const REFERENCE = /^(?:\$|%|\*|\{|<|\.\.\.)/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** As named-values.ts RANDOM_LOOKING: long hex with a digit and a letter, a long mixed-case run with digits, 13+ digits. */
const RANDOM_LOOKING = [/^\d{13,}$/, /^(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{13,}$/i, /^(?=[A-Za-z0-9_+/-]*[a-z])(?=[A-Za-z0-9_+/-]*[A-Z])(?=[A-Za-z0-9_+/-]*\d)[A-Za-z0-9_+/-]{16,}={0,2}$/];
const DIGEST_PREFIX = /sha(?:1|224|256|384|512):$/i;

export const isRandomLooking = (token: string) => UUID.test(token) || RANDOM_LOOKING.some((shape) => shape.test(token));
/** A token a credential could be: random-looking, or six characters or more with a digit. */
export const isValueLike = (token: string) => isRandomLooking(token) || (token.length >= 6 && /\d/.test(token));
/** A value a credential key holds: value-like, or opaque (twelve characters or more), never a path (`PWD=/home/app`); a word is a status ("token: missing"). A Bearer value must be value-like: "Bearer authentication" is prose. */
const isHeldValue = (token: string) => (isValueLike(token) || token.length >= 12) && !/^(?:\/|~\/|\.\.?\/)/.test(token);
/** A number, a count (`120/120`), a version, a time or a date: no credential, unless a password key holds it. */
const NUMBERISH = /^(?:v?\d+(?:[.:_/-]\d+)*|\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+Z?)?)$/i;
export const isNumberish = (token: string) => NUMBERISH.test(token);
/** A credential key's value (isHeldValue); a number only under a password key, so `tests pass: 120/120` stays. */
const isKeyedHeld = (token: string, key: string) => {
  const bare = withoutTrailing(token, ",.;:!?)]}");
  return isHeldValue(token) && (!isNumberish(bare) || (isNumericPasswordKey(key) && /^\d{6,}$/.test(bare)));
};
/**
 * A value prose names only by a nearby credential word: random-looking, hex only from LONG_HEX characters, since a
 * plan or object id near "secret" is 16 (measured on real states: plan hashes, short ids).
 */
const LONG_HEX = 20;
const isNamedByContext = (token: string) => isRandomLooking(token) && !(/^[0-9a-f]+$/i.test(token) && token.length < LONG_HEX);

/** `token` without the trailing `marks`. A loop, not `/[.!?]+$/`: that regex retries from every mark of a long run (quadratic, security.md T4). */
function withoutTrailing(token: string, marks: string): string {
  let end = token.length;
  while (end > 0 && marks.includes(token[end - 1])) end--;
  return token.slice(0, end);
}
/** `token` without the sentence marks that end it. */
const withoutClosingMarks = (token: string) => withoutTrailing(token, ".!?");

interface Span { start: number; end: number }

function shapeSpans(text: string): Span[] {
  const spans: Span[] = [];
  for (const shape of CREDENTIAL_SHAPES) for (const match of text.matchAll(shape)) spans.push({ start: match.index, end: match.index + match[0].length });
  return [...spans, ...pemSpans(text)];
}

/** A private key from its BEGIN line through its END line, or PEM_CHARS on when it has none. One scan: each key starts after the last. */
function pemSpans(text: string): Span[] {
  const spans: Span[] = [];
  let from = 0;
  for (const begin of text.matchAll(PEM_BEGIN)) {
    if (begin.index < from) continue;
    // END is looked for inside the key's window only: the rest of the text, once per key, is quadratic (security.md T4).
    const window = text.slice(begin.index, begin.index + PEM_CHARS);
    const end = window.indexOf(PEM_END, begin[0].length);
    const close = end < 0 ? -1 : window.indexOf("-----", end + PEM_END.length);
    const stop = begin.index + (close < 0 ? window.length : close + 5);
    spans.push({ start: begin.index, end: stop });
    from = stop;
  }
  return spans;
}

/** The value group (2) of each match of `pattern`, unless it only points at a value or `holds` refuses it (given the key part, group 1). */
function groupSpans(text: string, pattern: RegExp, holds: (value: string, key: string) => boolean = () => true): Span[] {
  const spans: Span[] = [];
  for (const match of text.matchAll(pattern)) {
    if (REFERENCE.test(match[2]) || !holds(match[2], match[1])) continue;
    const start = match.index + match[1].length;
    spans.push({ start, end: start + match[2].length });
  }
  return spans;
}

/**
 * Whether the credential word at [start, end) is part of a path or a file name (`/tmp/admin-bearer.txt`,
 * `token.json`), which says where a credential lives, not that a value follows. Looks at most FILE_NAME_REACH back.
 */
const FILE_NAME_REACH = 256;
function inFileName(text: string, start: number, end: number): boolean {
  const before = text.slice(Math.max(0, start - FILE_NAME_REACH), start);
  return /\/[^\s/]*$/.test(before) || /^[\w-]*\.[A-Za-z][A-Za-z0-9]{0,4}(?![\w-])/.test(text.slice(end, end + FILE_NAME_REACH));
}

/** Tokens named by context (isNamedByContext) that start within CONTEXT_REACH characters after a credential word, digests excepted. */
function contextSpans(text: string, tokens: ReadonlyArray<{ token: string; start: number }>): Span[] {
  const spans: Span[] = [];
  let index = 0;
  for (const word of text.matchAll(CREDENTIAL_WORD)) {
    const after = word.index + word[0].length;
    if (inFileName(text, word.index, after)) continue;
    while (index < tokens.length && tokens[index].start < after) index++;
    for (let next = index; next < tokens.length && tokens[next].start <= after + CONTEXT_REACH; next++) {
      const { token, start } = tokens[next];
      const bare = withoutClosingMarks(token);
      if (isNamedByContext(bare) && !DIGEST_PREFIX.test(text.slice(Math.max(0, start - 7), start))) spans.push({ start, end: start + bare.length });
    }
  }
  return spans;
}

/**
 * The password of each `scheme://user:pass@host`: up to the last `@` of the word, so a password holding one is taken
 * whole (`app:p@ss1234@db`). A port followed by a path is no login. Each login looks at most URL_PASSWORD_CHARS on.
 */
function urlPasswordSpans(text: string): Span[] {
  const spans: Span[] = [];
  for (const match of text.matchAll(URL_LOGIN)) {
    const start = match.index + match[0].length;
    const window = text.slice(start, start + URL_PASSWORD_CHARS + 1);
    const space = window.search(/\s/);
    const word = space < 0 ? window : window.slice(0, space);
    const at = word.lastIndexOf("@");
    if (at <= 0 || /^\d{1,5}\//.test(word) || REFERENCE.test(word)) continue;
    spans.push({ start, end: start + at });
  }
  return spans;
}

const isWordChar = (char: string) => /[\p{L}\p{N}]/u.test(char);

/** `word` without what wraps it (quotes, `**`, brackets, a closing mark), as offsets into `word`; empty when nothing is left. */
export function credentialCore(word: string): { start: number; end: number } {
  let start = 0;
  let end = word.length;
  while (start < end && !isWordChar(word[start])) start++;
  while (end > start && !isWordChar(word[end - 1])) end--;
  return { start, end };
}

/**
 * Where a value may stand in a word, widest first: the word, after its first or last `=` or `:` (`DB_PASSWORD='x'`),
 * after a short flag (`-px`), and each part between `/` and `@` (`app/x@db`), also after that part's first `:`
 * (`app:x@db:5432`). Linear in the word.
 */
function placesIn(word: string): Array<[start: number, end: number]> {
  const places: Array<[number, number]> = [[0, word.length]];
  const first = word.search(/[=:]/);
  const last = Math.max(word.lastIndexOf("="), word.lastIndexOf(":"));
  if (first >= 0) places.push([first + 1, word.length]);
  if (last > first) places.push([last + 1, word.length]);
  const flag = /^-{1,2}[A-Za-z]/.exec(word);
  if (flag) places.push([flag[0].length, word.length]);
  // The next `:` at or after a part's start; the pointer only moves forward, so the scan stays linear.
  let colon = -1;
  const part = (from: number, to: number) => {
    places.push([from, to]);
    if (colon < from) {
      const next = word.indexOf(":", from);
      colon = next < 0 ? Infinity : next;
    }
    if (colon < to) places.push([colon + 1, to]);
  };
  let from = 0;
  for (const separator of word.matchAll(/[/@]/g)) {
    part(from, separator.index);
    from = separator.index + 1;
  }
  if (from > 0) part(from, word.length);
  return places;
}

/** Each span value in `text`, wrapping trimmed (credentialCore), at the widest place in its word that holds it. */
function valueSpans(text: string, values: SpanCredentials): Span[] {
  const spans: Span[] = [];
  for (const match of text.matchAll(WORD)) {
    const word = match[0];
    for (const [from, to] of placesIn(word)) {
      const core = credentialCore(word.slice(from, to));
      if (core.end > core.start && values.has(word.slice(from + core.start, from + core.end))) {
        spans.push({ start: match.index + from + core.start, end: match.index + from + core.end });
        break;
      }
    }
  }
  return spans;
}

/** `text` with every span replaced, overlapping spans as one. */
function replaceSpans(text: string, spans: Span[]): Scrubbed {
  if (!spans.length) return { text, redacted: 0 };
  spans.sort((a, b) => a.start - b.start);
  let out = "";
  let cursor = 0;
  let redacted = 0;
  for (const span of spans) {
    if (span.end <= cursor) continue;
    if (span.start >= cursor) {
      out += text.slice(cursor, span.start) + REDACTED_VALUE;
      redacted++;
    }
    cursor = span.end;
  }
  return { text: out + text.slice(cursor), redacted };
}

/** What the text itself names as a credential: a shape, a credential key's value, a Bearer value, a URL password, a value after a credential word. */
function namedSpans(text: string): Span[] {
  const tokens = [...text.matchAll(TOKEN)].map((match) => ({ token: match[0], start: match.index }));
  return [
    ...shapeSpans(text),
    ...groupSpans(text, KEYED_VALUE, isKeyedHeld),
    ...groupSpans(text, BEARER_VALUE, isValueLike),
    ...urlPasswordSpans(text),
    ...contextSpans(text, tokens),
  ];
}

/** The values `text` names as credentials, wrapping trimmed: what scrubCredentials takes out of it on its own. */
export function namedCredentialValues(text: string): string[] {
  return namedSpans(text).map((span) => {
    const value = text.slice(span.start, span.end);
    const core = credentialCore(value);
    return value.slice(core.start, core.end);
  }).filter(Boolean);
}

/**
 * `text` with its credential values replaced. `span` is the span's credentials; without them (text read back from a
 * span record already written) only what the text itself names is found.
 */
export function scrubCredentials(text: string, span?: SpanCredentials): Scrubbed {
  return replaceSpans(text, [...namedSpans(text), ...(span?.size ? valueSpans(text, span) : [])]);
}

/** What a pass wrote, scrubbed: the events whose text the summarizer chose, and the span's narrative. */
export function scrubModelWritten(events: readonly StateEvent[], narrative: string | undefined, span: SpanCredentials): { events: StateEvent[]; narrative?: string; redacted: number } {
  let redacted = 0;
  const clean = (text: string) => {
    const scrubbed = scrubCredentials(text, span);
    redacted += scrubbed.redacted;
    return scrubbed.text;
  };
  const scrubbedEvents = events.map((event): StateEvent => {
    switch (event.kind) {
      case "decision.add": case "deadEnd.add": return { ...event, text: clean(event.text) };
      case "now.set": return { ...event, now: { inProgress: event.now.inProgress.map(clean), next: event.now.next.map(clean), blocked: event.now.blocked.map(clean), resume: clean(event.now.resume) } };
      default: return event;
    }
  });
  return { events: scrubbedEvents, ...(narrative === undefined ? {} : { narrative: clean(narrative) }), redacted };
}
