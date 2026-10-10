/**
 * Fact shapes: the value forms a session learns from tool output and goes on to use -- a uuid, a version, a
 * path, a commit or other hash, a long number, a compound identifier. Shared by the learned-facts probe
 * (score/facts.ts, which compares paths by basename) and the Learned values section (learned.ts, which copies
 * values verbatim), so the section and the probe that judges it never disagree about what a fact looks like.
 */
export type FactKind = "uuid" | "version" | "path" | "hash" | "number" | "identifier";

export interface FactMatch {
  /** The value exactly as it appears in the text. */
  raw: string;
  kind: FactKind;
}

/** In priority order: a value matched by an earlier kind is blanked before the later kinds look. */
const KINDS: Array<[FactKind, RegExp]> = [
  ["uuid", /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi],
  // Never a piece of a longer dotted number: 127.0.0.1 is an address, 2.14.0.7 a four-part build, not 127.0.0 or 2.14.0.
  ["version", /(?<![\d.])\bv?\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?\b(?!\.\d)/g],
  // Anchored on the left and bounded, so a long dotless run costs one attempt, not one per position (security.md T4).
  // A <placeholder> is one segment character, so a name format ("<source-basename>-YYYYMMDD.tar.gz") is one value.
  ["path", /(?<![\w.@/<>-])\/?(?:(?:<[\w-]{1,30}>|[\w.@-]){1,255}\/){0,32}(?:<[\w-]{1,30}>|[\w@-])(?:<[\w-]{1,30}>|[\w.@-]){0,255}\.[A-Za-z][A-Za-z0-9]{0,5}\b/g],
  ["hash", /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/g],
  ["number", /\b\d{4,}\b/g],
  ["identifier", /\b[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+\b|\b[a-z]+(?:[A-Z][a-z0-9]*)+\b/g],
];
const IDENTIFIER_MIN = 8;
const isYear = (value: string) => /^(19|20)\d\d$/.test(value);
export const basename = (value: string) => value.split("/").pop() ?? value;

function accepted(kind: FactKind, raw: string): boolean {
  if (kind === "path") return basename(raw).length >= 4;
  if (kind === "number") return !isYear(raw);
  if (kind === "identifier") return raw.length >= IDENTIFIER_MIN;
  return true;
}

/** Every fact-shaped value in `text`, in kind priority order, repeats included. */
export function factMatches(text: string): FactMatch[] {
  const matches: FactMatch[] = [];
  let rest = text;
  for (const [kind, pattern] of KINDS) {
    rest = rest.replace(pattern, (raw) => {
      if (accepted(kind, raw)) matches.push({ raw, kind });
      return " ".repeat(raw.length);
    });
  }
  return matches;
}
