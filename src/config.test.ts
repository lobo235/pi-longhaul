import test from "node:test";
import assert from "node:assert/strict";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { configPath, DEFAULT_COLD_SLICE_CAPS, DEFAULT_NEAR_DUPLICATE_THRESHOLD, DEFAULT_REMEMBER_PER_SPAN, MODEL_ENV, readConfigFile, resolveNarrativeRoute, resolveStateConfig, warmModeNotice } from "./config.ts";
import { DEFAULT_NARRATIVE_POLICY } from "./narrative/policy.ts";
import { DEFAULT_ROUTE_HEALTH } from "./narrative/route-health.ts";
import { DEFAULT_TURNS_POLICY } from "./narrative/turns/policy.ts";
import { DEFAULT_CAPS } from "./store/events.ts";
import { DEFAULT_CLAIM_PATTERNS } from "./world.ts";

test("resolveStateConfig: no file, empty file, and junk all give the defaults", () => {
  for (const raw of [undefined, "", "not json", "{not json", "[1]", "42"]) {
    const config = resolveStateConfig(() => raw);
    assert.deepEqual(config.caps, DEFAULT_CAPS, String(raw));
    assert.deepEqual(config.claimPatterns, DEFAULT_CLAIM_PATTERNS);
    assert.equal(config.rememberPerSpan, DEFAULT_REMEMBER_PER_SPAN);
    assert.deepEqual(config.coldSliceCaps, DEFAULT_COLD_SLICE_CAPS);
    assert.equal(config.nearDuplicateThreshold, DEFAULT_NEAR_DUPLICATE_THRESHOLD);
    assert.deepEqual(config.narrativePolicy, DEFAULT_NARRATIVE_POLICY);
    assert.equal(config.narrativeMode, "single");
    assert.deepEqual(config.narrativeTurns, DEFAULT_TURNS_POLICY);
    assert.deepEqual(config.routeHealth, DEFAULT_ROUTE_HEALTH);
    assert.equal(config.modelSpec, undefined);
    assert.deepEqual(config.routeProviders, [], "no session routes by default");
    assert.deepEqual(config.localOnlyRoots, [], "no directory is local-only by default");
    assert.deepEqual(config.summarizerHeaders, {}, "no header is sent by default");
    assert.equal(config.keptWindowThinking, undefined, "unset: strip only where verified");
  }
});

test("resolveStateConfig: each key overrides independently and is bounded (table)", () => {
  const cases: Array<[string, Record<string, unknown>, (config: ReturnType<typeof resolveStateConfig>) => void]> = [
    ["caps merge per key", { caps: { hardChars: 8000, decisions: "x" } }, (c) => { assert.equal(c.caps.hardChars, 8000); assert.equal(c.caps.decisions, DEFAULT_CAPS.decisions); }],
    ["caps below the floor fall back", { caps: { hardChars: 100 } }, (c) => assert.equal(c.caps.hardChars, DEFAULT_CAPS.hardChars)],
    ["corrections: 0 by default (every rule kept until lifted); a count asked for is honoured", { caps: { corrections: 3 } }, (c) => { assert.equal(DEFAULT_CAPS.corrections, 0); assert.equal(c.caps.corrections, 3); }],
    ["claim patterns replace the list when well-formed", { claimPatterns: [{ pattern: "make ci", kind: "test" }] }, (c) => assert.deepEqual(c.claimPatterns, [{ pattern: "make ci", kind: "test" }])],
    ["a malformed claim pattern keeps the defaults", { claimPatterns: [{ pattern: "x", kind: "bogus" }] }, (c) => assert.deepEqual(c.claimPatterns, DEFAULT_CLAIM_PATTERNS)],
    ["remember cap bounded 1..50", { rememberPerSpan: 500 }, (c) => assert.equal(c.rememberPerSpan, DEFAULT_REMEMBER_PER_SPAN)],
    ["remember cap in range", { rememberPerSpan: 3 }, (c) => assert.equal(c.rememberPerSpan, 3)],
    ["cold slice caps merge per key", { coldSliceCaps: { commands: 20 } }, (c) => assert.deepEqual(c.coldSliceCaps, { ...DEFAULT_COLD_SLICE_CAPS, commands: 20 })],
    ["near-duplicate threshold 0.5..1", { nearDuplicateThreshold: 0.9 }, (c) => assert.equal(c.nearDuplicateThreshold, 0.9)],
    ["near-duplicate threshold out of range", { nearDuplicateThreshold: 0.1 }, (c) => assert.equal(c.nearDuplicateThreshold, DEFAULT_NEAR_DUPLICATE_THRESHOLD)],
    ["narrative policy via resolveNarrativePolicy", { narrativePolicy: { fixableRetries: 2 } }, (c) => assert.equal(c.narrativePolicy.fixableRetries, 2)],
    ["route health via the copied resolver", { routeFailureThreshold: 3 }, (c) => assert.equal(c.routeHealth.failureThreshold, 3)],
    ["model spec trimmed", { model: "  example-cloud/x  " }, (c) => assert.equal(c.modelSpec, "example-cloud/x")],
    ["a non-string model spec is none", { model: 42 }, (c) => assert.equal(c.modelSpec, undefined)],
    ["a blank model spec is none", { model: "   " }, (c) => assert.equal(c.modelSpec, undefined)],
    ["narrative mode turns", { narrativeMode: "turns" }, (c) => assert.equal(c.narrativeMode, "turns")],
    ["narrative mode warm", { narrativeMode: "warm" }, (c) => assert.equal(c.narrativeMode, "warm")],
    ["an unknown narrative mode is the single call", { narrativeMode: "agent" }, (c) => assert.equal(c.narrativeMode, "single")],
    ["route providers are kept by name, trimmed", { routeProviders: [" local ", "lan-box"] }, (c) => assert.deepEqual(c.routeProviders, ["local", "lan-box"])],
    ["a route provider that is not a non-empty string is dropped, the rest kept", { routeProviders: ["local", 3, "", "  ", null] }, (c) => assert.deepEqual(c.routeProviders, ["local"])],
    ["route providers that are not a list are none", { routeProviders: "local" }, (c) => assert.deepEqual(c.routeProviders, [])],
    ["local-only roots are kept as written, trimmed; a non-string or empty entry is dropped", { localOnlyRoots: [" ~/secret ", "/srv/x", 7, ""] }, (c) => assert.deepEqual(c.localOnlyRoots, ["~/secret", "/srv/x"])],
    ["summarizer headers keep only well-formed entries", { summarizerHeaders: { local: { "x-session-affinity": "{sessionId}", "bad name": "v" } } }, (c) => assert.deepEqual(c.summarizerHeaders, { local: { "x-session-affinity": "{sessionId}" } })],
    ["kept-window thinking keep", { keptWindowThinking: "keep" }, (c) => assert.equal(c.keptWindowThinking, "keep")],
    ["kept-window thinking strip", { keptWindowThinking: "strip" }, (c) => assert.equal(c.keptWindowThinking, "strip")],
    ["an unknown kept-window value is unset", { keptWindowThinking: "STRIP" }, (c) => assert.equal(c.keptWindowThinking, undefined)],
    ["turns policy via resolveTurnsPolicy", { narrativeTurns: { repairTurns: 1, disabledChecks: ["now.resume"] } }, (c) => { assert.equal(c.narrativeTurns.repairTurns, 1); assert.deepEqual(c.narrativeTurns.disabledChecks, ["now.resume"]); }],
  ];
  for (const [, raw, check] of cases) check(resolveStateConfig(() => JSON.stringify(raw)));
  assert.equal(cases.length, 27);
});

test("resolveNarrativeRoute: env wins, then config; with neither, no session routes (it summarizes on its own model)", () => {
  const config = resolveStateConfig(() => JSON.stringify({ model: "example-cloud/from-config" }));
  assert.equal(resolveNarrativeRoute({ env: { [MODEL_ENV]: "example-cloud/from-env" }, config, cwd: "/tmp/p" }).spec, "example-cloud/from-env");
  assert.equal(resolveNarrativeRoute({ env: {}, config, cwd: "/tmp/p" }).spec, "example-cloud/from-config");
  assert.equal(resolveNarrativeRoute({ env: {}, config: resolveStateConfig(() => undefined), cwd: "/tmp/p" }).spec, undefined);
  assert.equal(resolveNarrativeRoute({ env: {}, config: resolveStateConfig(() => undefined), cwd: "/tmp/p" }).spec, undefined);
});

test("warmModeNotice: warns only when narrativeMode is warm, since a live session has no base and runs the single call", () => {
  for (const mode of ["single", "turns", undefined]) assert.equal(warmModeNotice(resolveStateConfig(() => JSON.stringify({ narrativeMode: mode }))), undefined);
  const notice = warmModeNotice(resolveStateConfig(() => JSON.stringify({ narrativeMode: "warm" })));
  assert.match(notice ?? "", /narrativeMode "warm".*single call/);
});

test("readConfigFile: the Longhaul config is longhaul.json in pi's agent dir; a missing file reads as nothing", () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "longhaul-agent-"));
  try {
    assert.equal(configPath(agentDir), path.join(agentDir, "longhaul.json"));
    assert.equal(readConfigFile(agentDir), undefined);
    fs.writeFileSync(path.join(agentDir, "longhaul.json"), '{"rememberPerSpan": 3}');
    assert.equal(resolveStateConfig(() => readConfigFile(agentDir)).rememberPerSpan, 3);
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

test("resolveNarrativeRoute: a session under a localOnlyRoots entry summarizes on its own model whatever route is configured", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "longhaul-local-only-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = resolveStateConfig(() => JSON.stringify({ model: "local/moe", localOnlyRoots: [dir] }));
  const route = resolveNarrativeRoute({ env: {}, config, cwd: path.join(dir, "sub") });
  assert.equal(route.rule, "local-only");
  assert.equal(route.spec, undefined);
  assert.equal(route.localOnlyRoot, dir);
  assert.equal(resolveNarrativeRoute({ env: {}, config, cwd: os.tmpdir() }).rule, "config", "a directory outside every root routes as configured");
});

test("config.example.json lists the defaults the code uses, so copying it changes nothing", () => {
  const example = fs.readFileSync(new URL("../config.example.json", import.meta.url), "utf8");
  const raw = JSON.parse(example) as Record<string, unknown>;
  assert.deepEqual(resolveStateConfig(() => example), resolveStateConfig(() => undefined));
  // Checked raw as well: an invalid example value would fall back to the default and pass the line above.
  assert.deepEqual(raw.caps, DEFAULT_CAPS);
  assert.deepEqual(raw.claimPatterns, DEFAULT_CLAIM_PATTERNS);
  assert.deepEqual(raw.coldSliceCaps, DEFAULT_COLD_SLICE_CAPS);
  const { transportRetry: _fixed, ...policy } = DEFAULT_NARRATIVE_POLICY;
  assert.deepEqual(raw.narrativePolicy, policy);
  assert.equal(raw.narrativeMode, "single");
});
