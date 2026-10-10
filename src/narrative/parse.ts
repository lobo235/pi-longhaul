/**
 * From the model's text to a validated NarrativeDiff, or a reason it is not one. The reasons are
 * the retry ladder's vocabulary: empty, truncated and invalid-json retry
 * the same prompt; wrong-type and schema retry with the field errors in a note.
 */
import { checkNarrativeDiff, NOW_ITEM_CHARS, NOW_ITEMS, REF_CHARS, type NarrativeDiff, type NotADiffReason } from "./types.ts";

export type ParseResult = { ok: true; diff: NarrativeDiff; prose: string } | { ok: false; reason: NotADiffReason; detail: string };

/**
 * The most of an answer the candidate search reads. The largest output budget any policy allows is 16,000 tokens,
 * and a token is rarely more than 4 characters, so 32 per token is 8x headroom: only a provider that ignored
 * maxTokens sends more, and the rest is not scanned (security.md T4).
 */
export const ANSWER_SCAN_CHARS = 16_000 * 32;

/** A fence opener after its backticks: an optional `json` tag, then blanks other than a line end, then the line end. */
const FENCE_OPENER_RE = /(?:json)?[^\S\n]*\n/y;

/**
 * The first fenced block: "```" (optionally "```json") ending its line, up to the first later line that starts,
 * after whitespace, with "```". An index scan, never a backtracking pattern: the regex this replaces was cubic on
 * an unclosed fence before a long run of line ends (security.md T4). If one opener has no closer, no later one can,
 * since its closer would close the earlier opener too, so the search stops there.
 */
function firstFence(text: string): { body: string; start: number; end: number } | undefined {
  for (let start = text.indexOf("```"); start >= 0; start = text.indexOf("```", start + 1)) {
    FENCE_OPENER_RE.lastIndex = start + 3;
    if (!FENCE_OPENER_RE.test(text)) continue;
    const bodyStart = FENCE_OPENER_RE.lastIndex;
    for (let newline = text.indexOf("\n", bodyStart); newline >= 0; ) {
      const next = text.indexOf("\n", newline + 1);
      const line = text.slice(newline + 1, next < 0 ? text.length : next);
      const indent = line.length - line.trimStart().length;
      if (line.startsWith("```", indent)) return { body: text.slice(bodyStart, newline), start, end: newline + 1 + indent + 3 };
      newline = next;
    }
    return undefined;
  }
  return undefined;
}

function outermostObject(text: string): { start: number; end: number } | undefined {
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return { start, end: i + 1 };
  }
  return undefined;
}

/**
 * Why an answer has no JSON candidate, by shape alone: no text, no `{`, a `{` whose object ends inside a string
 * (`open-string`: almost always an unescaped double quote, which flips every scanner's string state), or one that
 * ends outside a string with brackets still open (`unclosed`: a missing closer, or a cut answer).
 */
export type MissingJsonShape = "empty" | "no-brace" | "open-string" | "unclosed";

/** The brackets still open at the end of `json`, innermost last, and whether it ends inside a string. */
function openAtEnd(json: string): { open: string[]; inString: boolean } {
  const open: string[] = [];
  let inString = false;
  for (let i = 0; i < json.length; i++) {
    const ch = json[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === "\"") inString = false;
    } else if (ch === "\"") inString = true;
    else if (ch === "{" || ch === "[") open.push(ch);
    else if (ch === "}" || ch === "]") open.pop();
  }
  return { open, inString };
}

export function missingJsonShape(text: string): MissingJsonShape {
  if (text.trim() === "") return "empty";
  const start = text.indexOf("{");
  if (start < 0) return "no-brace";
  return openAtEnd(text.slice(start)).inString ? "open-string" : "unclosed";
}

/**
 * Appends the closers an answer left off, only when it ends on a closer itself — the model believed it was done
 * (2 of 6 Now answers in one replay stopped normally one `}` short). A cut answer ends mid-value and is never completed.
 */
function closedOuter(json: string): string | undefined {
  const trimmed = json.trimEnd().replace(/```$/, "").trimEnd();
  if (!/[}\]]$/.test(trimmed)) return undefined;
  const { open, inString } = openAtEnd(trimmed);
  if (inString || open.length === 0) return undefined;
  return trimmed + open.reverse().map((ch) => (ch === "{" ? "}" : "]")).join("");
}

/** Where a string sits decides what may follow its closing quote. */
type StringPlace = "key" | "value" | "item";

function placeOf(lastSignificant: string, open: string[]): StringPlace {
  if (lastSignificant === ":") return "value";
  return open.at(-1) === "{" ? "key" : "item";
}

/** The index of the first non-whitespace character at or after `from`, or the length when there is none. */
function skipSpace(json: string, from: number): number {
  let i = from;
  while (i < json.length && /\s/.test(json[i])) i++;
  return i;
}

/**
 * Whether a quote just before `from` can end a string in `place`: what follows must be the structure that
 * place allows. Index-based, never a slice or trim of the rest, so a scan stays linear (security.md T4).
 */
function canClose(place: StringPlace, json: string, from: number): boolean {
  const at = skipSpace(json, from);
  if (at === json.length) return true;
  const next = json[at];
  if (place === "key") return next === ":";
  if (next === (place === "value" ? "}" : "]")) return true;
  if (next !== ",") return false;
  const after = json[skipSpace(json, at + 1)];
  return place === "value" ? after === "\"" : after !== undefined && /["{[\d-]/.test(after);
}

/**
 * Escapes a double quote inside a string where the string's place (key, object value, array item) says it
 * cannot end: a model may write commands with bare quotes (`"resume": "edit "a.ts": then run "make check", then
 * commit"`), which flips every brace scanner. Only ever used when the text does not parse as written, and only
 * kept when the result does parse.
 */
export function escapeInnerQuotes(json: string): string {
  let out = "";
  let inString = false;
  let place: StringPlace = "key";
  let lastSignificant = "";
  const open: string[] = [];
  for (let i = 0; i < json.length; i++) {
    const ch = json[i];
    if (inString) {
      if (ch === "\\") { out += ch + (json[i + 1] ?? ""); i++; continue; }
      if (ch !== "\"") { out += ch; continue; }
      if (canClose(place, json, i + 1)) { inString = false; lastSignificant = ch; out += ch; } else out += "\\\"";
      continue;
    }
    if (ch === "\"") { place = placeOf(lastSignificant, open); inString = true; }
    else if (ch === "{" || ch === "[") open.push(ch);
    else if (ch === "}" || ch === "]") open.pop();
    if (!/\s/.test(ch)) lastSignificant = ch;
    out += ch;
  }
  return out;
}

const parses = (json: string): boolean => {
  try {
    JSON.parse(json);
    return true;
  } catch {
    return false;
  }
};

/** Drops a comma that only precedes a closer (`[1,]`, `{"a": 1,}`), outside strings; JSON allows none. */
function withoutTrailingCommas(json: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < json.length; i++) {
    const ch = json[i];
    if (inString) {
      if (ch === "\\") { out += ch + (json[i + 1] ?? ""); i++; continue; }
      if (ch === "\"") inString = false;
    } else if (ch === "\"") inString = true;
    else if (ch === "," && /^\s*[}\]]/.test(json.slice(i + 1))) continue;
    out += ch;
  }
  return out;
}

/** The repairs to try, cheapest first; each is kept only when it is what makes the candidate parse. */
function repairsOf(json: string): string[] {
  const escaped = escapeInnerQuotes(json);
  const bases = [json, escaped, withoutTrailingCommas(json), withoutTrailingCommas(escaped)];
  return [...bases, ...bases.map(closedOuter).filter((candidate): candidate is string => candidate !== undefined)];
}

/** The candidate as written when it parses, else the first repair that parses, else as written. */
function repaired(json: string): string {
  return parses(json) ? json : (repairsOf(json).find(parses) ?? json);
}

/**
 * The candidate JSON in an answer's first ANSWER_SCAN_CHARS: the first fenced block, else the outermost `{...}`,
 * else the whole trimmed text when that is itself valid JSON — a bare array, string or `null` is a candidate so the
 * ladder can call it `wrong-type` rather than `invalid-json`.
 */
export function extractJsonCandidate(answer: string): { json: string; prose: string } | undefined {
  const text = answer.length > ANSWER_SCAN_CHARS ? answer.slice(0, ANSWER_SCAN_CHARS) : answer;
  const fence = firstFence(text);
  if (fence) return { json: repaired(fence.body.trim()), prose: (text.slice(0, fence.start) + text.slice(fence.end)).trim() };
  const span = outermostObject(text);
  if (span) return { json: repaired(text.slice(span.start, span.end)), prose: (text.slice(0, span.start) + text.slice(span.end)).trim() };
  const start = text.indexOf("{");
  if (start >= 0) {
    const escaped = escapeInnerQuotes(text.slice(start));
    const inner = outermostObject(escaped);
    if (inner && parses(escaped.slice(inner.start, inner.end))) return { json: escaped.slice(inner.start, inner.end), prose: text.slice(0, start).trim() };
    const fixed = repairsOf(text.slice(start)).find(parses);
    if (fixed) return { json: fixed, prose: text.slice(0, start).trim() };
  }
  const trimmed = text.trim();
  try {
    JSON.parse(trimmed);
    return { json: trimmed, prose: "" };
  } catch {
    return undefined;
  }
}

type Loose = Record<string, unknown>;
const isObject = (value: unknown): value is Loose => typeof value === "object" && value !== null && !Array.isArray(value);
const clip = (value: unknown): unknown => (typeof value === "string" && value.length > NOW_ITEM_CHARS ? `${value.slice(0, NOW_ITEM_CHARS - 1)}…` : value);
const listOf = (value: unknown): unknown => (value === undefined || value === null ? [] : value);

function withoutBadEvidence(item: unknown): unknown {
  if (!isObject(item)) return item;
  const { evidence, ...rest } = item;
  return typeof evidence === "string" && evidence.length > 0 && evidence.length <= REF_CHARS ? item : rest;
}

function normalizedNow(now: unknown): unknown {
  if (!isObject(now)) return now;
  const list = (value: unknown) => (Array.isArray(value) ? value.slice(0, NOW_ITEMS).map(clip) : listOf(value));
  return { ...now, inProgress: list(now.inProgress), next: list(now.next), blocked: list(now.blocked), resume: clip(now.resume ?? "") };
}

/**
 * Shape slips a model makes that say nothing about the content -- null for an absent optional, an
 * omitted empty list, a resume line or evidence pointer past its bound -- are folded into the
 * schema here, so the schema rejects only answers that are actually wrong. The bounds stay the
 * schema's own: a clipped Now item is still at most NOW_ITEM_CHARS (security.md T2).
 */
export function normalizeDiffShape(value: Loose): Loose {
  const out: Loose = { ...value };
  for (const key of ["corrections", "lifts", "decisions", "deadEnds"]) out[key] = listOf(out[key]);
  for (const key of ["decisions", "deadEnds"]) if (Array.isArray(out[key])) out[key] = (out[key] as unknown[]).map(withoutBadEvidence);
  if (out.objective === null) delete out.objective;
  if (isObject(out.objective) && out.objective.doneWhen === null) {
    const { doneWhen: _dropped, ...objective } = out.objective;
    out.objective = objective;
  }
  out.now = normalizedNow(out.now);
  // Labels in any other shape are dropped, not the answer: validation then asks for them by ordinal.
  if (out.labels !== undefined && !isObject(out.labels)) delete out.labels;
  if (out.values === null) delete out.values;
  return out;
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

export function parseNarrativeAnswer(text: string, stopReason?: string): ParseResult {
  if (text.trim() === "") return { ok: false, reason: "empty", detail: "no content in the answer" };
  const candidate = extractJsonCandidate(text);
  if (!candidate) {
    if (stopReason === "length") return { ok: false, reason: "truncated", detail: `stop reason length and no complete JSON object (${text.length} chars)` };
    return { ok: false, reason: "invalid-json", detail: "no JSON object in the answer" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate.json);
  } catch (error) {
    if (stopReason === "length") return { ok: false, reason: "truncated", detail: `stop reason length; JSON incomplete: ${(error as Error).message}` };
    return { ok: false, reason: "invalid-json", detail: (error as Error).message };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { ok: false, reason: "wrong-type", detail: `top level is ${describeType(parsed)}, expected an object` };
  const checked = checkNarrativeDiff(normalizeDiffShape(parsed as Loose));
  if (!checked.ok) return { ok: false, reason: "schema", detail: checked.errors.join("; ") };
  return { ok: true, diff: checked.diff, prose: candidate.prose };
}
