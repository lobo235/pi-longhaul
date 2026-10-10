import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

const FIXTURE = path.join(import.meta.dirname, "..", "fixtures", "setup-check-session.jsonl");
const compactionModule = pathToFileURL(path.join(import.meta.dirname, "..", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "core", "compaction", "compaction.js")).href;

test("the setup guide's synthetic session is large enough for pi to compact at its default settings, so the live check makes exactly one compaction", async () => {
  const { DEFAULT_COMPACTION_SETTINGS, prepareCompaction } = (await import(compactionModule)) as { DEFAULT_COMPACTION_SETTINGS: unknown; prepareCompaction: (entries: SessionEntry[], settings: unknown) => { messagesToSummarize: unknown[] } | undefined };
  const lines = fs.readFileSync(FIXTURE, "utf8").trim().split("\n").map((line) => JSON.parse(line) as SessionEntry & { type: string });
  assert.equal(lines[0].type, "session");
  const preparation = prepareCompaction(lines.slice(1), DEFAULT_COMPACTION_SETTINGS);
  assert.ok(preparation && preparation.messagesToSummarize.length > 0, "pi would answer 'Nothing to compact'");
});

test("the setup guide's synthetic session names no real place: its directory is a placeholder and no home path appears", () => {
  const text = fs.readFileSync(FIXTURE, "utf8");
  assert.match(text, /"cwd":"\/tmp\/longhaul-setup-check"/);
  assert.doesNotMatch(text, /\/home\/|\/Users\//);
});
