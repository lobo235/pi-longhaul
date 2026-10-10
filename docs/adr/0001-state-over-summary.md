# Carry a state across compactions, not a rewritten summary

pi's own compaction asks a model to rewrite the conversation, previous summary included, as prose each time
the context fills. In a long session that is a summary of a summary of a summary: the user's rules come back
paraphrased, a decision loses the evidence it rested on, and whatever one rewrite drops is gone for every
later one. Longhaul instead keeps a **Session state** as an append-only event log on the transcript itself
(custom entries, so it travels with the session and needs no store of its own). Each compaction adds one span:
the events the pass accepted, the work-log line and the World. The text the next request sees is rendered
from that log under fixed caps, so it stays bounded however long the session runs, and what was retired is
fetched back with `longhaul_recall` rather than lost.

## Considered options

- **A better summary prompt.** Cheaper to build, but the failure is the rewrite itself, not its wording: any
  prompt that regenerates the whole text from the last text compounds its losses.
- **An external memory store** (a database or vector index beside pi). It would outlive the transcript and
  need its own lifecycle, privacy story and sync; entries on the transcript are copied, forked and deleted
  with the session, which is what a user expects of session memory.

## Consequences

The persisted entries are a format. They carry `stateFormat`, a reader refuses a newer format by name rather
than misreading it, and changing what an older transcript means is a major version.
