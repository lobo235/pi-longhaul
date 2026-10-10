# Contributing to Longhaul

Thank you for helping. This file says how a change gets in. Coding agents: [AGENTS.md](AGENTS.md) has the
same rules in a shorter form.

## Before you write code

**Open an issue first** for anything larger than a typo or a one-line fix. Say what you saw, what you expected,
and what you would change. Longhaul is small on purpose and some reasonable ideas are out of scope (see the
README's *Roadmap*); an issue saves you writing a pull request that cannot be merged.

Bug reports: run `/longhaul-report` in pi and attach the file it writes. **Never paste a transcript, a raw log,
or your `longhaul.json` routes into an issue**: they contain your conversations and your setup. The report is
built to carry neither.

Security problems: not in an issue. See [SECURITY.md](SECURITY.md).

## Setting up

```bash
git clone https://github.com/lobo235/pi-longhaul && cd pi-longhaul
npm ci          # Node >= 22.19
npm test        # typecheck, unit tests, load smoke
```

To try a change in your own pi: `pi install /path/to/pi-longhaul` (a local path install), then start a new
pi session. `pi remove /path/to/pi-longhaul` undoes it.

Read [CONTEXT.md](CONTEXT.md) before naming anything. The code uses those words and no synonyms.

## Making the change

- **Tests first**, one behaviour at a time, through the public function. Fakes over mocks:
  `src/test-support.ts` has a fake pi.
- **Fixtures are synthetic.** No real transcript, log, hostname, IP address, user name or key, even redacted.
- **Small pieces**: functions under 60 lines, files under 400.
- **Docs in the same pull request**: the README for behaviour or configuration, CONTEXT.md for a new term, an ADR
  in `docs/adr/` for a decision that is hard to reverse, and a line in `CHANGELOG.md` under `## [Unreleased]`.
- **Security-relevant code** cites the threat it defends against in [docs/security.md](docs/security.md)
  (`security.md T3`). A change that weakens a defence there needs to say so in the pull request.
- Persisted names (custom entry types, event kinds, ids, env vars, the log path) never change without a
  migration; see AGENTS.md.

`npm test` and `npm run smoke` must pass. CI runs both on Linux, macOS and Windows, a secret scan, a security audit of the workflows (zizmor), and a check of what the package would publish (`npm run check-pack`).

## Verifying a new pi version

Longhaul relies on pi internals, so each pi release line is verified before it is listed in `pi-compat.json`.
To verify one:

1. Set the exact version of `@earendil-works/pi-coding-agent` in `devDependencies`, then `npm install`, which
   updates the lockfile as well. Check `node_modules/@earendil-works/pi-coding-agent/package.json`: that copy
   is the pi `npm test` runs against.
2. `npm test`. The version gate in `src/pi-compat.test.ts` fails when that pi is outside every `major.minor`
   line `pi-compat.json` lists, which is expected for a new line; any other failure is a pi change to handle
   first. Then `npm run smoke` (one compaction by that pi, against a fake model).
3. Install that pi globally, install your checkout (`pi install /path/to/pi-longhaul`), and run one real
   compaction on a synthetic session: the *Live check* in
   [docs/setup-with-an-agent.md](docs/setup-with-an-agent.md) does exactly this. The log must show a
   `compaction` record, not `fallback`.
4. Optionally, one paired scorer run on synthetic sessions
   (`SCORE_SESSIONS=<dir> SCORE_MODEL=<provider/model-id> SCORE_N=1 npm run score`, see
   [docs/evaluation.md](docs/evaluation.md)).
5. Record it: `node scripts/record-pi-version.ts <version> "<what you ran>" "<what you ran>"`.

A nightly job runs steps 1 and 2 against the newest pi and opens a pull request recording it when they pass;
step 3 is still a maintainer's to run before merging.

## Releasing (maintainers)

1. Set `version` in `package.json` (and the lockfile: `npm install --package-lock-only`). A version with a
   `-` (`1.0.0-rc.1`) is published under the `next` dist-tag, anything else under `latest`.
2. Rename `## [Unreleased]` in `CHANGELOG.md` to `## [vX.Y.Z] - YYYY-MM-DD`, with the `v`: the release job
   checks for it. Put a fresh empty `## [Unreleased]` above it.
3. Merge to `main`, tag that commit `vX.Y.Z`, and push the tag. `release.yml` re-runs the tests, the smoke and the
   package check, then waits in the `npm` environment for a maintainer's approval and publishes with provenance.

The first publish of a new package cannot go through the workflow: npm configures a trusted publisher only for a
package that already exists. It is a manual `npm publish --access public` with two-factor authentication, from
a clean checkout of the tag after `npm ci && npm test && npm run smoke && npm run check-pack`. Right after it:
configure the trusted publisher on npmjs.com (this repository, workflow `release.yml`, environment `npm`), set
the package to require two-factor authentication and disallow tokens, and delete any token used. A trusted
publisher configuration that has not published within two days expires, so the next release should follow soon
or the configuration be made again.

Repository settings the workflows and docs rely on:

- an `npm` environment with required reviewers and a deployment rule limited to `v*` tags, and a ruleset that
  protects `v*` tags and `main` (required checks, no force push);
- the `main` ruleset requires a pull request with its review threads resolved and a linear history (squash or
  rebase merges), and every CI check: the `test` legs, `workflows` and `secrets`. Maintainers can bypass it;
- Dependabot alerts and security updates, plus the weekly version updates in `.github/dependabot.yml`; CodeQL
  default setup; secret scanning with push protection;
- "Allow GitHub Actions to create and approve pull requests", so the nightly can open its pull request;
- Discussions (the issue template links to them) and private vulnerability reporting (SECURITY.md does).

## Licence

Longhaul is MIT licensed. By opening a pull request you agree your contribution is licensed under the same
terms (inbound = outbound). There is no CLA and no sign-off requirement.

## Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).
