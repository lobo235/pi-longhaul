/** The scorer's knobs (`SCORE_*`), read once at start; a list or path that cannot be right stops the run before any call. */
import path from "node:path";

import { SCORE_ARMS, type ScoreArm } from "./measures.ts";

export interface ScoreOptions {
  /** The transcript store to replay. Required: nothing is read from pi's own store unless it is named. */
  sessions: string;
  out: string;
  arms: ScoreArm[];
  n: number;
  /** Only compactions whose timestamp starts with this. */
  at?: string;
  /** A previous run's rows.jsonl: replay exactly its compactions, so a before/after comparison is paired. */
  candidatesFrom?: string;
  caps: number[];
  probe: boolean;
  warmPrime: boolean;
  /** Replay sessions under a Local-only root too; their content then reaches the scorer's model. */
  includeLocalOnly: boolean;
  /** The keepRecentTokens the sessions were recorded with (SCORE_KEEP_RECENT_TOKENS); undefined = pi's default. */
  keepRecentTokens?: number;
  /** Each arm continues from its own earlier compactions (chain.ts); false = each compaction on its recorded path (SCORE_CHAIN=0). */
  chain: boolean;
  /** SCORE_LABELS: the label file (labels.ts); unset = `labels.json` in the sessions directory, when there is one. */
  labels?: string;
}

const DEFAULT_N = 10;
const DEFAULT_CAPS = [8000, 12000, 16000];

function armsOf(raw: string | undefined): ScoreArm[] {
  const named = (raw ?? "state,pi-default").split(",").map((arm) => arm.trim()).filter(Boolean);
  if (named.length === 0) throw new Error("SCORE_ARMS names no arm");
  const unknown = named.filter((arm) => !(SCORE_ARMS as readonly string[]).includes(arm));
  if (unknown.length) throw new Error(`SCORE_ARMS: unknown arm ${unknown.join(", ")}; the arms are ${SCORE_ARMS.join(", ")}`);
  if (named.includes("state-unlearned") && !named.includes("state")) throw new Error("SCORE_ARMS: state-unlearned needs the state arm, which it is derived from");
  return SCORE_ARMS.filter((arm) => named.includes(arm));
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/** Invalid entries are dropped; a list where none is valid is a typo, not a request to measure nothing. */
function capsOf(raw: string | undefined): number[] {
  if (raw === undefined) return DEFAULT_CAPS;
  if (!raw.trim()) return [];
  const caps = raw.split(",").map(Number).filter((cap) => Number.isInteger(cap) && cap > 0);
  if (!caps.length) throw new Error(`SCORE_CAPS: no valid cap in ${JSON.stringify(raw)}; give positive integers, comma-separated, or leave it empty for none`);
  return caps;
}

/** Refused rather than defaulted: a wrong value makes the replay cut elsewhere than the recording did. */
function keepRecentTokensOf(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  if (!/^\d+$/.test(raw.trim()) || value <= 0) throw new Error(`SCORE_KEEP_RECENT_TOKENS: ${JSON.stringify(raw)} is not a positive whole number of tokens`);
  return value;
}

function chainOf(env: NodeJS.ProcessEnv): boolean {
  const raw = env.SCORE_CHAIN?.trim();
  if (raw === undefined || raw === "" || raw === "1") return true;
  if (raw === "0") return false;
  throw new Error(`SCORE_CHAIN: ${JSON.stringify(env.SCORE_CHAIN)} is not 0 or 1`);
}

/** A chained replay runs every compaction of every session in order; choosing some of them would break the chain. */
const PICKERS = ["SCORE_N", "SCORE_AT", "SCORE_CANDIDATES_FROM"] as const;

export function scoreOptionsOf(env: NodeJS.ProcessEnv, repoRoot: string): ScoreOptions {
  const sessions = env.SCORE_SESSIONS?.trim();
  if (!sessions) throw new Error("SCORE_SESSIONS is required: the transcript directory to replay (a synthetic set, or a store of your own)");
  const caps = capsOf(env.SCORE_CAPS);
  const keepRecentTokens = keepRecentTokensOf(env.SCORE_KEEP_RECENT_TOKENS);
  const chain = chainOf(env);
  const picked = PICKERS.find((name) => chain && env[name] !== undefined && env[name] !== "");
  if (picked) throw new Error(`${picked}: a chained replay runs whole sessions, every compaction in order; set SCORE_CHAIN=0 to replay single compactions on their recorded paths`);
  return {
    chain,
    sessions,
    out: env.SCORE_OUT ?? path.join(repoRoot, "score-out", new Date().toISOString().replace(/[:.]/g, "-")),
    arms: armsOf(env.SCORE_ARMS),
    n: positiveInt(env.SCORE_N, DEFAULT_N),
    ...(env.SCORE_AT ? { at: env.SCORE_AT } : {}),
    ...(env.SCORE_CANDIDATES_FROM ? { candidatesFrom: env.SCORE_CANDIDATES_FROM } : {}),
    caps,
    probe: env.SCORE_PROBE === "1",
    warmPrime: env.SCORE_WARM_PRIME !== "0",
    includeLocalOnly: env.SCORE_INCLUDE_LOCAL_ONLY === "1",
    ...(keepRecentTokens !== undefined ? { keepRecentTokens } : {}),
    ...(env.SCORE_LABELS?.trim() ? { labels: env.SCORE_LABELS.trim() } : {}),
  };
}
