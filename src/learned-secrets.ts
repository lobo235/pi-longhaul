/**
 * Credential lines for Learned values (learned.ts; security.md T3). The ledger's `containsSecret` was written for
 * command lines, where a credential sits after `=`/`:` or a flag. Tool OUTPUT prints them other ways: an aligned
 * table (`token    hvs.x`, `Secret ID    = <uuid>`), a key whose value is on the lines under it (a YAML block
 * scalar, pretty-printed JSON), a bare JWT or Vault token. A Learned value is pinned into every later request, so
 * anything on such a line, or on a line under such a key, is never one.
 *
 * Kept apart from the command redactor on purpose: widening it would redact ordinary commands from the ledger.
 */
import { containsSecret } from "./ledger/handoff-commands.ts";
import { contentText, isRec, type Rec } from "./message-text.ts";

/** A key naming a credential. `pass` only as a whole word part (`DB_PASS`), never `passed` or `bypass`. */
export const CREDENTIAL_NAME = /token|passw(?:or)?d|passphrase|pass(?![a-z])|secret|credential|accessor|(?:api|access|private|client|signing|encryption|master)[_ -]?key/i;
/**
 * A JWT (three base64url segments, the first a JSON header) or a Vault token, wherever it stands. Each may start only
 * where no base64url character precedes it, so a run like `eyJ-eyJ-...` offers one start, not one per `eyJ` (a
 * 160k-char run took 15 s with `\b`).
 */
const TOKEN_SHAPES = [/(?<![\w-])eyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]*/, /(?<![\w-])hv[sbr]\.[\w-]{8,}/];
/** A key is at most this long; a separator further in means the line is prose, not `key = value`. */
const KEY_CHARS = 64;
/**
 * A value that opens a block: nothing yet, a YAML block scalar indicator (indent digit and chomp sign in either
 * order), or an opening bracket, each optionally followed by a comment (`password: # set below`).
 */
const BLOCK_OPENER = /^(?:[|>](?:[-+]?\d?|\d[-+])|[{[])?\s*(?:#.*)?$/;

/** A line read as `key = value`, `key: value` or `key    value` (aligned table), or undefined when it is not one. */
function keyedLine(line: string): { key: string; value: string } | undefined {
  const text = line.trim();
  const separator = text.slice(0, KEY_CHARS + 1).search(/[=:]|\s{2,}|\t/);
  if (separator <= 0) return undefined;
  return { key: text.slice(0, separator), value: text.slice(separator).replace(/^\s*[=:]?\s*/, "") };
}

const indentOf = (line: string) => line.length - line.trimStart().length;

/** Whether `line` itself carries a credential: a command-style shape, a credential-named key, or a token shape. */
function isCredentialLine(line: string): boolean {
  if (containsSecret(line) || TOKEN_SHAPES.some((shape) => shape.test(line))) return true;
  const keyed = keyedLine(line);
  return keyed !== undefined && CREDENTIAL_NAME.test(keyed.key);
}

/**
 * Splits `text` into its credential lines and the rest. A credential-named key with no value on its own line
 * (`client_token: |`, `"db_password":`) also makes the next non-empty line, every line indented under the key,
 * and every `- ` list item at the key's own indent, credential lines.
 */
export function splitCredentialLines(text: string): { credential: string[]; clean: string[] } {
  const credential: string[] = [];
  const clean: string[] = [];
  let blockIndent: number | undefined;
  let blockStarted = false;
  for (const line of text.split("\n")) {
    if (blockIndent !== undefined && line.trim() !== "") {
      // A YAML list may sit at its key's own indent (`api_tokens:` then `- a`, yaml.v2's and kubectl's style).
      const listItem = indentOf(line) === blockIndent && line.trimStart().startsWith("- ");
      if (!blockStarted || indentOf(line) > blockIndent || listItem) {
        blockStarted = true;
        credential.push(line);
        continue;
      }
      blockIndent = undefined;
    }
    if (!isCredentialLine(line)) {
      clean.push(line);
      continue;
    }
    credential.push(line);
    const keyed = keyedLine(line);
    if (keyed && CREDENTIAL_NAME.test(keyed.key) && BLOCK_OPENER.test(keyed.value)) {
      blockIndent = indentOf(line);
      blockStarted = false;
    }
  }
  return { credential, clean };
}

/** A credential word between non-letters: `db_password` and `get-secret-value` count, `tokenizer` does not. */
const SECRET_WORD = String.raw`(?<![A-Za-z])(?:secrets?|passw(?:or)?ds?|passphrases?|credentials?|tokens?)(?![A-Za-z])`;
/** Files that hold credentials by convention, as the last part of a path. */
const SECRET_FILE = String.raw`(?:^|[/\s"'=])(?:\.pgpass|\.netrc|\.env(?:\.[\w-]+)?|[\w.-]+\.(?:pem|key|p12|pfx|jks|keystore))(?=$|[\s"';&|)])`;

/** A path that names a secret file: a credential word anywhere in it, or a credential file's name (security.md T3). */
export const SECRET_PATH = new RegExp(`${SECRET_WORD}|${SECRET_FILE}`, "i");

/**
 * A command that reads a secret store or a secret file. Its output is a credential however plain it looks: a short
 * hex string or a PIN has a value's shape, so no line test can tell (security.md T3).
 */
export const READS_SECRET = new RegExp(
  [
    SECRET_WORD,
    SECRET_FILE,
    String.raw`(?:^|[\s;&|(])(?:pass|gopass|lpass)\s+(?:show\s+|otp\s+)?[\w./@-]`,
    String.raw`(?:^|[\s;&|(])op\s+(?:read|inject|item\s+get)\b`,
    String.raw`(?:^|[\s;&|(])vault\s+(?:kv\s+get|read)\b`,
    String.raw`(?:^|[\s;&|(])(?:bw|keyring)\s+get\b`,
    String.raw`(?:^|[\s;&|(])ykman\s+oath\b`,
    String.raw`(?:^|[\s;&|(])sops\s+(?:-d|--decrypt)\b`,
    String.raw`--with-decryption\b`,
  ].join("|"),
  "i",
);

/**
 * The output of every tool run in `messages` that read a secret: a command matching READS_SECRET (the user's `!`
 * runs included) or a file whose path matches SECRET_PATH, whichever tool opened it.
 */
export function secretStoreOutputs(messages: Rec[]): string[] {
  const secretCalls = new Set<string>();
  const outputs: string[] = [];
  for (const message of messages) {
    if (message.role === "bashExecution" && typeof message.command === "string" && READS_SECRET.test(message.command)) outputs.push(String(message.output ?? ""));
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (!isRec(block) || block.type !== "toolCall" || !isRec(block.arguments)) continue;
        const { command, path } = block.arguments;
        if ((typeof command === "string" && READS_SECRET.test(command)) || (typeof path === "string" && SECRET_PATH.test(path))) secretCalls.add(String(block.id));
      }
    }
    if (message.role === "toolResult" && secretCalls.has(String(message.toolCallId))) outputs.push(contentText(message.content));
  }
  return outputs;
}
