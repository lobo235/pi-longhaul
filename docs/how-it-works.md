# How Longhaul works

The README says what Longhaul does and how to configure it. This page is the next level down: what happens in
a compaction, what the log records, and the tools for looking at a state. Terms are defined in
[CONTEXT.md](../CONTEXT.md).

## The pass

When pi is about to compact and Longhaul is selected (`PI_COMPACTOR` unset, empty or `state`), one **Pass** runs:

1. **Ledger.** Every command the span ran, with its exit code, and every error, each with an id (`C12`,
   `E3`), merged with what earlier spans carried. A snapshot of the workspace (five read-only git commands, which run nothing a repository configures;
   skipped, never fatal, outside a repository) becomes the **World**.
2. **Fold.** The state so far is rebuilt from the transcript: its custom entries (`compaction-state.event`,
   `compaction-state.span`) and the previous compaction. `longhaul_remember` writes from this span are handed to
   the next step.
3. **Diff.** One model call (several if the span is too large for one, up to four chunks) asks for a small JSON
   answer: a label for every user message of the span, decisions, dead ends, a narrative line and Now. A label is
   `rule`, `not a rule`, `lifts R<n>` (or `lifts u<n>` for a rule given earlier in the same span) or
   `rule and lifts R<n>` for a rule that replaces or narrows another (several targets as `lifts R1, R6`: a new
   rule that replaces a rule and its narrowing lifts both); a new rule that cannot hold beside a rule in the state
   replaces it even when it does not say so, and a lift of a rule that a narrowing already replaced is asked
   again with the narrowing shown, by its `u<n>` when its id is new, so it is lifted only by name, and a lift of a
   replacement must also name whatever it set beyond the rule it replaced; a message that only withdraws a rule is a
   lift even when it says what is fine instead, since what is fine is not a new rule. A lift is applied only when the message
   says it withdraws something ("lifted", "no longer", "doesn't apply", "instead of" the rule's own words) and
   shares a word with the rule it names; otherwise the model is asked again with that rule shown, and a lift it
   still cannot place is dropped, because a stale rule left in view is safer than a live one silently
   withdrawn. A permission ("you may push to main now") is read as a one-off: to retire a rule, say it no
   longer holds. No word list decides what is a rule: a message that
   says "the code must run on Node 22.11" and one that says "never add dependencies" are both labeled, and an
   unlabeled message costs a retry. A description of what is being built (an option, a limit, an exit code) is
   not a rule, since the code and its tests keep it, unless the user states it as standing over later work
   ("every dry-run line must start with DRY:"). Code copies a labeled rule's words from the message itself, so a rule cannot
   be misquoted. A message of at most 300 characters is kept whole even when the model gave the rule's words,
   since a part can lean on the rest ("don't hard-code it" names nothing alone); a message over 600 characters
   must come with the rule's exact words, and words that start or end inside a word are sent back. The prompt lists each message whole up to 240 characters, with "…" where
   a longer one is cut. The answer may also
   name values a later turn may need (a timing, a total, a port), each with the turn it came from; one is kept
   only when it stands verbatim in that turn. Code verifies the answer before accepting any of it:
   - every quoted correction must be a verbatim substring of a user message (a quote cited under the wrong
     message binds to the newest message that does hold it; text no user wrote is rejected);
   - in a pi-goal `/goal` message only the objective inside the goal tags is quotable, never pi-goal's template;
   - an evidence id the ledger does not know is dropped, and the decision or dead end it backed is kept;
   - shape slips that say nothing about content (`null` for an absent optional, an omitted empty list) are
     normalized before the schema check, and every list and item is bounded by the schema.
4. **Close.** The accepted events get their sequence numbers, the span closes with one work-log line and the
   World, and the rendered state becomes the compaction summary pi stores.
5. **Span record.** After pi writes the compaction entry, Longhaul appends a `compaction-state.span` custom entry
   that names it, so the next pass and `longhaul_recall` can find this span's detail.
6. **Compaction line.** Then a `compaction-state.line` custom entry, display only: the time from Longhaul's hook to
   pi's compaction entry, with the pass's span, calls and tokens, or the reason it fell back to pi's own
   compaction. It is appended one event-loop turn later, because pi draws its own compaction block when the
   compaction ends and the line belongs under it. pi never sends a custom entry to the model; a reader of the
   transcript may ignore it.

**Taking over from another compactor.** When the newest compaction on the branch was not Longhaul's (pi's own,
or another extension's), its summary goes into the prompt, head and tail, and the model is asked to carry
forward what it still holds. Because a summary paraphrases, the pass also lists the user's earlier messages that
read as standing rules verbatim and records each as a correction itself, unless the model marks it a one-off (a
request, an answer or a question). A message reads as one when a sentence of it, not a question (a closing "ok?"
asks nothing), says "from now on" (or "from here on", "going forward") and withdraws nothing, or has a clause with a rule word (never, always, don't, do not, must, stop, only) that is not in
a request for now ("yet", "for now", "this time"), not withdrawing something ("forget it"; "don't forget it" does
not withdraw), not "never mind" and not describing a thing ("an option that keeps only lines"). It is judged clause
by clause, so "never deploy on a Friday, not even this time" keeps its rule. A message it leaves out is still
shown to the model and labeled like the user's other earlier messages. The user's other earlier messages are shown too, each cut to its start, and each must be
labeled like a message of the span: a withdrawal ("the DRY: prefix rule is lifted") is labeled `lifts u<n>` and
that rule is not carried, and a rule worded without a rule word ("tests go under tests/", "our servers run Node
22") is labeled a rule and carried. An earlier message left unlabeled costs a retry, in both modes; one longer than
the excerpt shown is recorded only from the exact words given for it. An earlier message read as a standing rule needs no label
but may carry one, so one that replaced an earlier rule ("switch to two-space indentation instead of tabs from now
on") is
labeled `rule and lifts u<n>`; left unlabeled it is recorded as a rule in message order, and a replacement it makes
is asked about as in a span. A one-off the model fails to mark is carried as a rule; it names
its message and can be withdrawn like any correction. A value the earlier summary records (a measurement, a hash,
a port) is named with the earlier turn that showed it and kept only where that turn shows it verbatim, so the
summary points at a value but never vouches for one. When the session already has a state, because a failed
Longhaul pass fell back to pi's own compaction, only the messages since Longhaul's last whole span are offered:
the state already judged everything before them, so a rule it had lifted or named a one-off is not recorded
again. A span that closed narrative-less or with a chunk missing judged none or only some of its messages, so
they are offered.

**When the diff fails.** A format defect the model can fix is retried once with a note (an answer that parsed is
kept while the retry runs). A lift refused because its rule was replaced is a question, not a defect: when the last
answer first raises it, the model gets one more call to answer it, once per chunk, rather than losing the lift. A
rule label whose rule would pass the lift check against an earlier rule still in force is asked about once the
chunk's answer is settled, never in a retry note. Only the user's own words count: the text judged is what the rule
records (the message, or a long message's given words where they stand in it), with quoted passages of six words or
more (straight, curly, German or guillemet marks, or inline code), blockquoted lines and code fences left out, so a
pasted or relayed withdrawal raises no question; the whole message must also pass the lift check as the store reads
it, so no question is asked whose answer the store would refuse. One more call
asks "u17 is labeled `rule` and may replace the rule u2 gave (…): answer `rule and lifts u2` or `rule`", under a
header that says to lift only when the user's own words withdraw the rule and that quoted or pasted text does not;
questions are shown whole or not at all, up to `retryNoteChars`. The kept answer stands; the only change a reply can
make is to add an asked target to that label's lifts, so the label keeps its words. Only the asked messages are read
from a reply, so a model that answers again in full is heard on those alone; an asked message answered with anything
but `rule` or `rule and lifts` an asked target, or no readable JSON, changes nothing. The added lift still passes the store's checks. No question
follows a call that threw. An answer cut off at the output limit with nothing usable, usually thinking the model's
entry did not declare, is retried with twice the output budget, at least 8,192 tokens and never past the model's
`maxTokens`; the call's trace records the raised budget. A routed summarizer that is unavailable falls back to the session's own model. If
everything fails, the pass closes **narrative-less**: the work-log line says so, the state still updates from the
ledger and the World, and the notice names the reason. Its user messages were never labeled, and no later span
holds them, so the next pass shows them whole before its conversation and must label them too (up to 30, back
to the last pass that closed whole); a rule given there is recorded one pass late rather than never. A span with
a chunk that never verified is carried the same way, whole, since the close does not record which messages that
chunk held. If the pass itself throws, Longhaul logs a `fallback`
record and answers nothing, so pi's own compaction finishes the job and the session keeps working.

**State format.** Every state event and the compaction details carry `stateFormat: 1`. An entry from a newer
format is refused by name, recorded as an anomaly, and not read, so a downgrade starts a clean state rather than
misreading one. A span record carries its own version, `v: 1`; a span record with any other `v` is skipped
without an anomaly, so its span's detail is simply not available to `longhaul_recall`.

### Turns mode

`"narrativeMode": "turns"` in `longhaul.json` (opt-in) replaces the single call with one continuing
conversation that asks for one section per turn, in a fixed order: narrative, objective, a label for every user
message of the span (`rule`, `lifts R<n>` or `not a rule`; code copies the words, so a misquote is impossible),
decisions and dead ends, and Now. The first turn carries a **Digest**: the state so far, the span's user
messages whole, the ledger, the file lists, the World and a condensed transcript (one line per tool call, each
tool result cut to its head and tail). The only tool is a read-only `show(ref)` for a message, command, error or
tool-call id, capped per turn.

Each answer passes a gate written in code. **Integrity checks** (it parses, every id exists, every message is
labelled, every quote verifies, the narrative is within its cap) are never excused; an item still failing after
two repair turns is dropped (a lift refused because its rule was replaced, first raised on the last turn, gets one
more turn). **Expectation checks** (a modified file is named in the narrative, an unfixed error
is a dead end or an open error, resume is set) may be excused by the model with a one-sentence reason, which the
span record keeps. The pass has a time budget (5 minutes, 2 per turn); sections it cannot reach carry from the
previous state. Turns mode makes five calls or more per compaction; it exists for small models that write a poor
single diff.

Taking over from another compactor, turns mode has two gaps the default mode does not ([#9](https://github.com/lobo235/pi-longhaul/issues/9)):
an earlier message read as a standing rule cannot carry a label, so one that replaced an earlier rule is recorded
beside it until a later message lifts one; and the model names no values in turns mode (only the ones code learns
from tool output are kept), so a value only the earlier summary held is not kept.

## The log

Logging is on by default, to `logs/compaction-state.jsonl` in pi's agent dir. `PI_COMPACT_STATE_DEBUG` is a path
or an off value (`off`, `none`, `0`, `false`, `no`, or empty), not a flag: `PI_COMPACT_STATE_DEBUG=1` writes to
a file named `1`.

Records carry codes, ids, counts and lengths, never message text. Every record also names its session: the
working directory, the session id, the session's model and thinking level; a `compaction` record adds the
summarizer route (the configured spec, the model used, and why a route was not used). An error keeps its class
and the first 200 characters of its message, with the home directory as `~`. That is enough to identify your
projects and your setup, so do not paste the log raw into an issue: `/longhaul-report` makes the digest for
that. The file is `0600` in a `0700` directory, rotates at 5 MB (one `.1` backup), is never written through a
symlink or into anything that is not a regular file, and a failed write never affects the compaction.
`PI_COMPACT_STATE_DEBUG_EXCERPTS=1` adds excerpts (rejected quotes, pruned paths), which puts pieces of your
messages in the log; `PI_COMPACT_STATE_DEBUG_STACK=1` adds stack traces.

| `event` | when | says |
|---|---|---|
| `extension-loaded` | pi loads Longhaul (at startup and on a reload) | `piVersion`, `piVersionVerified` (`true` for an exact verified version, `"line"` for a verified release line, `false`) |
| `compaction` | a pass finished | `span`, `tokensBefore`, `summaryChars`, `narrative` (kind, calls, accepted, dropped, usage, timings, and `reasoning`: the level asked for when the model cannot turn reasoning off), `route`, `capFit`, `world`, `carried`, `durationMs` |
| `compacted` | pi wrote the compaction entry | `fromExtension` (was the summary Longhaul's?), `reason`, `span`, `summaryChars`, `tokensBefore` |
| `compact-failed` | pi reported the compaction failed | `reason`, `span` |
| `kept-window-strip` | old reasoning was first left out of a new kept window | `cutoff`, `strippedBlocks`, `strippedChars`, `contextMessages` |
| `span-record-failed` | the span record could not be appended | `span`, `errorClass`, `error` |
| `compaction-line-failed` | the Compaction line could not be appended | `errorClass`, `error` |
| `aborted` | the compaction was cancelled mid-pass | `reason`, `errorClass`, `error` |
| `fallback` | the pass threw and pi's own compaction took over | `reason`, `errorClass`, `error` |

A session where Longhaul stands down (`PI_COMPACTOR=pi`) still writes `extension-loaded`, `compacted` and
`compact-failed`, so a report shows which compactor ran; it writes no `compaction` record. `/longhaul-report` turns the newest
eight records into a digest safe to attach to an issue.

## Looking at a state

From a clone of this repository (`npm ci` first); none of these call a model:

```bash
npm run state                              # the newest transcript's state in pi's agent dir (PI_CODING_AGENT_DIR applies)
npm run state -- FILE.jsonl --spans        # every span: entry, events, commands, errors, narrative
npm run state -- FILE.jsonl --anomalies    # what the fold could not use, and why
npm run state -- FILE.jsonl --span 3       # the state as it was at span 3
npm run state -- FILE.jsonl --json         # the state as JSON
```

`npm run state` treats transcript bytes as untrusted: everything it prints goes through the renderer's
sanitizer or `JSON.stringify`, so no control character reaches the terminal. A transcript whose compactions were
all made by another compactor lists them as foreign and shows an empty state.

`npm run replay` replays recorded transcripts through a real pi session with Longhaul loaded and only the model
faked: tool calls answer with their recorded results, compactions land where they did. Nothing leaves the
machine, and it prints counts only (compactions, fallbacks, handler errors), with transcript paths hashed.
`npm run facts` counts, over recorded compactions and with no model, how many values first seen in a span's tool
output and used again afterwards each compactor's summary kept.

`npm run score` compares Longhaul with pi's own compaction and costs model calls; see
[evaluation.md](evaluation.md).
