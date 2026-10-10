import assert from "node:assert/strict";
import { test } from "node:test";

import type { AssistantMessage } from "@earendil-works/pi-ai";

import { assistantMsg } from "../test-support.ts";
import {
  completeWithTransportRetry,
  DEFAULT_TRANSPORT_RETRY_POLICY,
  isRetryableTransportError,
  type TransportRetryEvent,
} from "./transport-retry.ts";

const errorMsg = (errorMessage: string): AssistantMessage => assistantMsg({ stopReason: "error", errorMessage, content: [] });

/** A produce() that returns the canned responses in order and records how often it ran. */
function producer(responses: Array<AssistantMessage | Error>) {
  const queue = [...responses];
  let runs = 0;
  const produce = async (): Promise<AssistantMessage> => {
    runs++;
    const next = queue.shift();
    if (next === undefined) throw new Error(`produce called ${runs} times, only ${responses.length} canned`);
    if (next instanceof Error) throw next;
    return next;
  };
  return { produce, runs: () => runs };
}

function harness() {
  const sleeps: number[] = [];
  const retries: TransportRetryEvent[] = [];
  return {
    sleeps,
    retries,
    options: {
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
      onRetry: (event: TransportRetryEvent) => {
        retries.push(event);
      },
    },
  };
}

test("transport retry: classification of provider error text", () => {
  const cases: Array<[string, string | undefined, boolean]> = [
    ["socket hang up", "socket hang up", true],
    ["fetch failed", "TypeError: fetch failed", true],
    ["terminated stream", "terminated", true],
    ["other side closed", "Error: other side closed", true],
    ["503 with JSON body", '503: {"message":"gateway.ServiceUnavailableError: model is not loaded"}', true],
    ["502 bad gateway", "502 Bad Gateway", true],
    ["500 internal", "500: internal server error", true],
    ["429 rate limit", "429: rate limit exceeded, please retry", true],
    ["408 request timeout", "408: request timeout", true],
    ["stream ended early", "Anthropic stream ended before message_stop", true],
    ["400 bad request", '400: {"message":"gateway.BadRequestError: `tools` must not be an empty array"}', false],
    ["400 whose body mentions a timeout", '400: {"message":"invalid value for timeout"}', false],
    ["403 forbidden", "403: forbidden", false],
    ["404 not a configured model", "404: not a configured model", false],
    ["quota exhausted", "429: insufficient_quota", false],
    ["billing", "402: billing hard limit reached", false],
    ["context overflow (handled by the fit retry)", "Requested token count exceeds the model's maximum context length of 131072 tokens", false],
    ["overflow phrased as a request error", "the request exceeds the available context size, try increasing it", false],
    ["unknown text", "boom", false],
    ["empty", "", false],
    ["undefined", undefined, false],
  ];
  for (const [name, message, expected] of cases) {
    assert.equal(isRetryableTransportError(message), expected, name);
  }
});

test("transport retry: one dropped call is retried after the base delay and the second answer is returned", async () => {
  const ok = assistantMsg();
  const { produce, runs } = producer([errorMsg("socket hang up"), ok]);
  const h = harness();

  const result = await completeWithTransportRetry(produce, h.options);

  assert.equal(result.response, ok);
  assert.equal(result.retries, 1);
  assert.deepEqual(result.errors, ["socket hang up"]);
  assert.equal(runs(), 2);
  assert.deepEqual(h.sleeps, [DEFAULT_TRANSPORT_RETRY_POLICY.baseDelayMs]);
  assert.deepEqual(h.retries, [
    { attempt: 1, maxRetries: DEFAULT_TRANSPORT_RETRY_POLICY.maxRetries, delayMs: DEFAULT_TRANSPORT_RETRY_POLICY.baseDelayMs, error: "socket hang up" },
  ]);
});

test("transport retry: backoff doubles and the budget is three attempts in total", async () => {
  const last = errorMsg("503: still down");
  const { produce, runs } = producer([errorMsg("terminated"), errorMsg("fetch failed"), last, assistantMsg()]);
  const h = harness();

  const result = await completeWithTransportRetry(produce, h.options);

  assert.equal(result.response, last, "the third error is returned as-is once the retry budget is spent");
  assert.equal(result.retries, 2);
  assert.equal(runs(), 3);
  assert.deepEqual(h.sleeps, [1000, 2000]);
  assert.deepEqual(result.errors, ["terminated", "fetch failed"]);
});

test("transport retry: a deterministic rejection is returned at once, without sleeping", async () => {
  for (const message of ['400: {"message":"gateway.BadRequestError: bad tools"}', "403: forbidden", "insufficient_quota", "boom"]) {
    const { produce, runs } = producer([errorMsg(message), assistantMsg()]);
    const h = harness();
    const result = await completeWithTransportRetry(produce, h.options);
    assert.equal(result.response.errorMessage, message);
    assert.equal(result.retries, 0, message);
    assert.equal(runs(), 1, message);
    assert.deepEqual(h.sleeps, [], message);
  }
});

test("transport retry: a successful answer and an aborted answer are never retried", async () => {
  for (const response of [assistantMsg(), assistantMsg({ stopReason: "aborted", content: [] })]) {
    const { produce, runs } = producer([response, assistantMsg()]);
    const h = harness();
    const result = await completeWithTransportRetry(produce, h.options);
    assert.equal(result.response, response);
    assert.equal(runs(), 1);
    assert.deepEqual(h.sleeps, []);
  }
});

test("transport retry: a thrown transport error is retried like an error answer; a thrown deterministic error propagates", async () => {
  const ok = assistantMsg();
  const thrown = producer([new Error("connect ECONNREFUSED: connection refused"), ok]);
  const h = harness();
  const result = await completeWithTransportRetry(thrown.produce, h.options);
  assert.equal(result.response, ok);
  assert.equal(result.retries, 1);
  assert.match(result.errors[0], /connection refused/);

  const fatal = producer([new Error("no API key configured for provider example"), ok]);
  await assert.rejects(completeWithTransportRetry(fatal.produce, harness().options), /no API key/);
  assert.equal(fatal.runs(), 1);

  const exhausted = producer([new Error("socket hang up"), new Error("socket hang up"), new Error("socket hang up"), ok]);
  await assert.rejects(completeWithTransportRetry(exhausted.produce, harness().options), /socket hang up/);
  assert.equal(exhausted.runs(), 3);
});

test("transport retry: an abort during the backoff returns an aborted answer and runs nothing further", async () => {
  const controller = new AbortController();
  const { produce, runs } = producer([errorMsg("terminated"), assistantMsg()]);
  const result = await completeWithTransportRetry(produce, {
    signal: controller.signal,
    sleep: async () => {
      controller.abort();
      throw new Error("sleep aborted");
    },
  });
  assert.equal(result.response.stopReason, "aborted");
  assert.equal(result.retries, 1);
  assert.equal(runs(), 1);
});

test("transport retry: maxRetries 0 disables it", async () => {
  const dropped = errorMsg("terminated");
  const { produce, runs } = producer([dropped, assistantMsg()]);
  const result = await completeWithTransportRetry(produce, { policy: { maxRetries: 0, baseDelayMs: 1 }, sleep: async () => {} });
  assert.equal(result.response, dropped);
  assert.equal(runs(), 1);
});

test("transport retry: the default sleep honours the signal", async () => {
  const controller = new AbortController();
  const { produce } = producer([errorMsg("terminated"), assistantMsg()]);
  const pending = completeWithTransportRetry(produce, { signal: controller.signal, policy: { maxRetries: 1, baseDelayMs: 60_000 } });
  controller.abort();
  const result = await pending;
  assert.equal(result.response.stopReason, "aborted");
});
