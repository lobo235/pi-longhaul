/**
 * The Longhaul config (CONTEXT.md): `longhaul.json` in pi's agent dir (config.example.json documents every key),
 * read fresh on every compaction so an edit needs no restart. Every key is optional and falls back per key; a
 * malformed file is the defaults.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import type { KeptWindowThinking } from "./kept-window.ts";
import { DEFAULT_NARRATIVE_POLICY, resolveNarrativePolicy, type NarrativePolicy } from "./narrative/policy.ts";
import { resolveConfiguredRouteHealth, resolveSummarizationRoute, type ResolvedSummarizationRoute } from "./narrative/route-config.ts";
import type { RouteHealthConfig } from "./narrative/route-health.ts";
import { resolveConfigFileModelSpec } from "./narrative/routing.ts";
import { resolveSummarizerHeaders, type SummarizerHeaders } from "./narrative/summarizer-headers.ts";
import { DEFAULT_TURNS_POLICY, resolveTurnsPolicy, type TurnsPolicy } from "./narrative/turns/policy.ts";
import { DEFAULT_CAPS, type Caps } from "./store/events.ts";
import { DEFAULT_NEAR_DUPLICATE_THRESHOLD } from "./store/near-duplicate.ts";
import { DEFAULT_CLAIM_PATTERNS, type ClaimKind, type ClaimPattern } from "./world.ts";

export const CONFIG_FILE_NAME = "longhaul.json";

export const configPath = (agentDir: string = getAgentDir()): string => path.join(agentDir, CONFIG_FILE_NAME);
export const MODEL_ENV = "PI_COMPACT_STATE_MODEL";

export interface ColdSliceCaps { commands: number; errors: number; commandChars: number }
export const DEFAULT_COLD_SLICE_CAPS: ColdSliceCaps = { commands: 200, errors: 50, commandChars: 300 };
export const DEFAULT_REMEMBER_PER_SPAN = 10;
export { DEFAULT_NEAR_DUPLICATE_THRESHOLD };

export interface StateConfig {
  caps: Caps;
  claimPatterns: ClaimPattern[];
  rememberPerSpan: number;
  coldSliceCaps: ColdSliceCaps;
  nearDuplicateThreshold: number;
  narrativePolicy: NarrativePolicy;
  /**
   * `single` = one diff call (narrative/run.ts, the default); `turns` = the section turns (narrative/turns/run.ts);
   * `warm` = the single call over the session's own request (narrative/warm.ts), `single` when no base is given or it does not fit.
   */
  narrativeMode: "single" | "turns" | "warm";
  narrativeTurns: TurnsPolicy;
  routeHealth: RouteHealthConfig;
  modelSpec?: string;
  /** Providers whose sessions may use a Summarizer route (CONTEXT.md *Route provider*); matched by exact name. */
  routeProviders: string[];
  /** Directories whose sessions never use a Summarizer route (CONTEXT.md *Local-only root*). */
  localOnlyRoots: string[];
  /** Extra headers on the compaction's own model calls, per provider (narrative/summarizer-headers.ts). */
  summarizerHeaders: SummarizerHeaders;
  /** Kept-window thinking (kept-window.ts): unset strips only on a verified API. */
  keptWindowThinking?: KeptWindowThinking;
}

export type ReadFileFn = () => string | undefined;

/**
 * The Longhaul config's text, or undefined when there is none. Reads `PI_CODING_AGENT_DIR` through pi on every call.
 * pi has no extension-settings API (only `registerFlag`, which still has to be typed), so this file is what makes
 * a setting durable. Config problems are never fatal: a missing, unreadable or malformed file means the defaults.
 */
export function readConfigFile(agentDir: string = getAgentDir()): string | undefined {
  try {
    return readFileSync(configPath(agentDir), "utf8");
  } catch {
    return undefined;
  }
}

const CAP_FLOORS: Record<keyof Caps, number> = { hardChars: 2000, objectiveQuoteChars: 40, corrections: 1, correctionChars: 40, decisions: 1, deadEnds: 1, itemChars: 40, workLogLines: 1, openErrors: 0, worldChars: 200, filesChars: 0, learnedChars: 0 };
const CLAIM_KINDS: ReadonlySet<string> = new Set<ClaimKind>(["test", "build", "lint", "custom"]);

function parseObject(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function numberIn(value: unknown, fallback: number, min: number, max: number, integer = true): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) return fallback;
  return integer && !Number.isInteger(value) ? fallback : value;
}

function mergeCaps(raw: unknown): Caps {
  const source = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const caps = { ...DEFAULT_CAPS };
  for (const key of Object.keys(DEFAULT_CAPS) as Array<keyof Caps>) caps[key] = numberIn(source[key], DEFAULT_CAPS[key], CAP_FLOORS[key], 1_000_000);
  return caps;
}

function claimPatternsOf(raw: unknown): ClaimPattern[] {
  if (!Array.isArray(raw) || raw.length === 0) return DEFAULT_CLAIM_PATTERNS;
  const patterns: ClaimPattern[] = [];
  for (const item of raw) {
    const candidate = item as { pattern?: unknown; kind?: unknown };
    if (typeof candidate?.pattern !== "string" || !candidate.pattern.trim() || typeof candidate.kind !== "string" || !CLAIM_KINDS.has(candidate.kind)) return DEFAULT_CLAIM_PATTERNS;
    patterns.push({ pattern: candidate.pattern.trim(), kind: candidate.kind as ClaimKind });
  }
  return patterns;
}

function coldSliceCapsOf(raw: unknown): ColdSliceCaps {
  const source = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  return {
    commands: numberIn(source.commands, DEFAULT_COLD_SLICE_CAPS.commands, 1, 5000),
    errors: numberIn(source.errors, DEFAULT_COLD_SLICE_CAPS.errors, 1, 5000),
    commandChars: numberIn(source.commandChars, DEFAULT_COLD_SLICE_CAPS.commandChars, 40, 10_000),
  };
}

/** The non-empty string entries of a list, trimmed; anything else is dropped, and a non-list is none. */
function namesOf(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => (typeof item === "string" && item.trim() ? [item.trim()] : []));
}

export function resolveStateConfig(readConfig: ReadFileFn): StateConfig {
  const source = parseObject(readConfig());
  return {
    caps: mergeCaps(source.caps),
    claimPatterns: claimPatternsOf(source.claimPatterns),
    rememberPerSpan: numberIn(source.rememberPerSpan, DEFAULT_REMEMBER_PER_SPAN, 1, 50),
    coldSliceCaps: coldSliceCapsOf(source.coldSliceCaps),
    nearDuplicateThreshold: numberIn(source.nearDuplicateThreshold, DEFAULT_NEAR_DUPLICATE_THRESHOLD, 0.5, 1, false),
    narrativePolicy: source.narrativePolicy === undefined ? DEFAULT_NARRATIVE_POLICY : resolveNarrativePolicy(source.narrativePolicy),
    narrativeMode: source.narrativeMode === "turns" || source.narrativeMode === "warm" ? source.narrativeMode : "single",
    narrativeTurns: source.narrativeTurns === undefined ? DEFAULT_TURNS_POLICY : resolveTurnsPolicy(source.narrativeTurns),
    routeHealth: resolveConfiguredRouteHealth(source),
    modelSpec: resolveConfigFileModelSpec(source),
    routeProviders: namesOf(source.routeProviders),
    localOnlyRoots: namesOf(source.localOnlyRoots),
    summarizerHeaders: resolveSummarizerHeaders(source.summarizerHeaders),
    ...(source.keptWindowThinking === "strip" || source.keptWindowThinking === "keep" ? { keptWindowThinking: source.keptWindowThinking } : {}),
  };
}

export function resolveNarrativeRoute(input: { env: NodeJS.ProcessEnv; config: StateConfig; cwd: string | undefined }): ResolvedSummarizationRoute {
  return resolveSummarizationRoute({ envSpec: input.env[MODEL_ENV], configSpec: input.config.modelSpec, cwd: input.cwd, localOnlyRoots: input.config.localOnlyRoots });
}

/**
 * Warm mode is scorer-only: a live session supplies no base request, so the pass runs the single call.
 * The once-per-session warning keeps a config that asks for warm from reading as warm mode running.
 */
export function warmModeNotice(config: StateConfig): string | undefined {
  if (config.narrativeMode !== "warm") return undefined;
  return 'longhaul: narrativeMode "warm" is scorer-only; this session has no base request, so compactions run the single call';
}
