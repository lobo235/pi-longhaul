/**
 * The gate in front of append, shared by both hands. A proposal names a message by ordinal (the
 * diff hand) or by the user's words alone (the tool hand); the resolver (intent.ts) binds the entry
 * id. Ids and seq are issued from the projection's cursor at verification time so replay reproduces
 * them. Rejections are data (events.ts); nothing throws. A quote is stored WHOLE: `holds()`
 * re-verifies it as a substring on every replay, so any cut belongs to the renderer (render.ts,
 * with its `… (recall message uN)` marker), never to the store.
 */
import { ownRuleOf, withoutReplacedWords } from "./lift-replacement.ts";
import { liftNamesRule } from "./lift-words.ts";
import type { Caps, Now, Provenance, Quote, Rejection, StateEvent } from "./events.ts";
import { findNearDuplicate } from "./near-duplicate.ts";
import { activeCorrections, activeDeadEnds, activeDecisions, applyEvent, liftTarget, type SessionState } from "./project.ts";

export type Proposal =
  | { kind: "objective"; ref?: string; text: string; doneWhen?: { ref?: string; text: string } }
  | { kind: "done-when"; ref?: string; text: string }
  | { kind: "correction"; ref?: string; text: string }
  | { kind: "lift"; target: string; ref?: string; text: string }
  | { kind: "decision"; text: string; evidence?: string }
  | { kind: "dead-end"; text: string; evidence?: string }
  | { kind: "now"; now: Now };

export type QuoteResolution =
  | { ok: true; quote: Quote; position: number }
  | { ok: false; rejection: Extract<Rejection, { code: "unknown-ref" | "not-user-message" | "not-substring" | "empty" }> };

export interface QuoteResolver {
  resolve(text: string, ref?: string): QuoteResolution;
  position(messageId: string): number | undefined;
  /** The whole user message a quote resolved to, line breaks kept (a lift is judged on it, sentence by sentence). */
  messageText(messageId: string): string | undefined;
  hasEvidence(evidence: string): boolean;
}

export interface VerifyContext {
  resolver: QuoteResolver;
  state: SessionState;
  provenance: Provenance;
  caps: Caps;
  nearDuplicateThreshold: number;
  /** Accepted remember writes already in this span (the cap counts accepted writes only). */
  acceptedThisSpan: number;
  rememberCap: number;
}

export type Verdict = { ok: true; event: StateEvent } | { ok: false; rejection: Rejection };

const reject = (rejection: Rejection): Verdict => ({ ok: false, rejection });

function checkText(text: string, max: number): Rejection | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { code: "empty" };
  if (trimmed.length > max) return { code: "too-long", max, actual: trimmed.length };
  return undefined;
}

function checkEvidence(evidence: string | undefined, ctx: VerifyContext): Rejection | undefined {
  if (evidence === undefined) return undefined;
  return ctx.resolver.hasEvidence(evidence) ? undefined : { code: "unknown-evidence", evidence };
}

/**
 * The event body `stamp` completes, with provenance stripped. Written as a type parameter so the
 * conditional distributes over the union: `Omit<StateEvent, …>` alone collapses to the members'
 * COMMON keys (`kind`), which would reject every field a caller passes.
 */
type StrippedBody<T> = T extends unknown ? Omit<T, keyof Provenance | "seq"> : never;

function stamp(ctx: VerifyContext, evidence: string | undefined, body: StrippedBody<StateEvent>): Verdict {
  const event = { ...ctx.provenance, ...(evidence !== undefined ? { evidence } : {}), seq: ctx.state.seq + 1, ...body } as StateEvent;
  return { ok: true, event };
}

function verifyQuoteKind(proposal: Extract<Proposal, { kind: "objective" | "done-when" | "correction" | "lift" }>, ctx: VerifyContext): Verdict {
  const resolved = ctx.resolver.resolve(proposal.text, proposal.ref);
  if (!resolved.ok) return reject(resolved.rejection);
  switch (proposal.kind) {
    case "objective": {
      let doneWhen: Quote | undefined;
      if (proposal.doneWhen) {
        const done = ctx.resolver.resolve(proposal.doneWhen.text, proposal.doneWhen.ref);
        if (!done.ok) return reject(done.rejection);
        doneWhen = done.quote;
      }
      const current = ctx.state.objective;
      if (current) {
        // The same message quoted again is no move: it would push the objective onto its own history and drop its
        // done-when. Only the done-when it lacked is new.
        if (resolved.quote.messageId === current.quote.messageId) {
          if (doneWhen && !current.doneWhen) return stamp(ctx, undefined, { kind: "objective.doneWhen", quote: doneWhen });
          return reject({ code: "objective-unchanged", ordinal: current.quote.ordinal });
        }
        // The summarizer moves the objective forward only: the user returns to earlier work in a new message. An
        // explicit remember is the agent's own deliberate choice and may point back.
        const currentPosition = ctx.resolver.position(current.quote.messageId) ?? -1;
        if (ctx.provenance.source !== "remember" && resolved.position < currentPosition) return reject({ code: "objective-not-later", ordinal: resolved.quote.ordinal, targetOrdinal: current.quote.ordinal });
      }
      return stamp(ctx, undefined, { kind: "objective.set", quote: resolved.quote, doneWhen });
    }
    case "done-when":
      if (!ctx.state.objective) return reject({ code: "no-objective" });
      return stamp(ctx, undefined, { kind: "objective.doneWhen", quote: resolved.quote });
    case "correction": {
      // A rule the user lifted stays lifted when the message that gave it is shown again (a span carried after a
      // failed pass, prepare.ts carryUnlabeled): only a new message saying it again adopts it again.
      const liftedHere = ctx.state.corrections.filter((item) => item.liftedBy && item.quote.messageId === resolved.quote.messageId);
      const duplicate = findNearDuplicate(resolved.quote.text, [...activeCorrections(ctx.state), ...liftedHere].map((item) => ({ id: item.id, text: item.quote.text })), ctx.nearDuplicateThreshold);
      if (duplicate) return reject({ code: "near-duplicate", earlierId: duplicate.id, overlap: duplicate.overlap });
      return stamp(ctx, undefined, { kind: "correction.add", id: `R${ctx.state.cursor.R + 1}`, quote: resolved.quote });
    }
    case "lift": {
      // The rule the projection will lift (project.ts liftTarget): an old transcript can carry a reminted id. A target
      // written u<n> names the rule by the message that gave it: a rule labeled in this same pass has no id the model saw.
      const byOrdinal = /^u\d+$/.test(proposal.target);
      const named = byOrdinal ? [...ctx.state.corrections].reverse().find((item) => item.quote.ordinal === proposal.target && !item.retired) : liftTarget(ctx.state.corrections, proposal.target);
      if (!named) return reject({ code: "unknown-target", target: proposal.target, known: activeCorrections(ctx.state).map((item) => item.id) });
      const target = named;
      if (target.liftedBy) {
        // A replaced rule's lifting message gave a rule of its own, quoted whole, so it names the old rule too: a
        // repeated lift would pass the check against it and withdraw whatever else that message set. Only a lift
        // naming the replacement reaches it; the note shows its words (review SEC-1301).
        const replacement = replacementOf(target, ctx.state.corrections, resolved.quote.messageId);
        if (replacement !== target && !replacement.liftedBy) {
          const own = ownRuleOf(replacement.quote.text, replacedBy(replacement, ctx.state.corrections));
          const shown = (text: string) => { const flat = text.replace(/\s+/g, " "); return flat.length > ctx.caps.correctionChars ? `${flat.slice(0, ctx.caps.correctionChars - 1)}…` : flat; };
          return reject({ code: "lift-replaced", target: target.id, by: replacement.quote.ordinal, replacement: replacement.id, rule: shown(replacement.quote.text), ...(own ? { alsoSet: shown(own) } : {}) });
        }
        return reject({ code: "already-lifted", target: target.id, by: target.liftedBy.ordinal });
      }
      const targetPosition = ctx.resolver.position(target.quote.messageId) ?? -1;
      if (resolved.position <= targetPosition) return reject({ code: "lift-not-later", target: target.id, targetOrdinal: target.quote.ordinal, ordinal: resolved.quote.ordinal });
      // The whole message the quote stands in must withdraw it (security.md T2): a quote only locates the message, so
      // "forget: no force-pushing" cut out of "don't forget: no force-pushing" is judged as the message says it.
      const message = ctx.resolver.messageText(resolved.quote.messageId) ?? "";
      if (!liftNamesRule(message, target.quote.text)) return reject({ code: "lift-unnamed", target: target.id, ordinal: resolved.quote.ordinal, rule: target.quote.text.replace(/\s+/g, " ").slice(0, 100) });
      // A replacement names the rule it replaced, so a repeated lift of that rule passes the check above: it must
      // also name what the replacement set of its own (review SEC-1401).
      const replaced = replacedBy(target, ctx.state.corrections);
      const own = ownRuleOf(target.quote.text, replaced);
      // Named both as written and without the old rule's words: masking alone moves the own rule's first word, so a
      // scope word in a repeated lift ("... lifted for production too") would name it (review SEC-1701).
      if (own && !(liftNamesRule(message, own) && liftNamesRule(message, withoutReplacedWords(own, replaced)))) return reject({ code: "lift-unnamed", target: target.id, ordinal: resolved.quote.ordinal, rule: own.replace(/\s+/g, " ").slice(0, 100) });
      return stamp(ctx, undefined, { kind: "correction.lift", target: target.id, by: { messageId: resolved.quote.messageId, ordinal: resolved.quote.ordinal } });
    }
  }
}

type Correction = SessionState["corrections"][number];

/** The texts of the rules `replacement`'s message lifted: what it replaced, if it is a replacement at all. */
function replacedBy(replacement: Correction, corrections: readonly Correction[]): string[] {
  return corrections.filter((item) => item !== replacement && item.liftedBy?.messageId === replacement.quote.messageId).map((item) => item.quote.text);
}

/**
 * The rule now standing in for `rule`: a lifted rule whose lifting message gave a rule of its own (a narrowing, "the
 * tab rule doesn't apply to JSON; keep tabs in TypeScript") was replaced by it. Followed through any number of
 * replacements, only to name it in a refusal: the model may have no id for it yet. `rule` itself when nothing did.
 */
function replacementOf(rule: Correction, corrections: readonly Correction[], liftingMessageId: string): Correction {
  let current = rule;
  for (let hops = 0; current.liftedBy && hops < corrections.length; hops++) {
    const by = current.liftedBy.messageId;
    const next = [...corrections].reverse().find((item) => item.quote.messageId === by && !item.retired && item !== current);
    if (!next || by === liftingMessageId) break;
    current = next;
  }
  return current;
}

function verifyTextKind(proposal: Extract<Proposal, { kind: "decision" | "dead-end" }>, ctx: VerifyContext): Verdict {
  const textProblem = checkText(proposal.text, ctx.caps.itemChars) ?? checkEvidence(proposal.evidence, ctx);
  if (textProblem) return reject(textProblem);
  const text = proposal.text.trim();
  const hot = proposal.kind === "decision" ? activeDecisions(ctx.state) : activeDeadEnds(ctx.state);
  const duplicate = findNearDuplicate(text, hot.map((item) => ({ id: item.id, text: item.text })), ctx.nearDuplicateThreshold);
  if (duplicate) return reject({ code: "near-duplicate", earlierId: duplicate.id, overlap: duplicate.overlap });
  return proposal.kind === "decision"
    ? stamp(ctx, proposal.evidence, { kind: "decision.add", id: `D${ctx.state.cursor.D + 1}`, text })
    : stamp(ctx, proposal.evidence, { kind: "deadEnd.add", id: `X${ctx.state.cursor.X + 1}`, text });
}

export function verify(proposal: Proposal, ctx: VerifyContext): Verdict {
  if (ctx.provenance.source === "remember" && ctx.acceptedThisSpan >= ctx.rememberCap) return reject({ code: "remember-cap", cap: ctx.rememberCap });
  try {
    switch (proposal.kind) {
      case "now":
        return stamp(ctx, undefined, { kind: "now.set", now: proposal.now });
      case "decision":
      case "dead-end":
        return verifyTextKind(proposal, ctx);
      default:
        return verifyQuoteKind(proposal, ctx);
    }
  } catch (error) {
    return reject({ code: "internal", detail: error instanceof Error ? error.message : String(error) });
  }
}

/** Verify in order, folding each accepted event into a scratch projection so a batch cannot contradict itself. */
export function applyProposals(proposals: Proposal[], ctx: VerifyContext): { events: StateEvent[]; rejected: Array<{ index: number; proposal: Proposal; rejection: Rejection }>; state: SessionState } {
  let state = ctx.state;
  let acceptedThisSpan = ctx.acceptedThisSpan;
  const events: StateEvent[] = [];
  const rejected: Array<{ index: number; proposal: Proposal; rejection: Rejection }> = [];
  proposals.forEach((proposal, index) => {
    const verdict = verify(proposal, { ...ctx, state, acceptedThisSpan });
    if (!verdict.ok) {
      rejected.push({ index, proposal, rejection: verdict.rejection });
      return;
    }
    events.push(verdict.event);
    state = applyEvent(state, verdict.event, ctx.caps);
    if (ctx.provenance.source === "remember") acceptedThisSpan++;
  });
  return { events, rejected, state };
}
