import { test } from "node:test";
import assert from "node:assert/strict";

import { scrubCredentials } from "./credential-scrub.ts";
import { spanCredentials } from "./span-credentials.ts";

const HEX64 = "9f2c4e81b7a3d6f05e19c8a2b4d7e3f6a1c9b8e2d5f4a7c3b6e9d2f1a8c5b4e7";

test("a random-looking value after a credential word is redacted, and the rest of the text kept", () => {
  assert.equal(scrubCredentials(`Re-probe AUTH ops-control (password ${HEX64}) to sentinel-0`).text, "Re-probe AUTH ops-control (password <redacted>) to sentinel-0");
});

const UUID = "3f7a2c91-5b4e-4d8a-9c1f-7e6b2a0d4c58";

// Synthetic tokens assembled at run time, so no scanner (gitleaks, push protection) reads a token in the source.
const tokenOf = (prefix: string, body: string) => `${prefix}${body}`;
const B64 = Buffer.from("user:Summer2024x").toString("base64");
const PEM = ["-----BEGIN OPENSSH", "PRIVATE KEY-----"].join(" ");
const PEM_END = ["-----END OPENSSH", "PRIVATE KEY-----"].join(" ");

const REDACTED_CASES: Array<[name: string, text: string, want: string]> = [
  ["a key in prose after the key's name", `have the gateway_key (${UUID}) and the client's contract`, "have the gateway_key (<redacted>) and the client's contract"],
  ["a Bearer value", `GET /rewrites with the Bearer ${UUID}`, "GET /rewrites with the Bearer <redacted>"],
  ["a credential key's value", "export DB_PASSWORD=hunter22 before the migration", "export DB_PASSWORD=<redacted> before the migration"],
  ["a long opaque credential key's value with no digit", "set RELAY_TOKEN=abcdefghijklmnopq on the relay", "set RELAY_TOKEN=<redacted> on the relay"],
  ["a JSON credential key's value", `set {"api_key": "abc123xyz"} in the request`, `set {"api_key": "<redacted>"} in the request`],
  ["the password of a URL login", "connect to redis://app:s3cretpw@cache:6379/0", "connect to redis://app:<redacted>@cache:6379/0"],
  ["a URL login with an empty user", "redis://:s3cretpw@cache", "redis://:<redacted>@cache"],
  ["a Vault token wherever it stands", "use hvs.CAESIabcdefgh1234567 for the write", "use <redacted> for the write"],
  ["a JWT wherever it stands", "the cookie was eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl ok", "the cookie was <redacted> ok"],
  ["a GitHub token wherever it stands", "the PAT ghp_abcdefghijklmnopqrstuvwx works", "the PAT <redacted> works"],
  ["a value ending a sentence, its full stop kept", `the new password is ${HEX64}.`, "the new password is <redacted>."],
  ["an error line naming a password before its colon", `sentinel-control password (64-hex): ${HEX64}`, "sentinel-control password (64-hex): <redacted>"],
  ["a password key glued to its prefix", "rerun with PGPASSWORD=Summer2024x psql", "rerun with PGPASSWORD=<redacted> psql"],
  ["a numeric password", "set ROOT_PASSWORD=48291375 first", "set ROOT_PASSWORD=<redacted> first"],
  ["a short key (pw, MYSQL_PWD)", "pw=Summer2024x and MYSQL_PWD=Winter2024x", "pw=<redacted> and MYSQL_PWD=<redacted>"],
  ["a Basic authorization value", `send the header Basic ${B64} to the proxy`, "send the header Basic <redacted> to the proxy"],
  ["a GitLab, Google, Stripe, npm and Hugging Face token", [tokenOf("glpat-", "x".repeat(20)), tokenOf("AIza", "y".repeat(35)), tokenOf("sk_" + "live_", "z".repeat(20)), tokenOf("npm_", "w".repeat(36)), tokenOf("hf_", "v".repeat(30))].join(" "), "<redacted> <redacted> <redacted> <redacted> <redacted>"],
  ["a private key's whole body", `key:\n${PEM}\nxxxxxxxxxxxxxxxx\nyyyyyyyyyyyyyyyy\n${PEM_END}\nthen ssh`, "key:\n<redacted>\nthen ssh"],
];

for (const [name, text, want] of REDACTED_CASES) {
  test(`redacted: ${name}`, () => assert.equal(scrubCredentials(text).text, want));
}

const KEPT_CASES: Array<[name: string, text: string]> = [
  ["an image digest", `deploy the digest sha256:${HEX64} to the job`],
  ["a digest after a credential word", `token rotated; image @sha256:${HEX64} is live`],
  ["a commit hash with no credential named", "rebased onto 1acffd949e88f5bcbc7c2298e85c8b746e151327 and pushed"],
  ["a port and a count", "the gateway listens on 8443; compacted 134000 tokens"],
  ["a variable standing for the credential", "curl -H 'Authorization: Bearer $KEY' and export TOKEN=${VAULT_TOKEN}"],
  ["a placeholder for the credential", "set password=<from vault> then retry"],
  ["a credential named with no value", "obtain a submit-capable cluster ACL token, then run the plan"],
  ["a host and port URL with a path", "fetch http://cache:6379/path@x for the probe"],
  ["already redacted text", "password <redacted> and Bearer <redacted>"],
  ["a word after Bearer", "letting docker negotiate Bearer authentication with the registry"],
  ["a word as a credential key's value", "the admin token: missing, and the AppRole token: denied"],
  ["a short hex id near a credential word", "fixed the secret blocks, revalidated, re-planned as 3e1f9a7c2b4d6e80"],
  ["a word that ends in pass", "the compass: north, and bypass = 1"],
  ["basic as a word", "letting the registry fall back to basic authentication"],
  ["a working directory", "ran it with PWD=/home/app/releases/current set"],
  // The re-review's R-003: a key word inside another word, a count or a date is not a credential.
  ["a word ending in pass before a date", "the compass: 2024-10-22 entry"],
  ["test results and counts", "tests pass: 120/120, e2e_pass: 1234567, bypass=12345678, max_tokens: 1234567, throughput_pw: 123456, PASS=1234567 FAIL=0"],
];

for (const [name, text] of KEPT_CASES) {
  test(`kept: ${name}`, () => assert.deepEqual(scrubCredentials(text), { text, redacted: 0 }));
}

test("the count is one per value replaced", () => {
  assert.equal(scrubCredentials(`password ${HEX64}; Bearer ${UUID}`).redacted, 2);
});

const call = (id: string, command: string) => ({ role: "assistant", content: [{ type: "toolCall", id, name: "bash", arguments: { command } }] });
const output = (id: string, text: string) => ({ role: "toolResult", toolCallId: id, toolName: "bash", content: [{ type: "text", text }] });
const taintOf = (messages: unknown[]) => spanCredentials(messages as never);

test("a value from a credential line of the span is redacted wherever the summarizer put it", () => {
  const tainted = taintOf([call("t1", "cat deploy/app.env"), output("t1", "DB_HOST=db1\nDB_PASSWORD=Summer2024x")]);
  assert.equal(scrubCredentials("log in to db1 as app with Summer2024x, then migrate", tainted).text, "log in to db1 as app with <redacted>, then migrate");
});

test("without the span's tokens the same plain-looking value is kept", () => {
  assert.equal(scrubCredentials("log in to db1 as app with Summer2024x, then migrate").redacted, 0);
});

test("a value glued to a flag or a login is still the span's value", () => {
  const tainted = taintOf([output("t1", "password: Summer2024x")]);
  assert.equal(scrubCredentials("ran mysql -pSummer2024x and app/Summer2024x@orcl", tainted).text, "ran mysql -p<redacted> and app/<redacted>@orcl");
});

test("every value a secret store printed is redacted, however plain it looks", () => {
  const tainted = taintOf([call("t1", "vault kv get -field=gateway_key kv/app"), output("t1", "7c41e9a2")]);
  assert.equal(scrubCredentials("the key is 7c41e9a2; add the rewrite", tainted).text, "the key is <redacted>; add the rewrite");
});

test("the words on a credential line are not redacted, only its values", () => {
  const tainted = taintOf([output("t1", "sentinel-control password: Summer2024x")]);
  assert.equal(scrubCredentials("seeded sentinel-control with a new password", tainted).redacted, 0);
});

test("the scrub stays linear on long hostile text (security.md T4)", () => {
  const tainted = new Set(Array.from({ length: 5_000 }, (_, index) => `Secret${index}x`));
  const hostile = ["eyJ-".repeat(40_000), "a_".repeat(60_000) + "password=", "password ".repeat(20_000), `redis://${"a".repeat(600)}:${":".repeat(100_000)}`, "Bearer ".repeat(30_000), `${"0123456789abcdef".repeat(8_000)}`, "key -".repeat(40_000), `key ${".".repeat(300_000)}x`, `pw=${":".repeat(300_000)}`, `postgres://u:${"@".repeat(300_000)}`, `${"-".repeat(300_000)}password`, `${"a1_".repeat(100_000)}pass=`, PEM.repeat(10_000)];
  for (const text of hostile) {
    const started = performance.now();
    scrubCredentials(text, tainted);
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 500, `${elapsed.toFixed(0)} ms on a ${text.length}-char text starting ${JSON.stringify(text.slice(0, 8))}`);
  }
});

test("both summarizer prompts tell the model never to copy a credential's value", async () => {
  const { CREDENTIAL_RULE } = await import("./credential-scrub.ts");
  const { NARRATIVE_SYSTEM_PROMPT } = await import("./narrative/prompt.ts");
  const { TURNS_SYSTEM_PROMPT } = await import("./narrative/turns/conversation.ts");
  assert.match(CREDENTIAL_RULE, /Never copy a password, key, token or other credential's value/);
  assert.ok(NARRATIVE_SYSTEM_PROMPT.includes(CREDENTIAL_RULE));
  assert.ok(TURNS_SYSTEM_PROMPT.includes(CREDENTIAL_RULE));
});

// The review's SEC-001: a span credential holds symbols, or the summarizer wraps it.
const SPAN_CASES: Array<[name: string, spanOutput: string, written: string, want: string]> = [
  ["a password with a semicolon, quoted", "DB_PASSWORD=Ab3$x;9Kq2", "Resume: export DB_PASSWORD='Ab3$x;9Kq2' and migrate", "Resume: export DB_PASSWORD='<redacted>' and migrate"],
  ["a password in bold", "password: Summer2024x", "log in with **Summer2024x** first", "log in with **<redacted>** first"],
  ["a password in curly quotes", "password: Summer2024x", "pw “Summer2024x” works", "pw “<redacted>” works"],
  ["a password between dashes", "password: Summer2024x", "the password—Summer2024x—works", "the password—<redacted>—works"],
  ["a password with no digit", "password: Summerwind", "use Summerwind for the login", "use <redacted> for the login"],
  ["a passphrase named in prose", "the passphrase is correct-horse-battery-staple ok", "the passphrase is correct-horse-battery-staple", "the passphrase is <redacted>"],
];

for (const [name, spanOutput, written, want] of SPAN_CASES) {
  test(`span credential: ${name}`, () => assert.equal(scrubCredentials(written, taintOf([output("t1", spanOutput)])).text, want));
}

test("span credential: a word a credential line printed as a status is not one", () => {
  const tainted = taintOf([output("t1", "token: missing\npassword: changeme")]);
  assert.equal(scrubCredentials("the config file is missing; changeme later", tainted).redacted, 0);
});

const NAMED_CASES: Array<[name: string, text: string, want: string]> = [
  ["a credential key's value with brackets and commas", "password=q7(Lm)Zr!4 and password=N8,tz{4Rq}w", "password=<redacted> and password=<redacted>"],
  ["a URL password holding an @", "postgres://app:p@ss1234@db/app", "postgres://app:<redacted>@db/app"],
];

for (const [name, text, want] of NAMED_CASES) {
  test(`named: ${name}`, () => assert.equal(scrubCredentials(text).text, want));
}

// Measured on real states: the broad named-value taint redacted versions, hashes and names in a third of the fields.
const SPAN_KEPT_CASES: Array<[name: string, spanOutput: string, written: string]> = [
  ["a token count", "max_tokens: 16384\ninput_tokens: 131072", "the request had 131072 input tokens and a 16384 cap"],
  ["a test runner's pass count", "ℹ pass 932\nℹ fail 0", "all 932 tests pass"],
  ["a list of secret names", "secrets: app-token, gateway-key", "the app-token secret is listed"],
  ["a credential key holding a name", "token_env: APP_MCP_TOKEN\nsecret_path: secret/app/gateway\ntoken_file: token.txt", "read APP_MCP_TOKEN from secret/app/gateway into token.txt"],
  ["a version on a credential line", "auth token: issued by vault 1.18.2", "upgraded vault to 1.18.2"],
  ["words after pin, card or login", "pin pi-longhaul to 1.0.3; the gallery card says pi-longhaul-ext; login shell uses bash-5.2", "pinned pi-longhaul at 1.0.3 and updated pi-longhaul-ext"],
];

for (const [name, spanOutput, written] of SPAN_KEPT_CASES) {
  test(`span kept: ${name}`, () => assert.deepEqual(scrubCredentials(written, taintOf([output("t1", spanOutput)])), { text: written, redacted: 0 }));
}

// Found on a real compaction: a credential key whose value is computed made every word of the command after it
// a credential, so `python3` and `sys,json` were redacted wherever the summarizer wrote them.
const SPAN_KEPT_COMMAND_CASES: Array<[name: string, command: string]> = [
  ["a credential key set from a command", `TOKEN=$(vault kv get -format=json kv/app 2>/dev/null | python3 -c "import sys,json; print(1)")`],
  ["a credential key set from a quoted command", `export API_KEY="$(op read op://vault/app/key) python3"`],
  ["a credential key set from a backquoted command", "TOKEN=`vault kv get -field=token kv/app` python3 -c 'import sys,json'"],
  ["a credential header given a variable", `curl -H "X-Cluster-Token: $TOKEN" https://example.com/v1/jobs | python3 -c "import sys,json; print(1)"`],
];

test("span kept: a call a secret key is set from is code, while a password key's value is one whatever its shape", () => {
  assert.deepEqual([...taintOf([call("t1", `python3 -c "import json\nsecret = json.load(open('app.json'))['key']\nimgtok = json.load(open('app.json'))['img']"`)])], []);
  assert.deepEqual([...taintOf([output("t1", "DB_PASSWORD=q7(Lm)Zr!4")])], ["q7(Lm)Zr!4"]);
});

for (const [name, command] of SPAN_KEPT_COMMAND_CASES) {
  test(`span kept: the words after ${name}`, () => assert.deepEqual([...taintOf([call("t1", command)])], []));
}

// Also found on real states: a Go test's name after `--- PASS:`, and an id after a file named for a credential.
const SPAN_KEPT_REPORT_CASES: Array<[name: string, spanOutput: string, written: string]> = [
  ["a test name a runner passed", "=== RUN   TestBridge2RejectsStaleGpuPanel\n--- PASS: TestBridge2RejectsStaleGpuPanel (0.01s)\nPASS", "refactored TestBridge2RejectsStaleGpuPanel and it passes"],
  ["an id after a file named for a credential", "BEARER=$(cat /tmp/admin-bearer.txt) for id in studio 3f7a2c91-5b4e-4d8a-9c1f-7e6b2a0d4c58; do", "the agent gave tool id 3f7a2c91-5b4e-4d8a-9c1f-7e6b2a0d4c58"],
];

for (const [name, spanOutput, written] of SPAN_KEPT_REPORT_CASES) {
  test(`span kept: ${name}`, () => assert.deepEqual(scrubCredentials(written, taintOf([output("t1", spanOutput)])), { text: written, redacted: 0 }));
}

test("span kept: an id or hash its label names, on a credential line or in a secret store's output", () => {
  const evaluation = "3f7a2c91-5b4e-4d8a-9c1f-7e6b2a0d4c58";
  const tainted = taintOf([
    output("t0", "Rotated a fresh BETTER_AUTH_SECRET. Planned: plan_hash 48e1c9a07b3d52f6."),
    call("t1", "TOKEN=$(vault kv get -field=token kv/app); deployctl run app.hcl"),
    output("t1", `==> Monitoring evaluation\n    Evaluation ID: ${evaluation}\n    commit 9c1f7e6b2a0d4c583f7a2c915b4e4d8a7e6b2a0d`),
  ]);
  const written = `planned plan_hash 48e1c9a07b3d52f6, evaluation ${evaluation} at commit 9c1f7e6b2a0d4c583f7a2c915b4e4d8a7e6b2a0d`;
  assert.deepEqual(scrubCredentials(written, tainted), { text: written, redacted: 0 });
});

test("span credential: a random-looking value a secret store printed with no id label is still one", () => {
  const tainted = taintOf([call("t1", "vault kv get kv/app"), output("t1", "Key    Value\napi    Qx7mZ2pLr9Vb4Nc8Kd1Hf")]);
  assert.equal(scrubCredentials("used Qx7mZ2pLr9Vb4Nc8Kd1Hf for the api", tainted).text, "used <redacted> for the api");
});

test("named: a bare pass key is one only before =, and a credential word outside a file name still names a value", () => {
  assert.equal(scrubCredentials("pass=Summer2024x and --- PASS: TestBridge2RejectsStaleGpuPanel").text, "pass=<redacted> and --- PASS: TestBridge2RejectsStaleGpuPanel");
  assert.equal(scrubCredentials("the token in /run/app/token.json is 3f7a2c91-5b4e-4d8a-9c1f-7e6b2a0d4c58").text, "the token in /run/app/token.json is <redacted>");
});

// The re-review's SEC-001 to SEC-003: what the narrowing above must still take.
const SPAN_STILL_CASES: Array<[name: string, spanOutput: string, value: string]> = [
  ["Go's :=", `password := "Summer2024!x"`, "Summer2024!x"],
  ["a Makefile's :=", "DB_PASSWORD := Summer2024x", "Summer2024x"],
  ["a typed Python field", `db_password: str = "Summer2024!x"`, "Summer2024!x"],
  ["a typed TypeScript constant", `const dbPassword: string = "Summer2024!x"`, "Summer2024!x"],
  ["a quoted value with an escaped quote", String.raw`DB_PASSWORD="Ab3\"x9Kq2Lm"`, String.raw`Ab3\"x9Kq2Lm`],
  ["a lower-case pass key in code", "auth: {\n  user: 'me@example.com',\n  pass: 'Summer2024!x',\n}", "Summer2024!x"],
  ["a lower-case pass key in YAML", "smtp:\n  pass: Summer2024x", "Summer2024x"],
  ["a YAML passphrase with spaces", "wifi:\n  password: my Secret#Pass 99 # set by ops", "Secret#Pass"],
  ["a secret_id far along its table row", `secret_id${" ".repeat(40)}3f7a2c91-5b4e-4d8a-9c1f-7e6b2a0d4c58`, "3f7a2c91-5b4e-4d8a-9c1f-7e6b2a0d4c58"],
];

for (const [name, spanOutput, value] of SPAN_STILL_CASES) {
  test(`span credential still taken: ${name}`, () => assert.ok(taintOf([output("t1", spanOutput)]).has(value), `not taken from: ${name}`));
}

test("span credential still taken: an id label does not reach across a line", () => {
  const tainted = taintOf([call("t1", "vault kv get kv/app"), output("t1", "rev\nQx7mZ2pLr9Vb4Nc8Kd1Hf\ncommit")]);
  assert.ok(tainted.has("Qx7mZ2pLr9Vb4Nc8Kd1Hf"));
});

test("span credential: a credential key's value is the word it holds, not the words after it", () => {
  assert.deepEqual([...taintOf([output("t1", "API_TOKEN=Qx7mZ2pLr9 python3 deploy.py --dry-run2")])], ["Qx7mZ2pLr9"]);
  assert.deepEqual([...taintOf([output("t1", `"password": "Winter wind 7" python3`)])], ["Winter"]);
});

test("span credential: a password key with letters before it (PGPASSWORD) still names one", () => {
  assert.equal(scrubCredentials("connected with Winterbreeze7 as app", taintOf([output("t1", "PGPASSWORD=Winterbreeze7 psql -h db1")])).text, "connected with <redacted> as app");
});

// The re-review's R-001 and R-002: a password given on a command line, or shaped like a name, is the span's too.
const COMMAND_CASES: Array<[name: string, command: string]> = [
  ["mysql's glued -p", "mysql -uroot -pSummer2024x app"],
  ["sshpass -p", "sshpass -p Summer2024x ssh deploy@host"],
  ["redis-cli -a", "redis-cli -a Summer2024x ping"],
  ["a login given to curl", ["curl", "-u", "admin:Summer2024x", "https://h/api"].join(" ")],
  ["htpasswd -b's last argument", "htpasswd -b .htpasswd admin Summer2024x"],
  ["a password flag", "deploy --db-password Summer2024x --env prod"],
];

for (const [name, command] of COMMAND_CASES) {
  test(`span credential from a command: ${name}`, () => assert.equal(scrubCredentials("then log in with Summer2024x", taintOf([call("t1", command)])).text, "then log in with <redacted>"));
}

const PASSWORD_SHAPE_CASES: Array<[name: string, spanOutput: string, value: string]> = [
  ["a dotted password", "DB_PASSWORD=Summer2024.x", "Summer2024.x"],
  ["a passphrase in words", "ADMIN_PASSWORD=unmade-tremor-oxidize", "unmade-tremor-oxidize"],
  ["a numeric password", "ROOT_PASSWORD=48291375", "48291375"],
  ["a numeric password in prose", "the root password is 48291375", "48291375"],
  ["a pass in prose", "the db pass is Summer2024x", "Summer2024x"],
];

for (const [name, spanOutput, value] of PASSWORD_SHAPE_CASES) {
  test(`span credential: ${name}`, () => assert.equal(scrubCredentials(`use ${value} for it`, taintOf([output("t1", spanOutput)])).text, "use <redacted> for it"));
}

test("span credential: a password in a login without a scheme", () => {
  const tainted = taintOf([call("t1", "psql postgres://app:Summer2024x@db:5432/app")]);
  assert.equal(scrubCredentials("connect as app:Summer2024x@db:5432 or login app:Summer2024x@db", tainted).text, "connect as app:<redacted>@db:5432 or login app:<redacted>@db");
});

test("a YAML password with many comment marks before a carriage return reads in linear time (SEC-005)", () => {
  const timeOf = (marks: number) => {
    const line = `password: a${" #".repeat(marks)}\rx`;
    const started = performance.now();
    taintOf([output("t1", line)]);
    return performance.now() - started;
  };
  timeOf(5_000);
  const small = timeOf(20_000);
  const large = timeOf(80_000);
  assert.ok(large < small * 8 + 20, `${small.toFixed(0)} ms at 20k marks, ${large.toFixed(0)} ms at 80k`);
});

test("private keys with no END line scrub in linear time (R-005): four times the text, at most about four times the time", () => {
  const timeOf = (keys: number) => {
    const text = `${PEM}\n`.repeat(keys);
    const started = performance.now();
    scrubCredentials(text);
    return performance.now() - started;
  };
  timeOf(20_000);
  const small = timeOf(125_000);
  const large = timeOf(500_000);
  assert.ok(large < small * 8, `${small.toFixed(0)} ms at 4 MB, ${large.toFixed(0)} ms at 16 MB`);
});

test("span credential: a credential line with two hundred thousand words neither throws nor stalls (N-001)", () => {
  const line = `password: ${Array.from({ length: 200_000 }, (_, index) => `Value${index}x`).join(" ")}`;
  const started = performance.now();
  assert.doesNotThrow(() => taintOf([output("t1", line)]));
  assert.ok(performance.now() - started < 3_000);
});

test("span credential: a key about passwords, not holding one, gives no value (N-002)", () => {
  const tainted = taintOf([output("t1", "password_policy: strong-default\npassword_hash_algorithm: argon2id\npassword_disabled: sometimes1\npassword_min_length: 123456")]);
  assert.deepEqual(scrubCredentials("the strong-default policy hashes with argon2id, sometimes1, min 123456", tainted).redacted, 0);
});

test("span credential: a short part after the credential's name still names one", () => {
  assert.equal(scrubCredentials("joined with Summerwind77", taintOf([output("t1", "WIFI_PASSPHRASE_2400_BAUD=Summerwind77")])).text, "joined with <redacted>");
});
