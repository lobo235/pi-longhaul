/**
 * Structural guards on index.ts, which registers pi hooks and tools and cannot be imported under
 * node --test without a pi process; behaviour is tested through pass.ts and the fake pi in
 * test-support.ts (later tasks).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

test("index.ts logs extension-loaded with the pi version and notifies an unverified pi once per session", () => {
  assert.match(src, /event: "extension-loaded", piVersion: PI_VERSION, piVersionVerified: piStatus === "exact" \? true : piStatus === "line" \? "line" : false/);
  assert.match(src, /pi\.on\("session_start"/);
  assert.match(src, /if \(rt\.piVersionNotice\) ctx\.ui\.notify\?\.\(rt\.piVersionNotice, "warning"\)/);
});

test("index.ts sets the loaded marker at load and stands down through select.ts", () => {
  assert.match(src, /process\.env\[STATE_LOADED_ENV\] = stateLoadedMarker\(\);/);
  assert.match(src, /const selection = selectCompactor\(process\.env\);\s*if \(stateStandsDown\(selection\)\) return undefined;/);
});

test("index.ts wires the pass, the span record and the failure path", () => {
  assert.match(src, /pi\.on\("session_before_compact"/);
  assert.match(src, /runStatePass\(/);
  assert.match(src, /event: "aborted"/);
  assert.match(src, /event: "fallback"/);
  assert.match(src, /pi\.on\("session_compact"/);
  assert.match(src, /pi\.appendEntry\(SPAN_ENTRY_TYPE, buildSpanRecord\(/);
  assert.match(src, /pi\.on\("session_compact_failed"/);
  assert.match(src, /routeHealth = result\.routeHealth/);
  assert.doesNotMatch(src, /pass-skipped/);
  assert.match(src, /registerRememberTool\(pi\)/);
  assert.match(src, /registerRecallTool\(pi\)/);
});
