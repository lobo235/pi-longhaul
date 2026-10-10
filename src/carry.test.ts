import test from "node:test";
import assert from "node:assert/strict";

import { carryFileOps, FILE_LIST_CAP, isStateDetails, latestStateDetails, narrativeTraceOf, previousFileLists, type StateDetails } from "./carry.ts";
import { DEFAULT_CAPS } from "./store/events.ts";
import { emptyState } from "./store/project.ts";
import { chain, compactionEntry, userEntry } from "./test-support.ts";
import { createRouteHealth } from "./narrative/route-health.ts";
import { EMPTY_PASS_USAGE } from "./narrative/usage.ts";

const details = (extra: Partial<StateDetails> = {}): StateDetails => ({ compactor: "state", promptRevision: "state-1", state: emptyState(), caps: DEFAULT_CAPS, ledger: { commands: [], errors: [] }, narrative: { kind: "diff", calls: 1, accepted: 2, dropped: 0, rescued: 0, missingChunks: [], usage: { ...EMPTY_PASS_USAGE, input: 1, output: 1, reasoning: 0, calls: 1 }, timings: { prepareMs: 0, callsMs: 0, validateMs: 0, totalMs: 0 } }, readFiles: ["a.ts"], modifiedFiles: ["b.ts"], ...extra });

test("latestStateDetails: details from a newer state format are not read; format 1 and unstamped details are", () => {
  assert.equal(latestStateDetails(chain([compactionEntry("c1", { ...details(), stateFormat: 2 })])), undefined);
  assert.ok(latestStateDetails(chain([compactionEntry("c1", { ...details(), stateFormat: 1 })])));
  assert.ok(latestStateDetails(chain([compactionEntry("c1", details())])));
});

test("latestStateDetails: the latest compaction entry when it is a state entry; undefined for another compactor's or pi's entry or no compaction", () => {
  assert.equal(latestStateDetails(chain([userEntry("m1", "hi")])), undefined);
  assert.deepEqual(latestStateDetails(chain([compactionEntry("c1", details())]))?.readFiles, ["a.ts"]);
  assert.equal(latestStateDetails(chain([compactionEntry("c1", details()), compactionEntry("c2", { readFiles: ["x"], modifiedFiles: [], commands: [], errors: [] })])), undefined);
  assert.equal(latestStateDetails(chain([compactionEntry("c1", details()), compactionEntry("c2", { readFiles: [], modifiedFiles: [] }, false)])), undefined);
  assert.equal(isStateDetails({ compactor: "state" }), false);
});

test("carryFileOps: previous lists union this span's, read minus modified, harm-pruned, capped newest-last", () => {
  const previous = details({ readFiles: ["old-read.ts", "b.ts"], modifiedFiles: ["old-mod.ts"] });
  const fileOps = { read: new Set(["new-read.ts", "shared.ts"]), written: new Set(["written.ts"]), edited: new Set(["shared.ts"]) };
  const carried = carryFileOps(previous, fileOps);
  assert.deepEqual(carried.readFiles, ["old-read.ts", "b.ts", "new-read.ts"]);
  assert.deepEqual(carried.modifiedFiles, ["old-mod.ts", "written.ts", "shared.ts"]);
  const many = carryFileOps(details({ readFiles: Array.from({ length: FILE_LIST_CAP + 5 }, (_, i) => `f${i}.ts`) }), { read: new Set(["last.ts"]), written: new Set(), edited: new Set() });
  assert.equal(many.readFiles.length, FILE_LIST_CAP);
  assert.equal(many.readFiles.at(-1), "last.ts");
  assert.deepEqual(carryFileOps(undefined, fileOps).readFiles, ["new-read.ts"]);
});

test("previousFileLists: the latest compaction's lists whichever compactor wrote it, so a switchover from another compactor keeps them", () => {
  const otherCompactor = { compactor: "another-compactor", readFiles: ["src/read.ts", 7], modifiedFiles: ["src/edited.ts"] };
  const lists = previousFileLists(chain([compactionEntry("c1", details({ readFiles: ["stale.ts"] })), compactionEntry("c2", otherCompactor)]));
  assert.deepEqual(lists, { readFiles: ["src/read.ts"], modifiedFiles: ["src/edited.ts"] });
  assert.deepEqual(carryFileOps(lists, { read: new Set(["now.ts"]), written: new Set(), edited: new Set() }).readFiles, ["src/read.ts", "now.ts"]);
  assert.equal(previousFileLists(chain([userEntry("m1", "hi")])), undefined);
  assert.deepEqual(previousFileLists(chain([compactionEntry("c1", undefined, false)])), { readFiles: [], modifiedFiles: [] });
});

test("carryFileOps: a carried build-tree path is removed by the harm rules and reported", () => {
  const carried = carryFileOps(details({ readFiles: ["node_modules/x/index.js", "src/a.ts"] }), { read: new Set(), written: new Set(), edited: new Set() });
  assert.deepEqual(carried.readFiles, ["src/a.ts"]);
  assert.equal(carried.removed.length, 1);
});

test("narrativeTraceOf: counts from the outcome", () => {
  const trace = narrativeTraceOf({ kind: "diff", events: [{} as never, {} as never], rejected: [{ chunk: 1, path: "p", rejection: { code: "empty" }, final: true }], routeHealth: createRouteHealth(), usage: { ...EMPTY_PASS_USAGE, input: 5, output: 6, reasoning: 0, calls: 2 }, calls: [{ chunk: 1, attempt: 1, verdict: "diff", fieldErrors: [], dropped: 0, rescued: 0, retries: 0, errors: [], durationMs: 1 }, { chunk: 1, attempt: 2, verdict: "diff", fieldErrors: [], dropped: 1, rescued: 1, retries: 0, errors: [], durationMs: 1 }], missingChunks: [], timings: { prepareMs: 1, callsMs: 2, validateMs: 3, totalMs: 6 }, model: "example-cloud/x" });
  assert.deepEqual(trace, { kind: "diff", reason: undefined, model: "example-cloud/x", calls: 2, accepted: 2, dropped: 1, rescued: 1, missingChunks: [], usage: { ...EMPTY_PASS_USAGE, input: 5, output: 6, reasoning: 0, calls: 2 }, timings: { prepareMs: 1, callsMs: 2, validateMs: 3, totalMs: 6 } });
});

test("narrativeTraceOf: the earlier rules the model called one-offs are traced by id, so a dropped earlier rule is explainable", () => {
  const base = { kind: "diff" as const, events: [], rejected: [], routeHealth: createRouteHealth(), usage: { ...EMPTY_PASS_USAGE, input: 0, output: 0, reasoning: 0, calls: 0 }, calls: [], missingChunks: [], timings: { prepareMs: 0, callsMs: 0, validateMs: 0, totalMs: 0 } };
  assert.deepEqual(narrativeTraceOf({ ...base, oneOffs: ["u3", "u7"] }).oneOffs, ["u3", "u7"]);
  assert.equal("oneOffs" in narrativeTraceOf(base), false);
});

test("narrativeTraceOf: the reasoning level a model that cannot turn reasoning off was asked for is traced; reasoning off leaves it out", () => {
  const base = { kind: "diff" as const, events: [], rejected: [], routeHealth: createRouteHealth(), usage: { ...EMPTY_PASS_USAGE, input: 0, output: 0, reasoning: 0, calls: 1 }, missingChunks: [], timings: { prepareMs: 0, callsMs: 0, validateMs: 0, totalMs: 0 } };
  const call = { chunk: 1, attempt: 1, verdict: "diff" as const, fieldErrors: [], dropped: 0, rescued: 0, retries: 0, errors: [], durationMs: 1 };
  assert.equal(narrativeTraceOf({ ...base, calls: [{ ...call, reasoning: "minimal" }] }).reasoning, "minimal");
  assert.equal("reasoning" in narrativeTraceOf({ ...base, calls: [call] }), false);
});
