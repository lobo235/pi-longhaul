/**
 * A recorded transcript as dry-replay steps (score/replay.ts): each user message starts a run whose
 * turns are the assistant messages that followed it, with every tool call answered by its recorded
 * result; a custom message is a notice (it triggered a run when assistant messages follow it); other
 * extensions' custom entries are re-appended in place; compactions happen where the recording had
 * them. What the replay regenerates (this extension's own entries, system-pin's) or cannot drive (a
 * user's `!` shell run) is skipped and counted. The steps carry transcript text: never print them.
 */
import { LEGACY_TOOL_NAMES } from "../tool-names.ts";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import type { ReplayStep, ScriptCall, ScriptTurn } from "./replay.ts";
import { isRec, type Rec } from "../message-text.ts";

/** Custom entries the replay writes itself: carrying the recorded ones too would double them. */
const REGENERATED = /^(compaction-state|system-pin)\./;


const textOf = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.filter((part) => isRec(part) && part.type === "text").map((part) => String((part as Rec).text ?? "")).join("") : "";

export interface RecordedSteps {
  steps: ReplayStep[];
  /** What was not replayed, by kind (custom type, message role or entry type). */
  skipped: Record<string, number>;
}

/** The recorded result of every tool call, by call id. */
function resultsOf(branch: SessionEntry[]): Map<string, { output: string; error: boolean }> {
  const results = new Map<string, { output: string; error: boolean }>();
  for (const entry of branch) {
    const message = entry.type === "message" ? (entry.message as unknown as Rec) : undefined;
    if (message?.role === "toolResult" && typeof message.toolCallId === "string") results.set(message.toolCallId, { output: textOf(message.content), error: message.isError === true });
  }
  return results;
}

function turnOf(message: Rec, results: Map<string, { output: string; error: boolean }>): ScriptTurn {
  const content = Array.isArray(message.content) ? message.content.filter(isRec) : [];
  const calls: ScriptCall[] = content.filter((part) => part.type === "toolCall").map((part) => {
    const result = results.get(String(part.id));
    // A transcript recorded before the rename names the tools `remember` / `recall`; replay them as today's tools.
    const name = String(part.name);
    return { tool: LEGACY_TOOL_NAMES[name] ?? name, args: isRec(part.arguments) ? part.arguments : {}, output: result?.output ?? "", ...(result?.error ? { error: true } : {}) };
  });
  return calls.length ? { calls } : { text: textOf(message.content) };
}

/** The kinds a skip may be reported as; anything else is reported by its group, never by its own text (security.md T1). */
const SKIP_KINDS = new Set(["bashExecution", "branchSummary", "compactionSummary", "compaction-state.event", "compaction-state.span", "system-pin.patch", "system-pin.release"]);
const skipKindOf = (kind: string): string => (SKIP_KINDS.has(kind) ? kind : kind.startsWith("compaction-state.") ? "compaction-state.other" : kind.startsWith("system-pin.") ? "system-pin.other" : "other-role");

export function stepsOf(branch: SessionEntry[]): RecordedSteps {
  const steps: ReplayStep[] = [];
  const skipped: Record<string, number> = Object.create(null);
  const skip = (kind: string) => {
    const key = skipKindOf(kind);
    skipped[key] = (skipped[key] ?? 0) + 1;
  };
  const results = resultsOf(branch);
  let run: Extract<ReplayStep, { turns: ScriptTurn[] }> | undefined;
  for (const entry of branch) {
    if (entry.type === "compaction") {
      steps.push({ kind: "compact" });
      run = undefined;
    } else if (entry.type === "custom_message") {
      run = { kind: "notice", text: textOf(entry.content), turns: [] };
      steps.push(run);
    } else if (entry.type === "custom") {
      if (REGENERATED.test(entry.customType)) skip(entry.customType);
      else steps.push({ kind: "entry", customType: entry.customType, data: entry.data });
    } else if (entry.type === "message") {
      const message = entry.message as unknown as Rec;
      if (message.role === "user") {
        run = { kind: "user", text: textOf(message.content), turns: [] };
        steps.push(run);
      } else if (message.role === "assistant" && run) run.turns.push(turnOf(message, results));
      else if (message.role !== "toolResult" && message.role !== "assistant") skip(String(message.role));
    }
  }
  return { steps, skipped };
}
