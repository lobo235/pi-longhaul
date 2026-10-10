/**
 * The continuation probe: does the next span know what to do? The presence measures (measures.ts)
 * ask whether a name appears in the compaction; this asks a model resumed on it. It rebuilds the
 * context a resumed pi session sends — the compaction summary, then the kept messages
 * (buildSessionContext + convertToLlm) — asks for a plan, and scores the plan against the names the
 * session actually touched in its next assistant messages. A floor run with no summary shows what the
 * kept window alone already gives, so an arm is judged by what its compaction adds.
 */
import type { Context, Model, Tool } from "@earendil-works/pi-ai";
import { buildSessionContext, convertToLlm, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { ModelCall } from "../narrative/call.ts";
import { extractJsonCandidate } from "../narrative/parse.ts";
import { baseTokensOf, type WarmBase } from "../narrative/warm.ts";
import type { NameNeeds } from "./measures.ts";

export const PROBE_SYSTEM = "You are a coding agent resuming a session in a repository. Answer the user's last message exactly as asked.";

export const PROBE_QUESTION = [
  "The conversation was just compacted; the summary is at the start. Before you continue, state your plan as one JSON object and nothing else:",
  '{"objective": "<what the user wants now, one sentence>", "next": ["<a file path you will read or edit, or a command you will run>", ...]}',
  "List up to 8 targets, the ones you will touch first, in order. Do not call tools and do not do the work.",
].join("\n");

const toolOf = (name: string, description: string, field: "path" | "command"): Tool => ({ name, description, parameters: Type.Object({ [field]: Type.String() }) });

/** Declared because the kept window has tool calls and results, which the server rejects without tools. */
export const PROBE_TOOLS: Tool[] = [toolOf("read", "Read a file.", "path"), toolOf("edit", "Edit a file.", "path"), toolOf("write", "Write a file.", "path"), toolOf("bash", "Run a shell command.", "command")];

export interface ProbeCompaction {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
}

export function probeContext(pathEntries: SessionEntry[], compaction: ProbeCompaction): Context {
  const parentId = pathEntries.at(-1)?.id ?? null;
  const entry = { type: "compaction", id: "probe-compaction", parentId, timestamp: new Date(0).toISOString(), summary: compaction.summary, firstKeptEntryId: compaction.firstKeptEntryId, tokensBefore: compaction.tokensBefore, fromHook: true } as unknown as SessionEntry;
  const session = buildSessionContext([...pathEntries, entry]);
  const messages = [...convertToLlm(session.messages), { role: "user" as const, content: PROBE_QUESTION, timestamp: 0 }];
  return { systemPrompt: PROBE_SYSTEM, messages, tools: PROBE_TOOLS };
}

/** The request a session sent just before compacting (the state-warm arm's base): the whole path, unsummarized. */
export function sessionRequestOf(pathEntries: SessionEntry[]): WarmBase {
  const messages = convertToLlm(buildSessionContext(pathEntries).messages);
  return { systemPrompt: PROBE_SYSTEM, messages, tools: PROBE_TOOLS, tokens: baseTokensOf(messages) };
}

export function parseProbe(text: string): { objective?: string; targets: string[] } | undefined {
  const candidate = extractJsonCandidate(text);
  if (!candidate) return undefined;
  try {
    const value = JSON.parse(candidate.json) as Record<string, unknown>;
    if (!Array.isArray(value.next)) return undefined;
    const targets = value.next.filter((item): item is string => typeof item === "string" && item.trim() !== "").map((item) => item.trim());
    return { ...(typeof value.objective === "string" ? { objective: value.objective } : {}), targets };
  } catch {
    return undefined;
  }
}

/**
 * Recall of the next span's names by the plan (a needed name is hit when any planned target contains it), and
 * `onTarget`, the planned targets that contain a needed name: recall is capped by how many names a span touches,
 * precision says whether what the resumed model would do first is what the session did.
 */
export function probeScore(targets: string[], needs: NameNeeds): { hit: number; total: number; share: number | null; targets: number; onTarget: number } {
  const names = [...needs.files, ...needs.artifacts];
  const hit = names.filter((name) => targets.some((target) => target.includes(name))).length;
  const onTarget = targets.filter((target) => names.some((name) => target.includes(name))).length;
  return { hit, total: names.length, share: names.length === 0 ? null : hit / names.length, targets: targets.length, onTarget };
}

export interface ProbeResult { hit: number; total: number; share: number | null; targets: number; onTarget: number; parsed: boolean }

export const PROBE_OUTPUT_TOKENS = 800;
export const PROBE_TIMEOUT_MS = 180_000;

const callTarget = (args: Record<string, unknown> | undefined): string | undefined => (typeof args?.path === "string" ? args.path : typeof args?.command === "string" ? args.command : undefined);

/**
 * One reasoning-off request. The plan is the JSON the model wrote, or — when it acts instead of planning — the
 * targets of the tool calls it made: its real next actions. Not tool_choice none: some OpenAI-compatible servers
 * drop a call the model insists on under it and return an empty answer.
 */
export async function runProbe(call: ModelCall, model: Model<any>, context: Context, needs: NameNeeds): Promise<ProbeResult> {
  const { targets, parsed } = await probePlan(call, model, context);
  return { ...probeScore(targets, needs), parsed };
}

/** The resumed model's plan: the targets it wrote, then those of any tool calls it made instead; `parsed` = it gave either. */
export async function probePlan(call: ModelCall, model: Model<any>, context: Context): Promise<{ targets: string[]; parsed: boolean }> {
  const response = await call.complete(model, context, { maxTokens: PROBE_OUTPUT_TOKENS, reasoning: "off", cacheRetention: "none", timeoutMs: PROBE_TIMEOUT_MS });
  if (response.stopReason === "error" || response.stopReason === "aborted") throw new Error(`probe request failed: ${response.errorMessage ?? response.stopReason}`);
  const text = response.content.filter((block) => block.type === "text").map((block) => (block as { text: string }).text).join("");
  const acted = response.content.flatMap((block) => (block.type === "toolCall" ? [callTarget((block as { arguments?: Record<string, unknown> }).arguments)] : [])).filter((target): target is string => target !== undefined);
  const plan = parseProbe(text);
  return { targets: [...(plan?.targets ?? []), ...acted], parsed: plan !== undefined || acted.length > 0 };
}
