/**
 * The error ledger behind handoff.ts: failure signatures merged into the carried records, keyed
 * by their first line with the volatile parts (timestamps, addresses, line numbers) removed;
 * `resolved` flips mechanically when a later run of the source command exits 0, and nothing else
 * flips it here. Everything else here is ranking for the cap.
 */
import type { ErrorRecord } from "./handoff.ts";
import { containsSecret, normalizeCommand, redactCommand } from "./handoff-commands.ts";
import type { ObservedError, ObservedRun } from "./handoff-observe.ts";
import { scrubCredentials } from "../credential-scrub.ts";

const VOLATILE_RES: RegExp[] = [
  /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g,
  /\b\d{1,2}:\d{2}:\d{2}(?:\.\d+)?\b/g,
  /\b0x[0-9a-fA-F]+\b/g,
  /\b[0-9a-f]{8,}\b/g,
  /\bline \d+/g,
  /:\d+(?::\d+)?\b/g,
];

/** The dedupe key: the signature's first line without timestamps, addresses or line numbers. */
export function errorKey(signature: string): string {
  let line = signature.split("\n")[0];
  for (const pattern of VOLATILE_RES) line = line.replace(pattern, "");
  return line.replace(/\s+/g, " ").trim();
}

/**
 * The signature a failure is recorded under: none when it has a command-style credential shape (dropped, as ever),
 * else with each value the credential scrub finds redacted (`password (64-hex): <redacted>`). Redacted, not dropped:
 * an ordinary failure ("secret db-creds version <uuid> not found") must stay open. The scrub is deterministic, so the
 * same failure keys the same way pass after pass.
 */
const recordedSignature = (signature: string) => containsSecret(signature) ? undefined : scrubCredentials(signature).text;

function idNumber(id: string): number {
  const match = /^E(\d+)$/.exec(id);
  return match ? Number(match[1]) : 0;
}

/** Whether `runs` holds a zero exit of `command` after position `after` (-1: anywhere). */
function succeededAfter(runs: ObservedRun[], command: string, after: number): boolean {
  const key = normalizeCommand(command);
  return runs.some((run, index) => index > after && run.exitCode === 0 && normalizeCommand(run.command) === key);
}

/**
 * The carried records plus this pass's errors. A signature seen before (same key) marks its record
 * unresolved again and last seen now; a new one gets the next id. Then the mechanical rule: a
 * record whose source command exits 0 later in this pass is resolved. Records are copied. A
 * signature that carries a credential shape (a failing push or curl echoes its URL or header) is
 * never recorded, carried or new, because the exact half outlives the messages it came from; any
 * other is recorded with the values the credential scrub finds redacted (recordedSignature); a
 * source command with one is stored as `<redacted>`, like its command record. Ids are never reused.
 */
export function mergeErrors(previous: ErrorRecord[], observed: ObservedError[], runs: ObservedRun[], pass: number): ErrorRecord[] {
  let nextId = previous.reduce((max, record) => Math.max(max, idNumber(record.id)), 0) + 1;
  const records = previous.flatMap((record) => {
    const signature = recordedSignature(record.signature);
    return signature === undefined ? [] : [{ ...record, signature, sourceCommand: redactCommand(record.sourceCommand) }];
  });
  const lastSeenAt = new Map<string, number>();
  for (const error of observed) {
    const signature = recordedSignature(error.signature);
    const key = signature === undefined ? "" : errorKey(signature);
    if (signature === undefined || key === "") continue;
    let record = records.find((candidate) => errorKey(candidate.signature) === key);
    if (record) {
      record.resolved = false;
      record.lastSeenPass = pass;
      if (record.sourceCommand === undefined && error.sourceCommand !== undefined) record.sourceCommand = redactCommand(error.sourceCommand);
    } else {
      record = { id: `E${nextId++}`, signature, sourceCommand: redactCommand(error.sourceCommand), resolved: false, lastSeenPass: pass };
      records.push(record);
    }
    lastSeenAt.set(record.id, error.runIndex);
  }
  for (const record of records) {
    if (record.resolved || record.sourceCommand === undefined) continue;
    if (succeededAfter(runs, record.sourceCommand, lastSeenAt.get(record.id) ?? -1)) record.resolved = true;
  }
  return records;
}

/** Records in rank order: unresolved before resolved, then the most recently seen, then the newest id. */
export function rankErrors(records: ErrorRecord[]): ErrorRecord[] {
  return [...records].sort(
    (a, b) => Number(a.resolved) - Number(b.resolved) || b.lastSeenPass - a.lastSeenPass || idNumber(b.id) - idNumber(a.id),
  );
}

/** Records in id order, for rendering and storage. */
export function sortErrorsById(records: ErrorRecord[]): ErrorRecord[] {
  return [...records].sort((a, b) => idNumber(a.id) - idNumber(b.id));
}
