/**
 * Contract checks against the pi this tree VENDORS (an exact devDependency, not the global
 * install). The first test pins it to a verified release line in pi-compat.json; the rest check the surfaces the
 * extension relies on, so a pi upgrade that moves one fails here and not at the next compaction.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import * as pi from "@earendil-works/pi-coding-agent";

import { PI_COMPAT_PATH, piVersionStatus, readPiCompat, unverifiedPiVersionNotice, withVerification } from "./pi-compat.ts";
import type { PiVerification } from "./pi-compat.ts";

const PKG = new URL("../node_modules/@earendil-works/pi-coding-agent/", import.meta.url);
const installedVersion = (JSON.parse(readFileSync(new URL("package.json", PKG), "utf8")) as { version: string }).version;

// pi 1.0.0 NESTED its @earendil-works/* deps under pi-coding-agent/node_modules; 1.0.1 HOISTS
// them to the top-level node_modules (sibling of pi-coding-agent). Neither layout is stable npm
// API, so resolve a dep's package directory by probing both, in the order it actually appears, and
// never hardcode one. A layout that puts the package elsewhere still resolves: this only special-
// cases the two pi has shipped so far.
function earendilDir(pkg: string): URL {
  const nested = new URL(`node_modules/@earendil-works/${pkg}/`, PKG);
  if (existsSync(nested)) return nested;
  return new URL(`../${pkg}/`, PKG);
}

test("pi-compat: the vendored pi is on a release line this extension was verified against", () => {
  const compat = readPiCompat();
  assert.notEqual(
    piVersionStatus(installedVersion, compat),
    "unverified",
    `pi ${installedVersion} is not in ${PI_COMPAT_PATH} (verified: ${compat.verified.map((v) => v.pi).join(", ")}). Run the procedure in CONTRIBUTING.md (*Verifying a new pi version*) and record it.`,
  );
  assert.equal(pi.VERSION, installedVersion);
  for (const entry of compat.verified) {
    assert.match(entry.pi, /^\d+\.\d+\.\d+/);
    assert.match(entry.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(entry.how.length >= 2, "how must list the steps that were run");
  }
});

test("piVersionStatus: an exact verified version, the same major.minor line, or unverified (table)", () => {
  const compat = { verified: [{ pi: "1.0.4", date: "2026-10-01", how: ["a", "b", "c"] }, { pi: "0.99.1", date: "2026-09-01", how: ["a", "b", "c"] }] };
  for (const [version, expected] of [
    ["1.0.4", "exact"],
    ["1.0.5", "line"],
    ["1.0.0", "line"],
    ["1.0.6-rc.1", "line"],
    ["0.99.7", "line"],
    ["1.1.0", "unverified"],
    ["2.0.4", "unverified"],
    ["0.98.0", "unverified"],
    ["not-a-version", "unverified"],
  ] as const) assert.equal(piVersionStatus(version, compat), expected, version);
});

test("pi-compat: a patch release on a verified line has no notice; a new minor or major warns and says it still runs", () => {
  const compat = { verified: [{ pi: "1.0.4", date: "2026-10-01", how: ["a", "b", "c"] }] };
  assert.equal(unverifiedPiVersionNotice("1.0.9", compat), null);
  assert.match(unverifiedPiVersionNotice("1.1.0", compat) ?? "", /pi 1\.1\.0 .*verified: 1\.0\.4.*pi's own compaction/);
});

test("pi-compat: the unverified notice names the running and the verified versions", () => {
  const compat = { verified: [{ pi: "0.87.1", date: "2026-09-28", how: ["a", "b", "c"] }] };
  assert.equal(unverifiedPiVersionNotice("0.87.1", compat), null);
  assert.match(unverifiedPiVersionNotice("0.88.0", compat) ?? "", /pi 0\.88\.0 has not been verified .*verified: 0\.87\.1/);
  // The notice must name the extension that is warning: other extensions ship their own version
  // check, and a user reading the log has to know which one to reverify.
  assert.match(unverifiedPiVersionNotice("0.88.0", compat) ?? "", /^longhaul: pi 0\.88\.0 has not been verified/);
});

test("pi-compat: the public exports the extension imports exist", () => {
  for (const name of ["VERSION", "serializeConversation", "estimateTokens", "sessionEntryToContextMessages"] as const) {
    assert.ok(name in pi, `export ${name}`);
  }
});

test("pi-compat: the extension-API surface the hooks and tools rely on is declared", () => {
  const types = readFileSync(new URL("dist/core/extensions/types.d.ts", PKG), "utf8");
  for (const needle of [
    "appendEntry<T = unknown>(customType: string, data?: T): void;",
    "registerTool<TParams extends TSchema",
    "export interface SessionBeforeCompactEvent",
    "export interface SessionCompactEvent",
    "promptGuidelines?: string[];",
    "prepareArguments?: (args: unknown) => Static<TParams>;",
    "executionMode?: ToolExecutionMode;",
  ]) {
    assert.ok(types.includes(needle), needle);
  }
  const compaction = readFileSync(new URL("dist/core/compaction/compaction.d.ts", PKG), "utf8");
  for (const needle of ["firstKeptEntryId", "messagesToSummarize", "turnPrefixMessages", "previousSummary", "tokensBefore"]) {
    assert.ok(compaction.includes(needle), `CompactionPreparation.${needle}`);
  }
  const core = readFileSync(new URL("dist/types.d.ts", earendilDir("pi-agent-core")), "utf8");
  const start = core.indexOf("export interface AgentToolResult");
  assert.ok(start >= 0);
  // pi 0.99.1 ADDED `isError?: boolean` to AgentToolResult ("report a failure without throwing":
  // the model sees an error result, details/structuredContent are kept). The design intent this
  // check exists for is UNCHANGED -- a domain rejection stays an ordinary result -- and the ONLY
  // thing that makes that intent safe is that the flag is never REQUIRED, so a result without it is
  // still valid. Assert THAT, not the field's presence. Presence and absence are both safe; a
  // required flag is not. An earlier version of this check asserted the field's optional FORM
  // (`isError?:`), which would have gone red for a perfectly compatible pi that dropped the field
  // again -- a false red that teaches the next reader to distrust the gate. Recorded as future-work
  // when the risk was known, and closed here.
  //
  // Bounded to AgentToolResult's OWN body: the first line-starting `}` after the opening line is
  // its close. A loose character window would also swallow AgentToolCallOutcome, which legitimately
  // declares a REQUIRED `isError: boolean`, and this check would then fail for the wrong reason.
  const resultBody = core.slice(start, core.indexOf("\n}", start));
  assert.doesNotMatch(resultBody.replace(/isError\?/g, ""), /isError/, "a tool result must not REQUIRE an error flag (optional or absent are both fine)");
  const session = readFileSync(new URL("dist/core/session-manager.d.ts", PKG), "utf8");
  assert.ok(session.includes('type: "custom";') && session.includes("customType: string;"), "CustomEntry shape");
});

test("withVerification: appends a new version with its date and steps, and keeps the earlier entries", () => {
  const compat = { verified: [{ pi: "1.0.4", date: "2026-10-01", how: ["a", "b"] }] };
  const next = withVerification(compat, { pi: "1.1.0", date: "2026-11-02", how: ["npm test", "compaction smoke"] });
  assert.deepEqual(next.verified.map((entry) => entry.pi), ["1.0.4", "1.1.0"]);
  assert.equal(piVersionStatus("1.1.0", next), "exact");
  assert.equal(compat.verified.length, 1, "the input is not modified");
});

test("withVerification: refuses a listed version, a version that is not x.y.z, a bad date and an empty how (table)", () => {
  const compat = { verified: [{ pi: "1.0.4", date: "2026-10-01", how: ["a", "b"] }] };
  const cases: [string, PiVerification, RegExp][] = [
    ["already listed", { pi: "1.0.4", date: "2026-11-02", how: ["a", "b"] }, /already/],
    ["not a version", { pi: "latest", date: "2026-11-02", how: ["a", "b"] }, /version/],
    ["shell text in the version", { pi: "1.1.0; rm -rf x", date: "2026-11-02", how: ["a", "b"] }, /version/],
    ["bad date", { pi: "1.1.0", date: "Nov 2", how: ["a", "b"] }, /date/],
    ["one step", { pi: "1.1.0", date: "2026-11-02", how: ["a"] }, /how/],
  ];
  for (const [name, entry, message] of cases) assert.throws(() => withVerification(compat, entry), message, name);
});
