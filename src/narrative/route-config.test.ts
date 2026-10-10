/**
 * The summarizer route policy (ADR 0003: no shipped route) and the route's circuit-breaker config:
 * the projects pinned to local summarization, the precedence between the env override, the pin and
 * longhaul.json, and the bounds a longhaul.json value must sit inside.
 *
 * Also the route health breaker's config resolver.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  localOnlyRootOf,
  resolveConfiguredRouteHealth,
  resolveSummarizationRoute,
  routeProvidersFor,
} from "./route-config.ts";
import { DEFAULT_ROUTE_HEALTH } from "./route-health.ts";

/** The preamble const the route tests use for their `~` expansion. */
const HOME = "/home/agent";
/** The Longhaul config's `localOnlyRoots` in these tests. */
const ROOTS = ["~/dev/notes", "~/dev/private"];

// --- the route's circuit-breaker policy (longhaul.json) ------------------------

test("route health: the defaults apply when longhaul.json sets nothing", () => {
  assert.deepEqual(resolveConfiguredRouteHealth({}), DEFAULT_ROUTE_HEALTH);
});
test("route health: a partial block overrides only the keys it sets", () => {
  const config = { routeCooldownMs: 120000 };
  assert.deepEqual(resolveConfiguredRouteHealth(config), { ...DEFAULT_ROUTE_HEALTH, cooldownMs: 120000 });
});
test("route health: one junk value falls back on its own, keeping the valid keys", () => {
  const config = { routeFailureThreshold: "two", routeCooldownMs: 60000, routeMaxRetries: 3 };
  assert.deepEqual(resolveConfiguredRouteHealth(config), {
    failureThreshold: DEFAULT_ROUTE_HEALTH.failureThreshold,
    cooldownMs: 60000,
    routedMaxRetries: 3,
  });
});
test("route health: non-integers, zero thresholds and negatives are ignored", () => {
  const cases = [
    { routeFailureThreshold: 0 },
    { routeFailureThreshold: 2.5 },
    { routeFailureThreshold: -1 },
    { routeCooldownMs: -1 },
    { routeCooldownMs: 0 },
    { routeCooldownMs: 1.5 },
    { routeMaxRetries: -1 },
    { routeMaxRetries: 2.5 },
  ];
  for (const c of cases) {
    assert.deepEqual(resolveConfiguredRouteHealth(c), DEFAULT_ROUTE_HEALTH, JSON.stringify(c));
  }
});
test("route health: routeMaxRetries 0 is a valid, deliberate value and survives the resolver", () => {
  assert.equal(resolveConfiguredRouteHealth({ routeMaxRetries: 0 }).routedMaxRetries, 0);
  assert.equal(resolveConfiguredRouteHealth({ routeFailureThreshold: 3 }).failureThreshold, 3);
});
test("route health: values outside the accepted range fall back, so a typo cannot disable the route", () => {
  // A cooldown large enough to pin the breaker open for ~285 years, and a retry budget that would
  // hang every compaction: both are integers, so only the bounds reject them.
  const absurd = { routeCooldownMs: 9007199254740992, routeFailureThreshold: 10_000, routeMaxRetries: 1_000_000_000 };
  assert.deepEqual(resolveConfiguredRouteHealth(absurd), DEFAULT_ROUTE_HEALTH);

  const boundCases = [
    // below the floor
    { routeCooldownMs: 59_999 }, { routeFailureThreshold: 0 }, { routeMaxRetries: -1 },
    // above the ceiling
    { routeCooldownMs: 86_400_001 }, { routeFailureThreshold: 101 }, { routeMaxRetries: 11 },
  ];
  for (const c of boundCases) {
    assert.deepEqual(resolveConfiguredRouteHealth(c), DEFAULT_ROUTE_HEALTH, JSON.stringify(c));
  }

  // The inclusive bounds themselves are accepted, not clamped away.
  assert.deepEqual(
    resolveConfiguredRouteHealth({ routeCooldownMs: 60_000, routeFailureThreshold: 100, routeMaxRetries: 10 }),
    { failureThreshold: 100, cooldownMs: 60_000, routedMaxRetries: 10 },
  );
  assert.deepEqual(
    resolveConfiguredRouteHealth({ routeCooldownMs: 86_400_000, routeFailureThreshold: 1, routeMaxRetries: 0 }),
    { failureThreshold: 1, cooldownMs: 86_400_000, routedMaxRetries: 0 },
  );
});

// --- the shipped default ------------------------------------------------------

test("with nothing configured a session summarizes on its own model: there is no shipped route", () => {
  const route = resolveSummarizationRoute({
    envSpec: undefined,
    configSpec: undefined,
    cwd: `${HOME}/dev/app`,
    localOnlyRoots: ROOTS,
    home: HOME,
  });
  assert.equal(route.rule, "none");
  assert.equal(route.spec, undefined);
});

// --- precedence (ADR 0003) ---------------------------------------------------

test("the env override wins over the pin, config and the default", () => {
  const route = resolveSummarizationRoute({
    envSpec: "example/model-b",
    configSpec: "example/other",
    cwd: `${HOME}/dev/notes`,
    localOnlyRoots: ROOTS,
    home: HOME,
  });
  assert.equal(route.rule, "env-override");
  assert.equal(route.spec, "example/model-b");
});

test("longhaul.json beats the default but not the pin", () => {
  const configured = resolveSummarizationRoute({
    envSpec: undefined,
    configSpec: "example/model-b",
    cwd: `${HOME}/dev/app`,
    localOnlyRoots: ROOTS,
    home: HOME,
  });
  assert.equal(configured.rule, "config");
  assert.equal(configured.spec, "example/model-b");

  const localOnly = resolveSummarizationRoute({
    envSpec: undefined,
    configSpec: "example/model-b",
    cwd: `${HOME}/dev/notes`,
    localOnlyRoots: ROOTS,
    home: HOME,
  });
  assert.equal(localOnly.rule, "local-only");
  assert.equal(localOnly.spec, undefined, "a local-only project must not route, whatever config says");
  assert.equal(localOnly.localOnlyRoot, `${HOME}/dev/notes`);
});

test("every local-only root self-summarizes even when the config names a route", () => {
  for (const root of ROOTS) {
    const route = resolveSummarizationRoute({
      envSpec: undefined,
      configSpec: "example/model-b",
      cwd: root.replace("~", HOME),
        localOnlyRoots: ROOTS,
      home: HOME,
    });
    assert.equal(route.rule, "local-only", root);
    assert.equal(route.spec, undefined, root);
  }
});

// --- the pin matches the project, not a name ---------------------------------

test("the pin matches the root and anything beneath it, and nothing else", () => {
  assert.equal(localOnlyRootOf(`${HOME}/dev/notes`, ROOTS, HOME), `${HOME}/dev/notes`);
  assert.equal(localOnlyRootOf(`${HOME}/dev/notes/worktrees/x`, ROOTS, HOME), `${HOME}/dev/notes`);
  assert.equal(localOnlyRootOf(`${HOME}/dev/notes/`, ROOTS, HOME), `${HOME}/dev/notes`);
  // The boundary is a separator: a sibling whose name starts with the root's is a different project.
  assert.equal(localOnlyRootOf(`${HOME}/dev/notes-2`, ROOTS, HOME), undefined);
  assert.equal(localOnlyRootOf(`${HOME}/dev/notesbook`, ROOTS, HOME), undefined);
  assert.equal(localOnlyRootOf(`${HOME}/dev/app`, ROOTS, HOME), undefined);
});

test("an unresolvable HOME cannot pin: an unexpanded root never matches", () => {
  assert.equal(localOnlyRootOf(`${HOME}/dev/notes`, ROOTS, ""), undefined);
  assert.equal(localOnlyRootOf(`${HOME}/dev/notes`, ["~/dev/notes"], undefined), undefined);
});

test("a session with no cwd is never pinned", () => {
  assert.equal(localOnlyRootOf(undefined, ROOTS, HOME), undefined);
  assert.equal(localOnlyRootOf("", ROOTS, HOME), undefined);
});

test("an absolute root is matched without HOME, and a relative one is ignored", () => {
  assert.equal(localOnlyRootOf("/srv/notes", ["/srv/notes"], undefined), "/srv/notes");
  assert.equal(localOnlyRootOf("/srv/notes", ["srv/notes"], undefined), undefined);
});

// --- canonicalization (security.md T5) --------------------------------------

test("a `..` segment that leaves the pinned root is not pinned (security.md T5)", () => {
  // The string test this replaces would MATCH both of these: the spelling starts with "/srv/notes/".
  assert.equal(localOnlyRootOf("/srv/notes/../outside", ["/srv/notes"], undefined), undefined);
  assert.equal(localOnlyRootOf("/srv/notes/sub/../../outside", ["/srv/notes"], undefined), undefined);
  // The genuinely-inside cases still pin, so the canonicalization is not vacuous.
  assert.equal(localOnlyRootOf("/srv/notes/sub", ["/srv/notes"], undefined), "/srv/notes");
  assert.equal(localOnlyRootOf("/srv/notes/../notes/sub", ["/srv/notes"], undefined), "/srv/notes");
});

test("a symlinked component that escapes the root is not pinned (security.md T5)", (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "pin-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, "notes");
  const outside = join(base, "outside");
  mkdirSync(root);
  mkdirSync(outside);
  symlinkSync(outside, join(root, "link"));

  // Spelling alone says "inside"; the real path is outside, so neither may pin.
  assert.equal(localOnlyRootOf(join(root, "link"), [root], undefined), undefined);
  assert.equal(localOnlyRootOf(join(root, "link", "sub"), [root], undefined), undefined);
  // A real directory inside still pins, proving the canonicalization did not break the match.
  mkdirSync(join(root, "real"));
  assert.equal(localOnlyRootOf(join(root, "real"), [root], undefined), root);
  // And the root itself still pins, including through the symlink's parent spelling.
  assert.equal(localOnlyRootOf(root, [root], undefined), root);
});

test("a sibling whose name only starts with the root's is still rejected after canonicalization", () => {
  assert.equal(localOnlyRootOf("/srv/notes-2", ["/srv/notes"], undefined), undefined);
  assert.equal(localOnlyRootOf("/srv/notes-2/sub", ["/srv/notes"], undefined), undefined);
  assert.equal(localOnlyRootOf("/srv/notesbook", ["/srv/notes"], undefined), undefined);
});

for (const [name, rule, expected] of [
  ["an environment override opens the route to the session's own provider", "env-override", ["listed", "session"]],
  ["a configured route stays limited to routeProviders", "config", ["listed"]],
  ["a local-only session keeps routeProviders as they are", "local-only", ["listed"]],
] as const) test(`routeProvidersFor: ${name}`, () => {
  assert.deepEqual(routeProvidersFor({ spec: "p/m", rule }, ["listed"], "session"), expected);
});
