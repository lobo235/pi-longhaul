/**
 * The route circuit breaker: a configured summarization route that is down must not be
 * re-tried on every compaction. Measured during an outage: with `maxRetries: 2` each pass spent three
 * 5-minute idle timeouts (~15 min) on a dead route before the session model picked the work up, and
 * the next pass paid it all over again.
 *
 * The policy here is deliberately small and pure: a per-session state object, and transitions that
 * return a new state. The caller (index.ts) owns the state across compactions in one process.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_ROUTE_HEALTH,
  createRouteHealth,
  shouldAttemptRoute,
  onRouteFailure,
  onRouteSuccess,
  describeRouteHealth,
} from "./route-health.ts";

const T0 = 1_000_000;

test("a fresh session attempts the configured route", () => {
  const state = createRouteHealth();
  assert.equal(shouldAttemptRoute(state, T0), true);
  assert.equal(state.openUntilMs, null);
  assert.equal(state.failures, 0);
});

test("one failed route attempt trips the breaker for the cooldown", () => {
  const config = { ...DEFAULT_ROUTE_HEALTH, failureThreshold: 1, cooldownMs: 30 * 60_000 };
  const opened = onRouteFailure(createRouteHealth(), T0, config);
  assert.equal(shouldAttemptRoute(opened, T0), false, "no attempt while open");
  assert.equal(shouldAttemptRoute(opened, T0 + config.cooldownMs - 1), false, "still open just before the cooldown ends");
  assert.equal(shouldAttemptRoute(opened, T0 + config.cooldownMs), true, "half-open probe after the cooldown");
  assert.equal(opened.openUntilMs, T0 + config.cooldownMs);
  assert.equal(opened.failures, 1);
});

test("a failed half-open probe re-opens the breaker for another cooldown", () => {
  const config = { ...DEFAULT_ROUTE_HEALTH, failureThreshold: 1, cooldownMs: 10 * 60_000 };
  const first = onRouteFailure(createRouteHealth(), T0, config);
  const t1 = T0 + config.cooldownMs;
  assert.equal(shouldAttemptRoute(first, t1), true);
  const second = onRouteFailure(first, t1, config);
  assert.equal(second.failures, 2);
  assert.equal(shouldAttemptRoute(second, t1), false);
  assert.equal(shouldAttemptRoute(second, t1 + config.cooldownMs), true);
});

test("a successful attempt resets the breaker", () => {
  const config = { ...DEFAULT_ROUTE_HEALTH, failureThreshold: 1, cooldownMs: 10 * 60_000 };
  const opened = onRouteFailure(createRouteHealth(), T0, config);
  const reset = onRouteSuccess(opened);
  assert.deepEqual(reset, { failures: 0, openUntilMs: null });
  assert.equal(shouldAttemptRoute(reset, T0), true, "usable again immediately, not after the cooldown");
});

test("with a threshold above one, the breaker stays closed until the failures accumulate", () => {
  const config = { ...DEFAULT_ROUTE_HEALTH, failureThreshold: 2, cooldownMs: 5 * 60_000 };
  const once = onRouteFailure(createRouteHealth(), T0, config);
  assert.equal(once.openUntilMs, null, "one failure is not enough");
  assert.equal(shouldAttemptRoute(once, T0), true, "still attempted");
  const twice = onRouteFailure(once, T0 + 1000, config);
  assert.equal(twice.openUntilMs, T0 + 1000 + config.cooldownMs);
  assert.equal(shouldAttemptRoute(twice, T0 + 1000), false);
});

test("transitions are pure: the input state is not mutated", () => {
  const config = { ...DEFAULT_ROUTE_HEALTH, failureThreshold: 1, cooldownMs: 1000 };
  const before = createRouteHealth();
  const after = onRouteFailure(before, T0, config);
  assert.notEqual(after, before);
  assert.deepEqual(before, { failures: 0, openUntilMs: null }, "the original object is untouched");
});

test("the log line names the reason, the cooldown and the failure count", () => {
  const config = { ...DEFAULT_ROUTE_HEALTH, failureThreshold: 2, cooldownMs: 90_000 };
  const closed = describeRouteHealth(createRouteHealth(), T0);
  assert.match(closed, /closed/);
  assert.match(closed, /0 failures/);
  const open = describeRouteHealth(onRouteFailure(onRouteFailure(createRouteHealth(), T0, config), T0, config), T0);
  assert.match(open, /open/);
  assert.match(open, /2 failures/);
  assert.match(open, /90s/, "the remaining cooldown so the log says how long the route is skipped");
});

test("the default policy fails fast: one failure trips it, and the routed attempt gets no retry", () => {
  assert.equal(DEFAULT_ROUTE_HEALTH.failureThreshold, 1);
  assert.equal(DEFAULT_ROUTE_HEALTH.routedMaxRetries, 0, "a dead route must cost one timeout, not three");
  assert.ok(DEFAULT_ROUTE_HEALTH.cooldownMs >= 60_000, "long enough that an outage is not re-probed every pass");
});
