/**
 * The command ledger behind handoff.ts: secret redaction, merge of the observed runs
 * (handoff-observe.ts) into the carried records, and the ranking that decides which records survive
 * the cap. Everything here is mechanical; no text in a record was ever produced by a model.
 */
import type { CommandRecord } from "./handoff.ts";
import type { ObservedRun } from "./handoff-observe.ts";

/** The text of a redacted command; redacted runs collapse into one record with this text. */
export const REDACTED_COMMAND = "<redacted>";

/** Score below which a record ranks under every non-trivial one (trivial records are dropped first). */
const TRIVIAL_SCORE = -1_000_000;

// --- redaction and normalization -----------------------------------------------------------------

/** A PEM private key header: any line carrying one is a credential, in a command or in tool output. */
export const PRIVATE_KEY = /-----BEGIN [A-Z ]{0,64}PRIVATE KEY(?: BLOCK)?-----/;

/**
 * Credential shapes: a named value (`TOKEN=`, `X-Api-Key:`), a flag with a value (`--passphrase x`),
 * a short code as a key (`ADMIN_PIN=`), an Authorization header or Bearer value, a mysql `-p`, a `-u user:pass`, credentials in a URL (a slash in the password too),
 * PEM key material, and the fixed prefixes of AWS, GitHub, OpenAI-style and Slack tokens. These
 * run on raw command text before any cap, so every quantifier that precedes a literal is bounded:
 * an unbounded `[a-z0-9+.-]*` before `://` backtracks per start position and took 6 s on a
 * 128k-char lowercase run (one large heredoc).
 */
const SECRET_PATTERNS: RegExp[] = [
  // An optional closing quote, escaped or not, before the separator: `{"password": "x"}`, `{\"password\":`
  // (security.md T3). No leading `\w*` and a bounded suffix: unbounded on both sides, a long keyword-dense word
  // backtracked once per keyword (security.md T4); an unanchored search finds the keyword inside a word anyway. The
  // whitespace before the separator stays unbounded: `\s` is disjoint from `\w`, the quote and `[=:]`, so each start
  // scans only its own run (linear), and `fmt`-aligned HCL pads `password   = "x"` well past any small bound
  // (security.md T3).
  /(?:token|password|passwd|passphrase|secret|api[-_]?key)\w{0,128}(?:\\{0,3}["'])?\s*[=:]\s*\S/i,
  // A flag may name the credential after a prefix (`--db-password`, `--client-secret`, `--new-pin`), but not a switch
  // (`--with-token < token.txt`, `--no-password`, `--ask-pass`), and a shell operator after it is no value.
  /(?:^|\s)--?(?:(?!(?:no|with|without|use|skip|ask|prompt|show|print|read|from|require|allow|disable|enable|generate|reset|revoke|max|min|cert|first|second|single|two|multi)[-_.])[a-z0-9]{1,32}[-_.](?:[a-z0-9]{1,32}[-_.]){0,3})?(?:token|pass|password|passwd|passphrase|secret|api[-_]?key|pin|otp|token-code|mfa-code|totp|authentication-code-?[12])(?:\s+|=)(?!(?:env|file|fd):|stdin\b|\d{1,2}(?:\s|$))[^\s<>|&;-]/i,
  // A prefix may have several parts (`--db-root-password`, `--spring.datasource.password`); a source named after the
  // flag (`-pass env:PW`, `file:`, `stdin`) and a pass number (`ffmpeg -pass 1`, `x264 --pass 2`) are not secrets.
  // `sshpass -p PASS`, `htpasswd -b FILE USER PASS` (`-bc` too) and `ykman otp ... --key KEY` take the secret as an argument.
  /\bsshpass\s+(?:(?:-P\s+\S+|-[a-zA-Z]\w*)\s+){0,3}?-p\s*\S/,
  /\bhtpasswd\b[^\n]{0,200}\s-[a-zA-Z]{0,8}b/,
  /\bykman\b[^\n]{0,500}\s--key(?=[\s=])/,
  // `openssl ... -pass pass:X` (`-passin`, `-passout`), `keytool -storepass X`, `redis-cli -a X`.
  /\s-pass(?:in|out)?\s+pass:\S/,
  /\s-(?:src|dest)?(?:store|key)?pass\s+(?!(?:env|file|fd):|stdin\b|\d{1,2}(?:\s|$))[^\s<>|&;-]/,
  /\bopenssl\b[^\n]{0,300}\s-k\s+\S/,
  /\bredis-cli\b[^\n]{0,200}\s-a\s+\S/,
  // `oathtool --totp -b SEED` (`-bv`, `--base32`) and `oathtool --hotp HEXKEY` take the one-time-password key on the
  // command line, and `ykman oath accounts add NAME SEED` the seed of a new account.
  /\boathtool\b[^\n]{0,500}\s(?:-[a-zA-Z]{0,8}b[a-zA-Z]{0,8}|--base32|[A-Fa-f0-9]{16,}|[A-Za-z2-7]{16,}=*)(?![\w-])/,
  /\bykman\b[^\n]{0,500}\boath\s+(?:accounts\s+)?add\b/,
  // A short code as a key: `ADMIN_PIN=4821`, `OTP_CODE=123456`, `card_cvv: 123`, `BANKPIN=4821`, `AdminPIN=4821`, `adminPin=4821`.
  // Whole key parts only, so `SPINNER=dots` and `opinion:` are not one, and the value must hold a digit, so a
  // switch (`mfa: enabled`, `otp=false`, `pin:latest`) is not one either. Every quantifier is bounded.
  /(?<![A-Za-z])(?:[A-Za-z0-9]{1,32}[_-])?(?:pin|otp|cvv\d?|cvc|passcode|mfa|2fa|totp)(?:[_-]?(?:code|number))?(?:\\{0,3}["'])?\s*[=:]\s*(?:\\{0,3}["'])?[^\s"']{0,63}?\d/i,
  /(?:(?<=[A-Za-z0-9])(?:PIN|OTP|CVV|CVC|MFA|TOTP)|(?<=[a-z0-9])(?:Pin|Otp|Cvv|Cvc|Passcode|Mfa|Totp))(?:_?(?:CODE|Code|NUMBER|Number))?(?:\\{0,3}["'])?\s*[=:]\s*(?:\\{0,3}["'])?[^\s"']{0,63}?\d/,
  // A one-time-password seed is base32 and may hold no digit (`TOTP=JBSWYDPEHPKBPXPQ`): sixteen to 128 uppercase
  // base32 letters, or groups of four (`JBSW YDPE HPKB PXPQ`, as providers show them), under an OTP key, quoted as in
  // JSON or not. Case-sensitive on the value, so `mfa: requiredforallusersnow` is not one; under a key that says
  // seed, secret or key (`otp_seed=`, `totp_key:`), a lowercase seed is one too.
  /(?<![A-Za-z])(?:[A-Za-z0-9]{1,32}[_-])?(?:mfa|MFA|Mfa|2fa|2FA|totp|TOTP|Totp|otp|OTP|Otp)(?:[_-]?(?:secret|SECRET|Secret|seed|SEED|Seed|key|KEY|Key))?(?:\\{0,3}["'])?\s*[=:]\s*(?:\\{0,3}["'])?(?:[A-Z2-7]{16,128}|[A-Z2-7]{4}(?:[ -][A-Z2-7]{4}){3,31})=*(?![A-Za-z0-9])/,
  /(?<![A-Za-z])(?:[A-Za-z0-9]{1,32}[_-])?(?:mfa|2fa|totp|otp)[_-]?(?:secret|seed|key)(?:\\{0,3}["'])?\s*[=:]\s*(?:\\{0,3}["'])?(?:[a-z2-7]{16,128}|[a-z2-7]{4}(?:[ -][a-z2-7]{4}){3,31})=*(?![a-z0-9])/i,
  /\bauthorization\s*:/i,
  /\bbearer\s+\S{8,}/i,
  /\b(?:mysql|mysqldump|mariadb)\b[^\n]{0,2000}\s-p(?:\s|\S)/i,
  /(?:^|\s)(?:-u|--user)\s+[^\s:]+:\S/,
  // A password may hold `/` and `:` (a generated base64 one often does); `host:port/path@x` is no login, so a port
  // followed by a path is not taken for one; the user may be empty (`redis://:pw@cache`). Both classes are bounded,
  // and the user part is disjoint from `:`.
  /[a-z][a-z0-9+.-]{0,30}:\/\/[^\s/:@]{0,512}:(?!\d{1,5}\/)[^\s@]{1,512}@/i,
  PRIVATE_KEY,
  /\bAGE-SECRET-KEY-1[0-9A-Z]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,})/,
  // As credential-scrub.ts CREDENTIAL_SHAPES: GitLab, Google API, Stripe, npm and Hugging Face tokens.
  /\b(?:glpat-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{35}|[sr]k_(?:live|test)_[A-Za-z0-9]{16,}|npm_[A-Za-z0-9]{36}|hf_[A-Za-z]{30,})/,
];

/** Whether `text` (a command, or a tool result's failure signature) carries a credential shape. */
export function containsSecret(text: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

/** The command text a record may carry: the original, or `<redacted>` when it holds a secret. */
export function redactCommand(command: string): string;
export function redactCommand(command: string | undefined): string | undefined;
export function redactCommand(command: string | undefined): string | undefined {
  return command !== undefined && containsSecret(command) ? REDACTED_COMMAND : command;
}

/** The dedupe key: whitespace-normalized text. The record keeps the original text. */
export function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

// --- merge ---------------------------------------------------------------------------------------

function idNumber(id: string): number {
  const match = /^C(\d+)$/.exec(id);
  return match ? Number(match[1]) : 0;
}

/** Key a carried record can be matched under; a truncated record matches on its kept prefix. */
function matchKey(record: CommandRecord): string {
  const normalized = normalizeCommand(record.command);
  return record.truncated && normalized.endsWith("...") ? normalized.slice(0, -3) : normalized;
}

function findRecord(records: CommandRecord[], normalized: string): CommandRecord | undefined {
  return records.find((record) => (record.truncated ? normalized.startsWith(matchKey(record)) : matchKey(record) === normalized));
}

function absorbRun(record: CommandRecord, run: ObservedRun, pass: number): void {
  const failedBefore = typeof record.lastExitCode === "number" && record.lastExitCode !== 0;
  record.runs += 1;
  if (failedBefore && run.exitCode === 0) record.failedThenSucceeded = true;
  record.lastExitCode = run.exitCode;
  record.lastSeenPass = pass;
  const ranAt = isoOf(run.at);
  if (ranAt) record.lastRanAt = ranAt;
}

/** The widest epoch-ms a Date can hold; toISOString throws beyond it, and a transcript may carry anything (security.md T1). */
const MAX_DATE_MS = 8.64e15;
const isoOf = (at: number | undefined): string | undefined => (at === undefined || !(Math.abs(at) <= MAX_DATE_MS) ? undefined : new Date(at).toISOString());

/**
 * The carried records plus this pass's runs: a run of a known command (same normalized text) bumps
 * its record, a new command gets the next id after the highest ever issued, and a run whose text
 * carries a secret is recorded as `<redacted>`. Records are copied, never mutated in place.
 */
export function mergeRuns(previous: CommandRecord[], runs: ObservedRun[], pass: number): CommandRecord[] {
  const records = previous.map((record) => ({ ...record }));
  let nextId = records.reduce((max, record) => Math.max(max, idNumber(record.id)), 0) + 1;
  for (const run of runs) {
    const text = redactCommand(run.command);
    const normalized = normalizeCommand(text);
    if (normalized === "") continue;
    const existing = findRecord(records, normalized);
    if (existing) {
      absorbRun(existing, run, pass);
      continue;
    }
    const ranAt = isoOf(run.at);
    records.push({ id: `C${nextId++}`, command: text, runs: 1, lastExitCode: run.exitCode, failedThenSucceeded: false, lastSeenPass: pass, ...(ranAt ? { lastRanAt: ranAt } : {}) });
  }
  return records;
}

// --- ranking -------------------------------------------------------------------------------------

const TRIVIAL_RE = /^(?:(?:ls|pwd|cd|git status)(?:\s+[^\s|&;<>$`]+)*|cat\s+[^\s|&;<>$`]+)$/;
const COMPLEX_RE = /\||<<|\bxargs\b|\bjq\b|\bawk\b|\bsed\s+-i\b|\bfind\b.*-exec\b/;

export function isTrivialCommand(command: string): boolean {
  return TRIVIAL_RE.test(normalizeCommand(command));
}

function isComplexCommand(command: string): boolean {
  return command.length > 80 || COMPLEX_RE.test(command);
}

/**
 * The score: +3 failed-then-succeeded, +2 per run beyond the first (max +6), +2 for a long or
 * piped command, -1 per pass since last seen. A trivial command (`ls`, `cat <file>`, `cd`, `pwd`,
 * `git status`) ranks under all others.
 */
export function scoreCommand(record: CommandRecord, pass: number): number {
  if (record.command === REDACTED_COMMAND) return 0;
  if (isTrivialCommand(record.command)) return TRIVIAL_SCORE;
  let score = 0;
  if (record.failedThenSucceeded) score += 3;
  score += Math.min(6, 2 * (record.runs - 1));
  if (isComplexCommand(record.command)) score += 2;
  score -= Math.max(0, pass - record.lastSeenPass);
  return score;
}

/** Records in rank order (highest score first; among equals the most recent id first). */
export function rankCommands(records: CommandRecord[], pass: number): CommandRecord[] {
  const scored = records.map((record) => ({ record, score: scoreCommand(record, pass) }));
  scored.sort((a, b) => b.score - a.score || idNumber(b.record.id) - idNumber(a.record.id));
  return scored.map((entry) => entry.record);
}

/** Records in id order, for rendering and storage. */
export function sortById(records: CommandRecord[]): CommandRecord[] {
  return [...records].sort((a, b) => idNumber(a.id) - idNumber(b.id));
}
