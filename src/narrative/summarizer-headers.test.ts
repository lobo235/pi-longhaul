/**
 * The Longhaul config's `summarizerHeaders` (summarizer-headers.ts): extra headers on the compaction's own model
 * calls, which pi's `before_provider_headers` event never sees.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { applySummarizerHeaders, resolveSummarizerHeaders, withSummarizerHeaders } from "./summarizer-headers.ts";

const SESSION_ID = "019a2b3c-4d5e-7f80-9a1b-2c3d4e5f6a7b";
const CONFIGURED = resolveSummarizerHeaders({ local: { "x-session-affinity": "{sessionId}", "x-client": "longhaul" } });

test("applySummarizerHeaders: a configured provider gets its headers, with {sessionId} filled in", () => {
  const headers: Record<string, string | null> = { authorization: "Bearer k" };
  applySummarizerHeaders(headers, CONFIGURED, { provider: "local", sessionId: SESSION_ID });
  assert.deepEqual(headers, { authorization: "Bearer k", "x-session-affinity": SESSION_ID, "x-client": "longhaul" });
});

test("applySummarizerHeaders: a provider the config does not name is untouched", () => {
  const headers: Record<string, string | null> = {};
  applySummarizerHeaders(headers, CONFIGURED, { provider: "cloud-vendor", sessionId: SESSION_ID });
  applySummarizerHeaders(headers, CONFIGURED, { provider: undefined, sessionId: SESSION_ID });
  assert.deepEqual(headers, {});
});

test("applySummarizerHeaders: a header already set, in any case and even to null, wins", () => {
  const headers: Record<string, string | null> = { "X-Session-Affinity": "preset", "X-CLIENT": null };
  applySummarizerHeaders(headers, CONFIGURED, { provider: "local", sessionId: SESSION_ID });
  assert.deepEqual(headers, { "X-Session-Affinity": "preset", "X-CLIENT": null });
});

test("applySummarizerHeaders: a session id outside pi's id shape withholds only the headers that use it", () => {
  for (const sessionId of [undefined, "", "has space", "line\r\nx-evil: 1", "a".repeat(200), 42]) {
    const headers: Record<string, string | null> = {};
    applySummarizerHeaders(headers, CONFIGURED, { provider: "local", sessionId });
    assert.deepEqual(headers, { "x-client": "longhaul" }, JSON.stringify(sessionId));
  }
});

test("resolveSummarizerHeaders: only well-formed provider names, header names and single-line templates survive", () => {
  assert.deepEqual(resolveSummarizerHeaders(undefined), {});
  assert.deepEqual(resolveSummarizerHeaders(["local"]), {});
  assert.deepEqual(resolveSummarizerHeaders({ local: "x" }), {});
  assert.deepEqual(
    resolveSummarizerHeaders({
      local: { "x-ok": "{sessionId}", "bad name": "v", "x-crlf": "a\r\nx-evil: 1", "x-num": 3, __proto__x: "v" },
      "bad provider": { "x-ok": "v" },
      empty: {},
    }),
    { local: { "x-ok": "{sessionId}", __proto__x: "v" } },
  );
});

test("resolveSummarizerHeaders + apply: names that collide with object internals are never configured or set", () => {
  const configured = resolveSummarizerHeaders(JSON.parse('{"constructor":{"x-a":"1"},"local":{"__proto__":"v","x-b":"2"}}'));
  const forConstructor: Record<string, string | null> = {};
  applySummarizerHeaders(forConstructor, configured, { provider: "constructor", sessionId: SESSION_ID });
  assert.deepEqual(forConstructor, { "x-a": "1" }, "a provider literally named constructor is just a provider");
  const forLocal: Record<string, string | null> = {};
  applySummarizerHeaders(forLocal, configured, { provider: "local", sessionId: SESSION_ID });
  assert.deepEqual(Object.keys(forLocal), ["x-b"]);
  assert.equal(Object.getPrototypeOf(forLocal), Object.prototype);
  const unconfigured: Record<string, string | null> = {};
  applySummarizerHeaders(unconfigured, resolveSummarizerHeaders({}), { provider: "toString", sessionId: SESSION_ID });
  assert.deepEqual(unconfigured, {}, "an inherited name is not a configured provider");
});

test("withSummarizerHeaders: an unconfigured provider gets its options back unchanged; a configured one runs the caller's transform first", async () => {
  const options = { maxTokens: 10 };
  assert.equal(withSummarizerHeaders(options, CONFIGURED, { provider: "cloud-vendor", sessionId: SESSION_ID }), options);
  const wrapped = withSummarizerHeaders({ maxTokens: 10, transformHeaders: (headers: Record<string, string | null>) => ({ ...headers, "x-client": "caller" }) }, CONFIGURED, { provider: "local", sessionId: SESSION_ID }) as { maxTokens: number; transformHeaders: (h: Record<string, string | null>) => Promise<Record<string, string | null>> };
  assert.equal(wrapped.maxTokens, 10);
  const original = { authorization: "Bearer k" };
  assert.deepEqual(await wrapped.transformHeaders(original), { authorization: "Bearer k", "x-client": "caller", "x-session-affinity": SESSION_ID });
  assert.deepEqual(original, { authorization: "Bearer k" }, "the input headers are not mutated");
});
