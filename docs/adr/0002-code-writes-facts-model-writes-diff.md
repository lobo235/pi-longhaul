# Code writes the facts; the model writes a verified diff

Everything that can be observed is written by code: commands and their exit codes, errors, the files read and
modified, the git branch and tree at compaction (World), background tasks, and values the session learned from
tool output. The model is asked only for what code cannot know, as a small JSON diff: the user's corrections
and their withdrawals, decisions and dead ends with evidence, the narrative line and Now. Code then verifies
the diff before anything is accepted. A quoted correction must be a substring of a user message, an evidence
id must exist in the ledger, and each list has a bound in the schema. An item that fails is dropped and logged;
a pass whose model fails entirely still closes the span from the code-written parts.

## Considered options

- **The model writes the state.** Simplest, and it reintroduces the paraphrase: a summarizer rewrites
  identifiers, invents test results and turns "never do X" into "prefer not to do X".
- **No model at all.** The code-written parts are reliable, but nobody can say from logs alone which user
  message was a standing rule or why an approach was abandoned.

## Consequences

The model never sees the ledger's ids and sometimes cites one that does not exist. Verification tolerates
that by dropping the reference and keeping the item, rather than rejecting a whole answer over a guess.
