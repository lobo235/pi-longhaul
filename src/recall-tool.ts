/**
 * The `recall` tool: read-only, parallel-safe, answers from the Session state store, the span
 * records and the live ledger of THIS session only. Capped at RECALL_CHARS_CAP so a broad query
 * costs a bounded number of tokens; the cap line says how to narrow.
 */
import { RECALL_TOOL } from "./tool-names.ts";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { readConfigFile, resolveStateConfig, type ReadFileFn } from "./config.ts";
import { recallOutput } from "./store/output.ts";
import { recall, RECALL_DEFAULT_LIMIT, type RecallWhat } from "./store/recall.ts";
import { buildToolContext, liveLedger } from "./tool-context.ts";
import { formatOutput, formatRecall, RECALL_CHARS_CAP } from "./tool-text.ts";

const WHATS: readonly (RecallWhat | "output")[] = ["span", "commands", "errors", "decisions", "dead-ends", "corrections", "message", "files", "output", "all"];
const LIMIT_MAX = 100;

const PARAMETERS = Type.Object({
  what: Type.Optional(Type.Union(WHATS.map((what) => Type.Literal(what)), { description: "What to search. Omit to search every kind. span: a span number's narrative; message: a user message by ordinal (u12); files: the files read or modified before the last compaction; output: the raw output behind a command or error id (query=C12 or E3)." })),
  query: Type.Optional(Type.String({ description: "A span number, an ordinal (u12), a command or error id for output (C12), or a case-insensitive substring. Example: what=commands query=\"npm test\"." })),
  offset: Type.Optional(Type.Integer({ minimum: 0, description: "output only: where the next page starts, as the previous page said." })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: LIMIT_MAX, description: `Hits to return (default ${RECALL_DEFAULT_LIMIT}).` })),
  format: Type.Optional(Type.Union([Type.Literal("brief"), Type.Literal("full")], { description: "full adds retired/lifted markers." })),
});

function outputResult(branch: SessionEntry[], ref: string, offset: number | undefined) {
  const result = recallOutput(branch, liveLedger(branch), { ref, offset });
  return { content: [{ type: "text" as const, text: formatOutput(result) }], details: { total: result.kind === "output" ? 1 : 0, shown: result.kind === "output" ? 1 : 0, what: "output" } };
}

export function registerRecallTool(pi: ExtensionAPI, deps: { readConfig: ReadFileFn } = { readConfig: readConfigFile }): void {
  pi.registerTool({
    name: RECALL_TOOL,
    label: "Recall",
    description: "Look up what compaction retired or a span's narrative: commands with exit codes, errors, decisions, dead ends, corrections, files read or modified before the last compaction, a user message by ordinal, or the exact output of a command or error id (what=output, paged). Before re-running a command just to see its output again, recall its output. Answers come from this session's own record, capped at 4,000 characters (output: 8,000 per page).",
    promptGuidelines: [
      `Before re-running a command or re-reading a file to find out what happened earlier, call \`${RECALL_TOOL}\` (commands <pattern>, errors, files <pattern>, span N) — the state's headings say what was retired.`,
      "Narrow before you widen: `what` plus a query is cheaper than a bare recall, and the cap line tells you when a query was too broad.",
    ],
    parameters: PARAMETERS,
    executionMode: "parallel",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
      const { what, query, limit, format, offset } = params as { what?: string; query?: string; limit?: number; format?: "brief" | "full"; offset?: number };
      if (what !== undefined && !WHATS.includes(what as RecallWhat)) return { content: [{ type: "text", text: `what must be one of ${WHATS.join(", ")}.` }], details: { total: 0, shown: 0, what } };
      if (what === "output") return outputResult(ctx.sessionManager.getBranch(), query ?? "", offset);
      const config = resolveStateConfig(deps.readConfig);
      const context = buildToolContext(ctx.sessionManager.getBranch());
      const bounded = Math.min(LIMIT_MAX, Math.max(1, Math.trunc(limit ?? RECALL_DEFAULT_LIMIT) || RECALL_DEFAULT_LIMIT));
      const result = recall({ what: what as RecallWhat | undefined, query, limit: bounded }, { log: context.log, ledger: context.ledger, messageText: (ordinal) => context.index.textOf(ordinal), caps: config.caps, files: context.files });
      const text = formatRecall(result.hits, result.total, format ?? "brief", RECALL_CHARS_CAP);
      return { content: [{ type: "text", text }], details: { total: result.total, shown: result.hits.length, what: what ?? "all" } };
    },
  });
}
