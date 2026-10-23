# Longhaul glossary

The words Longhaul's code and docs use, and what each one means. When code and this file disagree, this
file wins and the code is renamed.

## The state

**State compactor**:
A compactor that carries a **Session state** forward instead of rewriting a summary. Longhaul is one; its
product name is always given with the tagline "a state compactor for pi".
_Avoid_: summarizer (that is the model call inside it)

**Session state**:
What survives a compaction: the **Objective**, the user's standing corrections in their own words, decisions and
dead ends with evidence, the **World**, the files, **Learned values**, one work-log line per **Span**, and Now.
It is kept as an append-only log on the transcript and rendered under fixed caps.
_Avoid_: summary, memory

**Span**:
The stretch of conversation between two compactions. Each compaction closes one span.

**Pass**:
What Longhaul does at one compaction: record the facts, fold the state so far, ask for the **Diff**, verify
it, and close the span.

**Diff**:
The model's whole contribution to a pass: the corrections and lifts it found, decisions, dead ends, a
narrative line and Now, as a small JSON answer that code verifies before accepting any of it.
_Avoid_: summary

**Compaction line**:
The line Longhaul shows in pi's transcript under each compaction it ran, or fell back from: how long the
compaction took, and what the pass cost or why it fell back. Display only: it is never sent to the model.
_Avoid_: compaction notice (a notice is pi's transient status message)

**Narrative-less pass**:
A pass whose diff failed entirely. The span still closes from what code recorded.

**Ledger**:
Every command the session ran with its exit code, and every error, each with an id (`C12`, `E3`) that
evidence can cite.

**Objective**:
The state's first section: the **Goal line**, the **Request**, when the work counts as done, and the
**Earlier requests**.

**Request**:
The user's request the work is answering now, quoted verbatim. The summarizer moves it to a later message when
the user moves to a different request, never back to an earlier one.
_Avoid_: task, objective (the section, not the quote)

**Goal line**:
What the session is for, kept by code and never moved by the summarizer: the active pi-goal `/goal`, else the
session's **Opening request** once the Request has moved away from it.
_Avoid_: objective, project goal

**Opening request**:
The first Request the session had. Outside a `/goal` it becomes the Goal line, so the session's purpose survives
however often the Request moves.

**Earlier requests**:
The newest Requests the summarizer moved away from, other than the Goal line; they may already be done.

**World**:
The workspace at the moment of compaction: branch, commit, whether the tree is clean, the last result of each
test, build or lint command, open errors, background tasks still running. Newer than anything the model wrote.

**Correction**:
A standing rule the user gave, kept verbatim with the message it came from: one that still binds once the work
asked for now is done, never a request for that work. Only a **Lift**, the user withdrawing one, retires it, never
their number (short of a safety ceiling no real session reaches); the correction stays visible as history. A **Condensed** correction is one the hard cap shows as an
excerpt naming its message. A skill's text is never a correction: it is the skill author's, not the user's.
_Avoid_: preference, constraint (pi's own summary heading, not this concept)

**Learned values**:
Values a later turn may need again, verbatim, with where each came from: those the summarizer names from a turn
(a timing, a total, a port), kept only when they stand in that turn, and those code picks from local tool output
that the session used again (a hash, a version, a long number).
_Avoid_: facts (the scorer's measure of a related but different set)

**Credential scrub**:
Taking each credential value out of the text the summarizer writes into the state (the narrative, Now,
decisions, dead ends), leaving `<redacted>` and the words around it. The value is gone; what it was and where it
lives can stay.
_Avoid_: sanitize (one-line.ts: control characters and newlines), redact (the ledger's word for dropping a whole command)

## Configuration

**Agent dir**:
pi's own configuration directory: `~/.pi/agent`, or whatever `PI_CODING_AGENT_DIR` names. Longhaul keeps
its configuration and its log there, never next to its own code.

**Longhaul config**:
The file `longhaul.json` in the **Agent dir**. Every key is optional and falls back on its own; a file that
is missing or is not a JSON object means the defaults. It is read again at every compaction, so an edit
needs no restart.
_Avoid_: config.json, settings

**Summarizer route**:
The model that writes the diff for a compaction when it is not the session's own model. Chosen in order:
the `PI_COMPACT_STATE_MODEL` environment variable, then a **Local-only root**, then the **Longhaul config**,
then none (the session's model).
_Avoid_: compaction model, routing model

**Route provider**:
A provider named in the **Longhaul config**'s `routeProviders`. Only a session whose model comes from a
route provider may use a **Summarizer route**; every other session summarizes on its own model, so its
conversation never reaches a provider the user did not choose for it. None by default.
_Avoid_: allowed provider, trusted provider

**Local-only root**:
A directory named in the **Longhaul config**'s `localOnlyRoots`. A session working in it or beneath it
summarizes on its own model whatever route is configured, because its conversation must not leave the
machine through a summarizer. Only the environment override beats it. None by default.
_Avoid_: pinned root, local summarization root

**Summarizer headers**:
HTTP headers the **Longhaul config** adds to the summarizer's own model calls, per provider. pi lets an
extension add headers to the requests its agent loop makes, but not to a compaction's, so a provider that
routes by a header would otherwise get the summarizer's request without it. A header the request already
carries wins. None by default.
_Avoid_: affinity headers (one use of them, not the concept)

**Kept window**:
The recent messages a compaction leaves unsummarized, which pi sends again after the state on every later request.
Their old reasoning is left out of those requests where that is known to be safe, so a model re-reads the state
and recent tool input and output, not its earlier thinking. An active tool turn is never cut on an API that needs
its thinking back.
_Avoid_: kept messages, tail

## Models

**Must-reason model**:
A model whose reasoning cannot be turned off: pi's model entry marks reasoning off as unsupported. The diff
needs no reasoning, so every other model is asked for none; a must-reason model is asked for its lowest
level instead, with a larger output budget so its reasoning cannot crowd out the answer.
_Avoid_: thinking model, reasoning model (most reasoning models can turn it off)
