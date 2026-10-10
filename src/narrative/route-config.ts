/**
 * Route policy for the narrative call (CONTEXT.md *Summarizer route*). Every session summarizes on its
 * own model unless a route is configured (the Longhaul config, or PI_COMPACT_STATE_MODEL for one
 * invocation); a session under a Local-only root ignores the config's route. No route ships.
 */
import { realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

import { bounded } from "./policy.ts";
import { DEFAULT_ROUTE_HEALTH, type RouteHealthConfig } from "./route-health.ts";

/**
 * Accepted ranges for the breaker's tunables. These are policy bounds, not taste: an
 * out-of-range value falls back to the default, so a typo cannot pin the breaker open for years or
 * put a billion retries behind a dead route. The README lists the keys and defaults; the bounds live only here.
 */
const ROUTE_HEALTH_BOUNDS = {
  failureThreshold: [1, 100],
  cooldownMs: [60_000, 24 * 60 * 60_000],
  routedMaxRetries: [0, 10],
} as const;

/**
 * The route's circuit-breaker policy, from longhaul.json's `routeFailureThreshold`,
 * `routeCooldownMs` and `routeMaxRetries`. There is no env override: this is a per-machine
 * operational setting, not a per-invocation one. Each key falls back to its default on its own, so
 * one junk value cannot discard the rest of the block.
 */
export function resolveConfiguredRouteHealth(
  source: Readonly<Record<string, unknown>>,
  defaults: RouteHealthConfig = DEFAULT_ROUTE_HEALTH,
): RouteHealthConfig {
  return {
    failureThreshold: bounded(source.routeFailureThreshold, defaults.failureThreshold, ROUTE_HEALTH_BOUNDS.failureThreshold),
    cooldownMs: bounded(source.routeCooldownMs, defaults.cooldownMs, ROUTE_HEALTH_BOUNDS.cooldownMs),
    routedMaxRetries: bounded(source.routeMaxRetries, defaults.routedMaxRetries, ROUTE_HEALTH_BOUNDS.routedMaxRetries),
  };
}


export type SummarizationRouteRule = "env-override" | "local-only" | "config" | "none";

export interface ResolvedSummarizationRoute {
  /** The `provider/model-id` to route to, or undefined to summarize on the session model. */
  spec: string | undefined;
  rule: SummarizationRouteRule;
  /** The Local-only root this session works under, when `rule` is "local-only". */
  localOnlyRoot?: string;
}

/**
 * The providers whose sessions may use `route`. `PI_COMPACT_STATE_MODEL` is typed for one invocation on purpose,
 * so it opens the route to the session's own provider whatever `routeProviders` says (ADR 0003); a configured
 * route stays limited to `routeProviders`.
 */
export function routeProvidersFor(route: ResolvedSummarizationRoute, routeProviders: readonly string[], sessionProvider: string): readonly string[] {
  return route.rule === "env-override" ? [...routeProviders, sessionProvider] : routeProviders;
}

/**
 * The Local-only root (CONTEXT.md) `cwd` works under, or undefined. A root is the Longhaul config's
 * `localOnlyRoots` entry: a session working in a project's subdirectory is still that project, so a
 * root matches itself and everything beneath it. `~` expands with `home`, and the boundary is a path
 * separator, so `~/dev/notes-2` is NOT `~/dev/notes`. Both sides are canonicalized before the comparison
 * (`fs.realpathSync`, falling back to the deepest existing ancestor for a path that does not exist
 * yet): a string test alone lets a symlink under a root, or a `..` segment inside one, read as
 * local-only while resolving outside it (security.md T5). The value returned is `~`-expanded, not the real path.
 */
export function localOnlyRootOf(
  cwd: string | undefined,
  roots: readonly string[],
  home: string | undefined = process.env.HOME,
): string | undefined {
  const raw = cwd?.trim().replace(/\/+$/, "");
  if (!raw) return undefined;
  const target = canonical(raw);
  for (const root of roots) {
    const expanded = expandRoot(root, home);
    if (!expanded) continue;
    const realRoot = canonical(expanded);
    if (target === realRoot || target.startsWith(`${realRoot}/`)) return expanded;
  }
  return undefined;
}

/**
 * The real path of `p`, or -- when `p` does not exist yet -- the real path of its deepest existing
 * ancestor with the remaining segments appended. A bare `path.resolve` fallback is NOT enough: it
 * leaves a symlinked component in place, so `root/link/sub` (where nothing exists below the link)
 * would still read as under `root` while resolving outside it -- the exact escape this guards against.
 */
function canonical(p: string): string {
  let head = p;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(head);
      return tail.length ? resolve(real, ...tail.reverse()) : real;
    } catch {
      const parent = dirname(head);
      if (parent === head) return resolve(p);
      tail.push(basename(head));
      head = parent;
    }
  }
}

/**
 * Why a `localOnlyRoots` entry protects nothing, or undefined when it is usable. Only an absolute POSIX
 * path (`/...`) or a home-relative one (`~` or `~/...`, with a home to expand it against) can match a
 * session's directory; anything else -- a relative path, a Windows path -- would be silently skipped.
 */
export function unusableLocalOnlyRoot(root: string, home: string | undefined): string | undefined {
  const trimmed = root.trim();
  if (trimmed === "~" || trimmed.startsWith("~/")) return home?.replace(/\/+$/, "") ? undefined : "HOME is not set, so ~ cannot be expanded";
  return trimmed.startsWith("/") ? undefined : "it is not an absolute POSIX path (/... or ~/...)";
}

function expandRoot(root: string, home: string | undefined): string | undefined {
  const trimmed = root.trim().replace(/\/+$/, "");
  if (!trimmed) return undefined;
  if (trimmed === "~" || trimmed.startsWith("~/")) {
    const base = home?.replace(/\/+$/, "");
    if (!base) return undefined;
    return `${base}${trimmed.slice(1)}`;
  }
  return trimmed.startsWith("/") ? trimmed : undefined;
}

/**
 * Which rule chooses the summarizer, in precedence order: `PI_COMPACT_STATE_MODEL` > Local-only root >
 * the Longhaul config's `model` > none. With none, the session's own model writes the diff: no route ships.
 *
 * The env override is a deliberate per-invocation act and wins over everything, including a Local-only
 * root, so an experiment inside such a project stays possible. The root beats the config's route because it
 * encodes a data-locality directive rather than a machine preference.
 */
export function resolveSummarizationRoute(input: {
  envSpec: string | undefined;
  configSpec: string | undefined;
  cwd: string | undefined;
  localOnlyRoots: readonly string[];
  home?: string | undefined;
}): ResolvedSummarizationRoute {
  const fromEnv = input.envSpec?.trim();
  if (fromEnv) return { spec: fromEnv, rule: "env-override" };
  const localOnlyRoot = localOnlyRootOf(input.cwd, input.localOnlyRoots, input.home ?? process.env.HOME);
  if (localOnlyRoot) return { spec: undefined, rule: "local-only", localOnlyRoot };
  const fromConfig = input.configSpec?.trim();
  if (fromConfig) return { spec: fromConfig, rule: "config" };
  return { spec: undefined, rule: "none" };
}
