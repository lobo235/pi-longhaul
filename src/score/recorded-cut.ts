/**
 * Rebuilds the preparation pi handed the compactor at a recorded compaction, and proves it is the same one: the
 * replay must cut where the recording did. pi's cut depends on `keepRecentTokens`, which a transcript does not
 * record, so the scorer takes it from SCORE_KEEP_RECENT_TOKENS (pi's default otherwise) and checks the result
 * against the compaction entry's own `firstKeptEntryId`. A replay that cut elsewhere would summarize a different
 * span from the one the session's next messages followed, so it is reported, never scored.
 */
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export interface CompactionSettings { keepRecentTokens: number; [key: string]: unknown }
export type Preparation = { firstKeptEntryId: string; settings: CompactionSettings; [key: string]: any };

export interface RecordedCompaction {
  session: string;
  pathEntries: SessionEntry[];
  /** The recorded compaction entry's first kept entry; absent when the entry recorded none. */
  firstKeptEntryId?: string;
}

export interface PrepareDeps {
  prepare: (entries: SessionEntry[], settings: CompactionSettings) => Preparation | undefined;
  defaults: CompactionSettings;
  /** SCORE_KEEP_RECENT_TOKENS: the keepRecentTokens the recording used, when it was not pi's default. */
  keepRecentTokens?: number;
}

const HINT = "set SCORE_KEEP_RECENT_TOKENS to the keepRecentTokens the session was recorded with";

export function prepareAsRecorded(recorded: RecordedCompaction, deps: PrepareDeps): { prep: Preparation } | { error: string } {
  const settings = deps.keepRecentTokens === undefined ? deps.defaults : { ...deps.defaults, keepRecentTokens: deps.keepRecentTokens };
  const prep = deps.prepare(recorded.pathEntries, settings);
  if (!prep) return { error: `pi's prepareCompaction found nothing to summarize at keepRecentTokens ${settings.keepRecentTokens}; ${HINT}` };
  if (recorded.firstKeptEntryId && prep.firstKeptEntryId !== recorded.firstKeptEntryId) {
    return { error: `the replay keeps from ${prep.firstKeptEntryId} but the recorded compaction kept from ${recorded.firstKeptEntryId} (keepRecentTokens ${settings.keepRecentTokens}); ${HINT}` };
  }
  return { prep };
}
