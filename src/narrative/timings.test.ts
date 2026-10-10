/**
 * timings.ts: the fetch wrapper that splits a call's wall time into waiting for the prompt
 * (prefill) and generating the answer (decode), plus the gap from the session's last assistant
 * message to the hook. The wrapper must be invisible to the caller — same bytes, status and
 * headers, streaming preserved — and it must never be installed for an adapter that rejects a
 * custom fetch, because the google adapters throw on one.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { sinceLastAssistantMessage, timedTransport, TIMED_TRANSPORT_APIS } from "./timings.ts";

/** A clock the test drives, so every timing assertion is exact rather than a tolerance. */
function fakeClock(): { now: () => number; advance: (ms: number) => void } {
  let t = 1_000;
  return { now: () => t, advance: (ms) => void (t += ms) };
}

test("no wrapper for an adapter that rejects a custom fetch", () => {
  for (const api of ["google-generative-ai", "google-vertex", "bedrock-converse-stream", "", undefined]) {
    assert.equal(timedTransport({ api }), undefined, `api ${api} must not be wrapped`);
  }
  // The allow-list is exactly the adapters verified to read `options.fetch`; a new api is denied
  // until someone proves otherwise.
  assert.ok(TIMED_TRANSPORT_APIS.has("openai-completions"));
  assert.ok(!TIMED_TRANSPORT_APIS.has("google-generative-ai"));
  assert.ok(!TIMED_TRANSPORT_APIS.has("google-vertex"));
});

test("separates the prefill wait from the generation window", async () => {
  const clock = fakeClock();
  let source: ReadableStreamDefaultController<Uint8Array> | undefined;
  const base: typeof globalThis.fetch = async () => {
    clock.advance(120); // the server accepts the request and starts reading the prompt
    return new Response(new ReadableStream<Uint8Array>({ start(controller) { source = controller; } }), {
      status: 201,
      statusText: "Created",
      headers: { "x-test": "yes" },
    });
  };
  const transport = timedTransport({ api: "openai-completions" }, base, clock.now);
  assert.ok(transport);

  const response = await transport.fetch("https://example.test/v1/chat/completions", { method: "POST" });
  assert.equal(response.status, 201);
  assert.equal(response.statusText, "Created");
  assert.equal(response.headers.get("x-test"), "yes");
  assert.equal(transport.timings.headersMs, 120); // nothing has moved the clock since

  const body = response.text();
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  clock.advance(80); // prefill: the prompt is processed before any token exists
  source!.enqueue(new TextEncoder().encode("first"));
  await tick(); // let the pipe deliver the chunk before the clock moves on
  clock.advance(400); // generation: the rest of the answer
  source!.enqueue(new TextEncoder().encode("second"));
  source!.close();

  assert.equal(await body, "firstsecond"); // the body is passed through unchanged
  // firstChunkMs - headersMs is the prefill wait (80ms), the remainder is generation (400ms):
  // this split is the whole point of the wrapper (a slow model and a slow prompt look identical
  // in a call's total wall time).
  assert.equal(transport.timings.firstChunkMs, 200);
  assert.equal(transport.timings.endedMs, 600);
});

test("a buffered (bodyless) response is timed and handed through as it is", async () => {
  const clock = fakeClock();
  const base: typeof globalThis.fetch = async () => {
    clock.advance(75);
    return new Response(null, { status: 204 });
  };
  const transport = timedTransport({ api: "anthropic-messages" }, base, clock.now);
  assert.ok(transport);

  const response = await transport.fetch("https://example.test/v1/messages", { method: "POST" });

  assert.equal(response.status, 204);
  assert.equal(transport.timings.headersMs, 75);
  assert.equal(transport.timings.firstChunkMs, 75); // nothing to stream: headers are the answer
  assert.equal(transport.timings.endedMs, 75);
});

test("a transport retry counts its fetches and keeps the attempt that answered", async () => {
  const clock = fakeClock();
  let calls = 0;
  const base: typeof globalThis.fetch = async () => {
    calls++;
    clock.advance(200);
    if (calls === 1) throw new Error("connection reset");
    clock.advance(10);
    return new Response("{}", { status: 200 });
  };
  const transport = timedTransport({ api: "openai-completions" }, base, clock.now);
  assert.ok(transport);

  await assert.rejects(() => transport.fetch("https://example.test/", {}));
  const response = await transport.fetch("https://example.test/", {});
  assert.equal(await response.text(), "{}");
  assert.equal(transport.timings.requests, 2);
  assert.equal(transport.timings.headersMs, 210); // the second attempt's, not the failed one's
});

test("sinceLastAssistantMessage reports the gap from the last assistant message", () => {
  const entries = [
    { message: { role: "assistant" }, timestamp: "2026-09-16T07:00:00.000Z" },
    { message: { role: "user" }, timestamp: "2026-09-16T07:00:05.000Z" },
    { message: { role: "assistant" }, timestamp: "2026-09-16T07:00:10.000Z" },
    { message: { role: "toolResult" }, timestamp: "2026-09-16T07:00:11.000Z" },
  ];
  const now = Date.parse("2026-09-16T07:00:12.500Z");

  assert.equal(sinceLastAssistantMessage(entries, now), 2_500);
  // Entries without a usable timestamp are skipped, not counted as zero.
  assert.equal(sinceLastAssistantMessage([{ message: { role: "assistant" } }], now), undefined);
  assert.equal(sinceLastAssistantMessage([{ message: { role: "user" }, timestamp: "nope" }], now), undefined);
  assert.equal(sinceLastAssistantMessage([], now), undefined);
  // A clock skew must not produce a negative duration.
  assert.equal(sinceLastAssistantMessage(entries, Date.parse("2026-09-16T06:59:00.000Z")), 0);
});
