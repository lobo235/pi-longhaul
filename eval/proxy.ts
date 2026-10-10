/**
 * A loopback proxy for the recorder: the sandboxed pi calls it with no key, and it forwards to the upstream
 * OpenAI-compatible endpoint with the key added. It maps the label model id to the upstream id in the request
 * and back in every response line, so the transcript names only the label. Only the two calls pi makes through it
 * are forwarded: anything else that can reach loopback (the sandbox shares the host network) gets a 403 and never
 * reaches the upstream with the key.
 */
import * as http from "node:http";
import * as https from "node:https";

export interface ProxyOptions { upstreamUrl: string; upstreamModel: string; labelModel: string; key?: string }

/** pi's calls with a `/v1` baseUrl, matched exactly (method, path, no query): `<baseUrl>/chat/completions` and the model list. */
const ALLOWED_CALLS = new Set(["POST /v1/chat/completions", "GET /v1/models"]);

function refuse(req: http.IncomingMessage, res: http.ServerResponse): void {
  req.resume();
  res.writeHead(403, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message: "proxy: only POST /v1/chat/completions and GET /v1/models are forwarded" } }));
}

function forwardHeaders(body: Buffer, key: string | undefined): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = { "content-type": "application/json", "content-length": body.length };
  if (key) headers.authorization = `Bearer ${key}`;
  return headers;
}

/** Rewrites each `[from, to]` pair line by line, so a split chunk cannot hide a name across a boundary. */
function lineRewriter(pairs: [string, string][], write: (text: string) => void) {
  const apply = (text: string) => pairs.reduce((out, [from, to]) => out.split(from).join(to), text);
  let pending = "";
  return {
    push(chunk: string) {
      pending += chunk;
      const cut = pending.lastIndexOf("\n");
      if (cut < 0) return;
      write(apply(pending.slice(0, cut + 1)));
      pending = pending.slice(cut + 1);
    },
    end() { if (pending) write(apply(pending)); },
  };
}

export async function startProxy(options: ProxyOptions): Promise<{ port: number; close: () => void }> {
  const upstream = new URL(options.upstreamUrl.replace(/\/$/, ""));
  const client = upstream.protocol === "https:" ? https : http;
  const names: [string, string][] = [[options.upstreamModel, options.labelModel], [upstream.host, "upstream"], [upstream.hostname, "upstream"]];
  const server = http.createServer((req, res) => {
    if (!ALLOWED_CALLS.has(`${req.method} ${req.url}`)) return refuse(req, res);
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      let text = Buffer.concat(chunks).toString("utf8");
      if (text) {
        let parsed: { model?: string };
        try { parsed = JSON.parse(text) as { model?: string }; } catch { res.writeHead(400); res.end(); return; }
        parsed.model = options.upstreamModel;
        text = JSON.stringify(parsed);
      }
      const body = Buffer.from(text);
      const suffix = (req.url ?? "/").replace(/^\/v1/, "");
      const outgoing = client.request(`${upstream.href}${suffix}`, { method: req.method, headers: forwardHeaders(body, options.key) }, (answer) => {
        res.writeHead(answer.statusCode ?? 502, { "content-type": answer.headers["content-type"] ?? "application/json" });
        const rewrite = lineRewriter(names, (part) => res.write(part));
        answer.setEncoding("utf8");
        answer.on("data", (chunk: string) => rewrite.push(chunk));
        answer.on("end", () => { rewrite.end(); res.end(); });
      });
      outgoing.on("error", (error) => {
        const message = names.reduce((out, [from, to]) => out.split(from).join(to), error.message);
        res.writeHead(502);
        res.end(JSON.stringify({ error: { message: `proxy: ${message}` } }));
      });
      outgoing.end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as { port: number }).port, close: () => server.close() };
}
