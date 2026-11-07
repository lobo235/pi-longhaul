# A refusal carries the text it refused; the log drops it unless excerpts are on

`log-safe.ts` says a log line is what people paste into a bug report: codes, ids, counts and lengths, never a piece of
the conversation, with `PI_COMPACT_STATE_DEBUG_EXCERPTS=1` putting excerpts back. That rule made the log unusable for
the question it is most often asked. A `not-substring` rejection carried the message it compared against
(`excerpt`) and the closest window (`closest`), but never the model's own text — so a reader could not tell a
**paraphrase of the goal** (which a retry can fix) from **a citation of the wrong turn** (which it cannot), and a
week of records could not answer either. The same held for `unknown-ref`, where the interesting half is what was
cited, and `value-not-in-turn`, where it is the value.

So a rejection now carries `proposed`: the text the model put in the field, flattened, credential-scrubbed, cut to 200
characters. `logSafeRejected` passes it through unchanged only when `excerpts` is on — the rule holds, because a debug
log is not the thing people paste into a bug report — and records `proposedChars` otherwise, like every other content
field. Refusals are rare (one to three a compaction at most), so the cost is a few hundred bytes on the record that
needed it.

## Considered options

- **Log it always, as a small deliberate exception.** Rejected: the rule exists because those lines get pasted in
  public, and an exception that fires on every refusal is not small. The debug switch already exists for exactly this.
- **A separate debug verbosity level for refusals only** (`PI_COMPACT_STATE_DEBUG=full`). Rejected: a second
  verbosity rule to keep in mind, to save a few hundred bytes on a rare record.
- **Record the diagnosis instead — a flag saying "paraphrase" or "wrong turn".** Rejected: it would be a guess at
  read time that the text answers exactly, and it freezes the guess into the format.

## Consequences

The refusal's shape is now duplicated in four constructors (intent.ts for quotes, named-values.ts for values,
verify.ts for over-long text) and each must scrub before it sets the field; `proposedText` is the one place that does
that, so a new rejection code that carries text belongs next to it.
