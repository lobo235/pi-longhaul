/**
 * The span's credentials (credential-scrub.ts SpanCredentials): the whole values the span itself showed as
 * credentials, which the scrub then takes out of what the summarizer wrote wherever it put them (security.md T3).
 * Strong evidence only, because each value is redacted everywhere it stands: the named-value taint
 * (narrative/named-values.ts), right for refusing a value, counts the words after "pin", "card" or "login" and a
 * secret store's whole output, and on real states it redacted versions, commit hashes and paths in about a third of
 * the fields. A value counts when
 * - the span's text names it as the scrub itself would (credential-scrub.ts namedCredentialValues), unless it is
 *   shaped as a name (below);
 * - it is the value of a key named for one credential, ending in its name or a short part after it
 *   (`DB_PASSWORD`, `cluster_token`, `WIFI_PASSPHRASE_2400_BAUD`; not `tokens: 1200`, a test runner's `pass`, nor a key
 *   about one, `password_policy`, `token_env`), unless a token, secret or key key holds a value shaped as a name (`app-token`,
 *   `APP_TOKEN`, a path, a file name; a password key's value is one whatever its shape, `unmade-tremor-oxidize`);
 * - a command gives it as a password argument (`mysql -pX`, `sshpass -p X`, `redis-cli -a X`, `curl -u user:X`,
 *   `htpasswd -b FILE USER X`, `--db-password X`, `openssl -pass pass:X`, `keytool -storepass X`);
 * - it is a random-looking word on another credential line (a YAML block under such a key);
 * - a secret store printed it alone (`vault kv get -field=...`), or random-looking among other output;
 * - but never a random-looking word its label names as an id or a hash (`Evaluation ID: <uuid>`, `plan_hash <hex>`,
 *   `commit <sha>`), nor the words after a key whose value is computed (`TOKEN=$(vault kv get ... | python3 ...)`), nor
 *   a test runner's `--- PASS: TestName`;
 * - or prose gives it: `the password is ...`, `the db pass is ...`.
 * Never a number (except six digits and more given as a password), version, date or path, nor one plain lowercase
 * word ("token: missing"). Measured on real states, these took no version, hash or path out of a field.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { credentialCore, isNumberish, isNumericPasswordKey, isRandomLooking, isValueLike, namedCredentialValues, WORD } from "./credential-scrub.ts";
import { CREDENTIAL_NAME, keyedLine, secretStoreOutputs, splitCredentialLines } from "./learned-secrets.ts";
import type { Rec } from "./message-text.ts";
import { everyTextIn } from "./narrative/named-values.ts";

/** `the password is X`: the one value prose gives a password outright. */
const PROSE_PASSWORD = /(?<![A-Za-z])(?:passw(?:or)?d|passwd|pwd|pass|passphrase|passcode)\s+(?:is|was)\s+(\S+)/gi;
/**
 * A command's password argument, group 1 (as ledger/handoff-commands.ts SECRET_PATTERNS, which marks the line).
 * Every quantifier is bounded, each lazy run stops at a newline.
 */
const COMMAND_PASSWORDS = [
  /\b(?:mysql|mysqldump|mariadb)\b[^\n]{0,2000}?\s-p(?!\s)(\S+)/g,
  /\bsshpass\s+(?:(?:-P\s+\S+|-[a-oq-zA-Z]\w*)\s+){0,3}-p\s*(\S+)/g,
  /\bredis-cli\b[^\n]{0,200}?\s-a\s+(\S+)/g,
  /(?:^|\s)(?:-u|--user)\s+[^\s:]+:(\S+)/g,
  /\s-pass(?:in|out)?\s+pass:(\S+)/g,
  /\s-(?:src|dest)?(?:store|key)?pass\s+(?!(?:env|file|fd):|stdin\b)(\S+)/g,
  /(?:^|\s)--?(?:[a-z0-9]{1,32}[-_.]){0,3}(?:password|passwd|passphrase|pass|secret|token|api[-_]?key)(?:=|\s+)(?!-)(\S+)/gi,
];
/** `htpasswd -b FILE USER PASS`, or `-nb USER PASS` (no file). */
const HTPASSWD = /\bhtpasswd\s+(?:-[a-zA-Z]{1,8}\s+){0,3}?-([a-zA-Z]{0,8}b[a-zA-Z]{0,8})\s+(\S+)\s+(\S+)(?:\s+(\S+))?/g;
/** A test runner's status line, `--- PASS: TestName (0.01s)` or `PASS: name`, upper case: no credential (`pass: x` is one). */
const TEST_STATUS = /^\s*(?:[-=]{3}\s*)?PASS\s*:/;
/** A value pointed at rather than held (a variable, a placeholder), once a quote or bracket before it is dropped. */
const REFERENCE = /^["'`([]*(?:\$|%|\*|\{|<|\.\.\.)/;
const NOT_A_SECRET = [
  /^v?\d+(?:[.:_-]\d+)*$/i, // a number, a version, a time
  /^\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+Z?)?$/, // a date
  /^(?:\/|~\/|\.\.?\/)/, // a path
  /^[a-z]+$/, // one plain lowercase word: a status
];
const isSpanValue = (value: string) => value.length >= 4 && (/^\d{13,}$/.test(value) || !NOT_A_SECRET.some((shape) => shape.test(value)));
/** A password given as one: a span value, or six digits and more. */
const isPasswordValue = (value: string) => isSpanValue(value) || /^\d{6,}$/.test(value);
/**
 * What may follow a credential's name at the end of its key: up to two short parts (`WIFI_PASSPHRASE_2400_BAUD`,
 * `ADMIN_TOKEN_2`), then quotes. A part that says the key is ABOUT the credential (KEY_ABOUT) makes it no key for one.
 */
const KEY_TAIL = String.raw`((?:[_.-][A-Za-z0-9]{1,12}){0,2})["'\\]{0,4}$`;
const KEY_ABOUT = /[_.-](?:policy|disabled|enabled|required|length|len|min|max|algorithm|algo|hash|hashed|salt|rounds|file|path|dir|env|var|name|id|type|kind|mode|set|present|missing|rules|reset|expiry|expires|ttl|age|count|ref|url|header|field|prompt|hint|strength|changed|updated)(?![A-Za-z0-9])/i;
const endsInCredential = (pattern: RegExp, key: string) => {
  const match = pattern.exec(key.trim());
  return match !== null && !KEY_ABOUT.test(match[1]);
};
/** A key that ends in a password word (`DB_PASS`, `"password"`), not one about passwords (`password_policy`). */
const PASSWORD_KEY = new RegExp(String.raw`(?:passw(?:or)?d|passwd|pwd|pass(?:phrase|code)?)s?` + KEY_TAIL, "i");
const isPasswordKey = (key: string) => endsInCredential(PASSWORD_KEY, key);
/** Push without spreading: a spread passes every element as an argument and overflows the stack on a huge line. */
function pushAll(into: string[], items: Iterable<string>): void {
  for (const item of items) into.push(item);
}
/**
 * A key named for one credential, in at most three words, ending in its name (quotes aside): singular, so
 * `tokens: 1200` and a list of `secrets` are not one, no bare `pass` (a test runner's count), and no key about one
 * (`password_policy`, `token_env`, `PASSWORD_FILE`). Letters may precede the name (`PGPASSWORD`).
 */
const CREDENTIAL_KEY = new RegExp(String.raw`(?:passw(?:or)?d|passwd|passphrase|passcode|secret|token|api[_ -]?key|access[_ -]?key|private[_ -]?key|credential)` + KEY_TAIL, "i");
/** A bare lower-case `pass` key (nodemailer's `auth.pass`, YAML), which CREDENTIAL_KEY leaves out as a test runner's count. */
const BARE_PASS_KEY = /^["']?pass["']?$/;
const isCredentialKey = (key: string) => BARE_PASS_KEY.test(key.trim()) || key.length <= 40 && key.trim().split(/\s+/).length <= 3 && endsInCredential(CREDENTIAL_KEY, key);
/**
 * A value shaped as a name of something rather than a secret: an identifier, an environment variable, a path, a file
 * or host name, or a call that computes it (`secret = json.load(open('app.json'))`).
 */
const NAME_SHAPES = [/^[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)+$/, /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/, /\//, /^[\w-]+(?:\.[\w-]+)+$/, /^[A-Za-z_][\w.]{0,64}\(/];
const isNameShaped = (value: string) => !isRandomLooking(value) && NAME_SHAPES.some((shape) => shape.test(value));
/** A credential key's value: value-like, or eight characters and more; under a token, secret or key key, not shaped as a name. */
function isKeyedValue(value: string, key: string): boolean {
  if (/^\d{6,}$/.test(value)) return isNumericPasswordKey(key);
  if (isPasswordKey(key)) return isSpanValue(value) && (isValueLike(value) || value.length >= 6);
  return (isValueLike(value) || value.length >= 8) && !isNameShaped(value) && !isNumberish(value);
}
/** A command's password argument: a password, value-like or six characters and more. */
const isCommandValue = (value: string) => isPasswordValue(value) && (isValueLike(value) || value.length >= 6);
/** A value prose gives: value-like, or a long run with a non-letter in it (a passphrase), not a long English word. */
const isProseValue = (value: string) => isValueLike(value) || (value.length >= 12 && /[^A-Za-z]/.test(value));

/** The words of `text` that hold a value, each with what wraps it trimmed. */
function coresOf(text: string): string[] {
  const cores: string[] = [];
  for (const [word] of text.matchAll(WORD)) {
    if (REFERENCE.test(word)) continue;
    const core = credentialCore(word);
    if (core.end > core.start) cores.push(word.slice(core.start, core.end));
  }
  return cores;
}

/** A word that names the value after it as an id or a hash (`Evaluation ID:`, `plan_hash`, `commit`), not a secret. */
const ID_LABEL = /(?:^|[_.-])(?:id|ids|uuid|hash|sha|sha1|sha256|digest|commit|rev|revision|etag)$/i;

/**
 * The random-looking words of `text`, except one the word before it on its line labels as an id or a hash (ID_LABEL),
 * unless that label or the word before it names a credential (`secret_id`, `Secret ID`).
 */
function randomWordsOf(text: string): string[] {
  const values: string[] = [];
  let label = "";
  let previous = "";
  let end = 0;
  for (const match of text.matchAll(WORD)) {
    if (text.slice(end, match.index).includes("\n")) label = previous = "";
    const core = credentialCore(match[0]);
    const bare = match[0].slice(core.start, core.end);
    const idLabelled = ID_LABEL.test(label) && !CREDENTIAL_NAME.test(`${previous} ${label}`);
    if (!REFERENCE.test(match[0]) && isRandomLooking(bare) && !idLabelled) values.push(bare);
    previous = label;
    label = bare;
    end = match.index + match[0].length;
  }
  return values;
}

/** The password arguments of a command line. */
function commandValuesOf(line: string): string[] {
  const values: string[] = [];
  for (const pattern of COMMAND_PASSWORDS) for (const match of line.matchAll(pattern)) pushAll(values, coresOf(match[1]));
  for (const match of line.matchAll(HTPASSWD)) {
    const value = match[1].includes("n") ? match[3] : match[4];
    if (value) pushAll(values, coresOf(value));
  }
  return values.filter(isCommandValue);
}

/** A password key written as YAML (`password: my Secret#Pass 99`), whose plain value runs to the line's end or a comment. */
const isYamlPassword = (line: string, key: string) => isPasswordKey(key) && /^\s*:\s/.test(line.trimStart().slice(key.length));
/** What is left of an assignment once the key is cut at its first colon: Go's `:=` or a type (`: str = `, `: &str = `). */
const ASSIGNED = /^(?:[^\s=]{1,40}[ \t]{1,8})?:?=(?!=)[ \t]{0,8}/;
/**
 * What a key holds: its quoted string, or else its first word; the rest of the line is the command or prose around it
 * (`TOKEN=$(vault kv get ... | python3 -c "import sys,json"`). Nothing when the value is computed or pointed at.
 */
function heldBy(raw: string, toLineEnd: boolean): string {
  const value = raw.replace(ASSIGNED, "");
  const quoted = /^(\\{0,3}["'])((?:\\.|[^\n\\]){0,512}?)\1/.exec(value);
  const comment = toLineEnd ? value.search(/\s#/) : -1;
  const held = quoted ? quoted[2] : toLineEnd ? (comment < 0 ? value : value.slice(0, comment)) : (/^\S+/.exec(value)?.[0] ?? "");
  return REFERENCE.test(held) || /^["'([]*`/.test(held) ? "" : held;
}

function valuesOf(text: string): string[] {
  const values = namedCredentialValues(text).filter((value) => !isNameShaped(value));
  for (const line of splitCredentialLines(text).credential) {
    if (TEST_STATUS.test(line)) continue;
    const keyed = keyedLine(line);
    if (keyed && isCredentialKey(keyed.key)) pushAll(values, coresOf(heldBy(keyed.value, isYamlPassword(line, keyed.key))).filter((value) => isKeyedValue(value, keyed.key)));
    else pushAll(values, randomWordsOf(line));
    pushAll(values, commandValuesOf(line));
  }
  for (const match of text.matchAll(PROSE_PASSWORD)) pushAll(values, coresOf(match[1]).filter((value) => isProseValue(value) || /^\d{6,}$/.test(value)));
  return values;
}

/** What a secret store printed: a value printed alone is one whatever it looks like; among other output, a random-looking one. */
function storeValuesOf(output: string): string[] {
  const words = coresOf(output.trim());
  return words.length === 1 ? words : randomWordsOf(output);
}

/** The span's credentials in `messages`: every whole value one of them showed as a credential. */
export function spanCredentials(messages: readonly AgentMessage[]): Set<string> {
  const values = new Set<string>();
  const add = (value: string) => { if (isPasswordValue(value)) values.add(value); };
  for (const message of messages as unknown as Rec[]) for (const text of everyTextIn(message)) valuesOf(text).forEach(add);
  for (const output of secretStoreOutputs(messages as unknown as Rec[])) storeValuesOf(output).forEach(add);
  return values;
}
