/**
 * The recorder's key-adding proxy: only pi's two calls reach the upstream, with the key and the model mapping;
 * anything else is refused on loopback and never forwarded.
 */
import assert from "node:assert/strict";
import * as http from "node:http";
import { test } from "node:test";

import { startProxy } from "./proxy.ts";

interface Seen { method: string; url: string; authorization?: string; body: string }

/** A fake OpenAI-compatible upstream on loopback that records every request and names its own model in the answer. */
async function fakeUpstream(): Promise<{ url: string; seen: Seen[]; close: () => void }> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", authorization: req.headers.authorization, body: Buffer.concat(chunks).toString("utf8") });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ model: "upstream-model-7b", choices: [] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}/v1`, seen, close: () => { server.closeAllConnections(); server.close(); } };
}

/** One request with no keep-alive, so nothing outlives the test. */
function send(port: number, method: string, path: string, body = ""): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, agent: false, headers: body ? { "content-type": "application/json" } : {} }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (text += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("startProxy: pi's chat completion is forwarded with the key and the upstream model, and answered with the label", async (t) => {
  const upstream = await fakeUpstream();
  const proxy = await startProxy({ upstreamUrl: upstream.url, upstreamModel: "upstream-model-7b", labelModel: "local-7b", key: "test-key" });
  t.after(() => { proxy.close(); upstream.close(); });
  const answer = await send(proxy.port, "POST", "/v1/chat/completions", JSON.stringify({ model: "local-7b", messages: [] }));
  assert.equal(answer.status, 200);
  assert.deepEqual(JSON.parse(answer.text), { model: "local-7b", choices: [] });
  assert.equal(upstream.seen.length, 1);
  assert.deepEqual({ ...upstream.seen[0], body: JSON.parse(upstream.seen[0].body) }, { method: "POST", url: "/v1/chat/completions", authorization: "Bearer test-key", body: { model: "upstream-model-7b", messages: [] } });
  const models = await send(proxy.port, "GET", "/v1/models");
  assert.equal(models.status, 200);
  assert.deepEqual(upstream.seen.slice(1).map((seen) => [seen.method, seen.url]), [["GET", "/v1/models"]]);
});

test("startProxy: any other method or path is refused with 403 and never reaches the upstream (table)", async (t) => {
  const upstream = await fakeUpstream();
  const proxy = await startProxy({ upstreamUrl: upstream.url, upstreamModel: "upstream-model-7b", labelModel: "local-7b", key: "test-key" });
  t.after(() => { proxy.close(); upstream.close(); });
  const cases: Array<[string, string, string]> = [
    ["an admin path", "POST", "/v1/key/generate"],
    ["an admin path by GET", "GET", "/v1/key/generate"],
    ["chat completions by GET", "GET", "/v1/chat/completions"],
    ["models by POST", "POST", "/v1/models"],
    ["a path that only starts like chat completions", "POST", "/v1/chat/completions/../../key/generate"],
    ["a query string", "POST", "/v1/chat/completions?x=1"],
    ["the root", "GET", "/"],
  ];
  for (const [name, method, path] of cases) {
    const answer = await send(proxy.port, method, path, method === "POST" ? "{}" : "");
    assert.equal(answer.status, 403, name);
    assert.match(JSON.parse(answer.text).error.message, /proxy/, name);
  }
  assert.deepEqual(upstream.seen, []);
});
