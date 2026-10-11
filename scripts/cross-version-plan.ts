/**
 * Which pi versions the cross-version smoke hands one transcript between, and in what order: every version once,
 * oldest to newest (an upgrade), then newest to oldest (a downgrade), each chain on a transcript of its own. And
 * how far back in time each one's dependency tree is resolved.
 */
export interface Chain {
  name: "upgrade" | "downgrade";
  versions: string[];
}

const parts = (version: string): number[] => version.split(".").map(Number);

function compareVersions(left: string, right: string): number {
  const [a, b] = [parts(left), parts(right)];
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] - b[index];
  return 0;
}

/** Plain x.y.z only: each version reaches an npm install, and a release line's prereleases are not verified. */
const VERSION = /^\d+\.\d+\.\d+$/;

export function planChains(versions: string[]): Chain[] {
  for (const version of versions) if (!VERSION.test(version)) throw new Error(`not a pi version: ${JSON.stringify(version)}`);
  const upgrade = [...new Set(versions)].sort(compareVersions);
  if (upgrade.length < 2) throw new Error(`a cross-version check needs at least two pi versions, got ${upgrade.join(", ") || "none"}`);
  return [
    { name: "upgrade", versions: upgrade },
    { name: "downgrade", versions: [...upgrade].reverse() },
  ];
}

/** How long after a pi's own publish its lockstep packages (pi-ai, pi-agent-core, ...) may still appear. */
const LOCKSTEP_MARGIN_MS = 60 * 60 * 1000;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/**
 * The `npm install --before` time for one pi: its publish time (from `npm view ... time --json`) plus a margin, so
 * its dependency tree resolves as it did on release day, not to whatever a later release of a deep dependency
 * would make of it.
 */
export function installCutoff(times: Record<string, string>, version: string): string {
  const published = times[version];
  const at = typeof published === "string" && ISO_TIME.test(published) ? Date.parse(published) : Number.NaN;
  if (Number.isNaN(at)) throw new Error(`npm reports no publish time for pi ${version}`);
  return new Date(at + LOCKSTEP_MARGIN_MS).toISOString();
}
