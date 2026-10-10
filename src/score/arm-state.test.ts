import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentMessage } from "@earendil-works/pi-agent-core";

import type { Candidate } from "./candidates.ts";
import { armConfigText, scoreState, type StateArmDeps } from "./arm-state.ts";
import { asChained } from "./chain.ts";
import { assistantEntry, chain, modelWith, NOT_RULES, textResponse, toolResultEntry, userEntry } from "../test-support.ts";

const diff = JSON.stringify({ narrative: "ran the tests", labels: NOT_RULES, corrections: [{ messageRef: "u2", text: "never use mocks in these tests" }], lifts: [], decisions: [], deadEnds: [], now: { inProgress: [], next: ["fix the layout"], blocked: [], resume: "run npm test" } });

function fixture(): { candidate: Candidate; prep: Record<string, unknown> } {
  const entries = chain([
    userEntry("m1", "Build the parser and keep the ledger modules as they are"),
    assistantEntry("a1", "running tests", [{ name: "bash", arguments: { command: "npm test" } }]),
    toolResultEntry("t1", "a1-t0", "bash", "ok\n[exit 0]"),
    userEntry("m2", "never use mocks in these tests, fakes only"),
    assistantEntry("a2", "sure"),
  ]);
  const messages = entries.map((entry) => (entry as { message: AgentMessage }).message);
  const prep = { firstKeptEntryId: "a2", messagesToSummarize: messages.slice(0, -1), turnPrefixMessages: [], isSplitTurn: false, tokensBefore: 90_000, fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() }, settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 } };
  const candidate: Candidate = { file: "/sessions/s.jsonl", session: "s", at: "2026-01-01T00:00:00.000Z", index: 5, entryId: "c5", pathEntries: entries, after: [], spanUserTexts: ["Build the parser and keep the ledger modules as they are", "never use mocks in these tests, fakes only"], pathUserTexts: ["Build the parser and keep the ledger modules as they are", "never use mocks in these tests, fakes only"], cwd: "/work/project" };
  return { candidate, prep };
}

function depsOf(overrides: Partial<StateArmDeps> = {}): StateArmDeps {
  return {
    model: modelWith({ contextWindow: 131072 }),
    call: { complete: async () => textResponse("```json\n" + diff + "\n```") as never },
    find: () => undefined,
    hostConfig: () => undefined,
    caps: [8000, 12000],
    withUnlearned: false,
    warmPrime: false,
    env: {},
    ...overrides,
  };
}

test("state arm: the State compactor's own pass over the candidate, scored on the shared measures plus coverage at each cap and its tokens", async () => {
  const { candidate, prep } = fixture();
  const scored = await scoreState(candidate, prep, "state", depsOf());
  assert.equal(scored.row.arm, "state");
  assert.match(scored.rendered, /^# Session state/);
  assert.equal(scored.row.renderedChars, scored.rendered.length);
  assert.equal(scored.row.corrections.retained, 1);
  assert.deepEqual(Object.keys(scored.row.coverageAtCap ?? {}), ["8000", "12000"]);
  assert.ok(scored.row.tokens && scored.row.tokens.input > 0, "the pass's summed usage");
  assert.equal(scored.unlearned, undefined, "no derived arm unless asked");
});

test("state arm: the derived state-unlearned row is the same compaction with its Learned values section cut out, and makes no call", async () => {
  const { candidate, prep } = fixture();
  let calls = 0;
  const scored = await scoreState(candidate, prep, "state", depsOf({ withUnlearned: true, call: { complete: async () => { calls++; return textResponse("```json\n" + diff + "\n```") as never; } } }));
  assert.equal(calls, 1);
  assert.equal(scored.unlearned?.row.arm, "state-unlearned");
  assert.ok(!scored.unlearned?.rendered.includes("## Learned values"));
  assert.equal(scored.unlearned?.row.tokens, undefined);
});

test("armConfigText: each arm forces its narrative mode over the host's longhaul.json and keeps the rest of it", () => {
  const host = JSON.stringify({ narrativeMode: "turns", routeProviders: ["local"], narrativeTurns: { maxRepairs: 1 } });
  const cases: Array<[string, Parameters<typeof armConfigText>[0], string | undefined, string]> = [
    ["the state arm runs single whatever the host runs", "state", host, "single"],
    ["the turns arm runs turns", "state-turns", JSON.stringify({ narrativeMode: "single" }), "turns"],
    ["the warm arm runs warm", "state-warm", undefined, "warm"],
    ["an unreadable host config is the defaults", "state", "{not json", "single"],
  ];
  for (const [name, arm, hostText, mode] of cases) {
    const parsed = JSON.parse(armConfigText(arm, hostText)) as Record<string, unknown>;
    assert.equal(parsed.narrativeMode, mode, name);
  }
  const kept = JSON.parse(armConfigText("state-turns", host)) as Record<string, unknown>;
  assert.deepEqual(kept.routeProviders, ["local"]);
  assert.deepEqual(kept.narrativeTurns, { maxRepairs: 1 });
});

test("state arm, chained: the next compaction continues from the state the arm wrote, so a rule from the first span is still there", async () => {
  const { candidate, prep } = fixture();
  const first = await scoreState(candidate, prep, "state", depsOf());
  const recorded = { type: "compaction", id: "c5", parentId: "a2", timestamp: "2026-01-01T00:00:00.000Z", summary: "another compactor's summary", firstKeptEntryId: "a2", tokensBefore: 90_000, fromHook: false };
  const later = chain([userEntry("m3", "now write the docs"), assistantEntry("a3", "writing docs"), userEntry("m4", "and the changelog"), assistantEntry("a4", "ok")]);
  later[0] = { ...later[0], parentId: "c5" } as never;
  const pathEntries = [...candidate.pathEntries, recorded, ...later] as never[];
  const second: Candidate = { ...candidate, at: "2026-01-01T01:00:00.000Z", index: 11, entryId: "c11", pathEntries, spanUserTexts: ["now write the docs", "and the changelog"] };
  const chained = asChained(second, new Map([["c5", first.compaction]]));
  assert.ok("candidate" in chained, JSON.stringify(chained));
  const laterMessages = [candidate.pathEntries.at(-1), ...later].map((entry) => (entry as { message: AgentMessage }).message);
  const prep2 = { ...prep, firstKeptEntryId: "a4", messagesToSummarize: laterMessages.slice(0, -1), previousSummary: first.rendered };
  const quiet = JSON.stringify({ narrative: "wrote the docs", labels: NOT_RULES, corrections: [], lifts: [], decisions: [], deadEnds: [], now: { inProgress: [], next: [], blocked: [], resume: "commit" } });
  const scored = await scoreState(chained.candidate, prep2, "state", depsOf({ call: { complete: async () => textResponse("```json\n" + quiet + "\n```") as never } }));
  assert.match(scored.rendered, /R1 \[u2\] "never use mocks in these tests"/);
  assert.match(scored.rendered, /^1\. .*ran the tests/m, "span 1's work-log line carried");
  assert.equal(scored.row.earlierCorrections?.retained, 1);
});
