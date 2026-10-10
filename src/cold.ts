/**
 * The span record (CONTEXT.md *Span record*): what the pass appends after the compaction entry
 * lands, so the fold (store/log.ts) has this span's accepted events and a capped ledger slice
 * even when the loose remember entries are gone. Retain-ready: repo/branch via the snapshot,
 * span, per-item provenance in the events.
 */
import type { ColdSliceCaps } from "./config.ts";
import type { CommandRecord, ErrorRecord, WorkspaceSnapshot } from "./ledger/handoff.ts";
import type { SpanRecord, StateEvent } from "./store/events.ts";

const idNumber = (id: string): number => Number.parseInt(id.slice(1), 10) || 0;

export function buildSpanRecord(input: { span: number; compactionEntryId: string; events: StateEvent[]; ledger: { commands: CommandRecord[]; errors: ErrorRecord[] }; snapshot?: WorkspaceSnapshot; usage?: SpanRecord["usage"]; caps: ColdSliceCaps }): SpanRecord {
  const commands = [...input.ledger.commands].sort((a, b) => idNumber(a.id) - idNumber(b.id)).slice(-input.caps.commands).map((record) => ({ ...record, command: record.command.length > input.caps.commandChars ? record.command.slice(0, input.caps.commandChars) : record.command }));
  const errors = [...input.ledger.errors].sort((a, b) => idNumber(a.id) - idNumber(b.id)).slice(-input.caps.errors);
  return { v: 1, span: input.span, compactionEntryId: input.compactionEntryId, events: input.events, ledger: { commands, errors }, ...(input.snapshot ? { snapshot: input.snapshot } : {}), ...(input.usage ? { usage: input.usage } : {}) };
}
