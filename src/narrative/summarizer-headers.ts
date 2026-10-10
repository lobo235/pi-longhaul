/**
 * The Longhaul config's `summarizerHeaders`: extra HTTP headers on the compaction's own model calls.
 *
 * pi lets an extension add headers to the requests its agent loop makes (`before_provider_headers`), but a
 * compaction's summarizer calls the model registry directly and that event never sees it. A provider that routes
 * by a header -- a session-affinity key that keeps one conversation on one cache-holding server, a client tag --
 * would otherwise get the summarizer's request without it. Shape: `{ "<provider>": { "<header>": "<template>" } }`;
 * `{sessionId}` in a template is the pi session id, the only placeholder. Empty by default: nothing is sent.
 *
 * Guarantees: a header the request already carries (the provider's configured headers, any letter case, even
 * null) wins; a session id outside pi's id shape is never sent, and a header that needs one is withheld; nothing
 * here throws, because it runs inside a request.
 */

export type SummarizerHeaders = Readonly<Record<string, Readonly<Record<string, string>>>>;

const PLACEHOLDER = "{sessionId}";
const PROVIDER_NAME_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** RFC 9110 token: what an HTTP field name may contain. */
const HEADER_NAME_SHAPE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/** Visible ASCII and spaces only: a template can never carry a line break into the request. */
const HEADER_VALUE_SHAPE = /^[\x20-\x7e]*$/;
/** pi's rule for a session id (assertValidSessionId), with a length bound. */
const SESSION_ID_SHAPE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/;

/** The usable part of a config value: well-formed provider names, header names and templates; the rest is dropped. */
export function resolveSummarizerHeaders(raw: unknown): SummarizerHeaders {
  const resolved: Record<string, Record<string, string>> = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return resolved;
  for (const [provider, block] of Object.entries(raw)) {
    if (!PROVIDER_NAME_SHAPE.test(provider) || typeof block !== "object" || block === null || Array.isArray(block)) continue;
    // `__proto__` is a valid field-name token, but assigning it to a headers object reaches the prototype setter.
    const headers = Object.entries(block).filter((entry): entry is [string, string] => HEADER_NAME_SHAPE.test(entry[0]) && entry[0] !== "__proto__" && typeof entry[1] === "string" && HEADER_VALUE_SHAPE.test(entry[1]));
    if (headers.length > 0) resolved[provider] = Object.fromEntries(headers);
  }
  return resolved;
}

/** Add this provider's configured headers to `headers`, in place. Never throws, never overwrites. */
export function applySummarizerHeaders(
  headers: Record<string, string | null>,
  configured: SummarizerHeaders,
  request: { provider: string | undefined; sessionId: unknown },
): void {
  // Own keys only: a provider named like an inherited member (`toString`) is not configured.
  if (request.provider === undefined || !Object.hasOwn(configured, request.provider)) return;
  const wanted = configured[request.provider];
  const present = new Set(Object.keys(headers).map((name) => name.toLowerCase()));
  const sessionId = typeof request.sessionId === "string" && SESSION_ID_SHAPE.test(request.sessionId) ? request.sessionId : undefined;
  for (const [name, template] of Object.entries(wanted)) {
    if (present.has(name.toLowerCase())) continue;
    if (template.includes(PLACEHOLDER) && sessionId === undefined) continue;
    headers[name] = template.split(PLACEHOLDER).join(sessionId ?? "");
    present.add(name.toLowerCase());
  }
}

type Headers = Record<string, string | null>;
type HeaderTransform = (headers: Headers) => Headers | Promise<Headers>;

/**
 * The same as a request option: pi applies `transformHeaders` after the provider's configured headers, so those
 * still win. A transform the caller already set runs first.
 */
export function withSummarizerHeaders<T extends object>(
  options: T,
  configured: SummarizerHeaders,
  request: { provider: string | undefined; sessionId: unknown },
): T | (T & { transformHeaders: HeaderTransform }) {
  if (request.provider === undefined || !Object.hasOwn(configured, request.provider)) return options;
  const previous = (options as { transformHeaders?: HeaderTransform }).transformHeaders;
  return {
    ...options,
    transformHeaders: async (headers: Headers) => {
      const next = { ...(previous ? await previous(headers) : headers) };
      applySummarizerHeaders(next, configured, request);
      return next;
    },
  };
}
