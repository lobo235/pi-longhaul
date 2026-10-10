/**
 * The Compaction line (CONTEXT.md): a custom entry Longhaul appends after each compaction it ran or fell back
 * from, rendered in pi's transcript under pi's own collapsed compaction block. Display only: pi never sends a
 * custom entry to the model.
 *
 * pi draws the compaction block itself and offers no hook for it, so the time cannot go into that line. Two
 * shapes were considered: render the existing span record (store/events.ts) with a duration added, or a
 * separate entry. The span record exists only for a compaction Longhaul made, so a fallback would show
 * nothing, and it is data the state is rebuilt from; a separate display entry covers both outcomes and keeps
 * the record's shape unchanged.
 */

import type { EntryRenderer } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

/** The custom entry type. A transcript consumer that filters custom entries by type may drop it freely. */
export const LINE_ENTRY_TYPE = "compaction-state.line";

interface LineBase {
  v: 1;
  /** From Longhaul's compaction hook to the compaction entry, in milliseconds. */
  durationMs: number;
  tokensBefore: number;
}

export type CompactionLine =
  | (LineBase & { by: "longhaul"; span: number; calls: number; input: number; output: number; stateChars: number })
  | (LineBase & { by: "pi"; fallback: { errorClass: string; error: string } });

const count = (value: number) => value.toLocaleString("en-US");

function duration(ms: number): string {
  const tenths = Math.round(ms / 100);
  if (tenths < 600) return `${(tenths / 10).toFixed(1)} s`;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

function headline(line: CompactionLine): string {
  if (line.by === "longhaul") {
    const calls = `${line.calls} ${line.calls === 1 ? "call" : "calls"}`;
    return `longhaul: compacted in ${duration(line.durationMs)} (span ${line.span}, ${calls}, ${count(line.input)} in / ${count(line.output)} out)`;
  }
  return `longhaul: fell back to pi's own compaction, ${duration(line.durationMs)} (${line.fallback.errorClass}: ${line.fallback.error})`;
}

/** The line's text: one line, and expanded a second one with what the compaction started from and left. */
export function compactionLineText(line: CompactionLine, expanded: boolean): string {
  if (!expanded) return headline(line);
  const from = `from ${count(line.tokensBefore)} tokens`;
  return `${headline(line)}\n${line.by === "longhaul" ? `${from} to a ${count(line.stateChars)}-character state` : from}`;
}

/** Longest error text a line keeps: it names the cause, it is not the error report (`/longhaul-report` is). */
const ERROR_CHARS = 200;
const CLASS_CHARS = 60;

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/** Transcript text is untrusted: no control character reaches the terminal, a line break becomes a space. */
function cleanText(value: string, max: number): string {
  return value.replace(/[\t\n\r]/g, " ").replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(0, max);
}

/** A Compaction line read back from the transcript, or undefined for anything this version did not write. */
export function readCompactionLine(data: unknown): CompactionLine | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const line = data as Record<string, unknown>;
  if (line.v !== 1 || !isCount(line.durationMs) || !isCount(line.tokensBefore)) return undefined;
  const base = { v: 1 as const, durationMs: line.durationMs, tokensBefore: line.tokensBefore };
  if (line.by === "longhaul") {
    const { span, calls, input, output, stateChars } = line;
    if (![span, calls, input, output, stateChars].every(isCount)) return undefined;
    return { ...base, by: "longhaul", span: span as number, calls: calls as number, input: input as number, output: output as number, stateChars: stateChars as number };
  }
  if (line.by === "pi") {
    const fallback = line.fallback as Record<string, unknown> | undefined;
    if (typeof fallback?.errorClass !== "string" || typeof fallback.error !== "string") return undefined;
    return { ...base, by: "pi", fallback: { errorClass: cleanText(fallback.errorClass, CLASS_CHARS), error: cleanText(fallback.error, ERROR_CHARS) } };
  }
  return undefined;
}

/** pi's entry renderer for LINE_ENTRY_TYPE: the line, dimmed like pi's own status text. */
export const renderCompactionLine: EntryRenderer = (entry, options, theme) => {
  const line = readCompactionLine(entry.data);
  if (!line) return undefined;
  const text = compactionLineText(line, options.expanded).split("\n").map((row) => theme.fg("dim", row)).join("\n");
  return new Text(text, 1, 0);
};

export interface LineInput {
  durationMs: number;
  tokensBefore: number;
  /** The compaction entry's summary length: for a Longhaul compaction, the rendered state. */
  summaryChars: number;
  /** pi's session_compact flag: an extension's hook made this compaction. */
  fromExtension: boolean;
  /** The pass's span and usage, present when Longhaul's pass produced this compaction. */
  pass?: { span: number; usage?: { input: number; output: number; calls: number } };
  /** Why the pass failed, present when it fell back to pi's own compaction. */
  fallback?: { errorClass: string; error: string };
}

/** The line for one compaction, or undefined when it was neither Longhaul's nor its fallback (another extension made it). */
export function compactionLineFor(input: LineInput): CompactionLine | undefined {
  const base = { v: 1 as const, durationMs: Math.max(0, Math.round(input.durationMs)), tokensBefore: input.tokensBefore };
  if (input.fromExtension && input.pass) {
    const usage = input.pass.usage ?? { input: 0, output: 0, calls: 0 };
    return { ...base, by: "longhaul", span: input.pass.span, calls: usage.calls, input: usage.input, output: usage.output, stateChars: input.summaryChars };
  }
  if (!input.fromExtension && input.fallback) return { ...base, by: "pi", fallback: input.fallback };
  return undefined;
}
