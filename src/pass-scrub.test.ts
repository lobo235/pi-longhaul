import test from "node:test";
import assert from "node:assert/strict";

import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { createRouteHealth } from "./narrative/route-health.ts";
import { runStatePass, type PassDeps, type PassInput } from "./pass.ts";
import { assistantEntry, chain, modelWith, NOT_RULES, textResponse, toolResultEntry, userEntry } from "./test-support.ts";

// The span read a credential, and the summarizer copied it into what it wrote (security.md T3).
const PASSWORD = "Summer2024x";
const diffText = JSON.stringify({
  narrative: `Read the app env and logged in with ${PASSWORD}.`,
  labels: NOT_RULES,
  corrections: [],
  lifts: [],
  decisions: [{ text: `Use ${PASSWORD} for the migration role`, evidence: "C1" }],
  deadEnds: [{ text: `The old login ${PASSWORD} without TLS was refused` }],
  now: { inProgress: [`migrating as app/${PASSWORD}`], next: [], blocked: [], resume: `run the migration with DB_PASSWORD=${PASSWORD}` },
});

function inputOf(previousSummary?: string): PassInput {
  const entries = chain([
    userEntry("m1", "Run the migration against the app database"),
    assistantEntry("a1", "reading the env", [{ name: "bash", arguments: { command: "cat deploy/app.env" } }]),
    toolResultEntry("t1", "a1-t0", "bash", `DB_HOST=db1\nDB_PASSWORD=${PASSWORD}\n[exit 0]`),
    assistantEntry("a2", "done"),
  ]);
  const messages = entries.filter((entry) => entry.type === "message").map((entry) => (entry as { message: AgentMessage }).message);
  return {
    preparation: { ...(previousSummary ? { previousSummary } : {}), firstKeptEntryId: entries.at(-1)!.id, messagesToSummarize: messages.slice(0, -1), turnPrefixMessages: messages.slice(-1), isSplitTurn: true, tokensBefore: 90_000, fileOps: { read: new Set(), written: new Set(), edited: new Set() }, settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 } } as never,
    branchEntries: entries,
    reason: "threshold",
    sessionModel: modelWith({ provider: "example", id: "model-a", contextWindow: 131072 }),
    cwd: "/tmp/project",
    env: {},
  };
}

const git = async (_file: string, args: string[]) => args.includes("config") ? { stdout: "", stderr: "", code: 1, killed: false } : ({ stdout: args.includes("rev-parse") ? (args.includes("--abbrev-ref") ? "main\n" : "ab12cd\n") : "", stderr: "", code: 0, killed: false });

const depsAnswering = (answer: string): PassDeps => ({ ...deps, call: { complete: async () => textResponse("```json\n" + answer + "\n```") as never } });

const deps: PassDeps = {
  readConfig: () => undefined,
  exec: git as never,
  call: { complete: async () => textResponse("```json\n" + diffText + "\n```") as never },
  find: (provider: string, id: string) => modelWith({ provider, id, contextWindow: 131072 }),
  routeHealth: createRouteHealth(),
  now: () => new Date("2026-09-28T12:00:00.000Z"),
  sleep: async () => {},
};

test("a credential the span showed is redacted from everything the summarizer wrote, in the span record and the summary", async () => {
  const { pending, compaction, log } = await runStatePass(inputOf(), deps);
  const written = JSON.stringify(pending.events);
  assert.ok(!written.includes(PASSWORD), `the span record carries the password: ${written}`);
  assert.ok(!compaction.summary.includes(PASSWORD), "the summary carries the password");
  assert.match(written, /logged in with <redacted>\./);
  assert.match(written, /run the migration with DB_PASSWORD=<redacted>/);
  assert.match(written, /migrating as app\/<redacted>/);
  assert.equal(log.redacted, 5);
});

test("a credential the summarizer saw only in the previous summary is redacted too", async () => {
  const summary = "## Goal\nMigrate the app database.\n\nAdmin password: Winterwind\n";
  const answer = JSON.stringify({ ...JSON.parse(diffText), narrative: "Logged in as admin with Winterwind, then migrated.", decisions: [], deadEnds: [], now: { inProgress: [], next: [], blocked: [], resume: "migrate the app database" } });
  const { pending, compaction } = await runStatePass(inputOf(summary), depsAnswering(answer));
  const written = JSON.stringify(pending.events);
  assert.ok(!written.includes("Winterwind"), `the span record carries the password: ${written}`);
  assert.ok(!compaction.summary.includes("Winterwind"), "the summary carries the password");
});
