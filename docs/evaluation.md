# Evaluation

How Longhaul is measured against pi's own compaction, and what the measurements say. The README claims an
improvement only where a result below supports it.

## Method

The scorer (`npm run score`) takes a directory of pi transcripts and, for each compaction in them, rebuilds
exactly what pi handed the compactor at that point: the same preparation, from the same entries. Where pi cuts
depends on its `keepRecentTokens` setting, which a transcript does not record, so the scorer takes it from
`SCORE_KEEP_RECENT_TOKENS` (pi's default, 20,000, when unset) and checks every rebuilt cut against the one the
compaction entry recorded. A compaction whose replay would cut anywhere else is reported and not scored. It then runs
each **arm** over it and scores every arm's text with the same measures.

The replay is **chained**: each arm continues from its own earlier compactions. A recorded session was compacted
by whatever compactor ran while it was recorded (pi's own, for the published sessions), so replaying compaction 5
on its recorded path would hand Longhaul pi's summary of compactions 1 to 4 every time, and measure only Longhaul
taking over from another compactor. Chained, the arm's own compaction 4 (for Longhaul, its state and span record)
replaces the recorded one on the path to compaction 5, at the same position and cut, so a session runs on one
compactor throughout. An arm that fails at one compaction cannot continue that session; its later compactions
are reported as a broken chain, not scored. `SCORE_CHAIN=0` replays each compaction on its recorded path instead.
Results before chaining existed measured only that takeover and are not comparable.

| arm | what it is |
|---|---|
| `pi-default` | pi's own compaction (`compact()`), with the session's model, thinking level and auth: what a session without Longhaul gets |
| `state` | Longhaul's default: one diff call |
| `state-turns` | Longhaul's opt-in `turns` mode |
| `state-warm` | experimental, not shipped: the diff asked by repeating the session's own last request plus one instruction, so a prefix cache serves the span. It ships only if it matches `state` |
| `state-unlearned` | the `state` arm's own result with its Learned values section removed; no call of its own, so the pair isolates that section |

The arms differ only in the compactor. The model, the span and the measures are the same. Each arm summarizes
on the model given to the scorer (`SCORE_MODEL`), so a comparison is per model.

What happened **after** the compaction in the original session is the reference: the files, commands and
values the next assistant messages actually used, and the user's rules that were still in force.

## Measures

The **labeled** measures are judged against `eval/sessions/labels.json`, written by hand from each scenario and its
recording, so neither compactor's own detection decides what counts as a rule or a value. Every number in them is
a whole count. Anything still in the kept window is not judged, since the message itself is still in view.

| labeled field | measures | higher is |
|---|---|---|
| `goal` | the message that says what the session builds, once summarized: kept when any line of the state or summary still names it, by the label's marker | better |
| `rules` | labeled rules in force at the cut (given before it, not yet lifted) that a rules-section line matches by the rule's marker | better |
| `span`, `earlier` | the same, split into rules given in the span this compaction closes and rules given before it | better |
| `lifts` | rules the user withdrew before the cut that no rules-section line still shows in force (a line shows a rule lifted only by words outside its quotes: a rule's own "doesn't apply to JSON" does not count; the lift's own line, bound to the lifting message, quotes the rule's words and does not show it in force) | better |
| `values` | labeled values (a timing, a port, a total, a hash) due at the last compaction before the turn that uses them, kept as a whole token | better |
| `history` | the `values` only the conversation holds: the workspace cannot give them back | better |
| `stray` | Longhaul only: rule lines bound to a message no rule or lift was labeled at, such as a one-off request kept as a rule | lower |

Two labels were revised after a scoring run, both found by reading what a run missed or counted as stray. The
csv-toolkit first benchmark time accepted only "166 ms", the reply's rounding; the turn that uses it again quotes
the measured "165.7 ms", so both spellings count now. py-ledger's u19 ("The type hint rule is lifted for test
files; keep it for the ledger package itself.") was first labeled only as narrowing u9. It also gives a rule that
still stands, so it is now a rule of its own, and u9 stays in force without a `liftedAt` (a line that holds u19's
narrowed rule still names type hints). Each revision applies to every arm alike, and rows recorded before it are
not compared with rows after it.

The unlabeled measures work on any transcript store, including one with no labels:

| field | measures | higher is |
|---|---|---|
| `need` | exact file paths and normalized commands the next 10 assistant messages used, found in the text (Longhaul: or answerable by `longhaul_recall`) | better |
| `files`, `artifacts` | the same window by basename: files the file tools touched, and file-like names inside commands | better |
| `corrections` | the user's messages from the compacted span that contain a rule word (never, always, don't, do not, must, stop), kept verbatim (a 12-character window) inside a rules section. A word list: it misses a rule worded without one and counts a one-off that has one, which is why the labeled `rules` exist | better |
| `earlierCorrections` | the same for rules given before the span, which only a carried state or summary still holds; also reported per distinct rule | better |
| `facts` | values first seen in the span's tool output, not said by the session in the span, not visible after the cut, and used again in the next 10 assistant messages, kept as a whole token. Mostly identifiers read from source files (`writeHead`, `readFileSync`), which the next turn reads again from the file; a value the assistant already reported to the user is excluded by construction. A wide summary that names many identifiers scores well on it, and the Learned values section, which keeps no code names and only values the span itself used, cannot raise it. The labeled `values` measure what a resumed session cannot look up | better |
| `reused` | values first seen in the span's tool output, not visible after the cut and used again in the next 10 assistant messages, whether or not the span itself used them: what the Learned values section is for. Code names (identifiers, and dotted names with no file extension such as `process.exit`) are left out, by a test of its own rather than the section's | better |
| `factsWithRecall` | `facts`, also counting a fact `longhaul_recall` finds, as `need` and `names` do; the same as `facts` for an arm without the tool | better |
| `objectiveMoved` | compactions where the recorded objective quotes a different message than the previous compaction's (Longhaul only; the same message in other words is no move). The objective is the request the work answers now, so a new request in the span warrants a move: 47 of these 76 compactions have a new user message in the span, and no label says which moves were warranted | context |
| `objectiveBack` | of those, moves to an earlier message than the previous one (Longhaul only) | lower |
| `claimWrong` | World claims that disagree with the ledger (Longhaul only) | lower |
| `chars` | rendered size | context cost |
| `in`, `out` | mean prompt and output tokens per compaction | cost |
| `p50`, `p90` | wall time per compaction | time |
| `probe` (`SCORE_PROBE=1`) | a model resumed on the compaction is asked for its plan, scored against the names the next messages touched | better |

No measure uses a model as judge.

## Sessions

The published runs use **synthetic** sessions only, never recorded user transcripts. They are committed to
`eval/sessions/` (the repository only; not in the npm package), one per scenario in `eval/scenarios/`:

| scenario | the work | window | compactions |
|---|---|---|---|
| `csv-toolkit` | a TypeScript CSV parser and CLI | 40,960 | 10 |
| `py-ledger` | a Python household ledger on sqlite3, with schema migrations | 40,960 | 11 |
| `sh-backup` | a bash backup-rotation script with its own test runner | 49,152 | 20 |
| `ts-kv` | a TypeScript key-value HTTP server with TTL, ETags and persistence | 49,152 | 12 |
| `py-mdtoc` | a Python Markdown table-of-contents generator | 40,960 | 3 |
| `ts-logstat` | a TypeScript access-log summarizer CLI, written to defeat a word-list rule detector | 49,152 | 20 |

Each is a real pi session: a real model doing real work with pi's own tools in an empty project directory,
driven by 25 scripted user turns (`eval/record.ts`). The turns are written to exercise what compaction has to
carry: three standing **rules** per scenario (one lifted later in some), **values** the work produces and the
user asks for again later (commit hashes, timings, a schema version, a port), and questions that reach back
across compactions. In the first five, only the rule turns use rule-shaped wording, which makes a word list look
better than it is. `ts-logstat` is written against that: four of its rules have no rule word (one is stated as
a fact about production, one sits inside a task), three one-off requests do use one ("don't commit yet", "never
mind the timing"), one rule is partly lifted, one is replaced in other words and one is lifted without a rule
word. The labeled measures are what score it.

How they were made:

- **Model:** a local 27B reasoning model at thinking level `low`, recorded under the label `example/local-27b`.
- **Window:** a 40,960-token context window with pi's default `reserveTokens` (16,384) and `keepRecentTokens`
  8,000, much smaller than the model's own, so 25 turns give several compactions per session. The reserve is
  pi's default because a reasoning model needs that room: at 8,192 the model's thinking ran into the output
  limit after a few compactions and every later turn was cut off. `sh-backup` and `ts-kv` use 49,152: their work
  is larger, and at 40,960 pi's own summary plus the kept messages came back close to the 24,576-token
  compaction threshold, so pi compacted again almost at once. 49,152 moves the threshold to 32,768, about 12k
  tokens above even pi's largest summary. Every arm replays the same transcript, so a different window per
  session changes no comparison.
- **Sandbox:** pi ran under bubblewrap with a throwaway home directory and the project at `/work/<scenario>`,
  as the sandbox's PID 1 (otherwise bwrap is, and a model that runs `ps` reads bwrap's argv with every host
  path it mounts: one recording was thrown away for that); the model was reached through a loopback proxy that
  held the key, so neither the key nor the real endpoint is in a transcript. `eval/check-session.ts` vets every transcript before it is committed: the sandbox cwd, the
  label model only, no answer cut at the output limit unless it was reviewed and is listed (below), no absolute path outside the sandbox other than reviewed
  example paths the model wrote (`eval/example-paths.allow`), and a private denylist; gitleaks runs as well.
- **Stalls:** a turn with no event for 10 minutes (a tool call that never returns, such as a server the model
  started in the foreground) is aborted, as a user would press Esc, and the next turn runs; the transcript keeps
  the aborted turn. A turn still running after 90 minutes fails the recording. None of the six sessions has an
  aborted turn.
- **Cut turns:** three answers in `sh-backup` (transcript lines 164, 302 and 309) and one in `ts-logstat` (line
  321) stop at the 16,384-token output limit. In each the model drafted a whole script, README or set of edits
  inside its reasoning and reached the limit before
  writing any visible text; line 302 left its turn with no answer at all, and the next scripted turn ran. They
  are not thinking loops. They are kept because long sessions with a local reasoning model do this, and every
  arm replays the same transcript, so a cut favors none of them. Each is listed as a reviewed exception
  (`length <session>:<line>`) in `eval/example-paths.allow`; the checker refuses any other cut, and refuses an
  exception whose line is not a cut.
- **Compactions:** pi's own compaction, Longhaul not loaded.
- **Edits:** the transcripts are as recorded, with two exceptions. In `sh-backup` (line 146) the recording model
  ended one of its own commit messages with an AI co-author trailer, imitating commits it had seen in training;
  that one line was removed from the command text. The commit's hash and title are unchanged. In `ts-logstat`
  the model copied the Apache documentation's sample line into a test, with a private (RFC 1918) address;
  its seven occurrences read `203.0.113.9` (a documentation address of the same length, unused elsewhere in the
  session), so the repository's private-network guard holds. Everything else in every transcript is unchanged.
- **Labels and the scenario:** `ts-logstat`'s scenario expects the first commit hash at u6, but the recording
  model volunteered `git log` from u1 on, so the first hash it gave the user is the root commit `edfab42` (u1),
  and that is the label for u23's "the commit whose hash you gave me first". The recorded session itself
  answered u23 with a later commit.
- **Times:** every time in a recording is UTC.

That last point biases the corpus **toward pi's own compaction**: every turn after a compaction was produced by
a model that had read pi's summary, so the reference (what the next messages used) is partly shaped by it. The
bias favors the `pi-default` arm, never Longhaul, so a Longhaul lead on these sessions is conservative.

## Results

One run, 2026-10-09, at commit `900ead3`, over the six published sessions: 76 compactions, every one scored, no
broken chain. Every arm summarized on a local 27B reasoning model with 4-bit weights at thinking level `medium`,
with `SCORE_KEEP_RECENT_TOKENS=8000`. A single run of a single model: the small labeled counts (values out of 9,
history out of 5) move by one on noise, and nothing here says how a hosted model would do.

**Chained** (each arm continues from its own earlier compactions, as a session would run):

| labeled | `state` | `state-unlearned` | `pi-default` |
|---|---|---|---|
| `goal` | 26/76 | 26/76 | **76**/76 |
| `rules` | **226**/227 | 226/227 | 211/227 |
| `span` | **21**/22 | 21/22 | 17/22 |
| `earlier` | **205**/205 | 205/205 | 194/205 |
| `lifts` | **32**/33 | 32/33 | 31/33 |
| `values` | **9**/9 | 6/9 | 7/9 |
| `history` | **5**/5 | 5/5 | 4/5 |
| `stray` (lower is better) | 15 | 15 | — |

| unlabeled | `state` | `state-unlearned` | `pi-default` |
|---|---|---|---|
| `need` | 0.31 | 0.31 | 0.29 |
| `files` | 0.88 | 0.88 | 0.88 |
| `artifacts` | 0.49 | 0.49 | 0.39 |
| `corrections` | 0.42 | 0.42 | 0.42 |
| `earlierCorrections` (distinct, of 16) | 0.74 (0.78) | 0.74 (0.78) | **0.76** (**0.79**) |
| `facts` | 0.34 | 0.27 | **0.58** |
| `factsWithRecall` | 0.48 | 0.43 | **0.58** |
| `reused` | **0.84** | 0.63 | 0.81 |
| `objectiveMoved` (lower is better) | 42 | 42 | — |
| `claimWrong` (lower is better) | 0 | 0 | — |
| `chars` | 10,539 | 9,911 | 14,780 |
| `in` / `out` tokens | 9,906 / 961 | — | 18,550 / 4,944 |
| `p50` / `p90` | 10 s / 22 s | — | 52 s / 80 s |

What it says:

- **Rules.** Longhaul kept 226 of the 227 labeled rules in force at the cuts against pi's 211, and every rule
  given before the compacted span (205/205 against 194/205): the carried state does not erode the way a summary
  rewritten from the previous summary does. Both dropped withdrawn rules about equally well (32 and 31 of 33).
- **Values.** All 9 labeled values and all 5 history values were kept, against 7 and 4. The `state-unlearned`
  pair isolates the Learned values section: without it the same state keeps 6 of 9, and `reused` falls from
  0.84 to 0.63.
- **Where pi's own does better.** `facts`: pi's summary names more identifiers read from source files (0.58
  against 0.34, or 0.48 counting what `longhaul_recall` finds). As the measure's definition says, a wide summary
  scores well on it and the next turn mostly reads those names from the file again; it is reported, not argued
  away. `earlierCorrections`, the word-list measure, is level (0.74 against 0.76) where the labeled `earlier`
  is not.
- **Cost.** One diff call per compaction: about half the prompt tokens, a fifth of the output tokens and a
  fifth of the median time of pi's own compaction on the same spans, with a smaller result.
- **Weak spots.** The session's goal was gone from 50 of the 76 states (`goal`, counted afterwards from this
  run's saved states): the Objective showed the current request and the two before it, and once the work moved
  past three requests the opening one, which says what is being built, fell out. pi's summary kept it every time.
  15 rule lines were stray, mostly one-off requests kept as rules. The recorded objective
  changed at 42 of 76 compactions, and 47 of the 76 bring a new user message; the objective is the request the
  work answers now, so this mostly follows the work (a later run counting by message: 45, none backward).

**Takeover** (`SCORE_CHAIN=0`: every compaction replayed on its recorded path, so Longhaul is handed pi's
summary of everything before the span, as when it is enabled in a session pi has already compacted):

| labeled | `state` | `pi-default` |
|---|---|---|
| `goal` | 76/76 | 76/76 |
| `rules` | **210**/227 | 208/227 |
| `span` | **22**/22 | 17/22 |
| `earlier` | 188/205 | **191**/205 |
| `lifts` | 15/33 | **31**/33 |
| `values` | 2/9 | **8**/9 |
| `history` | 1/5 | **4**/5 |
| `stray` (lower is better) | 55 | — |

Taking over is Longhaul's weak case today. It still keeps the span's own rules, but rules lifted before the
span stay in force (15 of 33 honoured), most values carried only in pi's summary are lost, and stray rule lines
triple. A session that starts with Longhaul does not hit this; one that enables it midway does, at its first
compaction.

**Takeover, after the switchover fixes** (2026-10-10, commit `0b49d52` against `main` at `9660c95`, two runs of
each, same model and settings). An earlier rule-shaped message may now carry a label, so one that replaced an
earlier rule withdraws it; before, that label was dropped and both rules were recorded. And a value pi's summary
carried may be named from the earlier turn that showed it.

| labeled | `0b49d52` run 1 | run 2 | `main` run 1 | run 2 |
|---|---|---|---|---|
| `rules` | 216/227 | 206/227 | 212/227 | 204/227 |
| `earlier` | 195/205 | 187/205 | 192/205 | 185/205 |
| `lifts` | **28**/33 | **31**/33 | 22/33 | 26/33 |
| `values` | 2/9 | 3/9 | 2/9 | 3/9 |
| `history` | 1/5 | 1/5 | 1/5 | 2/5 |
| `stray` (lower is better) | 49 | 58 | 51 | 49 |

Withdrawn rules are now dropped about as often as pi's own summary drops them (28 and 31 of 33, against pi's
31). Nothing else moved beyond the spread between two runs of the same code: the summarizer now can name an
earlier turn's value (unlabeled `reused` 0.69 and 0.71 against 0.68 and 0.67), but on the nine labeled values it
mostly named none, so values and history stay pi's strength on a takeover, and stray rule lines, mostly one-off
requests kept as rules, are as many as before. The chained runs of the same pair (`state` 227/227 and 33/33
lifts, `main` 217/227 and 33/33) differ less than two runs of near-identical code did (`stray` 15 at `900ead3`
and 40 at `main`), so they are not read as a change.

**This release** (2026-10-10, commit `6fab98f`: the seed floor of #14 and the Goal line of #16, same model and
settings, one chained run and one takeover run, each with pi's own compaction alongside):

| labeled | chained `state` | `state-unlearned` | `pi-default` | takeover `state` | `pi-default` |
|---|---|---|---|---|---|
| `goal` | **76**/76 | 76/76 | 76/76 | 76/76 | 76/76 |
| `rules` | **220**/227 | 220/227 | 187/227 | **210**/227 | 209/227 |
| `span` | **21**/22 | 21/22 | 16/22 | **20**/22 | 17/22 |
| `earlier` | **199**/205 | 199/205 | 171/205 | 190/205 | **192**/205 |
| `lifts` | **32**/33 | 32/33 | 31/33 | 23/33 | **30**/33 |
| `values` | **8**/9 | 6/9 | 6/9 | 2/9 | **9**/9 |
| `history` | **4**/5 | 4/5 | 3/5 | 1/5 | **5**/5 |
| `stray` (lower is better) | 18 | 18 | — | 21 | — |

The goal row was counted from the saved states: the scoring copy of the label file lacked the goal labels for
this run. Chained, the session's goal is now in every state (26 of 76 at `900ead3`), and the rest is within the
spread of earlier chained runs (`rules` 217 to 227, `stray` 5 to 40). pi's own `rules` (187 against 211 at
`900ead3`) moved further between two runs than Longhaul's did.

The `lifts` and `stray` rows were rescored from the saved states after a scorer fix, with no new model calls
(the fix only narrows what counts as in force or stray, so filtering each row's saved lists gives what a fresh
run would score). As first scored, chained `lifts` read 29/33 and `stray` 21, takeover 22/33 and 22: three
states had lifted csv-toolkit's u7 and kept u18, the message that lifted it, as a rule of its own ("The rule
about pasting the test summary ... is lifted. Mention test results when something fails."). The lift word sits
inside the quote, and u18's words match u7's marker, so the scorer read the lift as u7 still in force, and
counted u18 as a stray rule. pi's lifts were unchanged: its summaries say "lifted" in their own words. The one
chained miss left is real (that state still shows u7 with no lift), and so are the takeover misses: the rule
still shown with no lift, or the lift bound to the wrong message (#15). Tables above this one were scored
before the fix, so a state that kept a lift message as a rule counts there as a missed lift and a stray line.

Taking over, stray rule lines fall from about 50 to 22 (11 in a first run of the seed floor alone, `2232e33`:
`rules` 223, `earlier` 201, `lifts` 26), and `rules` stay level with pi's. This run had six narrative-less passes
(the model's answer was not valid JSON), against two to four in earlier takeover runs, and a narrative-less pass
keeps only the rules code records: most of the misses are ts-logstat's rules with no rule-shaped word, which only
a label records. Values and lifts given before the takeover remain pi's strength there (#15 tracks the lifts).

**`turns` mode** (chained, `state-turns`): `rules` 225/227, `span` 21/22, `earlier` 204/205, `lifts` 29/33,
`values` 7/9, `history` 4/5, `stray` 5; `reused` 0.80, `facts` 0.29. It cuts stray rule lines from 15 to 5 and
matches or trails the default elsewhere, at about six times the prompt tokens (60,125 against 9,906 per
compaction) and a median of 14 s. The default stays one diff call.

**Earlier version.** The same chained run of commit `8c8cc20` (2026-10-07, before the fixes since then) kept
170/227 `rules`, 154/205 `earlier`, 15/33 `lifts` and 7/9 `values`, with 21 stray lines.

## Model compatibility

Separate from the scored sessions, `eval/matrix.ts` checks that a compaction goes through Longhaul end to end on
a given model: a short real session, `/compact`, then a fresh turn that must recall a value and a rule from
before the compaction (`eval/README.md`). Results so far, all through subscription logins:

| model | class | session thinking | result |
|---|---|---|---|
| GPT-5.5 | hidden reasoning, can be turned off | default; `medium` | pass, 1 call |
| GPT-5.6 Luna | hidden reasoning, can be turned off | default | pass, 1 call |
| Claude Haiku 4.5 | reasoning can be turned off | default; `low` | pass, 1 call |
| Claude Sonnet 5.5 | **must-reason** (asked for its lowest level) | default; `medium` | pass, 1 call |

In every cell the diff came back in one call, verified, and the resumed model recalled both the value and the
rule. The local 27B reasoning model the sessions were recorded with is covered by the sessions themselves.

## Reproducing

```bash
git clone https://github.com/lobo235/pi-longhaul && cd pi-longhaul && npm ci
SCORE_SESSIONS=eval/sessions SCORE_KEEP_RECENT_TOKENS=8000 \
  SCORE_MODEL=<provider/model-id[:thinking]> SCORE_ARMS=state,state-turns,pi-default npm run score
```

The published sessions were recorded with `keepRecentTokens` 8,000; for a store of your own, use the value it
was recorded with. A chained run replays every compaction of every session in order; `SCORE_N` (how many
compactions, newest first), `SCORE_AT` and `SCORE_CANDIDATES_FROM` pick single compactions and so need
`SCORE_CHAIN=0`. The labels are read from `labels.json` beside the sessions, or from `SCORE_LABELS`.
The run prints one summary line per arm, one labeled line per arm when there are labels, a `not scored:` line naming anything it had to leave out, and writes `rows.jsonl` and `summary.json` under `score-out/`. The rows
hold each arm's rendered text, which quotes the sessions: keep them private unless the sessions were synthetic.
Each arm costs at least one model call per compaction (`state-turns` five or more).
`SCORE_ARMS` takes any of the arm names above. A session under a
`localOnlyRoots` entry is skipped unless `SCORE_INCLUDE_LOCAL_ONLY=1`, because the scorer's model may be remote.
Transcripts are read as regular files only: a symlinked `.jsonl` is not followed, so copy sessions in rather than
linking them. A run that finds nothing to score says which of these it hit and exits 1.
A chained run over the same sessions scores the same compactions every time, so two runs pair by construction. With
`SCORE_CHAIN=0`, rerun with `SCORE_CANDIDATES_FROM=<previous rows.jsonl>` to score the same compactions.

`SCORE_MODEL=<provider/model-id> npm run evidence` runs the evidence check (`src/score/evidence.ts`): one synthetic
state that says the tests pass while World and the ledger show `npm test` failing, resumed `EVIDENCE_K` times
(default 5) with the precedence line's evidence clause and as many without it. Each plan is counted by code, with
no model judge: `reruns` when the test runs before any commit or push, `asserts` when a commit or push comes
first, `other`, or `no-plan`. It reads no transcript.
