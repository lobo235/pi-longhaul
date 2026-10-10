import test from "node:test";
import assert from "node:assert/strict";

import { checkSession, parseRules } from "./check-session.ts";

const header = { type: "session", version: 3, id: "s1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/work/demo" };
const reply = (extra: object = {}) => ({ type: "message", id: "m2", parentId: "m1", message: {
  role: "assistant", provider: "example", model: "local-27b", content: [{ type: "text", text: "Done in /work/demo/src/a.ts" }], ...extra } });
const ask = (text: string) => ({ type: "message", id: "m1", parentId: null, message: { role: "user", content: [{ type: "text", text }] } });
const lines = (...entries: object[]) => entries.map((entry) => JSON.stringify(entry));
const options = { name: "demo", label: "example/local-27b", deny: [/secret-host/] };

test("checkSession: a sandboxed session with only the label model is clean", () => {
  const report = checkSession(lines(header, ask("Add a parser."), reply(), { type: "compaction", summary: "s" }), options);
  assert.deepEqual(report.findings, []);
  assert.deepEqual({ turns: report.turns, compactions: report.compactions }, { turns: 1, compactions: 1 });
});

test("checkSession: each leak names the line it is on (table)", () => {
  const cases: [string, string[], RegExp][] = [
    ["a cwd outside the sandbox", lines({ ...header, cwd: "/srv/demo" }), /line 1: cwd/],
    ["another model", lines(header, reply({ model: "big-model" })), /line 2: model example\/big-model/],
    ["another provider", lines(header, reply({ provider: "cloud" })), /line 2: model cloud\/local-27b/],
    ["a model change", lines(header, { type: "model_change", provider: "cloud", modelId: "x" }), /line 2: model cloud\/x/],
    ["a host path", lines(header, reply({ content: [{ type: "text", text: "see /srv/data/x.csv" }] })), /line 2: path \/srv\/data\/x\.csv/],
    ["a denylisted name", lines(header, reply({ content: [{ type: "text", text: "via secret-host" }] })), /line 2: denylist/],
    ["a line that is not JSON", [JSON.stringify(header), "{oops"], /line 2: not JSON/],
    ["an answer cut at the output limit", lines(header, reply({ stopReason: "length" })), /line 2: stopped at length/],
    ["an answer that failed", lines(header, reply({ stopReason: "error" })), /line 2: stopped at error/],
  ];
  for (const [label, text, expected] of cases) {
    const report = checkSession(text, options);
    assert.ok(report.findings.some((finding) => expected.test(finding)), `${label}: ${report.findings.join("; ")}`);
  }
});

test("checkSession: paths inside the sandbox's own places are allowed (table)", () => {
  for (const path of ["/work/demo.", "/work/demo/README.md.", "/work/demo/README.md", "/home/user/.pi/agent/settings.json", "/tmp/x", "/opt/node/bin/node", "/usr/bin/git", "/dev/null"]) {
    const report = checkSession(lines(header, reply({ content: [{ type: "text", text: `ran ${path}` }] })), options);
    assert.deepEqual(report.findings, [], path);
  }
});

test("checkSession: a transcript that does not start with a session header is refused", () => {
  assert.match(checkSession(lines(reply()), options).findings.join(), /line 1: not a session header/);
});

test("checkSession: an allowed match is blanked before the deny rules run, and never hides a denied one beside it", () => {
  const rules = { ...options, deny: [/[\w.]+@example\.org/], allow: [/\bok@example\.org/] };
  const say = (text: string) => checkSession(lines(header, reply({ content: [{ type: "text", text }] })), rules).findings;
  assert.deepEqual(say("mail ok@example.org"), []);
  assert.match(say("mail ok@example.org or ops@example.org").join(), /line 2: denylist/);
});

test("checkSession: an allowed match is blanked before the path scan too", () => {
  const rules = { ...options, allow: [/\/path\/to\/\S*/] };
  const say = (text: string) => checkSession(lines(header, reply({ content: [{ type: "text", text }] })), rules).findings;
  assert.deepEqual(say("usage: backup.sh /path/to/source"), []);
  assert.match(say("usage: backup.sh /path/to/source /srv/real").join(), /line 2: path \/srv\/real/);
});

test("checkSession: a reviewed cut is excused on its own line only", () => {
  const cut = reply({ stopReason: "length" });
  const report = checkSession(lines(header, ask("Write it."), cut, ask("Again."), cut), { ...options, excusedCuts: [3] });
  assert.deepEqual(report.findings, ["line 5: stopped at length"]);
});

test("checkSession: an excused line that is not a cut is a finding, so a stale exception cannot linger", () => {
  assert.deepEqual(checkSession(lines(header, reply()), { ...options, excusedCuts: [2] }).findings,
    ["line 2: excused as a cut at the output limit, but it is not one"]);
});

test("checkSession: an answer that failed is never excused", () => {
  assert.match(checkSession(lines(header, reply({ stopReason: "error" })), { ...options, excusedCuts: [2] }).findings.join(), /line 2: stopped at error/);
});

test("parseRules: example paths, and reviewed cuts for the named session only", () => {
  const text = "# reviewed\nallow /path/to/\\S*\nlength demo:164\nlength other:9\n";
  const rules = parseRules(text, "examples.allow", ["allow", "length"], "demo");
  assert.deepEqual(rules.allow.map((rule) => rule.source), ["\\/path\\/to\\/\\S*"]);
  assert.deepEqual(rules.excusedCuts, [164]);
});

test("parseRules: a malformed line is refused (table)", () => {
  for (const line of ["length demo", "length demo:x", "length demo:0", "error demo:3", "deny secret"]) {
    assert.throws(() => parseRules(line, "examples.allow", ["allow", "length"], "demo"), /examples\.allow/, line);
  }
});
