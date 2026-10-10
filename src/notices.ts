/**
 * Once-per-session warnings about a setup Longhaul cannot fix on its own. Each returns the notice
 * text, or undefined when there is nothing to say; index.ts decides when, and remembers it said it.
 */
import path from "node:path";

import { unusableLocalOnlyRoot, type PathRules } from "./narrative/route-config.ts";

/**
 * A compaction landed that Longhaul did not make. pi runs every `session_before_compact` handler --
 * each pays for its own model call -- and keeps the last answer, so a second compactor costs a summary on every
 * compaction and decides by load order which one the session gets.
 */
export function foreignCompactionNotice(details: unknown, fromExtension: boolean): string | undefined {
  const stamp = typeof details === "object" && details !== null ? (details as { compactor?: unknown }).compactor : undefined;
  if (stamp === "state") return undefined;
  const maker = fromExtension ? "another extension's compactor" : "pi's own summarizer";
  return `longhaul: Longhaul did not make this compaction; ${maker} did. If another compactor is installed, pi runs both on every compaction (each pays for a model call) and keeps the last answer: disable one of them.`;
}

/** The smallest context window Longhaul supports: its rendered state alone runs to ~3.4k tokens. */
export const MIN_CONTEXT_WINDOW = 32_768;

/**
 * The session model's window is below the supported minimum. pi's own compaction defaults (reserve 16,384, keep
 * 20,000) already assume more than that, and the rendered state's caps do not scale down.
 */
export function smallWindowNotice(model: { provider: string; id: string; contextWindow?: number } | undefined): string | undefined {
  const window = model?.contextWindow;
  if (!model || typeof window !== "number" || window <= 0 || window >= MIN_CONTEXT_WINDOW) return undefined;
  const count = (value: number) => value.toLocaleString("en-US");
  return `longhaul: ${model.provider}/${model.id} has a ${count(window)}-token context window; Longhaul supports ${count(MIN_CONTEXT_WINDOW)} and up. Its state and the kept recent messages may not leave room for the conversation.`;
}

/**
 * Longhaul config `localOnlyRoots` entries that can never match a session's directory (route-config.ts
 * `unusableLocalOnlyRoot`). Such an entry would otherwise be skipped without a word, and the project it was meant
 * to keep on this machine would route like any other.
 */
export function localOnlyRootsNotice(roots: readonly string[], home: string | undefined, rules: PathRules = path): string | undefined {
  const unusable = roots.flatMap((root) => {
    const reason = unusableLocalOnlyRoot(root, home, rules);
    return reason ? [`"${root}" (${reason})`] : [];
  });
  if (unusable.length === 0) return undefined;
  return `longhaul: localOnlyRoots ${unusable.length === 1 ? "entry" : "entries"} ${unusable.join(", ")} cannot match any directory, so sessions there may be summarized off this machine. Use an absolute path (${rules.sep === "\\" ? "C:\\..." : "/..."}) or ~/... in longhaul.json.`;
}
