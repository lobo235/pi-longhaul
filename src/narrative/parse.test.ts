import test from "node:test";
import assert from "node:assert/strict";

import { ANSWER_SCAN_CHARS, extractJsonCandidate, missingJsonShape, parseNarrativeAnswer } from "./parse.ts";

const diff = { narrative: "n", corrections: [], lifts: [], decisions: [], deadEnds: [], now: { inProgress: [], next: [], blocked: [], resume: "r" } };
const fenced = "```json\n" + JSON.stringify(diff) + "\n```";

test("parseNarrativeAnswer: a fenced block, a bare object, and an object with prose around it all parse (trailing prose is tolerated, not an error)", () => {
  for (const text of [fenced, JSON.stringify(diff), `Here is the state:\n${fenced}\nLet me know if you want changes.`, `${JSON.stringify(diff)}\n\nDone.`]) {
    const result = parseNarrativeAnswer(text);
    assert.equal(result.ok, true, text.slice(0, 30));
    if (result.ok) assert.deepEqual(result.diff, diff);
  }
  const withProse = parseNarrativeAnswer(`intro\n${fenced}\noutro`);
  assert.ok(withProse.ok && withProse.prose === "intro\n\noutro");
});

test("parseNarrativeAnswer: the not-a-diff ladder (table; valid JSON of the wrong top-level type is wrong-type, not schema)", () => {
  const cases: Array<[string, string | undefined, string, RegExp]> = [
    ["", undefined, "empty", /no content/],
    ["   \n", undefined, "empty", /no content/],
    ["```json\n{\"narrative\": \"cut off", "length", "truncated", /stop reason length/],
    ["```json\n{not json}\n```", undefined, "invalid-json", /Unexpected|JSON/],
    ["[1,2,3]", undefined, "wrong-type", /array/],
    ["\"just a string\"", undefined, "wrong-type", /string/],
    ["null", undefined, "wrong-type", /null/],
    ["```json\n{\"narrative\": 5}\n```", undefined, "schema", /\/narrative/],
    ["I cannot produce that.", undefined, "invalid-json", /no JSON object/],
  ];
  for (const [text, stopReason, reason, detail] of cases) {
    const result = parseNarrativeAnswer(text, stopReason);
    assert.ok(!result.ok, text);
    assert.equal(result.reason, reason, text);
    assert.match(result.detail, detail, text);
  }
});

test("parseNarrativeAnswer: a length stop with a complete object still parses", () => {
  const result = parseNarrativeAnswer(fenced, "length");
  assert.equal(result.ok, true);
});

test("extractJsonCandidate: prefers the first fenced block, falls back to the outermost braces, undefined when neither exists", () => {
  assert.deepEqual(extractJsonCandidate("a\n```json\n{\"x\":1}\n```\nb {\"y\":2}"), { json: "{\"x\":1}", prose: "a\n\nb {\"y\":2}" });
  assert.deepEqual(extractJsonCandidate("say {\"x\":{\"y\":1}} now"), { json: "{\"x\":{\"y\":1}}", prose: "say  now" });
  assert.equal(extractJsonCandidate("nothing here"), undefined);
});

test("parseNarrativeAnswer: shape slips are normalised into the schema's bounds instead of costing the answer (table)", () => {
  const long = "x".repeat(450);
  const cases: Array<[string, Record<string, unknown>, (parsed: Record<string, any>) => void]> = [
    ["an over-long resume is clipped to the bound", { now: { ...diff.now, resume: long } }, (d) => { assert.equal(d.now.resume.length, 400); assert.ok(d.now.resume.endsWith("…")); }],
    ["an over-long Now item is clipped, an over-long list is cut", { now: { ...diff.now, next: [long, ...Array.from({ length: 30 }, (_, i) => `step ${i}`)] } }, (d) => { assert.equal(d.now.next.length, 24); assert.equal(d.now.next[0].length, 400); }],
    ["an evidence ref that cannot be a ref is dropped", { decisions: [{ text: "kept it", evidence: "the last command that ran the suite" }], deadEnds: [{ text: "tried", evidence: null }] }, (d) => { assert.deepEqual(d.decisions, [{ text: "kept it" }]); assert.deepEqual(d.deadEnds, [{ text: "tried" }]); }],
    ["null optionals and missing lists read as absent and empty", { objective: null, lifts: undefined, corrections: null, now: { resume: "r" } }, (d) => { assert.equal("objective" in d, false); assert.deepEqual([d.lifts, d.corrections, d.now.inProgress], [[], [], []]); }],
    ["a null doneWhen is absent", { objective: { messageRef: "u1", text: "build it", doneWhen: null } }, (d) => assert.deepEqual(d.objective, { messageRef: "u1", text: "build it" })],
  ];
  for (const [name, overrides, check] of cases) {
    const result = parseNarrativeAnswer("```json\n" + JSON.stringify({ ...diff, ...overrides }) + "\n```");
    assert.ok(result.ok, `${name}: ${result.ok ? "" : result.detail}`);
    if (result.ok) check(result.diff as never);
  }
});

test("extractJsonCandidate: unescaped double quotes inside a string are escaped when that is what makes the object parse", () => {
  const text = 'Here it is: {"now": {"inProgress": [], "next": ["run "make check" again"], "blocked": [], "resume": "say "done""}}';
  const candidate = extractJsonCandidate(text);
  assert.ok(candidate);
  assert.deepEqual(JSON.parse(candidate.json), { now: { inProgress: [], next: ['run "make check" again'], blocked: [], resume: 'say "done"' } });
});

test("extractJsonCandidate: a truncated object is not repaired into something else", () => {
  assert.equal(extractJsonCandidate('{"now": {"inProgress": ["a"'), undefined);
  assert.equal(missingJsonShape('{"now": {"inProgress": ["a"'), "unclosed");
  assert.equal(missingJsonShape('{"now": {"resume": "edit "a.ts": then'), "open-string");
});

test("extractJsonCandidate: an answer that ends on a closer but is missing the outer ones is closed, when that is what makes it parse", () => {
  const text = 'Done. {"now": {"inProgress": ["a"], "next": [], "blocked": [], "resume": "r"}';
  const candidate = extractJsonCandidate(text);
  assert.ok(candidate);
  assert.deepEqual(JSON.parse(candidate.json), { now: { inProgress: ["a"], next: [], blocked: [], resume: "r" } });
  assert.deepEqual(JSON.parse(extractJsonCandidate('{"a": [{"b": 1}]')!.json), { a: [{ b: 1 }] });
  assert.equal(missingJsonShape(text), "unclosed");
});

test("escapeInnerQuotes: a bare quote followed by a colon or comma inside a value is escaped when the string's place says it cannot end there", () => {
  const text = '{"now": {"inProgress": [], "next": ["fix "a.ts", then rerun"], "blocked": [], "resume": "edit "a.ts": then run "make check", then commit"}}';
  const candidate = extractJsonCandidate(text);
  assert.ok(candidate);
  assert.deepEqual(JSON.parse(candidate.json), { now: { inProgress: [], next: ['fix "a.ts", then rerun'], blocked: [], resume: 'edit "a.ts": then run "make check", then commit' } });
});

test("extractJsonCandidate: a fenced answer one closer short, and a trailing comma, are repaired when that is what makes them parse", () => {
  const fenced = 'Here:\n```json\n{"now": {"inProgress": [], "next": ["a"], "blocked": [], "resume": "r"}\n```';
  assert.deepEqual(JSON.parse(extractJsonCandidate(fenced)!.json), { now: { inProgress: [], next: ["a"], blocked: [], resume: "r" } });
  const unfencedTail = '{"now": {"inProgress": [], "next": [], "blocked": [], "resume": "r"}\n```';
  assert.deepEqual(JSON.parse(extractJsonCandidate(unfencedTail)!.json), { now: { inProgress: [], next: [], blocked: [], resume: "r" } });
  const comma = '{"decisions": [{"text": "kept, it", "evidence": "C1"},], "deadEnds": [],}';
  assert.deepEqual(JSON.parse(extractJsonCandidate(comma)!.json), { decisions: [{ text: "kept, it", evidence: "C1" }], deadEnds: [] });
});

test("extractJsonCandidate: a long malformed answer full of quotes is scanned in linear time (security.md T4: no event-loop stall)", () => {
  const answer = `{"a":[${'"",'.repeat(100_000)}`;
  const started = performance.now();
  extractJsonCandidate(answer);
  const elapsedMs = performance.now() - started;
  assert.ok(elapsedMs < 500, `took ${Math.round(elapsedMs)} ms for ${answer.length} chars; quadratic was ~4 s`);
});

test("extractJsonCandidate: what counts as a fence (table; pinned before the regex became a scan)", () => {
  const cases: Array<[string, string, { json: string; prose: string } | undefined]> = [
    ["CRLF line ends", "a\r\n```json\r\n{\"x\":1}\r\n```\r\nb", { json: "{\"x\":1}", prose: "a\r\n\r\nb" }],
    ["an upper-case language tag is not an opener", "```JSON\n{\"x\":1}\n```", { json: "{\"x\":1}", prose: "```JSON\n\n```" }],
    ["spaces after the tag, blank lines and an indented closer", "```json   \n{\"x\":1}\n\n   \n  ```  tail", { json: "{\"x\":1}", prose: "tail" }],
    ["a blank line after a bare opener", "```\n\n{\"x\":1}\n```", { json: "{\"x\":1}", prose: "" }],
    ["the first of two fences", "```json\n{\"x\":1}\n``` and\n```json\n{\"y\":2}\n```", { json: "{\"x\":1}", prose: "and\n```json\n{\"y\":2}\n```" }],
    ["an opener mid-line", "intro ```json\n{\"x\":1}\n```", { json: "{\"x\":1}", prose: "intro" }],
    ["an unclosed fence falls back to the braces", "```json\n{\"x\":1}", { json: "{\"x\":1}", prose: "```json" }],
    ["a closer on the opener's next line closes nothing", "```json\n```\n{\"y\":2}", { json: "{\"y\":2}", prose: "```json\n```" }],
    ["an opener needs its own line end", "```json{\"x\":1}\n```", { json: "{\"x\":1}", prose: "```json\n```" }],
    ["backticks inside a value are not a closer", "```json\n{\"x\":\"a ``` b\"}\n```", { json: "{\"x\":\"a ``` b\"}", prose: "" }],
    ["an empty fence", "```json\n\n```", { json: "", prose: "" }],
  ];
  for (const [name, text, expected] of cases) assert.deepEqual(extractJsonCandidate(text), expected, name);
});

test("extractJsonCandidate: an unclosed fence before a long run of line ends is scanned in linear time (security.md T4)", () => {
  for (const opener of ["```json", "```json\n{\"a\":1"]) {
    for (const run of ["\n", "\n \n", "\r\n"]) {
      const answer = `${opener}${run.repeat(50_000)}`;
      const started = performance.now();
      extractJsonCandidate(answer);
      const elapsedMs = performance.now() - started;
      assert.ok(elapsedMs < 500, `took ${Math.round(elapsedMs)} ms on ${JSON.stringify(run)} x 50,000; the fence regex was cubic (5,000 newlines took 14 s)`);
    }
  }
  // Many openers, none closed: the search stops at the first, since no later opener can close either.
  const openers = "x```\n".repeat(50_000);
  const started = performance.now();
  assert.equal(extractJsonCandidate(openers), undefined);
  assert.ok(performance.now() - started < 500, `took ${Math.round(performance.now() - started)} ms on 50,000 unclosed openers`);
});

test("extractJsonCandidate: text past ANSWER_SCAN_CHARS is never scanned", () => {
  const padding = "x".repeat(ANSWER_SCAN_CHARS);
  assert.equal(extractJsonCandidate(`${padding}{"a":1}`), undefined);
  assert.deepEqual(extractJsonCandidate(`${"x".repeat(ANSWER_SCAN_CHARS - 7)}{"a":1}`)?.json, "{\"a\":1}");
});
