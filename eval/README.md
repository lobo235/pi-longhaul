# eval

The synthetic sessions the published results are measured on, and the tools that made them. Not in the npm
package. What the sessions are and how they bias the results: `docs/evaluation.md` (*Sessions*).

| path | what it is |
|---|---|
| `scenarios/*.json` | one scenario per session: a name, a description of its rules and reused values, 25 user turns |
| `sessions/*.jsonl` | the recorded pi transcripts, one per scenario, added once recorded and vetted |
| `record.ts` | records a scenario: pi under bubblewrap, driven over RPC, one prompt per turn |
| `drive.ts` | the RPC turn loop `record.ts` uses: a turn quiet for 10 min is aborted and the next one runs |
| `sandbox.ts` | the bubblewrap argv `record.ts` runs pi under: pi is the sandbox's PID 1, so no `ps` shows a host path |
| `proxy.ts` | the loopback proxy `record.ts` puts between pi and the model: adds the key, maps the model name |
| `sessions/labels.json` | the hand-written ground truth the scorer's labeled measures use: rules, lifts and reused values |
| `labels.test.ts` | checks that every label binds to its recorded transcript |
| `check-session.ts` | vets a transcript before it is committed |
| `example-paths.allow` | example paths the models wrote (`/path/to/source`), each reviewed, that the check lets through |
| `matrix.ts`, `matrix-verdict.ts` | one model-matrix cell: does a compaction go through Longhaul on this provider and model |

## Recording a session

Needs Linux with `bwrap` (bubblewrap) and an OpenAI-compatible endpoint. The profile is the non-secret part of
the model's pi entry plus the label the transcript will carry:

```json
{ "label": "example/my-model", "contextWindow": 40960, "maxTokens": 16384, "reasoning": true, "input": ["text"],
  "thinking": "low", "compaction": { "reserveTokens": 16384, "keepRecentTokens": 8000 } }
```

`compat`, `providerCompat` and `thinkingLevelMap` are passed through to `models.json` when the model needs them.

```bash
node eval/record.ts --scenario eval/scenarios/csv-toolkit.json --out /tmp/rec --profile profile.json \
  --upstream-url https://llm.example.com/v1 --upstream-model my-model --upstream-key-file ~/.config/my-key
node eval/check-session.ts --name csv-toolkit --label example/my-model --allow eval/example-paths.allow \
  [--denylist FILE] /tmp/rec/csv-toolkit.raw.jsonl
```

Keep the reserve at pi's default for a reasoning model: a smaller one leaves its thinking too little room, and
the check refuses the session once an answer is cut at the output limit. A cut you have read and judged
legitimate (the model drafting a long answer in its reasoning, not a loop) can be listed in the allow file as
`length <name>:<line>`; the check then excuses that one answer, and flags the line if it is not a cut. Read a transcript before committing it,
whatever the check says: the check catches paths, names and models it knows about, not everything a model might
write.

## Running a model-matrix cell

The matrix answers a narrower question than the sessions: does Longhaul work on a given provider and model at
all. A cell is four short turns over a copy of this repository's `src/narrative/` and `README.md` (one of them
a rule), one compaction, and a recall question. It passes when the compaction went through Longhaul with its
diff accepted. A cell whose turns failed at the provider (a login with no quota left, a model the login cannot
use) fails with the first error, cut to 300 characters, rather than with pi's "nothing to compact" that follows.
Beside the verdict it prints:
- `reasoning`: the level the summary call asked for, `off` or the model's lowest;
- `carriedRule`: whether the state holds the rule verbatim;
- `recalledValue` and `recalledRule`: whether the answer after the compaction still names the value read before it, and the rule;
- the call's tokens and the time.

These are one sample each; the sessions measure quality. No message text is printed.

Give it an agent dir made for it, never your own: the cell writes Longhaul's log there, and a login for the
cell belongs there too. One cell runs per agent dir at a time.

```bash
mkdir -m 700 /tmp/matrix-agent           # a models.json entry for the model, or log in:
PI_CODING_AGENT_DIR=/tmp/matrix-agent pi  # then /login, and quit
node eval/matrix.ts --agent-dir /tmp/matrix-agent --model provider/model-id [--thinking low]
```

The session has the read-only tools only and no other extension, so a cloud model sees nothing but public
code. It costs a handful of requests.

`--installed` loads Longhaul from the agent dir's own packages instead of this checkout: `pi install` the
packed tarball (or the published package) into that dir first. That is the check that the package as published
works in a fresh agent dir; whatever else the dir has installed loads too.

## Scenario rules

- Every rule, lift and reused value a scenario plants goes into `sessions/labels.json` once the session is
  recorded: the rule's message and a marker, the value's spellings and the turns that learn and use it.
  `labels.test.ts` checks that each label binds to its transcript.
- The first five scenarios word every rule with a rule word (never, always, don't, must, only, …) and no task
  turn uses one. `ts-logstat` breaks that on purpose, so a detector that only looks for those words fails it.
- Everything is written from scratch in the session, with the language's standard library: no third-party code
  or data enters a transcript.
