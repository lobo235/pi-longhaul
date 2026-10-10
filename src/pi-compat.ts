/**
 * The record of pi versions this extension has been verified against (pi-compat.json), and the
 * check the entrypoint and the tests make against it.
 *
 * The extension is built on pi internals that are not a stable API (README, *pi versions*; ADR 0004). A new
 * pi release line therefore must not run it unnoticed: pi-compat.test.ts fails
 * `npm test` on a vendored pi outside every verified line, and index.ts warns once per session. A
 * patch release on a verified line runs silently and is logged as such.
 */
import fs from "node:fs";
import path from "node:path";

export interface PiVerification {
  /** The pi (`@earendil-works/pi-coding-agent`) version, as `pi --version` prints it. */
  pi: string;
  /** ISO date of the verification. */
  date: string;
  /** What was run; the README procedure names the steps. */
  how: string[];
}

export interface PiCompat {
  verified: PiVerification[];
}

export const PI_COMPAT_PATH = path.join(import.meta.dirname, "..", "pi-compat.json");

export function readPiCompat(file = PI_COMPAT_PATH): PiCompat {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<PiCompat>;
  if (!Array.isArray(parsed.verified)) throw new Error(`${file}: "verified" must be an array`);
  return { verified: parsed.verified };
}

/**
 * The record with one more verified version appended, for the nightly job and for a person recording a
 * verification. Refuses a version already listed or not plain `x.y.z`, a date that is not `YYYY-MM-DD`, and
 * fewer than two steps, so nothing it writes can fail the checks pi-compat.test.ts makes on the file.
 */
export function withVerification(compat: PiCompat, entry: PiVerification): PiCompat {
  if (!/^\d+\.\d+\.\d+$/.test(entry.pi)) throw new Error(`not a pi version: ${JSON.stringify(entry.pi)}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.date)) throw new Error(`not a YYYY-MM-DD date: ${JSON.stringify(entry.date)}`);
  if (entry.how.length < 2) throw new Error("how must list at least two steps that were run");
  if (compat.verified.some((listed) => listed.pi === entry.pi)) throw new Error(`pi ${entry.pi} is already listed`);
  return { verified: [...compat.verified, { pi: entry.pi, date: entry.date, how: [...entry.how] }] };
}

export type PiVersionStatus = "exact" | "line" | "unverified";

const lineOf = (version: string): string | undefined => /^(\d+)\.(\d+)\./.exec(version)?.slice(1, 3).join(".");

/**
 * How `version` relates to the verified record: listed exactly, on the same `major.minor` line as a listed version
 * (pi's patch releases keep the internals this extension reads), or neither.
 */
export function piVersionStatus(version: string, compat: PiCompat): PiVersionStatus {
  if (compat.verified.some((entry) => entry.pi === version)) return "exact";
  const line = lineOf(version);
  return line !== undefined && compat.verified.some((entry) => lineOf(entry.pi) === line) ? "line" : "unverified";
}

/**
 * The once-per-session warning for a pi release line nothing was verified on; null for an exact or same-line
 * version. It warns and runs: a compaction that fails falls back to pi's own, so a refusal would protect nothing.
 */
export function unverifiedPiVersionNotice(version: string, compat: PiCompat): string | null {
  if (piVersionStatus(version, compat) !== "unverified") return null;
  const listed = compat.verified.map((entry) => entry.pi).join(", ") || "(none)";
  return (
    `longhaul: pi ${version} has not been verified against this version of Longhaul ` +
    `(verified: ${listed}). It runs; a compaction it cannot make falls back to pi's own compaction.`
  );
}
