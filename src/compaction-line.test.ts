/**
 * The Compaction line (CONTEXT.md): what Longhaul shows in the transcript under a compaction it ran or fell back from.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { visibleWidth } from "@earendil-works/pi-tui";

import { compactionLineFor, compactionLineText, LINE_ENTRY_TYPE, readCompactionLine, renderCompactionLine, type CompactionLine } from "./compaction-line.ts";

const ran: CompactionLine = { v: 1, by: "longhaul", durationMs: 41_234, tokensBefore: 182_400, span: 7, calls: 1, input: 12_034, output: 512, stateChars: 38_410 };

test("compactionLineText: a compaction Longhaul ran says how long it took and what the pass cost", () => {
  assert.equal(compactionLineText(ran, false), "longhaul: compacted in 41.2 s (span 7, 1 call, 12,034 in / 512 out)");
});

const fellBack: CompactionLine = { v: 1, by: "pi", durationMs: 12_310, tokensBefore: 90_000, fallback: { errorClass: "Error", error: "the summarizer timed out" } };

test("compactionLineText: a compaction that fell back to pi's own says so, how long it took, and why", () => {
  assert.equal(compactionLineText(fellBack, false), "longhaul: fell back to pi's own compaction, 12.3 s (Error: the summarizer timed out)");
});

for (const [name, durationMs, shown] of [
  ["under a second", 840, "0.8 s"],
  ["a minute or more, in minutes and seconds", 125_400, "2 min 5 s"],
  ["exactly a minute", 60_000, "1 min 0 s"],
] as const) test(`compactionLineText: a duration ${name}`, () => {
  assert.match(compactionLineText({ ...ran, durationMs }, false), new RegExp(`compacted in ${shown} \\(`));
});

test("compactionLineText: more than one call is plural", () => {
  assert.match(compactionLineText({ ...ran, calls: 3 }, false), /, 3 calls,/);
});

test("compactionLineText: a duration that rounds up to a minute is shown in minutes, never as 60.0 s", () => {
  assert.match(compactionLineText({ ...ran, durationMs: 59_960 }, false), /compacted in 1 min 0 s \(/);
});

test("compactionLineText: expanded, it adds what the compaction started from and what it left", () => {
  assert.equal(compactionLineText(ran, true), "longhaul: compacted in 41.2 s (span 7, 1 call, 12,034 in / 512 out)\nfrom 182,400 tokens to a 38,410-character state");
  assert.equal(compactionLineText(fellBack, true), "longhaul: fell back to pi's own compaction, 12.3 s (Error: the summarizer timed out)\nfrom 90,000 tokens");
});

test("readCompactionLine: a line written by this version reads back as itself", () => {
  assert.deepEqual(readCompactionLine(JSON.parse(JSON.stringify(ran))), ran);
  assert.deepEqual(readCompactionLine(JSON.parse(JSON.stringify(fellBack))), fellBack);
});

for (const [name, data] of [
  ["not an object", "longhaul"],
  ["null", null],
  ["another version", { ...ran, v: 2 }],
  ["an unknown author", { ...ran, by: "someone" }],
  ["a negative duration", { ...ran, durationMs: -1 }],
  ["a duration that is not a number", { ...ran, durationMs: "41" }],
  ["a count that is not finite", { ...ran, input: Number.POSITIVE_INFINITY }],
  ["a fallback with no reason", { ...fellBack, fallback: undefined }],
  ["a fallback reason that is not text", { ...fellBack, fallback: { errorClass: "Error", error: 42 } }],
] as const) test(`readCompactionLine: ${name} is not a line`, () => {
  assert.equal(readCompactionLine(data), undefined);
});

test("readCompactionLine: transcript text cannot reach the terminal as control sequences, and is cut short", () => {
  const line = readCompactionLine({ ...fellBack, fallback: { errorClass: "Err\u001b[2Jor", error: "a\u001b]8;;http://x\u0007b\nc" + "x".repeat(500) } });
  assert.ok(line && line.by === "pi");
  assert.equal(line.fallback.errorClass, "Err[2Jor");
  assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(line.fallback.error), line.fallback.error);
  assert.ok(line.fallback.error.startsWith("a]8;;http://xb c"));
  assert.ok(line.fallback.error.length <= 200, String(line.fallback.error.length));
});

// The theme hook pi passes a renderer; this one answers "dim" with the terminal's own dim sequence, so widths stay real.
const DIM = "\u001b[2m";
const theme = { fg: (color: string, text: string) => (color === "dim" ? `${DIM}${text}\u001b[22m` : text) } as unknown as Parameters<typeof renderCompactionLine>[2];
const entry = (data: unknown) => ({ type: "custom", customType: LINE_ENTRY_TYPE, data, id: "e1", parentId: "c1", timestamp: "2026-10-07T12:00:00Z" }) as unknown as Parameters<typeof renderCompactionLine>[0];

test("renderCompactionLine: draws the line dimmed, collapsed or expanded, within the terminal width", () => {
  const collapsed = renderCompactionLine(entry(ran), { expanded: false }, theme)!.render(120).map((row) => row.trimEnd());
  assert.ok(collapsed.some((row) => row.includes(`${DIM}longhaul: compacted in 41.2 s`)), collapsed.join("\n"));
  const expanded = renderCompactionLine(entry(ran), { expanded: true }, theme)!.render(120).join("\n");
  assert.match(expanded, /to a 38,410-character state/);
  for (const row of renderCompactionLine(entry(fellBack), { expanded: true }, theme)!.render(30)) assert.ok(visibleWidth(row) <= 30, row);
});

test("renderCompactionLine: an entry this version cannot read draws nothing", () => {
  assert.equal(renderCompactionLine(entry({ v: 9 }), { expanded: false }, theme), undefined);
});

const common = { durationMs: 1234.6, tokensBefore: 5000, summaryChars: 900 };

for (const [name, input, expected] of [
  ["Longhaul's pass made the compaction", { ...common, fromExtension: true, pass: { span: 3, usage: { input: 10, output: 2, calls: 1 } } },
    { v: 1, by: "longhaul", durationMs: 1235, tokensBefore: 5000, span: 3, calls: 1, input: 10, output: 2, stateChars: 900 }],
  ["the pass recorded no usage", { ...common, fromExtension: true, pass: { span: 3 } },
    { v: 1, by: "longhaul", durationMs: 1235, tokensBefore: 5000, span: 3, calls: 0, input: 0, output: 0, stateChars: 900 }],
  ["the pass fell back to pi's own compaction", { ...common, fromExtension: false, fallback: { errorClass: "Error", error: "boom" } },
    { v: 1, by: "pi", durationMs: 1235, tokensBefore: 5000, fallback: { errorClass: "Error", error: "boom" } }],
  ["another extension made it", { ...common, fromExtension: true }, undefined],
  ["pi made it with no fallback of Longhaul's", { ...common, fromExtension: false }, undefined],
  ["a clock that stepped back", { ...common, durationMs: -5, fromExtension: false, fallback: { errorClass: "Error", error: "boom" } },
    { v: 1, by: "pi", durationMs: 0, tokensBefore: 5000, fallback: { errorClass: "Error", error: "boom" } }],
] as const) test(`compactionLineFor: ${name}`, () => {
  assert.deepEqual(compactionLineFor(input), expected);
});
