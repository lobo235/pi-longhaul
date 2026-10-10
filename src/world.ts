/**
 * World (CONTEXT.md *World*, *Claim*, *Stale*): what the ledger and the snapshot prove about the
 * tree, never what the summarizer believes. Claims derive from the last run of a command matching
 * a claim pattern (longhaul.json `claimPatterns`), bound to the commit and the tree state at the
 * pass that saw it run. A claim goes stale when a file-writing tool call follows it, the commit
 * moved, or a tree that was clean at the claim is dirty now; it stays stale until the command runs
 * again. Claims and open error ids ride the span.close event (store/events.ts), so World is
 * reproducible from the log alone. The done gate and the rendered lines are in world-render.ts.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";

import type { CommandRecord, WorkspaceSnapshot } from "./ledger/handoff.ts";
import { normalizeCommand } from "./ledger/handoff-commands.ts";

export type ClaimKind = "test" | "build" | "lint" | "custom";

export interface ClaimPattern {
  /** Leading tokens, whitespace-normalised: "npm test" matches "npm test -- x", not "npm testx". */
  pattern: string;
  kind: ClaimKind;
}

export const DEFAULT_CLAIM_PATTERNS: ClaimPattern[] = [
  { pattern: "npm test", kind: "test" }, { pattern: "node --test", kind: "test" }, { pattern: "go test", kind: "test" },
  { pattern: "pytest", kind: "test" }, { pattern: "cargo test", kind: "test" }, { pattern: "make test", kind: "test" },
  { pattern: "make check", kind: "test" }, { pattern: "cargo build", kind: "build" }, { pattern: "make build", kind: "build" },
  { pattern: "npm run build", kind: "build" }, { pattern: "tsc", kind: "build" }, { pattern: "make lint", kind: "lint" },
  { pattern: "golangci-lint", kind: "lint" }, { pattern: "npm run lint", kind: "lint" },
];

export interface Claim {
  kind: ClaimKind;
  /** The ledger command id ("C3") the claim is about. */
  commandRef: string;
  exitCode: number | null;
  /** When the run was recorded: the close of the span that saw it. */
  at: string;
  /** When the command itself last ran (the ledger's lastRanAt); renders as the claim's age. */
  ranAt?: string;
  commit?: string;
  /** Tree dirty when the claim was recorded (the clean-then-dirty rule needs it). */
  dirty?: boolean;
  stale: boolean;
}

/** Tool names whose call writes files, and bash shapes that do. */
const FILE_WRITE_TOOLS = new Set(["write", "edit", "multi_edit", "notebook_edit"]);
const WRITING_BASH_RE = /\bsed\s+-i\b|(^|[^>|])>(?!>?&)|\btee\b|\bmv\b|\brm\b|\bcp\b|\bgit\s+(checkout|pull|merge|rebase|stash|reset|apply|cherry-pick|revert)\b|\bnpm\s+(install|ci|update|uninstall)\b|\bpip\s+install\b|\bcargo\s+(add|update)\b|\bgo\s+(get|mod)\b/;

function segments(command: string): string[] {
  return normalizeCommand(command).split(/\s*(?:&&|;)\s*/).filter((segment) => segment !== "");
}

/** The kind of the first pattern whose tokens lead the command or any &&/; segment of it. */
export function classifyClaim(command: string, patterns: ClaimPattern[]): ClaimKind | undefined {
  for (const segment of segments(command)) {
    const tokens = segment.split(" ");
    for (const { pattern, kind } of patterns) {
      const wanted = pattern.trim().split(/\s+/);
      if (wanted.length <= tokens.length && wanted.every((token, index) => token === tokens[index])) return kind;
    }
  }
  return undefined;
}

export function isDirty(snapshot: WorkspaceSnapshot | undefined): boolean | undefined {
  if (!snapshot) return undefined;
  return (snapshot.statusShort ?? "").trim() !== "";
}

/**
 * Which commands had a file write after their last run in these messages (keyed by normalised
 * command text), and whether any write happened at all (which stales every carried claim).
 */
export function observeWrites(messages: AgentMessage[]): { writeAfterRun: Set<string>; anyWrite: boolean } {
  const lastRun = new Map<string, number>();
  let lastWrite = -1;
  messages.forEach((message, index) => {
    const record = message as unknown as { role?: string; content?: unknown; command?: string };
    if (record.role === "bashExecution" && typeof record.command === "string") {
      lastRun.set(normalizeCommand(record.command), index);
      if (WRITING_BASH_RE.test(record.command)) lastWrite = index;
      return;
    }
    if (record.role !== "assistant" || !Array.isArray(record.content)) return;
    for (const block of record.content as Array<{ type?: string; name?: string; arguments?: { command?: unknown } }>) {
      if (block.type !== "toolCall") continue;
      if (FILE_WRITE_TOOLS.has(block.name ?? "")) lastWrite = index;
      if (block.name === "bash" && typeof block.arguments?.command === "string") {
        lastRun.set(normalizeCommand(block.arguments.command), index);
        if (WRITING_BASH_RE.test(block.arguments.command)) lastWrite = index;
      }
    }
  });
  const writeAfterRun = new Set<string>();
  for (const [text, at] of lastRun) if (lastWrite > at) writeAfterRun.add(text);
  return { writeAfterRun, anyWrite: lastWrite >= 0 };
}

export interface DeriveClaimsInput {
  commands: CommandRecord[];
  /** The previous span.close's claims (carried timestamps and staleness). */
  previous: Claim[];
  pass: number;
  snapshot?: WorkspaceSnapshot;
  writes: ReturnType<typeof observeWrites>;
  patterns: ClaimPattern[];
  /** The span-close timestamp, ISO. */
  now: string;
}

function idNumber(id: string): number {
  return Number(/^C(\d+)$/.exec(id)?.[1] ?? 0);
}

export function deriveClaims({ commands, previous, pass, snapshot, writes, patterns, now }: DeriveClaimsInput): Claim[] {
  const carried = new Map(previous.map((claim) => [claim.commandRef, claim]));
  const dirtyNow = isDirty(snapshot);
  const claims: Claim[] = [];
  for (const record of [...commands].sort((a, b) => idNumber(a.id) - idNumber(b.id))) {
    const kind = classifyClaim(record.command, patterns);
    if (!kind) continue;
    const ranThisSpan = record.lastSeenPass === pass;
    const earlier = ranThisSpan ? undefined : carried.get(record.id);
    const base: Claim = earlier
      ? { ...earlier, kind, exitCode: record.lastExitCode }
      : { kind, commandRef: record.id, exitCode: record.lastExitCode, at: now, ...(record.lastRanAt ? { ranAt: record.lastRanAt } : {}), commit: snapshot?.commit, dirty: dirtyNow, stale: false };
    const staleByWrite = ranThisSpan ? writes.writeAfterRun.has(normalizeCommand(record.command)) : writes.anyWrite;
    const staleByCommit = base.commit !== undefined && snapshot?.commit !== undefined && base.commit !== snapshot.commit;
    const staleByTree = base.dirty === false && dirtyNow === true;
    claims.push({ ...base, stale: base.stale || staleByWrite || staleByCommit || staleByTree });
  }
  return claims;
}
