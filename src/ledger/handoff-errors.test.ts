import assert from "node:assert/strict";
import { test } from "node:test";

import { ERROR_CAP, EXACT_HALF_BUDGET, collectHandoff, finishHandoff, type ErrorRecord } from "./handoff.ts";
import { bashCall, bashExecution, branchWith, handoffDetailsOf as detailsOf, toolResult } from "./test-support.ts";

const TSC_ERROR = "src/a.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.\n\n  12   const x: number = 'a';\n               ~\nFound 1 error.";

// --- extraction ----------------------------------------------------------------------------------

test("errors: a failing bash result becomes a record whose signature is the matching line plus three more, tied to its command", () => {
  const state = collectHandoff({ branchEntries: [], messages: [...bashCall("npx tsc --noEmit", 2, TSC_ERROR)] });
  assert.equal(state.errors.length, 1);
  const [error] = state.errors;
  assert.equal(error.id, "E1");
  assert.equal(error.signature, "src/a.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.\n\n  12   const x: number = 'a';\n               ~");
  assert.equal(error.sourceCommand, "npx tsc --noEmit");
  assert.equal(error.resolved, false);
  assert.equal(error.lastSeenPass, 1);
});

test("errors: a non-zero exit with no error line keeps the last lines of output; a non-bash tool error has no source command; clean output is not an error", () => {
  const messages = [
    ...bashCall("make check", 2, "building\nmake: *** [Makefile:12: check] Error 2"),
    toolResult("read-1", "read", "Error: ENOENT: no such file or directory, open 'missing.ts'", true),
    ...bashCall("echo hi", 0, "hi\nno errors here"),
  ];
  const { errors } = collectHandoff({ branchEntries: [], messages });
  assert.deepEqual(errors.map((e) => [e.id, e.signature, e.sourceCommand]), [
    ["E1", "building\nmake: *** [Makefile:12: check] Error 2", "make check"],
    ["E2", "Error: ENOENT: no such file or directory, open 'missing.ts'", undefined],
  ]);
});

test("errors: dedupe ignores line numbers, hex addresses and timestamps; a second sighting keeps the first signature", () => {
  const messages = [
    ...bashCall("node x.js", 1, "Error: boom at 0x7fff1234 (line 12) 2026-09-15T10:00:00Z\n    at f (x.js:12:5)"),
    ...bashCall("node x.js", 1, "Error: boom at 0x7fffabcd (line 99) 2026-09-15T11:30:00Z\n    at f (x.js:99:1)"),
  ];
  const { errors } = collectHandoff({ branchEntries: [], messages });
  assert.equal(errors.length, 1);
  assert.match(errors[0].signature, /0x7fff1234/);
});

test("errors: a later zero exit of the same command resolves the record mechanically; an earlier one does not", () => {
  const resolved = collectHandoff({ branchEntries: [], messages: [...bashCall("make check", 2, "FAILED: x"), ...bashCall("make check", 0)] });
  assert.equal(resolved.errors[0].resolved, true);
  const open = collectHandoff({ branchEntries: [], messages: [...bashCall("make check", 0), ...bashCall("make check", 2, "FAILED: x")] });
  assert.equal(open.errors[0].resolved, false);
  const execution = collectHandoff({ branchEntries: [], messages: [bashExecution("go test ./...", 1, { output: "FAIL: TestX\n--- FAIL" }), bashExecution("go test ./...", 0)] });
  assert.equal(execution.errors[0].resolved, true);
  assert.equal(execution.errors[0].sourceCommand, "go test ./...");
});

// --- carry-forward -------------------------------------------------------------------------------

test("three consecutive compactions accumulate errors through details: ids are stable, a re-seen error reopens, a later success resolves", () => {
  const first = finishHandoff(collectHandoff({ branchEntries: [], messages: [...bashCall("make check", 2, "FAILED: a")] }));
  assert.deepEqual(first.errors.map((e) => [e.id, e.resolved, e.lastSeenPass]), [["E1", false, 1]]);

  const second = finishHandoff(
    collectHandoff({ branchEntries: branchWith(detailsOf(first)), messages: [...bashCall("make check", 0), ...bashCall("npm test", 1, "FAILED: b")] }),
  );
  assert.deepEqual(second.errors.map((e) => [e.id, e.resolved, e.lastSeenPass]), [["E1", true, 1], ["E2", false, 2]]);

  const third = finishHandoff(
    collectHandoff({ branchEntries: branchWith(detailsOf(first), detailsOf(second)), messages: [...bashCall("make check", 2, "FAILED: a")] }),
  );
  assert.deepEqual(third.errors.map((e) => [e.id, e.resolved, e.lastSeenPass]), [["E1", false, 3], ["E2", false, 2]]);
});

test("over the cap, resolved records go first and unresolved ones are kept whatever their age", () => {
  const previous: ErrorRecord[] = [];
  for (let i = 1; i <= ERROR_CAP + 4; i++) {
    previous.push({ id: `E${i}`, signature: `Error: e${i}`, resolved: i % 2 === 0, lastSeenPass: i });
  }
  const finished = finishHandoff(collectHandoff({ branchEntries: branchWith({ readFiles: [], modifiedFiles: [], commands: [], errors: previous }), messages: [] }));
  assert.equal(finished.errors.length, ERROR_CAP);
  const unresolved = previous.filter((e) => !e.resolved).map((e) => e.id);
  for (const id of unresolved) assert.ok(finished.errors.some((e) => e.id === id), `${id} kept`);
});

// --- rendering -----------------------------------------------------------------------------------

test("the <errors> block follows <commands>, names the source command record, and carries the state", () => {
  const messages = [...bashCall("make check", 2, "FAILED: lint"), ...bashCall("make check", 0), toolResult("r1", "read", "Error: ENOENT missing.ts", true)];
  const finished = finishHandoff(collectHandoff({ branchEntries: [], messages }));
  assert.equal(
    finished.exactHalf,
    "\n\n<commands>\nC1 [runs:2 exit:0 failed-then-ok] make check\n</commands>" +
      "\n\n<errors>\nE1 [resolved C1] FAILED: lint\nE2 [unresolved] Error: ENOENT missing.ts\n</errors>",
  );
});

test("the exact-half budget counts the errors block too", () => {
  const messages = [];
  for (let i = 0; i < ERROR_CAP; i++) messages.push(...bashCall(`node -e "${"x".repeat(900)}" # ${i}`, 1, `Error: ${"y".repeat(500)} ${i}`));
  const finished = finishHandoff(collectHandoff({ branchEntries: [], messages }));
  assert.ok(finished.exactHalf.length <= EXACT_HALF_BUDGET, `${finished.exactHalf.length}`);
  assert.ok(finished.errors.every((e) => e.signature.length <= 400));
});

test("a note carried on a record an older compactor wrote is kept and rendered; nothing here writes one", () => {
  const commands = [{ id: "C1", command: "make check", runs: 1, lastExitCode: 2, failedThenSucceeded: false, lastSeenPass: 1, note: "full lint and typecheck" }];
  const errors: ErrorRecord[] = [{ id: "E1", signature: "FAILED: lint", sourceCommand: "make check", resolved: true, lastSeenPass: 1, note: "fixed by adding the missing import" }];
  const finished = finishHandoff(collectHandoff({ branchEntries: branchWith({ readFiles: [], modifiedFiles: [], commands, errors }), messages: [...bashCall("npm test")] }));
  assert.deepEqual([finished.commands[0].note, finished.commands[1].note], ["full lint and typecheck", undefined]);
  assert.deepEqual(finished.errors.map((e) => [e.id, e.resolved, e.note]), [["E1", true, "fixed by adding the missing import"]]);
  assert.match(finished.exactHalf, /C1 \[runs:1 exit:2\] make check\n    note: full lint and typecheck\n/);
  assert.match(finished.exactHalf, /E1 \[resolved C1\] FAILED: lint\n    note: fixed by adding the missing import\n/);
});

test("errors: a signature carrying a credential is never recorded, new or carried; a secret-bearing source command is stored redacted; ids are not reused", () => {
  const messages = [
    ...bashCall("wget --header 'Authorization: Bearer abcdefgh' https://x/api", 8, "ERROR 401: Unauthorized."),
    ...bashCall("curl -sf https://x/health", 22, "curl: (22) The requested URL returned error: 500\nX-Api-Key: 0123456789"),
    ...bashCall("git push https://oauth2:ghp_aaaaaaaaaaaaaaaaaaaaaaaa@github.example/x/y", 128, "fatal: unable to access 'https://oauth2:ghp_aaaaaaaaaaaaaaaaaaaaaaaa@github.example/x/y': 403"),
    ...bashCall("make check", 2, "make: *** [Makefile:12: check] Error 2"),
  ];
  const { errors } = collectHandoff({ branchEntries: [], messages });
  assert.deepEqual(errors.map((e) => [e.id, e.signature, e.sourceCommand]), [
    ["E1", "ERROR 401: Unauthorized.", "<redacted>"],
    ["E2", "make: *** [Makefile:12: check] Error 2", "make check"],
  ]);

  const carried: ErrorRecord[] = [
    { id: "E1", signature: "make: *** [Makefile:12: check] Error 2", sourceCommand: "make check", resolved: false, lastSeenPass: 1 },
    { id: "E2", signature: "fatal: unable to access 'https://a:hunter2@h/x': 403", resolved: false, lastSeenPass: 1 },
  ];
  const next = collectHandoff({
    branchEntries: branchWith({ readFiles: [], modifiedFiles: [], commands: [], errors: carried }),
    messages: [...bashCall("npx tsc --noEmit", 2, TSC_ERROR)],
  });
  assert.deepEqual(next.errors.map((e) => [e.id, e.signature.split("\n")[0]]), [
    ["E1", "make: *** [Makefile:12: check] Error 2"],
    ["E3", "src/a.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'."],
  ]);
});
