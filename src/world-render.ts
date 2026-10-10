/**
 * The done gate (CONTEXT.md *Done gate*) and the World section's lines. Done is never declared by
 * prose: when the acceptance names a ledger command, the gate is evaluated from the claim, the
 * commit and the tree, and the rendered line is the only place "met" can come from.
 */
import { RECALL_TOOL } from "./tool-names.ts";
import type { CommandRecord, ErrorRecord, WorkspaceSnapshot } from "./ledger/handoff.ts";
import { normalizeCommand } from "./ledger/handoff-commands.ts";
import { isDirty, type Claim } from "./world.ts";

export type DoneGate =
  | { kind: "not-mechanical" }
  | { kind: "mechanical"; commandRef: string; command: string; exitCode: number | null; commit?: string; clean: boolean | undefined; stale: boolean; met: boolean; reason?: string };

function idNumber(id: string): number {
  return Number(/^[CE](\d+)$/.exec(id)?.[1] ?? 0);
}

/** The ledger command the acceptance names: longest normalised text contained in it, else a bare C<n>. */
function namedCommand(doneWhenText: string, commands: CommandRecord[]): CommandRecord | undefined {
  const wanted = normalizeCommand(doneWhenText);
  const byText = commands
    .filter((record) => record.command.length > 0 && wanted.includes(normalizeCommand(record.command)))
    .sort((a, b) => b.command.length - a.command.length)[0];
  if (byText) return byText;
  const ids = new Set(Array.from(doneWhenText.matchAll(/\bC(\d+)\b/g), (match) => `C${match[1]}`));
  return commands.find((record) => ids.has(record.id));
}

export function evaluateDoneGate(doneWhenText: string | undefined, commands: CommandRecord[], claims: Claim[], snapshot: WorkspaceSnapshot | undefined): DoneGate {
  if (!doneWhenText) return { kind: "not-mechanical" };
  const record = namedCommand(doneWhenText, commands);
  if (!record) return { kind: "not-mechanical" };
  const claim = claims.find((candidate) => candidate.commandRef === record.id);
  const clean = isDirty(snapshot) === undefined ? undefined : !isDirty(snapshot);
  const base = { kind: "mechanical" as const, commandRef: record.id, command: record.command, exitCode: claim?.exitCode ?? null, commit: claim?.commit, clean, stale: claim?.stale ?? false };
  const reason = !claim ? "not run yet" : claim.exitCode !== 0 ? `last exit ${claim.exitCode ?? "-"}` : claim.stale ? "tree changed since the run" : clean === undefined ? "tree state unknown" : clean ? undefined : "tree dirty";
  return reason ? { ...base, met: false, reason } : { ...base, met: true };
}

export function renderDoneGate(gate: DoneGate): string {
  if (gate.kind === "not-mechanical") return "Done gate: not mechanical (acceptance in words)";
  const commit = gate.commit ? ` @ ${gate.commit}` : "";
  const clean = gate.clean === undefined ? "unknown" : gate.clean ? "yes" : "no";
  const verdict = gate.met ? "met" : `not met (${gate.reason})`;
  return `Done gate: \`${gate.command}\` last exit ${gate.exitCode ?? "-"}${commit}, clean tree: ${clean}, ${verdict}`;
}

export function openErrors(errors: ErrorRecord[], cap: number): ErrorRecord[] {
  return errors.filter((record) => !record.resolved).sort((a, b) => idNumber(b.id) - idNumber(a.id)).slice(0, cap);
}

export interface WorldInput {
  snapshot?: WorkspaceSnapshot;
  claims: Claim[];
  commands: CommandRecord[];
  errors: ErrorRecord[];
  pass: number;
  caps: { openErrors: number; worldChars: number };
  /** When the pass ran: ages are measured against the snapshot's capture, else this (no snapshot outside a repo). */
  compactedAt?: string;
}

function treeLine(snapshot: WorkspaceSnapshot | undefined): string {
  if (!snapshot) return "branch unknown (no snapshot)";
  const branch = snapshot.branch ?? "unknown";
  const commit = snapshot.commit ? ` @ ${snapshot.commit}` : "";
  const files = (snapshot.statusShort ?? "").split("\n").filter((line) => line.trim() !== "").length;
  const tree = files === 0 ? "tree clean" : `tree dirty (${files} file${files === 1 ? "" : "s"}): ${snapshot.diffStat ?? ""}`;
  return `branch ${branch}${commit}, ${tree}`;
}

/**
 * How long before `asOf` (the compaction) a run happened: "under 1m", "14m", "3h", "2d". Undefined
 * when either time is unreadable or the run is after `asOf` (clock skew): no age beats a wrong one.
 */
export function ageLabel(ranAt: string | undefined, asOf: string | undefined): string | undefined {
  const elapsed = Date.parse(asOf ?? "") - Date.parse(ranAt ?? "");
  if (!Number.isFinite(elapsed) || elapsed < 0) return undefined;
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "under 1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/** One line per claim kind: the newest claim of that kind, with its age as of the compaction. */
function claimLines(claims: Claim[], commands: CommandRecord[], asOf: string | undefined): string[] {
  const byKind = new Map<Claim["kind"], Claim>();
  for (const claim of claims) byKind.set(claim.kind, claim);
  return [...byKind.entries()].map(([kind, claim]) => {
    const text = commands.find((record) => record.id === claim.commandRef)?.command ?? claim.commandRef;
    const age = ageLabel(claim.ranAt, asOf);
    return `last ${kind}: \`${text}\` exit ${claim.exitCode ?? "-"}${claim.commit ? ` @ ${claim.commit}` : ""}${age ? `, ran ${age} before compaction` : ""}, tree changed since: ${claim.stale ? "yes" : "no"}`;
  });
}

function errorLine(record: ErrorRecord, commands: CommandRecord[]): string {
  const firstLine = record.signature.split("\n")[0].replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(0, 120);
  const source = commands.find((candidate) => candidate.command === record.sourceCommand);
  const runs = source ? `; ${source.command} ran ${source.runs}×` : "";
  return `${record.id} ${firstLine} (last seen span ${record.lastSeenPass}${runs})`;
}

export function renderWorldLines({ snapshot, claims, commands, errors, caps, compactedAt }: WorldInput): string[] {
  const lines = [treeLine(snapshot), ...(claims.length === 0 ? ["no claims yet"] : claimLines(claims, commands, snapshot?.capturedAt ?? compactedAt))];
  const open = openErrors(errors, caps.openErrors);
  if (open.length > 0) lines.push(`open errors: ${open.map((record) => errorLine(record, commands)).join("; ")}`);
  return fitLines(lines, caps.worldChars);
}

/** Cut the LAST line (open errors, the only unbounded one) so the section stays under the cap. */
function fitLines(lines: string[], maxChars: number): string[] {
  const joined = lines.join("\n");
  if (joined.length <= maxChars) return lines;
  const marker = `… (${RECALL_TOOL} errors)`;
  const head = lines.slice(0, -1).join("\n");
  const room = maxChars - head.length - 1 - marker.length;
  const last = lines[lines.length - 1];
  return [...lines.slice(0, -1), `${last.slice(0, Math.max(0, room))}${marker}`];
}
