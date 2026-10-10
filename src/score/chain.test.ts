import test from "node:test";
import assert from "node:assert/strict";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import type { Candidate } from "./candidates.ts";
import { asChained, chainOrder, runChained } from "./chain.ts";

const user = (id: string, parentId: string | null, text: string) => ({ type: "message", id, parentId, timestamp: "t", message: { role: "user", content: text, timestamp: 1 } });
const compaction = (id: string, parentId: string, summary: string) => ({ type: "compaction", id, parentId, timestamp: `at-${id}`, summary, firstKeptEntryId: parentId, tokensBefore: 100, fromHook: false });

const branch = [user("u1", null, "one"), compaction("c1", "u1", "pi wrote this"), user("u2", "c1", "two"), compaction("c2", "u2", "pi again"), user("u3", "c2", "three")] as unknown as SessionEntry[];

function candidateAt(index: number, session = "s"): Candidate {
  return { file: `/x/${session}.jsonl`, session, at: `at-${branch[index].id}`, index, entryId: branch[index].id, pathEntries: branch.slice(0, index), after: branch.slice(index + 1), spanUserTexts: [], pathUserTexts: [] };
}

test("asChained: every earlier compaction on the path is replaced by the arm's own, keeping the recorded cut and position", () => {
  const own = new Map([["c1", { summary: "the arm's state", details: { compactor: "state" }, fromHook: true }]]);
  const chained = asChained(candidateAt(3), own);
  assert.ok("candidate" in chained, JSON.stringify(chained));
  const replaced = chained.candidate.pathEntries[1] as Extract<SessionEntry, { type: "compaction" }>;
  assert.equal(replaced.summary, "the arm's state");
  assert.deepEqual(replaced.details, { compactor: "state" });
  assert.equal(replaced.fromHook, true);
  assert.equal(replaced.id, "c1");
  assert.equal(replaced.firstKeptEntryId, "u1");
  assert.equal(replaced.parentId, "u1");
  assert.deepEqual(chained.candidate.pathEntries.map((entry) => entry.id), ["u1", "c1", "u2"]);
});

test("asChained: the recorded transcript is never changed", () => {
  const own = new Map([["c1", { summary: "the arm's state", fromHook: true }]]);
  asChained(candidateAt(3), own);
  assert.equal((branch[1] as unknown as { summary: string }).summary, "pi wrote this");
});

test("asChained: an earlier compaction the arm did not write breaks the chain, naming it", () => {
  const chained = asChained(candidateAt(3), new Map());
  assert.ok("error" in chained);
  assert.match(chained.error, /c1/);
  assert.match(chained.error, /chain/);
});

test("asChained: the first compaction of a session needs nothing from the arm", () => {
  const chained = asChained(candidateAt(1), new Map());
  assert.ok("candidate" in chained);
  assert.deepEqual(chained.candidate.pathEntries.map((entry) => entry.id), ["u1"]);
});

test("asChained: a details-less arm compaction drops the recorded details rather than keeping another compactor's", () => {
  const withDetails = branch.map((entry) => (entry.id === "c1" ? { ...entry, details: { compactor: "other" } } : entry)) as SessionEntry[];
  const candidate = { ...candidateAt(3), pathEntries: withDetails.slice(0, 3) };
  const chained = asChained(candidate, new Map([["c1", { summary: "pi-default's own", fromHook: false }]]));
  assert.ok("candidate" in chained);
  assert.equal("details" in chained.candidate.pathEntries[1], false);
});

test("chainOrder: each session's compactions oldest first, sessions kept apart", () => {
  const ordered = chainOrder([candidateAt(3, "b"), candidateAt(1, "a"), candidateAt(3, "a"), candidateAt(1, "b")]);
  assert.deepEqual(ordered.map((candidate) => `${candidate.session}:${candidate.entryId}`), ["a:c1", "a:c2", "b:c1", "b:c2"]);
});

test("runChained: each arm scores every compaction in order on a path carrying its own earlier compactions", async () => {
  const seen: string[] = [];
  await runChained([candidateAt(3), candidateAt(1)], ["a", "b"], async (arm, candidate) => {
    const earlier = candidate.pathEntries.filter((entry) => entry.type === "compaction").map((entry) => (entry as { summary: string }).summary);
    seen.push(`${arm}@${candidate.entryId}<-[${earlier.join(",")}]`);
    return { compaction: { summary: `${arm}:${candidate.entryId}`, fromHook: true } };
  }, { scored: () => {}, failed: (arm, candidate, error) => assert.fail(`${arm}@${candidate.entryId}: ${error}`) });
  assert.deepEqual(seen, ["a@c1<-[]", "b@c1<-[]", "a@c2<-[a:c1]", "b@c2<-[b:c1]"]);
});

test("runChained: an arm that fails at one compaction is reported there and at every later one of that session, while the other arm goes on", async () => {
  const failed: string[] = [];
  const scored: string[] = [];
  await runChained([candidateAt(1), candidateAt(3)], ["a", "b"], async (arm, candidate) => {
    if (arm === "a" && candidate.entryId === "c1") throw new Error("model down");
    return { compaction: { summary: "x", fromHook: true } };
  }, { scored: (arm, candidate) => scored.push(`${arm}@${candidate.entryId}`), failed: (arm, candidate, error) => failed.push(`${arm}@${candidate.entryId}: ${error}`) });
  assert.deepEqual(scored, ["b@c1", "b@c2"]);
  assert.equal(failed.length, 2);
  assert.match(failed[0], /^a@c1: model down/);
  assert.match(failed[1], /^a@c2: chain broken.*c1/);
});

test("asChained: the entries the arm's compaction left after it (a span record) follow it on the path, as they would live", () => {
  const own = new Map([["c1", { summary: "state", fromHook: true, follow: [{ customType: "compaction-state.span", data: { span: 1 } }] }]]);
  const chained = asChained(candidateAt(3), own);
  assert.ok("candidate" in chained);
  const ids = chained.candidate.pathEntries.map((entry) => entry.id);
  assert.deepEqual(ids, ["u1", "c1", "c1.follow1", "u2"]);
  const record = chained.candidate.pathEntries[2] as unknown as { type: string; customType: string; data: unknown; parentId: string };
  assert.deepEqual([record.type, record.customType, record.data, record.parentId], ["custom", "compaction-state.span", { span: 1 }, "c1"]);
});
