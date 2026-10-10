/**
 * Writes fixtures/setup-check-session.jsonl: a small SYNTHETIC pi session, large enough for pi to compact (more
 * than pi's default 20,000 kept tokens), for the setup guide's optional live check (docs/setup-with-an-agent.md).
 * Every word in it is invented here; nothing comes from a real session. Deterministic: rerun after changing it.
 *
 *   node scripts/setup-check-session.ts
 */
import fs from "node:fs";
import path from "node:path";

const START = Date.parse("2026-01-01T09:00:00.000Z");
let clock = START;
let previous: string | null = null;
const entries: Record<string, unknown>[] = [];
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function push(id: string, message: Record<string, unknown>): void {
  clock += 15_000;
  entries.push({ type: "message", id, parentId: previous, timestamp: new Date(clock).toISOString(), message: { ...message, timestamp: clock } });
  previous = id;
}
const user = (id: string, text: string) => push(id, { role: "user", content: text });
const assistant = (id: string, text: string, calls: Array<{ name: string; arguments: Record<string, unknown> }> = []) =>
  push(id, { role: "assistant", content: [{ type: "text", text }, ...calls.map((call, i) => ({ type: "toolCall", id: `${id}-c${i}`, ...call }))], api: "openai-completions", provider: "example", model: "example-model", usage, stopReason: calls.length ? "toolUse" : "stop" });
const tool = (id: string, callId: string, name: string, text: string) => push(id, { role: "toolResult", toolCallId: callId, toolName: name, content: [{ type: "text", text }], isError: false });

/** A plausible report module, long enough to fill the span: the same small functions over many report kinds. */
function reportModule(): string {
  const kinds = ["orders", "refunds", "invoices", "payouts", "customers", "products", "shipments", "returns", "coupons", "taxes", "subscriptions", "disputes"];
  const blocks = kinds.flatMap((kind) => Array.from({ length: 10 }, (_, i) => [
    `export function ${kind}Summary${i}(rows: Row[], from: Date, to: Date): Summary {`,
    `  const inRange = rows.filter((row) => row.at >= from && row.at < to && row.kind === "${kind}");`,
    `  const total = inRange.reduce((sum, row) => sum + row.amountCents, 0);`,
    `  return { kind: "${kind}", count: inRange.length, totalCents: total, averageCents: inRange.length ? Math.round(total / inRange.length) : 0 };`,
    `}`,
  ].join("\n")));
  return ["// src/report.ts", 'import type { Row, Summary } from "./types.ts";', ...blocks].join("\n\n");
}

function testOutput(passing: number): string {
  const lines = Array.from({ length: 160 }, (_, i) => `ok ${i + 1} - report ${["orders", "refunds", "invoices", "payouts"][i % 4]} summary ${i}`);
  return [...lines, `# tests ${passing}`, `# pass ${passing}`, "# fail 0", "[exit 0]"].join("\n");
}

user("u0", "Before we change anything: what does src/report.ts do?");
assistant("a0", "Reading it.", [{ name: "read", arguments: { path: "src/report.ts" } }]);
tool("r0", "a0-c0", "read", reportModule());
assistant("a0b", "It builds one summary per report kind and date range: a count, a total and an average, all in cents.");
user("u1", "Add a CSV export to the reports page. Stream the rows; do not add any new dependencies.");
assistant("a1", "I'll read the report module first.", [{ name: "read", arguments: { path: "src/report.ts" } }]);
tool("r1", "a1-c0", "read", reportModule());
assistant("a2", "Running the existing tests before changing anything.", [{ name: "bash", arguments: { command: "npm test" } }]);
tool("r2", "a2-c0", "bash", testOutput(160));
user("u2", "Never build the whole file in memory; some exports have a million rows.");
assistant("a3", "Understood. I'll write rows to the response as they are produced.", [{ name: "write", arguments: { path: "src/export.ts", content: "export async function* csvRows() {}\n" } }]);
tool("r3", "a3-c0", "write", "Wrote src/export.ts");
assistant("a4", "Reading the report module again to wire the export into each summary.", [{ name: "read", arguments: { path: "src/report.ts" } }]);
tool("r4", "a4-c0", "read", reportModule());
assistant("a5", "Tests again after the change.", [{ name: "bash", arguments: { command: "npm test" } }]);
tool("r5", "a5-c0", "bash", testOutput(161));
user("u3", "Quote fields that contain commas, quotes or newlines, as RFC 4180 says.");
assistant("a6", "Adding the quoting rule and a test for embedded newlines next.");

const header = { type: "session", version: 3, id: "setup-check", timestamp: new Date(START).toISOString(), cwd: "/tmp/longhaul-setup-check" };
const out = path.join(import.meta.dirname, "..", "fixtures", "setup-check-session.jsonl");
fs.writeFileSync(out, [header, ...entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
process.stdout.write(`${out}: ${entries.length} entries, ${fs.statSync(out).size} bytes\n`);
