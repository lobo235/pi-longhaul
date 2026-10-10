/** Builders for store tests: events with defaults, quotes, and a log from events. */
import type { Now, Quote, StateEvent, StateLog, World } from "./events.ts";

let seq = 0;
export function resetSeq(): void {
  seq = 0;
}

export function quote(ordinal: string, text: string, messageId = `m-${ordinal}`): Quote {
  return { messageId, ordinal, text };
}

type Provenance = Partial<Pick<StateEvent, "source" | "span" | "at" | "seq">>;
/**
 * One union member per event kind, provenance optional, so `ev({ kind: "…" , … })` type-checks without
 * naming `K`. (A generic `Extract<…, { kind: K }>` signature collapses to `Omit<unknown, …>` at every call
 * site: this mapped lookup is the same contract, evaluated.)
 */
type EvInput = { [K in StateEvent["kind"]]: Omit<Extract<StateEvent, { kind: K }>, "source" | "span" | "at" | "seq"> & Provenance }[StateEvent["kind"]];

export function ev(body: EvInput): StateEvent {
  const { source = "diff", span = 1, at = `2026-09-28T10:00:${String(seq).padStart(2, "0")}.000Z`, seq: explicitSeq, ...rest } = body as EvInput & Provenance;
  return { source, span, at, seq: explicitSeq ?? ++seq, ...rest } as unknown as StateEvent;
}

export const NOW: Now = { inProgress: ["wiring"], next: ["tests"], blocked: [], resume: "run npm test" };
export const WORLD: World = { branch: "main", commit: "ab12cd", dirty: false, claims: [], openErrorIds: [] };

export function closeEvent(span: number, overrides: Partial<Extract<StateEvent, { kind: "span.close" }>> = {}): StateEvent {
  return ev({ kind: "span.close", source: "pass", span, fromRef: `u${span}`, toRef: `u${span + 1}`, narrative: `span ${span} work`, narrativeLess: false, world: WORLD, ...overrides });
}

export function logOf(...events: StateEvent[]): StateLog {
  const closes = events.filter((event) => event.kind === "span.close");
  return {
    events,
    spans: closes.map((event) => ({ span: event.span, compactionEntryId: `c${event.span}` })),
    openSpan: closes.length + 1,
    anomalies: [],
    nextSeq: Math.max(0, ...events.map((event) => event.seq)) + 1,
  };
}
