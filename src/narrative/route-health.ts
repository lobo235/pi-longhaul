/**
 * Circuit breaker for the configured summarization route.
 *
 * A route is an optimization, and the attempt chain already falls back to the session model
 * (run.ts). What it lacked was memory: measured during an outage, a route whose
 * model was not loaded cost three 5-minute idle timeouts (~15 min) on EVERY compaction pass --
 * `maxRetries: 2` behind a dead backend -- because each pass started with a clean slate. A session
 * that compacts every ~10 minutes therefore spent most of its wall clock waiting for a model that
 * was never going to answer.
 *
 * This module is the memory: one state object per process (pi runs one process per session) that
 * opens the breaker after `failureThreshold` failed route attempts, skips the route while open, and
 * half-opens after `cooldownMs` so a recovered model is picked up again without restarting anything.
 *
 * Only the ROUTE is ever skipped. The session model is the session's own model, so it never passes
 * through this policy: a tripped route still leaves the chain with exactly the attempt an unrouted
 * session has.
 */
import type { TransportRetryPolicy } from "./transport-retry.ts";

export interface RouteHealthConfig {
  /** Failed route attempts that open the breaker. 1 = a dead route costs one timeout per session. */
  failureThreshold: number;
  /** How long the route stays skipped; one probe is allowed once it has elapsed (half-open). */
  cooldownMs: number;
  /** Transport retries for the routed attempt only: no 5-minute retry behind a dead route. */
  routedMaxRetries: number;
}

export const DEFAULT_ROUTE_HEALTH: RouteHealthConfig = {
  failureThreshold: 1,
  cooldownMs: 30 * 60_000,
  routedMaxRetries: 0,
};

export interface RouteHealthState {
  /** Consecutive failed route attempts since the last success. */
  failures: number;
  /** Epoch ms until which the route is skipped; null when the breaker is closed. */
  openUntilMs: number | null;
}

export function createRouteHealth(): RouteHealthState {
  return { failures: 0, openUntilMs: null };
}

/** True when the route may be attempted now: closed, or half-open once the cooldown has elapsed. */
export function shouldAttemptRoute(state: RouteHealthState, nowMs: number): boolean {
  return state.openUntilMs === null || nowMs >= state.openUntilMs;
}

/** Record a failed route attempt; opens the breaker once `failureThreshold` is reached. */
export function onRouteFailure(state: RouteHealthState, nowMs: number, config: RouteHealthConfig): RouteHealthState {
  const failures = state.failures + 1;
  const open = failures >= config.failureThreshold;
  return { failures, openUntilMs: open ? nowMs + config.cooldownMs : state.openUntilMs };
}

/** Record a successful route attempt: the route is healthy again, usable immediately. */
export function onRouteSuccess(_state: RouteHealthState): RouteHealthState {
  return createRouteHealth();
}

/**
 * The retry budget for the routed attempt. A dead route must cost one timeout, not three: the
 * session model is waiting to pick up the work, so retrying the route only costs wall clock.
 * `baseDelayMs` is kept from the caller so a retry that does happen still waits as configured.
 */
export function routedRetryPolicy(config: RouteHealthConfig, baseDelayMs: number): TransportRetryPolicy {
  return { maxRetries: config.routedMaxRetries, baseDelayMs };
}

/** A log-friendly line for the `route-skipped` / `route-tripped` records. */
export function describeRouteHealth(state: RouteHealthState, nowMs: number): string {
  const failures = `${state.failures} failure${state.failures === 1 ? "" : "s"}`;
  if (state.openUntilMs === null) return `closed (${failures})`;
  const remainingMs = Math.max(0, state.openUntilMs - nowMs);
  return `open for ${Math.ceil(remainingMs / 1000)}s of cooldown (${failures})`;
}
