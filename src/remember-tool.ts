/**
 * The `remember` tool: one verified write into the Session state, sequential so two calls in one
 * turn never race the fold. Quotes only, resolved newest-first; the store's commitRemember is the
 * whole policy. Argument repair: a quote passed as `text` (or the reverse) is swapped with a Note,
 * because a model that got the field wrong got the intent right.
 */
import { REMEMBER_TOOL } from "./tool-names.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { readConfigFile, resolveStateConfig, type ReadFileFn } from "./config.ts";
import { commitRemember } from "./store/commit.ts";
import { EVENT_ENTRY_TYPE, type PersistedEvent } from "./store/events.ts";
import type { Proposal } from "./store/verify.ts";
import { buildToolContext } from "./tool-context.ts";
import { formatRemember } from "./tool-text.ts";

export const REMEMBER_KINDS = ["correction", "lift", "decision", "dead-end", "done-when"] as const;
type RememberKind = (typeof REMEMBER_KINDS)[number];

export interface RememberParams { kind: RememberKind; quote?: string; text?: string; evidence?: string; target?: string }

const QUOTED: ReadonlySet<RememberKind> = new Set(["correction", "lift", "done-when"]);

export function proposalOf(params: RememberParams): { proposal: Proposal; note?: string } | { error: string } {
  if (!REMEMBER_KINDS.includes(params.kind)) return { error: `kind must be one of ${REMEMBER_KINDS.join(", ")}.` };
  const quote = params.quote?.trim() || undefined;
  const text = params.text?.trim() || undefined;
  if (QUOTED.has(params.kind)) {
    const words = quote ?? text;
    if (params.kind === "lift" && (!params.target || !words)) return { error: "lift needs `target` (a correction id such as R2) and `quote` (the user's withdrawing words)." };
    if (!words) return { error: `${params.kind} needs \`quote\`: the user's exact words.` };
    const note = quote ? undefined : `Note: quote taken from \`text\`; ${params.kind === "correction" ? "corrections quote the user" : `${params.kind} quotes the user`}, pass \`quote\`.`;
    if (params.kind === "lift") return { proposal: { kind: "lift", target: params.target!, text: words }, note };
    if (params.kind === "done-when") return { proposal: { kind: "done-when", text: words }, note };
    return { proposal: { kind: "correction", text: words }, note };
  }
  const words = text ?? quote;
  if (!words) return { error: `${params.kind} needs \`text\`: one sentence in your own words.` };
  const note = text ? undefined : `Note: text taken from \`quote\`; ${params.kind === "decision" ? "decisions" : "dead ends"} are your own words, pass \`text\`.`;
  if (params.kind === "decision") return { proposal: { kind: "decision", text: words, evidence: params.evidence }, note };
  return { proposal: { kind: "dead-end", text: words, evidence: params.evidence }, note };
}

const PARAMETERS = Type.Object({
  kind: Type.Union(REMEMBER_KINDS.map((kind) => Type.Literal(kind)), { description: "correction: a standing rule the user gave (quote). lift: the user withdrew a correction (target + quote). decision / dead-end: your own one sentence (text, evidence). done-when: the user's acceptance words (quote)." }),
  quote: Type.Optional(Type.String({ description: "The user's exact words, a substring of one user message (12+ chars). Example: \"never use mocks in these tests\"." })),
  text: Type.Optional(Type.String({ description: "Your own sentence for a decision or dead end. Example: \"Copied the ledger modules instead of importing them across extensions\"." })),
  evidence: Type.Optional(Type.String({ description: "C<n>, E<n>, u<n>, \"last command\" or \"last error\"." })),
  target: Type.Optional(Type.String({ description: "For lift: the correction id, e.g. R2." })),
});

export function registerRememberTool(pi: ExtensionAPI, deps: { readConfig: ReadFileFn; now: () => Date } = { readConfig: readConfigFile, now: () => new Date() }): void {
  pi.registerTool({
    name: REMEMBER_TOOL,
    label: "Remember",
    description: "Write one verified item into the session state that survives compaction: a user correction (their exact words), a lift, a decision, a dead end, or the acceptance criterion. Rejections say why and whether to retry.",
    promptGuidelines: [
      `Call \`${REMEMBER_TOOL}\` the moment the user states a standing rule (kind correction, quote their exact words) or when you settle a decision or abandon an approach (kind decision / dead-end, one sentence with evidence C<n>/E<n>/u<n>).`,
      "Never paraphrase a correction: the quote must be a substring of a user message, at least 12 characters, or it is rejected with the closest match.",
    ],
    parameters: PARAMETERS,
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
      const mapped = proposalOf(params as RememberParams);
      if ("error" in mapped) return { content: [{ type: "text", text: `not remembered: ${mapped.error}` }], details: { ok: false, remaining: undefined, rejection: { code: "schema", detail: mapped.error } } };
      const config = resolveStateConfig(deps.readConfig);
      const context = buildToolContext(ctx.sessionManager.getBranch());
      const outcome = commitRemember(mapped.proposal, {
        log: context.log, resolver: context.index, caps: config.caps, nearDuplicateThreshold: config.nearDuplicateThreshold, rememberCap: config.rememberPerSpan,
        now: () => deps.now().toISOString(), appendEntry: (customType: string, data: PersistedEvent) => pi.appendEntry(customType, data),
      });
      const text = `${mapped.note ? `${mapped.note}\n` : ""}${formatRemember(outcome)}`;
      return { content: [{ type: "text", text }], details: outcome.ok ? { ok: true, remaining: outcome.remaining, event: outcome.event } : { ok: false, remaining: outcome.remaining, rejection: outcome.rejection } };
    },
  });
}

export { EVENT_ENTRY_TYPE };
