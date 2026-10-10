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

- **The pull request title** becomes the squash commit's subject: `area: summary`, in the imperative or as a
  statement of the new behaviour (`render: keep the Goal line once the Request moves`).
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

`npm test` and `npm run smoke` must pass. CI runs both on Linux, macOS and Windows, a secret scan, a security audit of the workflows (zizmor), a check of what the package would publish (`npm run check-pack`), and the cross-version smoke (`npm run cross-version`): one transcript handed through every pi in `pi-compat.json`, oldest to newest and back, with a Longhaul compaction by each. It installs each pi from npm into a temporary directory, with install scripts off and its dependencies as they were on that pi's release day (`npm install --before`), so it needs the network, and a local run executes that code as you; `--extra x.y.z` adds a version, `--keep` keeps the directory.

## Verifying a new pi version

Longhaul relies on pi internals, so each pi release line is verified before it is listed in `pi-compat.json`.
To verify one:

1. Set the exact version of `@earendil-works/pi-coding-agent` in `devDependencies`, then `npm install`, which
   updates the lockfile as well. Check `node_modules/@earendil-works/pi-coding-agent/package.json`: that copy
   is the pi `npm test` runs against.
2. `npm test`. The version gate in `src/pi-compat.test.ts` fails when that pi is outside every `major.minor`
   line `pi-compat.json` lists, which is expected for a new line; any other failure is a pi change to handle
   first. Then `npm run smoke` (one compaction by that pi, against a fake model), and
   `npm run cross-version -- --extra <version>`: the new pi must continue transcripts every listed pi wrote, and
   they must continue its.
3. Install that pi globally, install your checkout (`pi install /path/to/pi-longhaul`), and run one real
   compaction on a synthetic session: the *Live check* in
   [docs/setup-with-an-agent.md](docs/setup-with-an-agent.md) does exactly this. The log must show a
   `compaction` record, not `fallback`.
4. Optionally, one paired scorer run on synthetic sessions
   (`SCORE_SESSIONS=<dir> SCORE_MODEL=<provider/model-id> SCORE_N=1 npm run score`, see
   [docs/evaluation.md](docs/evaluation.md)).
5. Record it: `node scripts/record-pi-version.ts <version> "<what you ran>" "<what you ran>"`.

A nightly job runs steps 1 and 2 (the cross-version smoke included) against the newest pi and opens a pull request
recording it when they pass;
step 3 is still a maintainer's to run before merging.

## Releasing (maintainers)

1. Set `version` in `package.json` (and the lockfile: `npm install --package-lock-only`). A version with a
   `-` (`1.0.0-rc.1`) is published under the `next` dist-tag, anything else under `latest`. Point `pi.image` in `package.json` at the new tag too: the release job checks it.
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


**Where a release shows up.** The [pi package gallery](https://pi.dev/packages) lists the package from npm within
minutes of a publish: its card shows the `package.json` `description` and the `pi.image` card
(`.github/assets/infographic.png`, pinned to the release tag), and its page renders the README inside the published
tarball. Editing either on GitHub changes nothing there until the next release, and a README link to a file the
package does not ship must be an absolute GitHub URL. After `publish`, `release.yml` creates the GitHub Release
for the tag from its `CHANGELOG.md` section; for the manual first publish, run
`gh release create vX.Y.Z --verify-tag --title vX.Y.Z --notes-file <that section>` instead. The repository's
social preview (Settings > General) is `.github/assets/social-preview.png`, uploaded by hand.

## Repository settings (maintainers)

The workflows and docs rely on:


- an `npm` environment with required reviewers and a deployment rule limited to `v*` tags, and a ruleset that
  protects `v*` tags and `main` (required checks, no force push);
- the `main` ruleset requires a pull request approved by a code owner (`.github/CODEOWNERS`), with its review threads
  resolved and a linear history (squash or
  rebase merges), and every CI check: the `test` legs, `workflows` and `secrets`. Maintainers can bypass it;
- Dependabot alerts and security updates, plus the weekly version updates in `.github/dependabot.yml`; CodeQL
  default setup, whose high and critical alerts block a merge; secret scanning with push protection;
- "Allow GitHub Actions to create and approve pull requests", so the nightly can open its pull request;
- Discussions (the issue template links to them) and private vulnerability reporting (SECURITY.md does);
- GitHub pauses scheduled workflows in a repository with no activity for 60 days; re-enable `nightly-pi` from
  the Actions tab when that happens.

## Licence

Longhaul is MIT licensed. By opening a pull request you agree your contribution is licensed under the same
terms (inbound = outbound). There is no CLA and no sign-off requirement.

## Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).
