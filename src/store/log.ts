/**
 * readLog: fold the branch into the StateLog. Closed spans come from their span records
 * (authoritative); the open span from loose event entries after the last compaction entry; a
 * compaction another compactor wrote, or a state compaction whose span record never landed, gets a
 * synthesized close so the projection carries a code-written work-log line. Every replayed quote
 * is re-verified against the branch; a mismatch is an anomaly, which is what a forged entry on a
 * synced tree meets. Nothing here throws: a malformed entry is skipped and counted.
 */
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import { EVENT_ENTRY_TYPE, isStateEvent, newerStateFormat, SPAN_ENTRY_TYPE, STATE_FORMAT, type FoldAnomaly, type ForeignCompactor, type Quote, type SpanRecord, type SpanSummary, type StateEvent, type StateLog } from "./events.ts";

export interface QuoteChecker {
  holds(quote: Quote): boolean;
}

export function compactorOfEntry(entry: { fromHook?: boolean; details?: unknown }): "pi" | "extension" | "state" {
  if (!entry.fromHook) return "pi";
  const details = entry.details as { compactor?: unknown } | null | undefined;
  return details?.compactor === "state" ? "state" : "extension";
}

export function spanNumberOf(branchEntries: SessionEntry[], compactionEntryId: string): number | undefined {
  let count = 0;
  for (const entry of branchEntries) {
    if (entry.type !== "compaction") continue;
    count++;
    if (entry.id === compactionEntryId) return count;
  }
  return undefined;
}

export function isSpanRecord(value: unknown): value is SpanRecord {
  const record = value as Partial<SpanRecord> | null;
  return typeof record === "object" && record !== null && record.v === 1 && typeof record.span === "number" && typeof record.compactionEntryId === "string" && Array.isArray(record.events) && typeof record.ledger === "object" && record.ledger !== null && Array.isArray(record.ledger.commands) && Array.isArray(record.ledger.errors);
}

interface Fold {
  events: StateEvent[];
  spans: SpanSummary[];
  anomalies: FoldAnomaly[];
  seqs: Set<string>;
  /** Loose events collected since the last compaction entry, keyed by nothing: in branch order. */
  loose: StateEvent[];
  /** The compaction entry awaiting its span record, if any. */
  pending?: { id: string; span: number; compactor: ReturnType<typeof compactorOfEntry> };
}

function quoteOf(event: StateEvent): Quote[] {
  switch (event.kind) {
    case "objective.set": return event.doneWhen ? [event.quote, event.doneWhen] : [event.quote];
    case "goal.set": case "objective.doneWhen": case "correction.add": return [event.quote];
    default: return [];
  }
}

/** Admit one event into the fold, or record why not. */
function admit(fold: Fold, raw: unknown, span: number, entryId: string, checker: QuoteChecker, into: StateEvent[]): void {
  const newer = newerStateFormat(raw);
  if (newer !== undefined) {
    fold.anomalies.push({ span, entryId, reason: `event from a newer state format (${newer}; this version reads ${STATE_FORMAT}): ${entryId}` });
    return;
  }
  if (!isStateEvent(raw)) {
    fold.anomalies.push({ span, entryId, reason: `malformed event entry: ${entryId}` });
    return;
  }
  if (!quoteOf(raw).every((quote) => checker.holds(quote))) {
    fold.anomalies.push({ span, entryId, reason: `quote does not verify: ${entryId} (${raw.kind})` });
    return;
  }
  if (raw.span !== span) {
    fold.anomalies.push({ span, entryId, reason: `event names span ${raw.span} while folding span ${span}: ${entryId}` });
    return;
  }
  const key = String(raw.seq);
  if (fold.seqs.has(key)) {
    fold.anomalies.push({ span, entryId, reason: `duplicate seq: ${raw.seq} at ${entryId}` });
    return;
  }
  fold.seqs.add(key);
  into.push(raw);
}

/**
 * One past the highest seq in `lists`. Loops here and below, never a spread into a call (`Math.max(...)`,
 * `push(...)`): a call's arguments live on the stack, which overflows past ~125k events (security.md T4).
 */
function seqAfter(...lists: StateEvent[][]): number {
  let highest = 0;
  for (const list of lists) for (const event of list) if (event.seq > highest) highest = event.seq;
  return highest + 1;
}

function nextSeq(fold: Fold): number {
  return seqAfter(fold.events, fold.loose);
}

/**
 * Close `pending` without a record: a foreign compaction, or a state pass whose session_compact never wrote.
 * The span's loose events fold in either way. They are `remember` writes -- the user's own words, quote-verified
 * on admission -- and a span closed by another compactor has no record to carry them, so dropping them here lost
 * every write made in a session that ran another compactor before switching to this one.
 */
function synthesizeClose(fold: Fold, foreign: ForeignCompactor | undefined, at: string): void {
  const pending = fold.pending!;
  const events = fold.loose;
  const close: StateEvent = { source: "pass", span: pending.span, at, seq: nextSeq(fold), kind: "span.close", fromRef: "?", toRef: "?", narrativeLess: true, foreign, world: { claims: [], openErrorIds: [] } };
  if (!foreign) fold.anomalies.push({ span: pending.span, entryId: pending.id, reason: `no span record for compaction entry ${pending.id}; close synthesized` });
  for (const event of events) fold.events.push(event);
  fold.events.push(close);
  fold.spans.push({ span: pending.span, compactionEntryId: pending.id, foreign });
  fold.loose = [];
  fold.pending = undefined;
}

function takeRecord(fold: Fold, entry: Extract<SessionEntry, { type: "custom" }>, checker: QuoteChecker): void {
  const pending = fold.pending;
  if (!pending) {
    fold.anomalies.push({ span: fold.spans.length, entryId: entry.id, reason: `span record without a compaction entry: ${entry.id}` });
    return;
  }
  if (!isSpanRecord(entry.data)) {
    fold.anomalies.push({ span: pending.span, entryId: entry.id, reason: `malformed span record: ${entry.id}` });
    return;
  }
  const record = entry.data;
  if (record.compactionEntryId !== pending.id) {
    fold.anomalies.push({ span: pending.span, entryId: entry.id, reason: `span record ${entry.id} names compaction entry ${record.compactionEntryId}, expected ${pending.id}` });
    return;
  }
  // The record SUPERSEDES the span's loose events, so release their seqs before admitting its own
  // (otherwise the record's authoritative copy of a loose event is dropped as a duplicate seq).
  for (const loose of fold.loose) fold.seqs.delete(String(loose.seq));
  const events: StateEvent[] = [];
  for (const raw of record.events) admit(fold, raw, pending.span, entry.id, checker, events);
  for (const event of events) fold.events.push(event);
  fold.spans.push({ span: pending.span, compactionEntryId: pending.id, record });
  fold.loose = [];
  fold.pending = undefined;
}

export function readLog(branchEntries: SessionEntry[], checker: QuoteChecker): StateLog {
  const fold: Fold = { events: [], spans: [], anomalies: [], seqs: new Set(), loose: [] };
  let compactions = 0;
  for (const entry of branchEntries) {
    // A pending state compaction is closed by its span record, which is the NEXT entry of interest;
    // anything else arriving first means the record never landed.
    if (fold.pending && !(entry.type === "custom" && entry.customType === SPAN_ENTRY_TYPE)) synthesizeClose(fold, undefined, entry.timestamp);
    if (entry.type === "compaction") {
      compactions++;
      const compactor = compactorOfEntry(entry);
      fold.pending = { id: entry.id, span: compactions, compactor };
      if (compactor !== "state") synthesizeClose(fold, compactor, entry.timestamp);
      continue;
    }
    if (entry.type !== "custom") continue;
    if (entry.customType === SPAN_ENTRY_TYPE) {
      takeRecord(fold, entry, checker);
    } else if (entry.customType === EVENT_ENTRY_TYPE) {
      const openSpan = compactions + 1;
      const raw = entry.data as { span?: unknown } | undefined;
      if (typeof raw?.span === "number" && raw.span < openSpan) {
        fold.anomalies.push({ span: raw.span, entryId: entry.id, reason: `span ${raw.span} is closed; loose event ${entry.id} ignored` });
        continue;
      }
      admit(fold, entry.data, openSpan, entry.id, checker, fold.loose);
    }
  }
  if (fold.pending) synthesizeClose(fold, undefined, new Date().toISOString());
  const events = [...fold.events, ...fold.loose];
  return { events, spans: fold.spans, openSpan: compactions + 1, anomalies: fold.anomalies, nextSeq: seqAfter(events) };
}
