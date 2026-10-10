/** Recorded compactions as replay inputs: the branch before each compaction entry (what pi's prepareCompaction saw) and the entries after it (the need window). */
import fs from "node:fs";
import path from "node:path";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import { homeDirectory, localOnlyRootOf } from "../narrative/route-config.ts";
import { isRouteProvider } from "../narrative/routing.ts";
import type { SessionLabels } from "./labels.ts";

export interface Candidate {
  file: string;
  session: string;
  at: string;
  index: number;
  /** The recorded compaction entry's id: what a chained replay keys the arm's own compaction by (chain.ts). */
  entryId: string;
  pathEntries: SessionEntry[];
  after: SessionEntry[];
  spanUserTexts: string[];
  /** Every user text on the branch before the compaction, oldest first. */
  pathUserTexts: string[];
  /** The session's own directory, from the transcript header; undefined when the header names none. */
  cwd?: string;
  /** The compaction entry's recorded cut (recorded-cut.ts checks the replay against it); absent when it recorded none. */
  firstKeptEntryId?: string;
  /** The session's hand-written labels (labels.ts), when the label file has the session. */
  labels?: SessionLabels;
}

/** One recorded compaction's identity across runs: the transcript's basename and the entry's timestamp. */
export const candidateKey = (session: string, at: string): string => `${session}@${at}`;

/** A transcript larger than this is skipped whole rather than read into memory (security.md T1). */
export const MAX_TRANSCRIPT_BYTES = 512 * 1024 * 1024;

function parseTranscript(file: string): { entries: SessionEntry[]; cwd?: string } {
  const entries: SessionEntry[] = [];
  let cwd: string | undefined;
  if (fs.statSync(file).size > MAX_TRANSCRIPT_BYTES) return { entries };
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as { type?: string; id?: string; cwd?: unknown };
      if (parsed.type === "session") cwd ??= typeof parsed.cwd === "string" ? parsed.cwd : undefined;
      else if (typeof parsed.id === "string") entries.push(parsed as SessionEntry);
    } catch {
      // a malformed line is skipped, never fatal: transcripts are untrusted input
    }
  }
  return { entries, cwd };
}

export function readTranscript(file: string): SessionEntry[] {
  return parseTranscript(file).entries;
}

/** A transcript whose directory is unknown, empty or relative counts as local-only: the scorer's model may be remote, so it fails closed. */
const isLocalOnlyIn = (roots: readonly string[]) => (cwd: string | undefined): boolean => !cwd?.trim() || !path.isAbsolute(cwd.trim()) || localOnlyRootOf(cwd, roots, homeDirectory()) !== undefined;

export function pathTo(entries: SessionEntry[], leafId: string): SessionEntry[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const chain: SessionEntry[] = [];
  const seen = new Set<string>();
  // A parent cycle (untrusted bytes) ends the walk rather than looping (security.md T1).
  for (let current = byId.get(leafId); current && !seen.has(current.id); current = current.parentId ? byId.get(current.parentId) : undefined) {
    seen.add(current.id);
    chain.push(current);
  }
  return chain.reverse();
}

function userText(entry: SessionEntry): string | undefined {
  if (entry.type !== "message" || entry.message.role !== "user") return undefined;
  const content = entry.message.content;
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.filter((block) => block.type === "text").map((block) => (block as { text: string }).text).join("\n") : undefined;
}

function sessionModelProvider(entries: SessionEntry[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.type === "message" && entry.message.role === "assistant") return (entry.message as { provider?: string }).provider;
  }
  return undefined;
}

/** Why a run found nothing to score: no transcripts, transcripts without a compaction, or symlinks it does not follow. */
export function nothingToScore(dir: string): string {
  const found = listTranscripts(dir).length;
  let linked = 0;
  const walk = (current: string) => {
    for (const item of fs.readdirSync(current, { withFileTypes: true })) {
      if (item.isDirectory()) walk(path.join(current, item.name));
      else if (item.isSymbolicLink() && item.name.endsWith(".jsonl")) linked++;
    }
  };
  walk(dir);
  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
  const head = found === 0 ? `no transcripts (*.jsonl files) under ${dir}` : `${plural(found, "transcript")} under ${dir} ${found === 1 ? "has" : "have"} no compaction to replay (a session under a localOnlyRoots root is skipped unless SCORE_INCLUDE_LOCAL_ONLY=1)`;
  return linked ? `${head}; ${plural(linked, "symlinked transcript")} ${linked === 1 ? "was" : "were"} not followed; copy ${linked === 1 ? "it" : "them"} in instead` : head;
}

export function listTranscripts(dir: string): string[] {
  const files: string[] = [];
  const walk = (current: string) => {
    for (const item of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, item.name);
      if (item.isDirectory()) walk(full);
      else if (item.isFile() && item.name.endsWith(".jsonl")) files.push(full);
    }
  };
  walk(dir);
  return files;
}

export interface CandidateOptions {
  n: number;
  at?: string;
  /** Only sessions whose model's provider is named here, by exact name; absent = any model. */
  providers?: readonly string[];
  /** candidateKey values: replay exactly those compactions, whatever is newest now. */
  only?: ReadonlySet<string>;
  /** Replay sessions under a Local-only root too (their content may leave the machine). */
  includeLocalOnly?: boolean;
  /** The Longhaul config's `localOnlyRoots`, for the default local-only test; none when absent. */
  localOnlyRoots?: readonly string[];
  /** The local-only test; defaults to `localOnlyRoots`, and an unknown directory counts as local-only. */
  isLocalOnly?: (cwd: string | undefined) => boolean;
}

/** Every recorded compaction that matches, newest first; a local-only session is skipped unless `includeLocalOnly`. */
export function candidates(sessionsDir: string, options: CandidateOptions): Candidate[] {
  const found: Candidate[] = [];
  const isLocalOnly = options.isLocalOnly ?? isLocalOnlyIn(options.localOnlyRoots ?? []);
  for (const file of listTranscripts(sessionsDir)) {
    const { entries, cwd } = parseTranscript(file);
    const leaf = entries.at(-1);
    if (!leaf || (!options.includeLocalOnly && isLocalOnly(cwd))) continue;
    const branch = pathTo(entries, leaf.id);
    branch.forEach((entry, index) => {
      if (entry.type !== "compaction") return;
      if (options.at && !entry.timestamp.startsWith(options.at)) return;
      if (options.only && !options.only.has(candidateKey(path.basename(file, ".jsonl"), entry.timestamp))) return;
      const pathEntries = branch.slice(0, index);
      if (options.providers && !isRouteProvider(sessionModelProvider(pathEntries), options.providers)) return;
      const previous = pathEntries.map((candidate, at) => (candidate.type === "compaction" ? at : -1)).filter((at) => at >= 0).at(-1) ?? -1;
      found.push({ file, session: path.basename(file, ".jsonl"), at: entry.timestamp, index, entryId: entry.id, pathEntries, after: branch.slice(index + 1), spanUserTexts: pathEntries.slice(previous + 1).map(userText).filter((text): text is string => text !== undefined), pathUserTexts: pathEntries.map(userText).filter((text): text is string => text !== undefined), cwd,
        ...(typeof entry.firstKeptEntryId === "string" ? { firstKeptEntryId: entry.firstKeptEntryId } : {}) });
    });
  }
  return found.sort((a, b) => b.at.localeCompare(a.at)).slice(0, options.n);
}
