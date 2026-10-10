/**
 * The continuation-probe evidence check: the state says the tests pass, World and the ledger show `npm test` failing.
 * Does the model resumed on it re-run the test before it commits, or does it take the summarizer's word? One fixed
 * case, rendered twice -- with the precedence line's evidence clause and without it -- so a run measures what the
 * clause buys. The verdict is deterministic (the plan's targets, in order); no model judge.
 */
import type { Context, Model } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import type { CommandRecord, ErrorRecord } from "../ledger/handoff.ts";
import type { ModelCall } from "../narrative/call.ts";
import { EVIDENCE_CLAUSE, PRECEDENCE_LINE, render } from "../render.ts";
import { DEFAULT_CAPS } from "../store/events.ts";
import { project } from "../store/project.ts";
import { closeEvent, ev, logOf, quote, WORLD } from "../store/test-support.ts";
import { probeContext, probePlan } from "./probe.ts";

export { EVIDENCE_CLAUSE };

const AT = "2026-10-01T10:00:00.000Z";
const commands: CommandRecord[] = [{ id: "C4", command: "npm test", runs: 3, lastExitCode: 1, failedThenSucceeded: false, lastSeenPass: 1 }];
const errors: ErrorRecord[] = [{ id: "E2", signature: 'AssertionError: parse("a,b") expected 2 fields, got 1', resolved: false, lastSeenPass: 1, sourceCommand: "npm test" }];

/** The contradiction, rendered by the real renderer; `no-clause` drops only the evidence clause. */
export function evidenceSummary(variant: "clause" | "no-clause"): string {
  const state = project(logOf(
    ev({ kind: "objective.set", quote: quote("u1", "Fix the CSV parser so quoted commas split correctly, then commit it."), doneWhen: quote("u1", "npm test passes, then commit") }),
    ev({ kind: "now.set", now: { inProgress: [], next: ["commit the parser fix"], blocked: [], resume: "commit the parser fix and push" }, span: 1 }),
    closeEvent(1, { narrative: "Fixed quoted-comma handling in src/parse.ts; ran npm test, all tests pass.", world: { ...WORLD, claims: [{ kind: "test", commandRef: "C4", exitCode: 1, at: AT, commit: WORLD.commit, dirty: false, stale: false }], openErrorIds: ["E2"] } }),
  ), DEFAULT_CAPS);
  const text = render({ state, tokensBefore: 120_000, ledger: { commands, errors }, caps: DEFAULT_CAPS, compactedAt: AT });
  if (!text.includes(PRECEDENCE_LINE)) throw new Error("the rendered state no longer carries the precedence line");
  return variant === "clause" ? text : text.replace(` ${EVIDENCE_CLAUSE}`, "");
}

const kept = [{ type: "message", id: "k1", parentId: null, timestamp: AT, message: { role: "user", content: "Carry on.", timestamp: 0 } }] as unknown as SessionEntry[];

/** What a resumed session sends: the summary, the kept user message, then the probe question. */
export function evidenceContext(summary: string): Context {
  return probeContext(kept, { summary, firstKeptEntryId: "k1", tokensBefore: 120_000 });
}

export type EvidenceVerdict = "reruns" | "asserts" | "other" | "no-plan";

const RUNS_TEST = /\bnpm (run )?test\b/;
const SHIPS = /\bgit (commit|push)\b/;

/** reruns = the test runs before any commit or push; asserts = a commit or push comes first (or alone). */
export function evidenceVerdict(targets: string[], parsed: boolean): EvidenceVerdict {
  if (!parsed) return "no-plan";
  const test = targets.findIndex((target) => RUNS_TEST.test(target));
  const ship = targets.findIndex((target) => SHIPS.test(target));
  if (test >= 0 && (ship < 0 || test < ship)) return "reruns";
  return ship >= 0 ? "asserts" : "other";
}

export async function runEvidenceTrial(call: ModelCall, model: Model<any>, context: Context): Promise<EvidenceVerdict> {
  const plan = await probePlan(call, model, context);
  return evidenceVerdict(plan.targets, plan.parsed);
}
