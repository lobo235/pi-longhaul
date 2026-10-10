/**
 * Dry-mode Segment-pass schedule: over a recorded transcript's own context sizes and timestamps, when would
 * growth-triggered Segment passes have run, and how far behind the newest finished one would each real compaction
 * have been? A pass starts at a turn once the context has grown `growthTokens` since the last pass started, at most
 * one in flight, and covers the context up to that turn once `passMs` has elapsed; a compaction abandons a pass still
 * running. A turn is one answered request (approximating pi's `turn_end`), sized by its reported usage. No catch-up
 * on settle, so the lag is an upper bound. Reads usage and timestamps only, never content.
 */
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import { usedTokens } from "../narrative/warm.ts";

export type TimelineEvent = { kind: "turn"; at: number; tokens: number } | { kind: "compaction"; at: number };

export interface SegmentPolicy {
  growthTokens: number;
  passMs: number;
}

export interface SpanSegments {
  passes: number;
  /** Context growth over the span, first turn to last. */
  spanTokens: number;
  /** Growth no finished pass covered when the compaction came: what the compaction would still have to narrate. */
  lagTokens: number;
}

const timeOf = (value: unknown): number | undefined => {
  const at = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(at) ? at : undefined;
};

export function timelineOf(branch: SessionEntry[]): TimelineEvent[] {
  return branch.flatMap((entry): TimelineEvent[] => {
    const at = timeOf(entry.timestamp);
    if (at === undefined) return [];
    if (entry.type === "compaction") return [{ kind: "compaction", at }];
    if (entry.type !== "message" || entry.message.role !== "assistant") return [];
    const tokens = usedTokens((entry.message as { usage?: unknown }).usage);
    return tokens ? [{ kind: "turn", at, tokens }] : [];
  });
}

interface SpanState {
  start: number;
  last: number;
  covered: number;
  lastStart: number;
  passes: number;
  inFlight?: { endsAt: number; coversTo: number };
}

function settle(span: SpanState, at: number): void {
  if (span.inFlight && at >= span.inFlight.endsAt) {
    span.covered = span.inFlight.coversTo;
    span.inFlight = undefined;
  }
}

export function simulateSegments(timeline: TimelineEvent[], policy: SegmentPolicy): SpanSegments[] {
  const spans: SpanSegments[] = [];
  let span: SpanState | undefined;
  for (const event of timeline) {
    if (event.kind === "compaction") {
      if (!span) continue;
      settle(span, event.at);
      spans.push({ passes: span.passes, spanTokens: span.last - span.start, lagTokens: span.last - span.covered });
      span = undefined;
      continue;
    }
    span ??= { start: event.tokens, last: event.tokens, covered: event.tokens, lastStart: event.tokens, passes: 0 };
    span.last = event.tokens;
    settle(span, event.at);
    if (!span.inFlight && event.tokens - span.lastStart >= policy.growthTokens) {
      span.inFlight = { endsAt: event.at + policy.passMs, coversTo: event.tokens };
      span.lastStart = event.tokens;
      span.passes += 1;
    }
  }
  return spans;
}
