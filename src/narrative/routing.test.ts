/**
 * Which model runs the summarization (routing.ts): the configured spec, the override lookup and the summarizer's own budget.
 */
import test from "node:test";
import assert from "node:assert/strict";

import type { Model } from "@earendil-works/pi-ai";

import {
  resolveSummarizationModel,
  isRouteProvider,
  type ModelLookup,
} from "./routing.ts";
import { modelWith } from "../test-support.ts";

// --- summarization model routing -------------------------------------------

function modelNamed(provider: string, id: string, contextWindow: number, maxTokens = 32768): Model<any> {
  return { ...modelWith({ maxTokens }), provider, id, name: id, contextWindow } as Model<any>;
}

const SESSION = modelNamed("local", "dense-27b", 131072);
const FAST = modelNamed("local", "moe-35b", 131072);
/** The Longhaul config's `routeProviders` in these tests: the session's own provider. */
const ROUTE = ["local"];

test("isRouteProvider: a provider is a route provider only when the list names it exactly", () => {
  const routeProviders = ["local", "local-fast"];
  for (const p of ["local", "local-fast"]) assert.equal(isRouteProvider(p, routeProviders), true, `should be a route provider: ${p}`);
  for (const p of [undefined, "", " local ", "Local", "local-", "local_fast", "xlocal", "localx", "openai"]) {
    assert.equal(isRouteProvider(p, routeProviders), false, `should not be a route provider: ${JSON.stringify(p)}`);
  }
  assert.equal(isRouteProvider("local", []), false, "none by default");
});

function lookup(...models: Model<any>[]): ModelLookup {
  return (provider, id) => models.find((m) => m.provider === provider && m.id === id);
}

test("no override spec: summarization stays on the session model", () => {
  for (const spec of [undefined, "", "   "]) {
    const out = resolveSummarizationModel(SESSION, spec, lookup(FAST), ROUTE);
    assert.equal(out.model, SESSION);
    assert.equal(out.fallbackReason, undefined);
  }
});

test("override spec routes summarization to the named model", () => {
  const out = resolveSummarizationModel(SESSION, "local/moe-35b", lookup(SESSION, FAST), ROUTE);
  assert.equal(out.model, FAST);
  assert.equal(out.fallbackReason, undefined);
});

test("override spec is split on the first slash only, so slashed model ids resolve", () => {
  const slashed = modelNamed("openrouter", "anthropic/claude-x", 200000);
  const out = resolveSummarizationModel(SESSION, "openrouter/anthropic/claude-x", lookup(slashed), ROUTE);
  assert.equal(out.model, slashed);
});

test("unknown override model falls back to the session model with a reason", () => {
  const out = resolveSummarizationModel(SESSION, "local/does-not-exist", lookup(SESSION, FAST), ROUTE);
  assert.equal(out.model, SESSION);
  assert.match(out.fallbackReason ?? "", /local\/does-not-exist/);
});

test("malformed override spec falls back to the session model with a reason", () => {
  const out = resolveSummarizationModel(SESSION, "no-slash-here", lookup(SESSION, FAST), ROUTE);
  assert.equal(out.model, SESSION);
  assert.match(out.fallbackReason ?? "", /provider\/model-id/);
});

test("override with a smaller context window than the session is still routed: fit is decided per call", () => {
  const small = modelNamed("lan-box", "moe-35b-mtp", 32768);
  const out = resolveSummarizationModel(SESSION, "lan-box/moe-35b-mtp", lookup(small), ROUTE);
  assert.equal(out.model, small);
  assert.equal(out.fallbackReason, undefined);
});

test("a session whose provider is not a route provider ignores the route and self-summarizes", () => {
  const cloud = modelNamed("cloud-vendor", "big-model", 336384);
  for (const spec of [undefined, "local/moe-35b"]) {
    const out = resolveSummarizationModel(cloud, spec, lookup(SESSION, FAST, cloud), ROUTE);
    assert.equal(out.model, cloud);
    assert.equal(out.fallbackReason, undefined, "an inapplicable route is not a broken one");
  }
  const out = resolveSummarizationModel(cloud, "local/moe-35b", lookup(SESSION, FAST, cloud), ROUTE);
  assert.match(out.routeIgnored ?? "", /cloud-vendor is not a route provider/);
  assert.equal(out.crossProvider, undefined);
});

test("with no routeProviders (the default) no session routes, whatever the config names", () => {
  const out = resolveSummarizationModel(SESSION, "local/moe-35b", lookup(SESSION, FAST), []);
  assert.equal(out.model, SESSION);
  assert.match(out.routeIgnored ?? "", /local is not a route provider/);
});

test("a route-provider session routed to a provider outside routeProviders is flagged cross-provider", () => {
  const cloud = modelNamed("cloud-vendor", "big-model", 336384);
  const out = resolveSummarizationModel(SESSION, "cloud-vendor/big-model", lookup(SESSION, cloud), ROUTE);
  assert.equal(out.model, cloud);
  assert.equal(out.crossProvider, true);
  assert.equal(resolveSummarizationModel(SESSION, "local/moe-35b", lookup(SESSION, FAST), ROUTE).crossProvider, false);
});

