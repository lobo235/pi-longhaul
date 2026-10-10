import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import { COMMAND_CAP, EXACT_HALF_BUDGET, collectHandoff, finishHandoff, type CommandRecord, type HandoffDetails } from "./handoff.ts";
import { containsSecret } from "./handoff-commands.ts";
import { bashCall, bashExecution, branchWith, handoffDetailsOf as detailsOf, userMsg as user } from "./test-support.ts";

// --- extraction ----------------------------------------------------------------------------------

test("collectHandoff: bash tool calls and !executions become command records with runs and exit codes", () => {
  const messages = [
    user("go"),
    ...bashCall("make check"),
    ...bashCall("make   check", 2, "tsc: error TS2322"),
    ...bashCall("make check"),
    bashExecution("git push", 0),
    ...bashCall("npm test", "timeout"),
    ...bashCall("node --test x.test.ts", "pending"),
  ];
  const state = collectHandoff({ branchEntries: [], messages });
  assert.equal(state.pass, 1);
  const byText = Object.fromEntries(state.commands.map((c) => [c.command, c]));
  // dedupe on whitespace-normalized text, original text of the first sighting kept
  assert.deepEqual(Object.keys(byText).sort(), ["git push", "make check", "node --test x.test.ts", "npm test"]);
  assert.equal(byText["make check"].runs, 3);
  assert.equal(byText["make check"].lastExitCode, 0);
  assert.equal(byText["make check"].failedThenSucceeded, true);
  assert.equal(byText["git push"].runs, 1);
  assert.equal(byText["npm test"].lastExitCode, null); // timeout: no exit code
  assert.equal(byText["node --test x.test.ts"].lastExitCode, null); // no result yet
  assert.ok(state.commands.every((c) => c.lastSeenPass === 1));
  assert.deepEqual(state.commands.map((c) => c.id), ["C1", "C2", "C3", "C4"]);
});

test("collectHandoff: a record carries when its command last ran (the result's time; a pending call's own)", () => {
  const at = (message: AgentMessage, ms: number) => ({ ...message, timestamp: ms }) as AgentMessage;
  const [call, result] = bashCall("npm test");
  const [pending] = bashCall("make build", "pending");
  const messages = [at(call, Date.parse("2026-09-28T09:40:00Z")), at(result, Date.parse("2026-09-28T09:46:00Z")), at(pending, Date.parse("2026-09-28T09:50:00Z")), at(bashExecution("git push"), Date.parse("2026-09-28T09:55:00Z"))];
  const byText = Object.fromEntries(collectHandoff({ branchEntries: [], messages }).commands.map((c) => [c.command, c]));
  assert.equal(byText["npm test"].lastRanAt, "2026-09-28T09:46:00.000Z");
  assert.equal(byText["make build"].lastRanAt, "2026-09-28T09:50:00.000Z");
  assert.equal(byText["git push"].lastRanAt, "2026-09-28T09:55:00.000Z");
});

test("collectHandoff: a !! execution excluded from the model's context is not recorded; no prose is parsed", () => {
  const messages = [
    user("please run `rm -rf build` for me"),
    bashExecution("secret-tool", 0, { excludeFromContext: true }),
    { role: "assistant", content: [{ type: "text", text: "I ran `make lint` earlier" }], timestamp: 9 } as unknown as AgentMessage,
  ];
  assert.deepEqual(collectHandoff({ branchEntries: [], messages }).commands, []);
});

test("collectHandoff: secrets are redacted in the record and the record is kept", () => {
  const messages = [
    ...bashCall("curl -H 'Authorization: Bearer abc' https://example.invalid/api"),
    ...bashCall("API_TOKEN_X=deadbeef ./run.sh"),
    ...bashCall("mysql -p'hunter2' -e 'select 1'"),
    ...bashCall("aws s3 ls --profile AKIAIOSFODNN7EXAMPLE"),
    ...bashCall("echo PASSWORD=x"),
    ...bashCall("pi -p \"Say done\" --model m"),
  ];
  const { commands } = collectHandoff({ branchEntries: [], messages });
  const texts = commands.map((c) => c.command);
  assert.ok(!texts.some((t) => /abc|deadbeef|hunter2|AKIA|PASSWORD=x/.test(t)), texts.join("\n"));
  assert.equal(texts.filter((t) => t === "<redacted>").length, 1, "redacted commands collapse into one record");
  assert.equal(commands.find((c) => c.command === "<redacted>")?.runs, 5);
  assert.ok(texts.includes('pi -p "Say done" --model m'), "a pi prompt flag is not a mysql password");
});

// --- carry-forward -------------------------------------------------------------------------------

test("three consecutive compactions accumulate commands through details, with stable ids and pass numbers", () => {
  const first = finishHandoff(collectHandoff({ branchEntries: [], messages: [...bashCall("make check"), ...bashCall("ls")] }));
  assert.deepEqual(first.commands.map((c) => [c.id, c.runs, c.lastSeenPass]), [["C1", 1, 1], ["C2", 1, 1]]);

  const second = finishHandoff(
    collectHandoff({ branchEntries: branchWith(detailsOf(first)), messages: [...bashCall("make check", 1), ...bashCall("npm test")] }),
  );
  const secondById = Object.fromEntries(second.commands.map((c) => [c.id, c]));
  assert.equal(secondById.C1.runs, 2);
  assert.equal(secondById.C1.lastExitCode, 1);
  assert.equal(secondById.C1.lastSeenPass, 2);
  assert.equal(secondById.C2.lastSeenPass, 1, "a command not seen this pass keeps its earlier pass");
  assert.equal(secondById.C3.command, "npm test");

  const third = finishHandoff(
    collectHandoff({ branchEntries: branchWith(detailsOf(first), detailsOf(second)), messages: [...bashCall("make check")] }),
  );
  const thirdById = Object.fromEntries(third.commands.map((c) => [c.id, c]));
  assert.equal(third.commands.length, 3);
  assert.equal(thirdById.C1.runs, 3);
  assert.equal(thirdById.C1.failedThenSucceeded, true, "a failure in pass 2 followed by success in pass 3");
  assert.equal(thirdById.C1.lastExitCode, 0);
  assert.equal(thirdById.C2.lastSeenPass, 1);
  assert.equal(collectHandoff({ branchEntries: branchWith(detailsOf(first), detailsOf(second)), messages: [] }).pass, 3);
});

test("carry-forward ignores a previous entry whose details have no handoff data (pi-generated or older extension)", () => {
  const entry = branchWith({ readFiles: ["a"], modifiedFiles: [] } as unknown as HandoffDetails);
  const state = collectHandoff({ branchEntries: entry, messages: [...bashCall("make check")] });
  assert.equal(state.pass, 2);
  assert.deepEqual(state.commands.map((c) => c.id), ["C1"]);
});

test("ids never restart: a new command after a dropped record gets a fresh id", () => {
  const previous: CommandRecord[] = [{ id: "C7", command: "make check", runs: 1, lastExitCode: 0, failedThenSucceeded: false, lastSeenPass: 1 }];
  const state = collectHandoff({
    branchEntries: branchWith({ readFiles: [], modifiedFiles: [], commands: previous, errors: [] }),
    messages: [...bashCall("npm test")],
  });
  assert.deepEqual(state.commands.map((c) => c.id), ["C7", "C8"]);
});

// --- scoring and the cap -------------------------------------------------------------------------

test("over the cap, trivial commands are dropped first and a failed-then-succeeded pipeline beats a trivial command with more runs", () => {
  const messages: AgentMessage[] = [];
  for (let i = 0; i < COMMAND_CAP; i++) messages.push(...bashCall(`node script-${i}.js`));
  messages.push(...bashCall("ls"), ...bashCall("ls"), ...bashCall("ls"), ...bashCall("ls"));
  messages.push(...bashCall("cat one.txt | jq .x", 1), ...bashCall("cat one.txt | jq .x", 0));
  const finished = finishHandoff(collectHandoff({ branchEntries: [], messages }));
  assert.equal(finished.commands.length, COMMAND_CAP);
  const texts = finished.commands.map((c) => c.command);
  assert.ok(!texts.includes("ls"), "trivial command dropped first");
  assert.ok(texts.includes("cat one.txt | jq .x"), "failed-then-succeeded pipeline kept");
});

test("among equal scores the oldest record is dropped first; a stale one ages out", () => {
  const messages: AgentMessage[] = [...bashCall("make drift-check")];
  for (let i = 0; i < COMMAND_CAP; i++) messages.push(...bashCall(`node script-${i}.js`));
  const capped = finishHandoff(collectHandoff({ branchEntries: [], messages }));
  assert.ok(!capped.commands.some((c) => c.command === "make drift-check"));

  // A record last seen many passes ago loses one point per pass and drops before a fresh one.
  const stale: CommandRecord = { id: "C1", command: "node old.js", runs: 2, lastExitCode: 0, failedThenSucceeded: false, lastSeenPass: 1 };
  const fresh: AgentMessage[] = [];
  for (let i = 0; i < COMMAND_CAP; i++) fresh.push(...bashCall(`node new-${i}.js`));
  const branch = branchWith(...Array.from({ length: 6 }, () => ({ readFiles: [], modifiedFiles: [], commands: [stale], errors: [] })));
  const aged = finishHandoff(collectHandoff({ branchEntries: branch, messages: fresh }));
  assert.ok(!aged.commands.some((c) => c.command === "node old.js"));
});

// --- rendering -----------------------------------------------------------------------------------

test("finishHandoff renders the blocks in their line format and order", () => {
  const messages = [...bashCall("make check"), ...bashCall("make check", 2, "FAILED: lint"), ...bashCall("make check"), ...bashCall("npm test", "timeout", "running")];
  const finished = finishHandoff(collectHandoff({ branchEntries: [], messages }));
  assert.equal(
    finished.exactHalf,
    "\n\n<commands>\nC1 [runs:3 exit:0 failed-then-ok] make check\nC2 [runs:1 exit:?] npm test\n</commands>" +
      "\n\n<errors>\nE1 [resolved C1] FAILED: lint\nE2 [unresolved C2] running\nCommand timed out after 30 seconds\n</errors>",
  );
});

test("finishHandoff renders nothing when there are no records", () => {
  const finished = finishHandoff(collectHandoff({ branchEntries: [], messages: [user("hi")] }));
  assert.equal(finished.exactHalf, "");
});

test("the exact half never exceeds its budget: long commands are truncated to 300 chars and marked, then the lowest-ranked are dropped", () => {
  const messages: AgentMessage[] = [];
  for (let i = 0; i < COMMAND_CAP; i++) messages.push(...bashCall(`node -e "${"x".repeat(900)}" # ${i}`));
  const finished = finishHandoff(collectHandoff({ branchEntries: [], messages }));
  assert.ok(finished.exactHalf.length <= EXACT_HALF_BUDGET, `${finished.exactHalf.length} > ${EXACT_HALF_BUDGET}`);
  const truncated = finished.commands.filter((c) => c.truncated);
  assert.ok(truncated.length > 0);
  for (const record of truncated) {
    assert.ok(record.command.length <= 300, record.command.length.toString());
    assert.ok(record.command.endsWith("..."));
  }
  // Only as many texts are cut as the budget needs, and a cut is permanent: the carried record is the cut one.
  assert.ok(truncated.length < COMMAND_CAP, "the last record stayed whole once the budget held");
  const next = collectHandoff({ branchEntries: branchWith(detailsOf(finished)), messages: [] });
  assert.equal(next.commands.filter((c) => c.truncated).length, truncated.length);
  assert.ok(next.commands.filter((c) => c.truncated).every((c) => c.command.length <= 300));
});

test("split turn: commands are extracted from both ranges, the history before the turn prefix", () => {
  const state = collectHandoff({
    branchEntries: [],
    messages: [...bashCall("make check")],
    turnPrefixMessages: [...bashCall("npm test", 1)],
  });
  assert.deepEqual(state.commands.map((c) => [c.id, c.command]), [["C1", "make check"], ["C2", "npm test"]]);
});

test("containsSecret: bounds are wide enough that a long credential is still redacted", () => {
  assert.equal(containsSecret(`git clone https://deploy:${"p".repeat(300)}@git.example/repo.git`), true);
  assert.equal(containsSecret(`https://${"u".repeat(100)}:hunter2@git.example/repo.git`), true);
  assert.equal(containsSecret(`mysql ${"-e 'select 1' ".repeat(50)}-phunter2`), true);
});

test("containsSecret: credential shapes in headers, flags, URLs and key material", () => {
  const secret = [
    "wget --header 'X-Api-Key: 0123456789' https://x",
    "psql postgres://app:hunter2@db.example/app",
    "psql postgres://app:Kq7/vZ2mP9@db/app",
    "DATABASE_URL=postgres://admin:s3cr3t/xyz@db/app",
    "redis://:pa:ss/word@cache:6379/0",
    "ADMIN_PIN=4821",
    "export OTP_CODE=123456",
    "CARD_CVV: 123",
    "mfa_code=482913",
    "adminPin=4821",
    "BANKPIN=4821",
    "AdminPIN=4821",
    "TOTP=JBSWYDPEHPKBPXPQ",
    "export MFA_SECRET=JBSWYDPEHPKBPXPQ",
    "otp_seed: 'GEZDGNBVGYZTQOJQ'",
    "curl -d '{\"totp\": \"JBSWYDPEHPKBPXPQ\"}' https://x",
    "curl -d '{\"otp_code\": \"123456\"}' https://x",
    "curl -d '{\"admin_pin\": \"4821\"}' https://x",
    "OTP_SEED=jbswydpehpkbpxpq",
    'curl -d "{\\"otp_code\\": \\"123456\\"}" https://x',
    'curl -d "{\\"pin\\":\\"4821\\"}" https://x',
    'curl -d "{\\"totp\\": \\"JBSWYDPEHPKBPXPQ\\"}" https://x',
    'curl -d "{\\"otp_seed\\": \\"jbswydpehpkbpxpq\\"}" https://x',
    "oathtool --totp -b JBSWY3DPEHPK3PXP",
    "oathtool --totp --base32 JBSWYDPEHPKBPXPQ",
    "aws sts get-session-token --serial-number arn:aws:iam::0:mfa/u --token-code 123456",
    "aws sts get-session-token --serial-number arn:aws:iam::0:mfa/u --token-code=123456",
    "aws iam enable-mfa-device --user-name u --serial-number s --authentication-code1 123456 --authentication-code2 654321",
    "aws iam enable-mfa-device --authentication-code-1 123456",
    "oathtool --totp -bv JBSWY3DPEHPK3PXP",
    "oathtool --hotp 3132333435363738393031323334353637383930",
    "ykman oath accounts add github JBSWY3DPEHPK3PXP",
    "mytool --db-password hunter2",
    "mytool --admin-password hunter2",
    "az ad sp create --client-secret s3cr3tvalue",
    "mytool --auth-token abc123def",
    "mytool --api-token abc123",
    "mytool --new-password hunter2",
    "ykman piv access change-pin --new-pin 654321",
    "sshpass -p hunter2 ssh host",
    "htpasswd -b file user hunter2",
    "ykman otp yubiotp 1 --key 0123456789abcdef0123456789abcdef",
    "mytool --db.password hunter2",
    "mytool --pass hunter2",
    "openssl enc -aes-256-cbc -pass pass:hunter2 -in f",
    "openssl pkcs12 -in c.p12 -passin pass:hunter2",
    "redis-cli -h host -a hunter2 ping",
    "keytool -list -keystore ks.jks -storepass hunter2",
    "sshpass -v -p hunter2 ssh host",
    "mytool --db-root-password hunter2",
    "mytool --azure-client-secret abc",
    "mytool --spring.datasource.password hunter2",
    "keytool -importkeystore -srckeypass a -destkeypass b",
    "openssl enc -aes256 -k hunter2 -in f",
    "sshpass -P assword: -p hunter2 ssh h",
    "totp_key: JBSW YDPE HPKB PXPQ",
    "MFA_KEY=JBSW-YDPE-HPKB-PXPQ",
    "TOTP=" + "JBSWYDPEHPKBPXPQ".repeat(6),
    "tool unlock --pin 4821",
    "gpg --passphrase hunter2 -d file",
    "http -u admin:hunter2 https://x",
    "git clone https://oauth2:ghp_aaaaaaaaaaaaaaaaaaaaaaaa@github.example/x/y",
    "printf -- '-----BEGIN OPENSSH PRIVATE KEY-----' > k",
    "export OPENAI_API_KEY=sk-aaaaaaaaaaaaaaaaaaaaaaaa",
    "gh auth login --token ghp_aaaaaaaaaaaaaaaaaaaaaaaa",
  ];
  const clean = [
    "docker login --password-stdin < f",
    "gh auth login --with-token < token.txt",
    "ykman piv keys generate --key-type ECCP256 9a pub.pem",
    "sshpass -f pwfile ssh -p 2222 host",
    "mytool --reset-password me@example.com",
    "mytool --revoke-token abcd",
    "npm run build -- --max-pin 3",
    "curl --cert-pin sha256//abc https://x",
    "git commit --no-verify -m 'bypass the hook'",
    "ffmpeg -i in.mp4 -c:v libx264 -b:v 2M -pass 1 -f null /dev/null",
    "x264 --pass 2 -o out.mkv in.y4m",
    "openssl enc -aes256 -pass env:PW -in f",
    "openssl enc -aes256 -pass file:pw.txt -in f",
    "mytool --first-pass x",
    "git push origin main",
    "grep -u foo file",
    "cat docs/api-keys.md",
    "npm test -- --passWithNoTests",
    "curl https://example.com:8443/path",
    "curl http://localhost:8080/api/users/a@b.example",
    "SPINNER=dots npm test",
    "mfa: enabled",
    "pin: true",
    "otp: false",
    "cvv: required",
    "ENABLE_MFA=true ./deploy",
    "docker run -e MFA=off app",
    "helm upgrade app ./chart --set otp=false",
    "image: ghcr.io/acme/pin:latest",
    "opinion: fine",
    "mfa: requiredforallusersnow",
    "TOTP=ENABLED",
    "curl -d '{\"mfa\": \"enabled\"}' https://x",
    "otp_mode=totp",
    "git log --pretty=oneline",
    "open https://example.com:443/u/someone@example.com",
  ];
  for (const text of secret) assert.ok(containsSecret(text), `should redact: ${text}`);
  for (const text of clean) assert.ok(!containsSecret(text), `should keep: ${text}`);
});

test("containsSecret: linear on long input, so one large heredoc command cannot stall the compaction", () => {
  const started = Date.now();
  for (const text of ["a".repeat(128_000), `sk-${"a".repeat(128_000)}`, "mysql ".repeat(50_000), `-----BEGIN ${"A ".repeat(64_000)}`, `token${" ".repeat(40)}`.repeat(5_000), "token".repeat(40_000), `password${"\t".repeat(200_000)}x`, `a://u:${"/".repeat(128_000)}`, "a://:".repeat(40_000), `a://${":".repeat(128_000)}`]) containsSecret(text);
  // ~200 ms alone; the bound has room for a loaded parallel run, and backtracking on 128k characters takes minutes.
  assert.ok(Date.now() - started < 5000, `${Date.now() - started} ms`);
  assert.ok(containsSecret("psql postgres://app:hunter2@db.example/app"));
  assert.ok(containsSecret("mysql -h db -u app -phunter2 -e 'select 1'"));
});

test("collectHandoff: records carried in a state compactor entry (details.ledger) and in another compactor's entry (details.commands) are both rehydrated; a pi entry carries none", () => {
  const first = finishHandoff(collectHandoff({ branchEntries: [], messages: bashCall("make check", 2, "boom") }));
  const stateEntry = { type: "compaction", id: "c0", parentId: null, timestamp: "2026-09-28T00:00:00.000Z", summary: "s", firstKeptEntryId: "x", tokensBefore: 1, fromHook: true, details: { compactor: "state", ledger: { commands: first.commands, errors: first.errors } } } as unknown as SessionEntry;
  const piEntry = { ...stateEntry, id: "c1", fromHook: false, details: { readFiles: [], modifiedFiles: [] } } as unknown as SessionEntry;
  assert.equal(collectHandoff({ branchEntries: [stateEntry], messages: [] }).commands[0]?.id, "C1");
  assert.equal(collectHandoff({ branchEntries: branchWith(detailsOf(first)), messages: [] }).commands[0]?.id, "C1");
  assert.deepEqual(collectHandoff({ branchEntries: [piEntry], messages: [] }).commands, []);
});

test("collectHandoff (security.md T1): a timestamp no Date can hold records no time, it never throws", () => {
  const [call, result] = bashCall("npm test");
  for (const ms of [1e17, -1e17, Number.MAX_VALUE]) {
    const messages = [call, { ...result, timestamp: ms } as AgentMessage];
    const [record] = collectHandoff({ branchEntries: [], messages }).commands;
    assert.equal(record.lastRanAt, undefined, String(ms));
  }
});

test("containsSecret: a quoted credential key (JSON, YAML, env) is a secret too (security.md T3)", () => {
  for (const text of [`{"password": "hunter2"}`, `curl -d '{"token":"abc"}' https://api.example`, `'secret': 'x'`, `api_key: "abc"`]) assert.equal(containsSecret(text), true, text);
  for (const text of [`npm test`, `grep -n "tokens" README.md`, `"tokenizer" is fine`]) assert.equal(containsSecret(text), false, text);
});

test("containsSecret: escaped-quote JSON and age keys are secrets; a long keyword-dense word stays linear (security.md T3, T4)", () => {
  for (const text of [`{\\"password\\":\\"aHVudGVyMg==\\"}`, `AGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ`, `-----BEGIN PGP PRIVATE KEY BLOCK-----`]) assert.equal(containsSecret(text), true, text);
  const started = Date.now();
  containsSecret("token".repeat(40_000)); // 200 KB: the unbounded pattern took ~1.9 s here, the bounded one ~20 ms
  assert.ok(Date.now() - started < 500, `took ${Date.now() - started} ms`);
});

test("containsSecret: aligned config keys are secrets however far the separator is padded (security.md T3)", () => {
  for (const text of [
    `  password            = "hunter2"`,
    `secret\t\t\t\t\t\t\t\t\t= x`,
    `SECRET_${"A".repeat(70)}=x`,
    `12:   password        = "x"`,
  ]) assert.ok(containsSecret(text), `should redact: ${text}`);
});
