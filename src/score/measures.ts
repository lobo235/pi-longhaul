/**
 * The five offline measures of the paired replay (docs/evaluation.md): need coverage over the
 * next k assistant messages, correction retention, objective stability, claim correctness against
 * the ledger, rendered size. Pure functions over recorded transcripts and rendered summaries.
 */
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import { goalObjectiveOf, normalizeWs } from "../intent.ts";
import type { CommandRecord } from "../ledger/handoff.ts";
import { normalizeCommand } from "../ledger/handoff-commands.ts";
import type { Claim } from "../world.ts";
import type { FactCoverage } from "./facts.ts";
import type { LabeledMeasures } from "./labels.ts";

export interface NeedWindow { filesRead: string[]; commandsRun: string[] }

const FILE_TOOLS: ReadonlySet<string> = new Set(["read", "write", "edit", "multi_edit", "notebook_edit"]);

export function needWindow(entriesAfter: SessionEntry[], k = 10): NeedWindow {
  const filesRead = new Set<string>();
  const commandsRun = new Set<string>();
  let assistants = 0;
  for (const entry of entriesAfter) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    if (++assistants > k) break;
    for (const block of Array.isArray(entry.message.content) ? entry.message.content : []) {
      if (block.type !== "toolCall") continue;
      const call = block as { name: string; arguments?: Record<string, unknown> };
      if (FILE_TOOLS.has(call.name) && typeof call.arguments?.path === "string") filesRead.add(call.arguments.path);
      if (call.name === "bash" && typeof call.arguments?.command === "string") commandsRun.add(normalizeCommand(call.arguments.command));
    }
  }
  return { filesRead: [...filesRead], commandsRun: [...commandsRun] };
}

const shareOf = (numerator: number, denominator: number): number | null => (denominator === 0 ? null : numerator / denominator);

export function needCoverage(window: NeedWindow, rendered: string, recallable: (needle: string) => boolean): { covered: number; total: number; share: number | null; missed: string[] } {
  const needs = [...window.filesRead, ...window.commandsRun];
  const missed = needs.filter((need) => !rendered.includes(need) && !recallable(need));
  return { covered: needs.length - missed.length, total: needs.length, share: shareOf(needs.length - missed.length, needs.length), missed };
}

/**
 * Name-level needs: what the next k assistant messages touched, by basename. The verbatim measure
 * above asks for the exact normalised command, which a multi-line script never matches in any
 * summary; a name is what a resumed agent actually needs to find again.
 */
export interface NameNeeds { files: string[]; artifacts: string[] }

const PATHISH = /(?:~|\.{0,2})?\/?[\w.@-]+(?:\/[\w.@-]+)*\.[A-Za-z0-9]{1,6}\b|(?:~|\.)?\/[\w.@-]+(?:\/[\w.@-]+)+/g;
const basename = (value: string): string => value.replace(/\/+$/, "").split("/").pop() ?? value;

export function nameNeeds(entriesAfter: SessionEntry[], k = 10): NameNeeds {
  const files = new Set<string>();
  const artifacts = new Set<string>();
  let assistants = 0;
  for (const entry of entriesAfter) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    if (++assistants > k) break;
    for (const block of Array.isArray(entry.message.content) ? entry.message.content : []) {
      if (block.type !== "toolCall") continue;
      const call = block as { name: string; arguments?: Record<string, unknown> };
      if (FILE_TOOLS.has(call.name) && typeof call.arguments?.path === "string") files.add(basename(call.arguments.path));
      if (call.name !== "bash" || typeof call.arguments?.command !== "string") continue;
      for (const match of call.arguments.command.matchAll(PATHISH)) {
        const name = basename(match[0]);
        if (name.length >= 4 && name.includes(".")) artifacts.add(name);
      }
    }
  }
  return { files: [...files], artifacts: [...artifacts].filter((name) => !files.has(name)) };
}

export function nameCoverage(names: string[], rendered: string, recallable: (needle: string) => boolean): { covered: number; total: number; share: number | null; missed: string[] } {
  const missed = names.filter((name) => !rendered.includes(name) && !recallable(name));
  return { covered: names.length - missed.length, total: names.length, share: shareOf(names.length - missed.length, names.length), missed };
}

export const CORRECTION_RE = /\b(never|always|don'?t|do not|must|stop)\b/i;
/** Longer than this, a user message is a paste (a document, a log), not a standing rule. */
export const CORRECTION_MAX_CHARS = 2000;

/** The words the user wrote: inside a /goal-mode message only the objective is theirs, the rest is pi's template. */
const ownWords = (text: string): string => goalObjectiveOf(text) ?? text;

export function userCorrections(spanUserTexts: string[]): string[] {
  return spanUserTexts.map(ownWords).filter((text) => {
    const length = normalizeWs(text).length;
    return CORRECTION_RE.test(text) && length >= 12 && length <= CORRECTION_MAX_CHARS;
  });
}

/** Corrections from user messages on the branch before this span: the ones only a carried state or summary still holds. */
export function earlierCorrections(pathUserTexts: string[], spanUserTexts: string[]): string[] {
  const inSpan = new Set(spanUserTexts);
  return userCorrections(pathUserTexts.filter((text) => !inSpan.has(text)));
}

const WINDOW = 12;

function retained(correction: string, rendered: string): boolean {
  const needle = normalizeWs(correction);
  const hay = normalizeWs(rendered);
  for (let start = 0; start + WINDOW <= needle.length; start++) if (hay.includes(needle.slice(start, start + WINDOW))) return true;
  return false;
}

/** The state's corrections section, and other compactors' Constraints & Preferences and User Corrections. */
const RULE_HEADING_RE = /^## (Constraints\b|User Corrections\b)/i;

/**
 * Only the sections that carry rules, joined. A correction counts as kept only when one of these holds it: a rule
 * that survives only as a phrase in a log line or a progress note is not one the next turn will treat as a rule.
 */
export function ruleSections(rendered: string): string {
  const kept: string[] = [];
  let inRules = false;
  for (const line of rendered.split("\n")) {
    if (line.startsWith("## ")) inRules = RULE_HEADING_RE.test(line);
    if (inRules && line.trim()) kept.push(line);
  }
  return kept.join("\n");
}

export interface CorrectionRetention {
  retained: number;
  total: number;
  share: number | null;
  missed: string[];
  /** Absent on rows from before it existed. */
  kept?: string[];
}

export function correctionRetention(corrections: string[], rendered: string): CorrectionRetention & { kept: string[] } {
  const missed = corrections.filter((correction) => !retained(correction, rendered));
  const kept = corrections.filter((correction) => retained(correction, rendered));
  return { retained: kept.length, total: corrections.length, share: shareOf(kept.length, corrections.length), missed, kept };
}

/**
 * How the objective changed between two compactions, judged by the message it quotes: the same message in other
 * words is no move. A move to an earlier message is `back`, apart from a move forward to the user's next request.
 */
export function objectiveStability(previous: ObjectiveRef | undefined, current: ObjectiveRef | undefined): "stable" | "moved" | "back" | "set" | "none" {
  if (!previous && !current) return "none";
  if (!previous) return "set";
  if (!current) return "moved";
  if (previous.messageId === current.messageId) return "stable";
  return ordinalNumber(current.ordinal) < ordinalNumber(previous.ordinal) ? "back" : "moved";
}

type ObjectiveRef = { messageId: string; ordinal: string };
const ordinalNumber = (ordinal: string) => Number(/^u(\d+)$/.exec(ordinal)?.[1] ?? Number.NaN);

export function claimCorrectness(claims: Claim[], commands: CommandRecord[]): { correct: number; total: number; wrong: Array<{ commandRef: string; claimed: number | null; ledger?: number | null }> } {
  const byId = new Map(commands.map((record) => [record.id, record]));
  const wrong = claims.flatMap((claim) => {
    const record = byId.get(claim.commandRef);
    return record && record.lastExitCode === claim.exitCode ? [] : [{ commandRef: claim.commandRef, claimed: claim.exitCode, ledger: record?.lastExitCode }];
  });
  return { correct: claims.length - wrong.length, total: claims.length, wrong };
}

/**
 * `text` without the section whose heading line starts with `heading`: from that line up to the next `## ` heading or the
 * recall hint. Pairs a section's arm with the same compaction minus that section, so the model's narrative is held fixed.
 */
export function withoutSection(text: string, heading: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.startsWith(heading));
  if (start < 0) return text;
  const after = lines.findIndex((line, index) => index > start && (line.startsWith("## ") || line.startsWith("recall: ")));
  return [...lines.slice(0, start), ...(after < 0 ? [] : lines.slice(after))].join("\n");
}

/** The published arms, in run order (state-unlearned is derived from state, so it follows it). A harness may add its own. */
export const SCORE_ARMS = ["state", "state-unlearned", "state-turns", "state-warm", "pi-default"] as const;
export type ScoreArm = (typeof SCORE_ARMS)[number];

export interface ScoreRow {
  /**
   * state-turns = the state compactor with narrativeMode turns (narrative/turns/);
   * state-warm = narrativeMode warm (narrative/warm.ts), the session's own request plus one instruction;
   * state-unlearned = the state arm's own result with its Learned values section cut out (withoutSection), no model call of its own;
   * pi-default = pi's own compaction (`compact()`), the baseline. A ScoreArm, or an arm a harness adds.
   */
  arm: string;
  at: string;
  session: string;
  renderedChars: number;
  need: ReturnType<typeof needCoverage>;
  corrections: CorrectionRetention;
  objective: ReturnType<typeof objectiveStability> | null;
  claims: ReturnType<typeof claimCorrectness> | null;
  coverageAtCap?: Record<string, number | null>;
  /** Name-level need coverage (nameNeeds); absent on rows from before it existed. */
  names?: { files: ReturnType<typeof nameCoverage>; artifacts: ReturnType<typeof nameCoverage> };
  earlierCorrections?: CorrectionRetention;
  /** Prompt and output tokens over the arm's model calls; absent when the provider reported none, and on derived arms. */
  tokens?: { input: number; output: number };
  /** Wall time of the arm's compaction; absent on rows from before it was recorded. */
  durationMs?: number;
  /** Learned facts (facts.ts): values from the span's tool output the session used again, kept in the rendered text. */
  facts?: FactCoverage;
  /** Reused values (facts.ts factNeeds includeSaid): tool-output values, the span's own uses included, that the next turns need again; no code names (facts.ts isCodeNameFact). */
  reused?: FactCoverage;
  /** The continuation probe (probe.ts), with SCORE_PROBE=1: the next span's names the resumed model planned to touch. */
  probe?: { hit: number; total: number; share: number | null; targets: number; onTarget: number; parsed: boolean };
  /** state-warm: whether the narrative call actually went warm (false = the base did not fit and the re-encoded call ran). */
  warm?: boolean;
  /** state-warm: prompt tokens of its warm calls, and how many of them the server read from its prefix cache. */
  warmTokens?: { cacheRead: number; prompt: number };
  /** state-warm: the priming request's wall time (warm-prime.ts), kept out of durationMs. */
  primeMs?: number;
  /** The labeled measures (labels.ts), when the session has labels. */
  labeled?: LabeledMeasures;
}

export type ArmSummary = { n: number; renderedChars: number; needShare: number | null; correctionShare: number | null; objectiveMoved: number; objectiveBack: number; claimWrong: number; fileShare: number | null; artifactShare: number | null; earlierCorrectionShare: number | null; earlierCorrectionsDistinct: { n: number; share: number | null }; durationP50Ms: number | null; durationP90Ms: number | null; probeShare: number | null; probePlanned: number | null; probePrecision: number | null; factShare: number | null; factRecallShare: number | null; reusedShare: number | null; warmShare: number | null; warmCached: number | null; inputTokens: number | null; outputTokens: number | null };

/** Nearest-rank percentile; null with no values. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

/** covered / total summed over the rows that carry the measure; null when none had a denominator. */
function pooled(parts: Array<{ hit: number; total: number } | undefined>): number | null {
  const present = parts.filter((part): part is { hit: number; total: number } => part !== undefined);
  const total = present.reduce((sum, part) => sum + part.total, 0);
  return total === 0 ? null : present.reduce((sum, part) => sum + part.hit, 0) / total;
}

function mean(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length === 0 ? null : present.reduce((sum, value) => sum + value, 0) / present.length;
}

/**
 * Per distinct correction (session + words): the share of the compactions it was due at that kept it, averaged.
 * Pooled shares let one rule due at fifteen compactions of one session decide the result; this does not.
 * Rows from before `kept` existed carry no list and are left out.
 */
function distinctCorrectionShare(rows: ScoreRow[]): { n: number; share: number | null } {
  const byRule = new Map<string, { kept: number; due: number }>();
  for (const row of rows) {
    const measure = row.earlierCorrections;
    if (!measure?.kept) continue;
    for (const [text, wasKept] of [...measure.kept.map((t) => [t, true] as const), ...measure.missed.map((t) => [t, false] as const)]) {
      const key = `${row.session}\u0000${normalizeWs(text)}`;
      const tally = byRule.get(key) ?? { kept: 0, due: 0 };
      tally.due++;
      if (wasKept) tally.kept++;
      byRule.set(key, tally);
    }
  }
  return { n: byRule.size, share: mean([...byRule.values()].map((tally) => tally.kept / tally.due)) };
}

export function summarize(rows: ScoreRow[], arms: readonly string[] = SCORE_ARMS): Record<string, ArmSummary> {
  const arm = (name: string): ArmSummary => {
    const own = rows.filter((row) => row.arm === name);
    const durations = own.flatMap((row) => (row.durationMs === undefined ? [] : [row.durationMs]));
    return {
      n: own.length,
      renderedChars: own.length ? Math.round(own.reduce((sum, row) => sum + row.renderedChars, 0) / own.length) : 0,
      needShare: mean(own.map((row) => row.need.share)),
      correctionShare: mean(own.map((row) => row.corrections.share)),
      objectiveMoved: own.filter((row) => row.objective === "moved" || row.objective === "back").length,
      objectiveBack: own.filter((row) => row.objective === "back").length,
      claimWrong: own.reduce((sum, row) => sum + (row.claims?.wrong.length ?? 0), 0),
      fileShare: pooled(own.map((row) => row.names && { hit: row.names.files.covered, total: row.names.files.total })),
      artifactShare: pooled(own.map((row) => row.names && { hit: row.names.artifacts.covered, total: row.names.artifacts.total })),
      earlierCorrectionShare: pooled(own.map((row) => row.earlierCorrections && { hit: row.earlierCorrections.retained, total: row.earlierCorrections.total })),
      earlierCorrectionsDistinct: distinctCorrectionShare(own),
      durationP50Ms: percentile(durations, 50),
      durationP90Ms: percentile(durations, 90),
      probeShare: pooled(own.map((row) => row.probe)),
      probePlanned: mean(own.flatMap((row) => (row.probe ? [row.probe.parsed ? 1 : 0] : []))),
      probePrecision: pooled(own.map((row) => row.probe && { hit: row.probe.onTarget, total: row.probe.targets })),
      factShare: pooled(own.map((row) => row.facts && { hit: row.facts.kept, total: row.facts.total })),
      // Rows written before keptWithRecall existed count their text-only figure.
      factRecallShare: pooled(own.map((row) => row.facts && { hit: row.facts.keptWithRecall ?? row.facts.kept, total: row.facts.total })),
      reusedShare: pooled(own.map((row) => row.reused && { hit: row.reused.kept, total: row.reused.total })),
      warmShare: mean(own.flatMap((row) => (row.warm === undefined ? [] : [row.warm ? 1 : 0]))),
      warmCached: pooled(own.map((row) => row.warmTokens && { hit: row.warmTokens.cacheRead, total: row.warmTokens.prompt })),
      inputTokens: mean(own.map((row) => row.tokens?.input ?? null)),
      outputTokens: mean(own.map((row) => row.tokens?.output ?? null)),
    };
  };
  return Object.fromEntries(arms.map((name) => [name, arm(name)]));
}
