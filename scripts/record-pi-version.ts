/**
 * Records a verified pi version in pi-compat.json: `node scripts/record-pi-version.ts <x.y.z> [step ...]`.
 * With no steps it records the ones the nightly job runs. Refuses a listed version or a malformed one.
 */
import * as fs from "node:fs";

import { PI_COMPAT_PATH, readPiCompat, withVerification } from "../src/pi-compat.ts";

const NIGHTLY_STEPS = [
  "npm test on the vendored pi (the version gate skipped): typecheck, unit suite, load smoke and the extension-API contract checks",
  "npm run smoke: one real compaction by that pi in a fresh agent dir, against a fake model; the diff was accepted",
];

const [version, ...steps] = process.argv.slice(2);
if (!version) {
  console.error("usage: node scripts/record-pi-version.ts <x.y.z> [step ...]");
  process.exit(2);
}
const next = withVerification(readPiCompat(), {
  pi: version,
  date: new Date().toISOString().slice(0, 10),
  how: steps.length ? steps : NIGHTLY_STEPS,
});
const raw = JSON.parse(fs.readFileSync(PI_COMPAT_PATH, "utf8")) as Record<string, unknown>;
fs.writeFileSync(PI_COMPAT_PATH, JSON.stringify({ ...raw, verified: next.verified }, null, 2) + "\n");
console.log(`recorded pi ${version} in pi-compat.json`);
