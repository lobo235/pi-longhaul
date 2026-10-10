import test from "node:test";
import assert from "node:assert/strict";

import { buildToolContext } from "../tool-context.ts";
import { assistantEntry, chain, compactionEntry, toolResultEntry, userEntry } from "../test-support.ts";
import { OUTPUT_PAGE_CHARS, recallOutput } from "./output.ts";

function session(extra: ReturnType<typeof userEntry>[] = []) {
  return chain([
    userEntry("m1", "run the tests"),
    assistantEntry("a1", "Running.", [{ name: "bash", arguments: { command: "npm test" } }]),
    toolResultEntry("r1", "a1-t0", "bash", "first run\nnot ok 3 - parse splits quoted commas\nAssertionError: expected 2 got 1\n\nCommand exited with code 1", true),
    assistantEntry("a2", "Again.", [{ name: "bash", arguments: { command: "npm  test" } }]),
    toolResultEntry("r2", "a2-t0", "bash", "second run\nnot ok 3 - parse splits quoted commas\nAssertionError: expected 2 got 1\n\nCommand exited with code 1", true),
    compactionEntry("c1", undefined, false),
    ...extra,
  ]);
}

/** The ledger as a compaction carries it (in its details): built over the branch as if never compacted. */
const ledgerOf = (branch: ReturnType<typeof session>) => buildToolContext(branch.filter((entry) => entry.type !== "compaction")).ledger;
const recallFrom = (branch: ReturnType<typeof session>, ref: string, offset?: number) => recallOutput(branch, ledgerOf(branch), { ref, offset });

test("recallOutput C<n>: the raw result of the command's LATEST run on the branch, even from before a compaction", () => {
  const branch = session();
  const ledger = ledgerOf(branch);
  const id = ledger.commands.find((record) => record.command.startsWith("npm"))!.id;
  const result = recallFrom(branch, id);
  assert.equal(result.kind, "output");
  if (result.kind !== "output") return;
  assert.equal(result.command, "npm test");
  assert.match(result.text, /^second run\nnot ok 3/, "the newest run, byte-exact, newlines kept");
  assert.equal(result.remaining, 0);
});

test("recallOutput E<n>: the run of the error's source command whose output carries the error", () => {
  const branch = session([assistantEntry("a3", "Once more.", [{ name: "bash", arguments: { command: "npm test" } }]), toolResultEntry("r3", "a3-t0", "bash", "all 12 tests pass\n\nCommand exited with code 0")]);
  const ledger = ledgerOf(branch);
  const error = ledger.errors[0];
  assert.ok(error, "the failure was recorded as an error");
  const result = recallOutput(branch, ledger, { ref: error.id });
  assert.equal(result.kind, "output");
  if (result.kind === "output") {
    assert.ok(result.text.includes(error.signature), "the output that carried the error");
    assert.doesNotMatch(result.text, /all 12 tests pass/, "not the later passing run of the same command");
  }
});

test("recallOutput pages a long output and says where to continue", () => {
  const long = "x".repeat(OUTPUT_PAGE_CHARS + 500);
  const branch = chain([userEntry("m1", "dump"), assistantEntry("a1", "Dumping.", [{ name: "bash", arguments: { command: "cat big.log" } }]), toolResultEntry("r1", "a1-t0", "bash", long)]);
  const first = recallFrom(branch, "C1");
  assert.ok(first.kind === "output" && first.text.length === OUTPUT_PAGE_CHARS && first.remaining === 500 && first.nextOffset === OUTPUT_PAGE_CHARS);
  const second = recallFrom(branch, "C1", OUTPUT_PAGE_CHARS);
  assert.ok(second.kind === "output" && second.text.length === 500 && second.remaining === 0);
});

test("recallOutput refuses what it cannot give exactly: an unknown id, a non-ledger ref, a redacted command", () => {
  const branch = chain([userEntry("m1", "go"), assistantEntry("a1", "Setting.", [{ name: "bash", arguments: { command: "export API_TOKEN=abc123secretvalue && ./deploy" } }]), toolResultEntry("r1", "a1-t0", "bash", "deployed")]);
  const cases: Array<[string, string, RegExp]> = [
    ["unknown id", "C99", /no command C99/],
    ["file path", "src/a.ts", /command or error id/],
    ["redacted", "C1", /secret/],
  ];
  for (const [name, ref, reason] of cases) {
    const result = recallFrom(branch, ref);
    assert.equal(result.kind, "refused", name);
    if (result.kind === "refused") assert.match(result.reason, reason, name);
  }
});

test("recallOutput E<n> of a non-bash error never answers with a secret-bearing bash run that carries the same text (security.md T3)", () => {
  const branch = chain([
    userEntry("m1", "go"),
    assistantEntry("a1", "Reading.", [{ name: "read", arguments: { path: "missing.txt" } }]),
    toolResultEntry("r1", "a1-t0", "read", "Error: ENOENT: no such file or directory, open 'missing.txt'", true),
    assistantEntry("a2", "Fetching.", [{ name: "bash", arguments: { command: 'curl -s -H "Authorization: Bearer abcdef0123456789" https://api.example.com/items' } }]),
    toolResultEntry("r2", "a2-t0", "bash", "{\"note\":\"Error: ENOENT: no such file or directory, open 'missing.txt'\",\"account_key\":\"s3cr3t\"}"),
  ]);
  const ledger = buildToolContext(branch).ledger;
  const error = ledger.errors.find((record) => record.sourceCommand === undefined);
  assert.ok(error, "the read failure was recorded as an error with no source command");
  const result = recallOutput(branch, ledger, { ref: error.id });
  const text = JSON.stringify(result);
  assert.doesNotMatch(text, /abcdef0123456789|s3cr3t|Authorization/, "neither the secret-bearing command nor its output");
  if (result.kind === "output") assert.match(result.text, /^Error: ENOENT/, "the read's own output");
});

test("recallOutput redacts a credential-shaped line in the output it returns, keeping the rest (security.md T3)", () => {
  const branch = chain([
    userEntry("m1", "env"),
    assistantEntry("a1", "Listing.", [{ name: "bash", arguments: { command: "printenv" } }]),
    toolResultEntry("r1", "a1-t0", "bash", "HOME=/home/u\nSERVICE_TOKEN=abcdef123456\nSHELL=/bin/bash"),
  ]);
  const result = recallFrom(branch, "C1");
  assert.equal(result.kind, "output");
  if (result.kind !== "output") return;
  assert.doesNotMatch(result.text, /abcdef123456/);
  assert.match(result.text, /^HOME=\/home\/u\n<line redacted: it carried a credential>\nSHELL=\/bin\/bash$/);
});

test("recallOutput judges a credential line whole, whatever page or offset cuts it, and a private key's body with its header (security.md T3)", () => {
  const filler = "x".repeat(OUTPUT_PAGE_CHARS - 10);
  const key = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\nQUJDREVGR0hJSktMTU5PUA==\n-----END OPENSSH PRIVATE KEY-----";
  const output = `${filler}\nSERVICE_TOKEN=supersecretvalue\nplain line\n${key}\nafter`;
  const branch = chain([userEntry("m1", "go"), assistantEntry("a1", "Reading.", [{ name: "bash", arguments: { command: "cat creds.txt" } }]), toolResultEntry("r1", "a1-t0", "bash", output)]);
  const pages: string[] = [];
  for (let offset: number | undefined = 0; offset !== undefined; ) {
    const result = recallFrom(branch, "C1", offset);
    assert.equal(result.kind, "output");
    if (result.kind !== "output") break;
    pages.push(result.text);
    offset = result.nextOffset;
  }
  const inside = output.indexOf("supersecret");
  const chosen = recallFrom(branch, "C1", inside);
  const all = [...pages, chosen.kind === "output" ? chosen.text : ""].join("|");
  assert.doesNotMatch(all, /supersecret|b3BlbnNzaC1rZXkt|QUJDREVGR0hJSktMTU5PUA/);
  assert.match(all, /plain line/);
  assert.match(all, /after$/);
});

test("recallOutput never treats a bash result whose call it cannot resolve as a non-bash run (security.md T3)", () => {
  const branch = chain([
    userEntry("m1", "go"),
    assistantEntry("a1", "Reading.", [{ name: "read", arguments: { path: "missing.txt" } }]),
    toolResultEntry("r1", "a1-t0", "read", "Error: ENOENT: no such file or directory, open 'missing.txt'", true),
    toolResultEntry("r2", "orphan-call", "bash", "Error: ENOENT: no such file or directory, open 'missing.txt'\norphan bash output"),
  ]);
  const ledger = buildToolContext(branch).ledger;
  const error = ledger.errors.find((record) => record.sourceCommand === undefined);
  assert.ok(error);
  const result = recallOutput(branch, ledger, { ref: error.id });
  assert.ok(result.kind === "output" && !result.text.includes("orphan bash output"), "the read's own output, not the orphan's");
});

test("recallOutput redacts a PGP private key block's body with its header (security.md T3)", () => {
  const output = "before\n-----BEGIN PGP PRIVATE KEY BLOCK-----\n\nlQOYBGXXXXXXXXXXXXXXXX\n=ABCD\n-----END PGP PRIVATE KEY BLOCK-----\nafter";
  const branch = chain([userEntry("m1", "go"), assistantEntry("a1", "Exporting.", [{ name: "bash", arguments: { command: "gpg --export-secret-keys --armor" } }]), toolResultEntry("r1", "a1-t0", "bash", output)]);
  const result = recallFrom(branch, "C1");
  assert.ok(result.kind === "output");
  if (result.kind !== "output") return;
  assert.doesNotMatch(result.text, /lQOYBG|=ABCD/);
  assert.match(result.text, /^before\n/);
  assert.match(result.text, /\nafter$/);
});

test("recallOutput collapses a run of redacted lines into one marker, so a page never grows past its source (security.md T4)", () => {
  const output = `-----BEGIN RSA PRIVATE KEY-----\n${"a\n".repeat(2000)}-----END RSA PRIVATE KEY-----\ndone`;
  const branch = chain([userEntry("m1", "go"), assistantEntry("a1", "Reading.", [{ name: "bash", arguments: { command: "cat id_rsa" } }]), toolResultEntry("r1", "a1-t0", "bash", output)]);
  const result = recallFrom(branch, "C1");
  assert.ok(result.kind === "output" && result.text === "<line redacted: it carried a credential>\ndone", result.kind === "output" ? result.text.slice(0, 200) : result.reason);
});

test("recallOutput redacts an aligned HCL credential line, however far the formatter padded the separator (security.md T3)", () => {
  const output = 'vault {\n  address             = "https://vault.example:8200"\n  password            = "hunter2"\n}';
  const branch = chain([userEntry("m1", "go"), assistantEntry("a1", "Reading.", [{ name: "bash", arguments: { command: "cat agent.hcl" } }]), toolResultEntry("r1", "a1-t0", "bash", output)]);
  const result = recallFrom(branch, "C1");
  assert.ok(result.kind === "output");
  if (result.kind !== "output") return;
  assert.doesNotMatch(result.text, /hunter2/);
  assert.match(result.text, /address +=/);
});

test("recallOutput masks what the Learned values filter masks: an aligned table, a YAML block value, a bare JWT (table; security.md T3)", () => {
  const cases: Array<[string, string, RegExp, RegExp]> = [
    ["an aligned table", "Key            Value\ntoken          s3cr3tvalue1\ntoken_ttl      768h", /s3cr3tvalue1/, /^Key +Value\n/],
    ["a YAML block value", "auth:\n  client_token: |\n    blockvaluesecret99\n  lease: 3600\nok: true", /blockvaluesecret99/, /\nok: true$/],
    ["a bare JWT", "issued\neyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJlLXZhbHVl\ndone", /eyJhbGci|c2lnbmF0dXJl/, /^issued\n.*\ndone$/],
  ];
  for (const [name, output, secret, kept] of cases) {
    const branch = chain([userEntry("m1", "go"), assistantEntry("a1", "Reading.", [{ name: "bash", arguments: { command: "cat config.out" } }]), toolResultEntry("r1", "a1-t0", "bash", output)]);
    const result = recallFrom(branch, "C1");
    assert.ok(result.kind === "output", name);
    if (result.kind !== "output") continue;
    assert.doesNotMatch(result.text, secret, name);
    assert.match(result.text, kept, name);
    assert.match(result.text, /<line redacted: it carried a credential>/, name);
  }
});
