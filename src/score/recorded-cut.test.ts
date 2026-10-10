import assert from "node:assert/strict";
import { test } from "node:test";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import { prepareAsRecorded } from "./recorded-cut.ts";

const DEFAULTS = { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 };
const entries = [{ type: "message", id: "u1" }] as unknown as SessionEntry[];
const candidate = (firstKeptEntryId?: string) => ({ session: "demo", pathEntries: entries, ...(firstKeptEntryId ? { firstKeptEntryId } : {}) });

/** A stand-in for pi's prepareCompaction: keeps from `m8` at 8,000 tokens, from `m5` at pi's default, nothing below 4,000. */
const prepare = (_entries: SessionEntry[], settings: { keepRecentTokens: number }) =>
  settings.keepRecentTokens < 4000 ? undefined : { firstKeptEntryId: settings.keepRecentTokens <= 8000 ? "m8" : "m5", settings };

test("prepareAsRecorded: replays with the recording's keepRecentTokens and accepts the cut pi recorded", () => {
  const outcome = prepareAsRecorded(candidate("m8"), { prepare, defaults: DEFAULTS, keepRecentTokens: 8000 });
  assert.ok("prep" in outcome, JSON.stringify(outcome));
  assert.equal(outcome.prep.settings.keepRecentTokens, 8000);
  assert.equal(outcome.prep.settings.reserveTokens, 16384);
});

test("prepareAsRecorded: without an override it replays with pi's defaults", () => {
  const outcome = prepareAsRecorded(candidate("m5"), { prepare, defaults: DEFAULTS });
  assert.ok("prep" in outcome, JSON.stringify(outcome));
  assert.equal(outcome.prep.settings.keepRecentTokens, 20000);
});

test("prepareAsRecorded: a cut that differs from the recorded one is refused, naming both and the setting to change", () => {
  const outcome = prepareAsRecorded(candidate("m8"), { prepare, defaults: DEFAULTS });
  assert.ok("error" in outcome);
  assert.match(outcome.error, /keeps from m5.*recorded compaction kept from m8.*SCORE_KEEP_RECENT_TOKENS/);
});

test("prepareAsRecorded: nothing to summarize is an error naming the keepRecentTokens it used", () => {
  const outcome = prepareAsRecorded(candidate("m8"), { prepare, defaults: DEFAULTS, keepRecentTokens: 2000 });
  assert.ok("error" in outcome);
  assert.match(outcome.error, /nothing to summarize at keepRecentTokens 2000.*SCORE_KEEP_RECENT_TOKENS/);
});

test("prepareAsRecorded: a compaction entry that recorded no cut is replayed as prepared", () => {
  const outcome = prepareAsRecorded(candidate(), { prepare, defaults: DEFAULTS });
  assert.ok("prep" in outcome);
});
