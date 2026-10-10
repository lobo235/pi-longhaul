# Working on Longhaul (for coding agents)

Longhaul (`pi-longhaul`) is a state compactor for the pi coding agent: an extension that replaces pi's
compaction summary with a **Session state** carried across compactions. Read [CONTEXT.md](CONTEXT.md) first;
its terms are the ones the code uses, and when code and glossary disagree the glossary wins and the code is
renamed. Human contributors: [CONTRIBUTING.md](CONTRIBUTING.md) says the same with more context.

## Commands

```bash
npm ci                 # Node >= 22.19; installs the vendored pi as a devDependency
npm test               # typecheck + every src/**/*.test.ts and eval/**/*.test.ts + a load smoke; must pass before any commit
npm run typecheck      # tsc only
node --test src/pass.test.ts   # one file
npm run smoke          # the packed package loaded by the vendored pi: one real compaction, fresh agent dir, fake model on loopback
npm run check-pack     # what npm would publish: nothing test-only, nothing missing
npm run state -- FILE  # inspect the state a transcript carries (read-only)
```

`npm run score` makes real model calls and costs money; never run it unless the person asked for it, and
only on synthetic sessions (see [docs/evaluation.md](docs/evaluation.md)).

## Layout

- `src/index.ts`: the extension entry (events, tools, the `/longhaul-report` command).
- `src/pass.ts`: one compaction pass; `src/carry.ts`, `src/render.ts`: the state and how it renders.
- `src/ledger/`: commands, errors and the World, recorded by code. `src/learned*.ts`: Learned values.
- `src/narrative/`: the model call that writes the Diff, its prompt, parsing, verification and routing.
- `src/store/`: the state's custom entries on the transcript. `src/score/`: the offline scorer. The scorer, `src/state-cli.ts` and every `test-support.ts` are clone-only: `package.json` `files` leaves them out and `npm run check-pack` fails if one ships.
- `scripts/`: the smoke, the package check, the fixture generator, `record-pi-version.ts`.
- `eval/`: the synthetic evaluation sessions, their scenarios, and the recorder and checker that made them (see `eval/README.md`).
- `pi-compat.json`: the pi versions Longhaul is verified against. `docs/adr/`: decisions; `docs/security.md`:
  threats T1-T8.

## Invariants (do not break these)

1. **Persisted names never change.** Custom entry types (`compaction-state.event`, `compaction-state.span`,
   `compaction-state.line`),
   event kinds, ids (`C12`, `E3`, `R1`, `D1`), the log path and the env var names are read back from existing
   transcripts and logs. A rename needs a migration, an ADR and a major version.
2. **pi versions are verified, not assumed.** `src/pi-compat.test.ts` fails on a vendored pi that
   `pi-compat.json` does not list. Do not add a version to that file without running the procedure in
   CONTRIBUTING.md; do not weaken the test to make it pass.
3. **Summarizer routing is default-deny** (ADR 0003). A session's conversation goes only to its own model
   unless the user's `longhaul.json` names a route and allows the session's provider. Never add a default
   route, a project-level config file, or any network call besides the summarizer's.
4. **The model proposes, code verifies** (ADR 0002). A correction is accepted only as a verbatim quote of a
   user message, and a rule the model labels is copied from the message by code; facts (World, files) are
   written by code, never by the model. A Learned value the model names is kept only when code finds it
   verbatim in the turn it cites (ADR 0006).
5. **Transcript bytes are untrusted** (security.md T1-T3). Parsing never throws on content, every pattern is
   linear on long input, logs carry no message text, and Learned values pass the credential filter.
6. **Fixtures are synthetic.** Never commit a real transcript, log, hostname, IP address, user name or API key,
   even redacted. Use `example`, `example.com` and documentation addresses (`192.0.2.0/24`).

## How to change code

- Test first, one behaviour at a time, through the public function. Use in-memory fakes (`src/test-support.ts`
  has a fake pi), not mocks that assert call order.
- Functions stay under 60 lines and files under 400. Split by responsibility when one grows.
- A comment that names a security reason cites the threat (`security.md T3`), not an ad-hoc id.
- Update docs in the same change: README (configuration, behaviour), CONTEXT.md (new terms),
  `CHANGELOG.md` under `## [Unreleased]`.
- Do not bump the version or edit `pi-compat.json` unless asked; both are release steps.
