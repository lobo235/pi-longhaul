# Code records an operator's answer to `ask_user_question` as a decision

ADR 0002 gives the state two hands: code writes what it can observe, and the model writes a verified diff of what it
cannot (corrections, decisions, dead ends, the narrative, Now). An operator's answer to `ask_user_question` falls
between them. It is observable — the tool result carries the question, the option picked and any words typed — but
nothing recorded it: it was left to the model's discretion whether to write a decision about it, and after a compaction
that discretion was the only trace. In one real session 15 answers decided a whole feature extraction; the state kept
whichever of them the model happened to write down.

So code now records each answered question as a `decision.add` the moment its tool result lands, in branch order
(`q1`, `q2`, ...), with provenance `source: "code"` — a fourth `Source` value, because `pass` means "mechanical,
written by the pass itself" and this write happens at a tool result, not a pass. An answer is never a correction:
it arrives as a tool result, and only a user message may be quoted (security.md T2). A declined questionnaire records
nothing.

## Considered options

- **Leave it to the model.** No new write path, and the summarizer already sees the tool results. Rejected: it is
  exactly the paraphrase-by-omission ADR 0002 exists to stop — the answer survives only if the model decides to write
  it, and nothing in the state shows that a fork was decided at all.
- **Capture at the next model request instead** (`context` hook), when the answer is on the branch, so the decision
  could carry `evidence: "q<n>"` like every other decision. Rejected: it trades a guarantee for a citation — an answer
  followed by session end is never recorded — and pays a branch scan on every request. The evidence is not lost: the
  composed text names the question, `q<n>` still resolves in `longhaul_recall`, and a later decision of the model's own
  can cite the answer.
- **Reuse `source: "pass"`.** Rejected: it reads as "the pass wrote this", and the log is the instrument this decision
  was made from; a fourth value costs one validator clause and no old transcript.

## Consequences

A fork-heavy session now spends decision slots on answers: 15 answers in one real session composed 2,704 characters,
and they arrive in bursts (8 in a row during one design phase). `caps.decisions` therefore rises from 10 to 20, so such
a phase fits without evicting the decisions the model wrote in the same phase; the 13,500-character hard cap still
bounds the render and still retires the oldest first, which is why the count is a tidy-up limit rather than the binding
one. `caps.itemChars` (1024) lets an answer keep enough of its question to stand alone.

Code now writes prose into a field the model used to own ("Operator chose "X" for: Q"). It is a report of an
observation, not an interpretation, and it is scrubbed like any model-written item (security.md T3).
