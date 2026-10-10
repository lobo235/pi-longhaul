/**
 * Which model runs the summarization, and which models to try in order.
 */
import type { Model } from "@earendil-works/pi-ai";

/**
 * The Longhaul config's own `model` spec, WITHOUT the env override, so a caller can name the rule that
 * chose the summarizer (route-config.ts `resolveSummarizationRoute`, ADR 0003). A missing, non-string
 * or blank `model` means "no spec from here".
 */
export function resolveConfigFileModelSpec(source: Readonly<Record<string, unknown>>): string | undefined {
  return typeof source.model === "string" ? source.model.trim() || undefined : undefined;
}

/** Look up a configured model by provider and model id. Mirrors `ModelRegistry.find`. */
export interface ModelLookup {
  (provider: string, modelId: string): Model<any> | undefined;
}

export interface ResolvedSummarizationModel {
  model: Model<any>;
  /** Set when an override was requested but could not be honoured. */
  fallbackReason?: string;
  /** Set when a configured route exists but does not apply to this session. Logged, never a warning. */
  routeIgnored?: string;
  /**
   * True when the route sends a route-provider session's summarization to a provider outside
   * `routeProviders`: a cost-and-egress crossing the caller logs. Allowed, because the user named it.
   */
  crossProvider?: boolean;
}

/**
 * Pick the model that runs the summarization.
 *
 * Routing is scoped to **Route providers** (CONTEXT.md): a route applies only when the session's
 * provider is named in the Longhaul config's `routeProviders`. Every other session summarizes on its
 * own model, so its conversation never reaches a provider the user did not choose for it, and a
 * local model is never asked to read a session it does not run. The configured route is therefore
 * ignored, not warned about, for those sessions.
 *
 * Why route at all: summarization is decode-bound on a long, mostly carried-forward state, and a
 * sparse mixture-of-experts model can decode several times faster than a dense model of similar
 * quality on the same hardware.
 *
 * `spec` is "provider/model-id", split on the FIRST slash so ids that themselves contain
 * slashes (OpenRouter-style "anthropic/claude-x") still resolve. Any problem with the
 * override degrades to the session model rather than failing compaction. Routing is on fit, not
 * on declared windows: see fit.ts and summarizationAttempts.
 */
export function resolveSummarizationModel(
  sessionModel: Model<any>,
  spec: string | undefined,
  find: ModelLookup,
  routeProviders: readonly string[],
): ResolvedSummarizationModel {
  const trimmed = spec?.trim();
  if (!isRouteProvider(sessionModel.provider, routeProviders)) {
    return trimmed ? { model: sessionModel, routeIgnored: `${sessionModel.provider} is not a route provider; route ${trimmed} applies only to sessions on routeProviders` } : { model: sessionModel };
  }
  if (!trimmed) return { model: sessionModel };

  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) {
    return { model: sessionModel, fallbackReason: `"${trimmed}" is not provider/model-id` };
  }

  const provider = trimmed.slice(0, slash);
  const modelId = trimmed.slice(slash + 1);
  const override = find(provider, modelId);
  if (!override) {
    return { model: sessionModel, fallbackReason: `${trimmed} is not a configured model` };
  }

  // A smaller context window than the session's is not a reason to refuse the route: the prompt
  // is sized against the summarizer's own window per call (fit.ts), and only when it cannot be
  // made to fit does the attempt chain move on to the session model.
  return { model: override, crossProvider: !isRouteProvider(override.provider, routeProviders) };
}

/**
 * True when the Longhaul config's `routeProviders` names `provider` exactly (CONTEXT.md *Route provider*).
 * Exact on purpose: a prefix, a case fold or a pattern would let a provider become routable by being named
 * like one, and the failure that matters -- a summarizer reading a session the user never sent to it -- must
 * not be reachable that way. None by default.
 */
export function isRouteProvider(provider: string | undefined, routeProviders: readonly string[]): boolean {
  return provider !== undefined && provider !== "" && routeProviders.includes(provider);
}

/**
 * Models to try, in order, for one compaction.
 *
 * The configured route goes first (a sparse MoE decodes several times faster). If that call fails
 * AT RUNTIME -- the model is not loaded on the server, the endpoint is down, the gateway rejects it
 * -- retry on the session model, which is what the session has been using all along. A
 * self-summarizing session (not on a route provider, or no route) has exactly one attempt.
 *
 * Whether the retry can actually disable thinking is not knowable from the Model object; a
 * provider that refuses `reasoning: "off"` throws, and then the caller falls back to pi's
 * default path.
 */
export interface SummarizationAttemptOptions {
  /**
   * False once the circuit breaker has opened this route (route-health.ts). The route is then not
   * attempted at all: the chain is exactly what an unrouted session has, so a dead route costs the
   * pass nothing while it is open. The session model is never affected -- it is the session's own.
   */
  routeAvailable?: boolean;
}

export function summarizationAttempts(
  sessionModel: Model<any>,
  routed: ResolvedSummarizationModel,
  options: SummarizationAttemptOptions = {},
): Model<any>[] {
  if (options.routeAvailable === false || routed.model === sessionModel) return [sessionModel];
  return [routed.model, sessionModel];
}

