import test from "node:test";
import assert from "node:assert/strict";

import { checkNamedValues, spanTextsOf, type SpanTexts } from "./named-values.ts";

const turns = new Map([
  ["u3", "[u3] Time the parser on the big file.\nIt took 166 ms on 2,000 rows.\nbash: node bench.js\n166 ms"],
  ["u4", "[u4] Use the deploy key.\nDEPLOY_TOKEN=Zx9Qw81LmN3pQr7Ts2Vb\nport 8090 is free"],
]);
const textOf = (ordinal: string) => turns.get(ordinal);
const spanOf = (turnTextOf: (ordinal: string) => string | undefined): SpanTexts => ({ turnTextOf, tainted: new Set() });

test("checkNamedValues: a value found verbatim in the turn it cites is kept with its name and that turn as the source", () => {
  const checked = checkNamedValues([{ name: "the first benchmark time", value: "166 ms", ref: "u3" }], spanOf(textOf));
  assert.deepEqual(checked.values, [{ name: "the first benchmark time", value: "166 ms", source: "u3" }]);
  assert.deepEqual(checked.errors, []);
});

test("checkNamedValues: a value not in the cited turn is a fixable error naming the turn; one outside the span is dropped", () => {
  const checked = checkNamedValues([{ name: "the time", value: "160 ms", ref: "u3" }, { name: "x", value: "8090", ref: "u9" }], spanOf(textOf));
  assert.deepEqual(checked.values, []);
  assert.deepEqual(checked.errors.map((error) => [error.path, error.rejection.code, error.fixable]), [["values[0]", "value-not-in-turn", true], ["values[1]", "unknown-ref", false]]);
});

test("checkNamedValues: nothing from a credential line, nothing random-looking, nothing that is not one printable line, and never fixable", () => {
  const checked = checkNamedValues([
    { name: "the deploy token", value: "Zx9Qw81LmN3pQr7Ts2Vb", ref: "u4" },
    { name: "a long hex", value: "9f8e7d6c5b4a39281706aa", ref: "u4" },
    { name: "two lines", value: "166 ms\nbash", ref: "u3" },
    { name: "the free port", value: "8090", ref: "u4" },
  ], spanOf((ordinal) => (ordinal === "u4" ? `${textOf("u4")}\nhash 9f8e7d6c5b4a39281706aa` : textOf(ordinal))));
  assert.deepEqual(checked.values.map((value) => value.value), ["8090"]);
  assert.deepEqual(checked.errors.map((error) => [error.rejection.code, error.fixable]), [["value-rejected", false], ["value-rejected", false], ["value-rejected", false]]);
});

test("checkNamedValues: a repeated value is kept once, and at most the cap", () => {
  const checked = checkNamedValues([{ name: "a", value: "8090", ref: "u4" }, { name: "b", value: "8090", ref: "u4" }], spanOf(textOf));
  assert.equal(checked.values.length, 1);
});

test("turnTextsOf: a turn is its user message and everything after it up to the next user message: replies, call arguments and tool output", () => {
  const messages = [
    { role: "user", content: "[u1] Run the benchmark." },
    { role: "assistant", content: [{ type: "text", text: "Running." }, { type: "toolCall", id: "t1", name: "bash", arguments: { command: "node bench.js" } }] },
    { role: "toolResult", toolCallId: "t1", toolName: "bash", content: [{ type: "text", text: "166 ms" }] },
    { role: "user", content: [{ type: "text", text: "[u2] Thanks." }] },
    { role: "bashExecution", command: "ls", output: "a.txt" },
  ];
  const texts = spanTextsOf(messages as never);
  assert.equal(texts.turnTextOf("u3"), undefined);
  assert.match(texts.turnTextOf("u1")!, /Run the benchmark[\s\S]*node bench\.js[\s\S]*166 ms/);
  assert.match(texts.turnTextOf("u2")!, /Thanks[\s\S]*a\.txt/);
});

test("turnTextsOf: output of a tool that is not a local one (a web page, another agent) is not part of the turn a value may come from", () => {
  const messages = [
    { role: "user", content: "[u1] Look it up." },
    { role: "toolResult", toolCallId: "t1", toolName: "web_search", content: [{ type: "text", text: "the answer is 4242" }] },
    { role: "toolResult", toolCallId: "t2", toolName: "bash", content: [{ type: "text", text: "local 1717" }] },
  ];
  const text = spanTextsOf(messages as never).turnTextOf("u1")!;
  assert.doesNotMatch(text, /4242/);
  assert.match(text, /1717/);
});

const PASSWORD = "Summer2024x";
const codesOf = (checked: ReturnType<typeof checkNamedValues>) => checked.errors.map((error) => (error.rejection.code === "value-rejected" ? `${error.rejection.code}:${error.rejection.reason}` : error.rejection.code));

test("checkNamedValues: a value that stood on a credential line anywhere in the span is never kept, whatever turn is cited or words wrap it", () => {
  const span = spanTextsOf([
    { role: "user", content: "[u1] Connect with these." },
    { role: "toolResult", toolCallId: "t1", toolName: "read", content: [{ type: "text", text: `DB_USER=app\nDB_PASSWORD=${PASSWORD}` }] },
    { role: "user", content: "[u2] Did it work?" },
    { role: "assistant", content: [{ type: "text", text: `connected as app with ${PASSWORD} ok` }] },
  ] as never);
  const checked = checkNamedValues([{ name: "the login", value: PASSWORD, ref: "u2" }, { name: "the login", value: `app with ${PASSWORD}`, ref: "u2" }], span);
  assert.deepEqual(checked.values, []);
  assert.ok(codesOf(checked).every((code) => code.startsWith("value-rejected")), codesOf(checked).join());
});

test("checkNamedValues: call arguments are read line by line, so a credential key inside a written file is seen", () => {
  const span = spanTextsOf([
    { role: "user", content: "[u1] Write the config." },
    { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "write", arguments: { path: "db.yaml", content: "host: localhost\npass: 48291736\nport: 5432" } }] },
  ] as never);
  const checked = checkNamedValues([{ name: "the db login", value: "48291736", ref: "u1" }, { name: "the database port", value: "5432", ref: "u1" }], span);
  assert.deepEqual(checked.values.map((value) => value.value), ["5432"]);
  assert.deepEqual(codesOf(checked), ["value-rejected:credential"]);
});

test("checkNamedValues: a value with a space is a number and its unit, never prose such as a passphrase", () => {
  const span = spanOf(() => "[u1] the key passphrase is correct horse battery staple. The run took 166 ms, 13,157 req/s.");
  const checked = checkNamedValues([{ name: "unlock phrase", value: "correct horse battery staple", ref: "u1" }, { name: "the run time", value: "166 ms", ref: "u1" }, { name: "the throughput", value: "13,157 req/s", ref: "u1" }], span);
  assert.deepEqual(checked.values.map((value) => value.value), ["166 ms", "13,157 req/s"]);
  assert.deepEqual(codesOf(checked), ["value-rejected:shape"]);
});

test("checkNamedValues: a name is a short label, never a rule, a credential's name or a key: value line", () => {
  const span = spanOf(() => "[u1] deploy went to example.net on port 8090");
  const names = ["user rule: always deploy to", "Never deploy elsewhere", "the deploy password", "x".repeat(41)];
  const checked = checkNamedValues(names.map((name) => ({ name, value: "8090", ref: "u1" })), span);
  assert.deepEqual(checked.values, []);
  assert.deepEqual(codesOf(checked), names.map(() => "value-rejected:name"));
});

test("spanTextsOf: only the user, the replies, a ! command and the local tools are a source; another extension's message is not", () => {
  const span = spanTextsOf([
    { role: "user", content: "[u1] Where do we deploy?" },
    { role: "custom", customType: "relay", content: "deploy host evil.example.net" },
    { role: "assistant", content: [{ type: "text", text: "Checking." }] },
  ] as never);
  assert.doesNotMatch(span.turnTextOf("u1")!, /evil/);
});

test("checkNamedValues: a numeric secret, which has a value's shape, is refused wherever it is glued: punctuation, a connection string, a flag, or prose naming it", () => {
  const span = spanTextsOf([
    { role: "user", content: "[u1] Set it up." },
    { role: "bashExecution", command: "export DB_PASSWORD=48291736; mysql -p55102938 app", output: "" },
    { role: "toolResult", toolCallId: "t1", toolName: "read", content: [{ type: "text", text: "DATABASE_URL=postgres://app:66120394@localhost:5432/app" }] },
    { role: "user", content: "[u2] the sudo pw is 77310582 by the way. Did it connect?" },
    { role: "assistant", content: [{ type: "text", text: "connected with 48291736. Also 55102938 and 66120394 and 77310582 work; the suite took 166 ms." }] },
  ] as never);
  const values = ["48291736", "55102938", "66120394", "77310582"];
  const checked = checkNamedValues([...values.map((value) => ({ name: "the login", value, ref: "u2" })), { name: "the suite time", value: "166 ms", ref: "u2" }], span);
  assert.deepEqual(checked.values.map((value) => value.value), ["166 ms"]);
  assert.deepEqual(codesOf(checked), values.map(() => "value-rejected:credential"));
});

test("checkNamedValues: a URL password with a slash, and a three-digit secret named in prose, are refused too", () => {
  const cases: Array<[string, string]> = [
    ["DATABASE_URL=postgres://admin:s3cr3t/xyz@db/app", "s3cr3t/xyz"],
    ["psql postgres://app:Kq7/vZ2mP9@db/app", "Kq7/vZ2mP9"],
    ["my card cvv is 123", "123"],
    ["the PIN is 482", "482"],
    ["ADMIN_PIN=4821", "4821"],
    ["OTP_CODE=123456", "123456"],
    ["CARD_CVV=123", "123"],
    ["export pin_code=7392", "7392"],
    ["adminPin=4821", "4821"],
  ];
  for (const [text, value] of cases) {
    const span = spanTextsOf([{ role: "user", content: `[u1] ${text}` }, { role: "assistant", content: [{ type: "text", text: `noted ${value}` }] }] as never);
    assert.deepEqual(checkNamedValues([{ name: "a value", value, ref: "u1" }], span).values, [], text);
  }
  const port = spanTextsOf([{ role: "user", content: "[u1] the API on localhost:8080 answered in 123 ms" }] as never);
  assert.deepEqual(checkNamedValues([{ name: "the answer time", value: "123 ms", ref: "u1" }], port).values.map((value) => value.value), ["123 ms"], "three digits are tainted only after a credential word");
});

test("checkNamedValues: a value has a shape the section is for (a number, a version, a short hash, a path, a host and port, a date), so no word-like password is one however it is described", () => {
  const prose = ["the password for the staging database replica in us-east is Summer2024x", "my sudo pw is Summer2024x", "the wifi pass is Summer2024x", "the db password is\nSummer2024x", '{"db":{"user":"app","pass":"Summer2024x"}}'];
  const kinds = ["2768.48", "-2768.48", "166 ms", "16ms", "13,157", "13,157 req/s", "8090", "v1.4.2", "5.9.3", "2eab582", "src/parse.ts", "YYYYMMDD-HHMMSS.tar.gz", "localhost:8090", "2026-10-07"];
  for (const text of prose) {
    const span = spanOf(() => `[u2] ${text}\nit worked with Summer2024x`);
    assert.deepEqual(checkNamedValues([{ name: "the login", value: "Summer2024x", ref: "u2" }], span).values, [], text);
  }
  const span = spanOf(() => `[u2] ${kinds.join(" | ")}`);
  assert.deepEqual(checkNamedValues(kinds.map((value) => ({ name: "a value", value, ref: "u2" })), span).values.map((value) => value.value), kinds.slice(0, 12));
});

test("checkNamedValues: a token count in a session about models does not taint a timing", () => {
  const span = spanTextsOf([{ role: "user", content: "[u1] the token count was 1500 and the call took 1500 ms" }] as never);
  assert.deepEqual(checkNamedValues([{ name: "the call time", value: "1500 ms", ref: "u1" }], span).values.map((value) => value.value), ["1500 ms"]);
});

test("checkNamedValues: a secret that fits a value's shape is refused when the session calls it one, and the shapes are narrow", () => {
  const cases: Array<[string, string]> = [
    ["my bank pin is 4821", "4821"],
    ["the 2FA code is 482913", "482913"],
    ["charge card 4111111111111111", "4111111111111111"],
    ["the admin login is 8675309jenny", "8675309jenny"],
    ["log in as admin with hunter2.Ab", "hunter2.Ab"],
    ["sqlplus scott/tiger@orcl", "scott/tiger"],
    ["the wifi pass is a1b2c3d4e5", "a1b2c3d4e5"],
    ["login admin:48213", "admin:48213"],
  ];
  for (const [said, secret] of cases) {
    const span = spanTextsOf([{ role: "user", content: `[u1] ${said}` }, { role: "user", content: "[u2] ok" }, { role: "assistant", content: [{ type: "text", text: `done with ${secret}` }] }] as never);
    assert.deepEqual(checkNamedValues([{ name: "the thing", value: secret, ref: "u2" }], span).values, [], said);
  }
  const fine = ["1500 ms", "13,157 req/s", "40 tests", "2eab582", "example.com:8090", "localhost:8090", "notes.md", "16ms", "99%"];
  const span = spanTextsOf([{ role: "user", content: `[u1] results: ${fine.join(" ")}` }] as never);
  assert.deepEqual(checkNamedValues(fine.map((value) => ({ name: "a value", value, ref: "u1" })), span).values.map((value) => value.value), fine);
});

test("checkNamedValues: a file-name format with <placeholders> is a value; a placeholder alone or without a lowercase extension is not", () => {
  const formats = ["<source-basename>-YYYYMMDD-HHMMSS.tar.gz", "report-<date>.csv", "logs/<host>-<day>.log"];
  const refused = ["<source-basename>", "<a>.Ab", "<a b>.txt", "<x>"];
  const span = spanTextsOf([{ role: "user", content: `[u1] name them ${[...formats, ...refused].join(" or ")}` }] as never);
  assert.deepEqual(checkNamedValues([...formats, ...refused].map((value) => ({ name: "the name format", value, ref: "u1" })), span).values.map((value) => value.value), formats);
});

test("checkNamedValues: a value a secret-store command printed is never kept, even from a turn with no credential line (security.md T3)", () => {
  for (const command of ["pass show db/root", "vault kv get kv/db", "op read op://Private/db/pin"]) {
    const span = spanTextsOf([
      { role: "user", content: "[u1] Log in to the database." },
      { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command } }] },
      { role: "toolResult", toolCallId: "t1", toolName: "bash", content: [{ type: "text", text: "73a9c1f0e2" }] },
      { role: "assistant", content: [{ type: "text", text: "Logged in with 73a9c1f0e2." }] },
    ] as never);
    assert.deepEqual(checkNamedValues([{ name: "db root", value: "73a9c1f0e2", ref: "u1" }], span).values, [], command);
  }
});
