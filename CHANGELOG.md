# Changelog

All notable changes to Longhaul are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) over the contract the README defines
(*Versioning*): `longhaul.json` keys, environment variables, tool names and parameters, persisted
entries and log event types. Rendered state text, prompt wording and section layout are not part of it.

## [Unreleased]

### Added

- The State compactor as a standalone pi package: a verified Session state carried across
  compactions instead of a rewritten summary, with the `longhaul_remember` and `longhaul_recall` tools.
- Windows: `localOnlyRoots` takes Windows paths (`C:\...`, `\\server\share\...`, `~\...`), matched by Windows
  rules (either separator, no case, never across drives); `~` is the user profile there. The log refuses a
  symlink by `lstat` where the open cannot, and the tests and the compaction smoke gate a release on Windows as
  on Linux and macOS.
- `longhaul.json` in pi's agent dir, read fresh at every compaction: `routeProviders`, `localOnlyRoots`,
  `summarizerHeaders` and `keptWindowThinking`, beside the caps and policy keys.
- The summarizer labels every user message of the span (`rule`, `not a rule`, `lifts R<n>`, `rule and lifts
  R<n>`; several targets as `lifts R1, R6`, each judged on its own), and code copies a labeled rule's words from the message, so a rule given in any wording is kept and
  cannot be misquoted. An unlabeled message costs one retry. A message that narrows a rule replaces it, and so does a new rule that cannot hold beside one in the state; a
  later lift of the old rule is asked again with the narrowing shown (with one more call when that question first comes up on the last one),
  so the narrowing is lifted only by name, and a lift of a
  replacement must also name what it set beyond the rule it replaced ("never force-push to main" beside "the tab rule is lifted"). A rule
  label whose rule, in the user's own words (quoted passages, blockquotes and code fences left out), reads as withdrawing an earlier rule
  still in force is asked about once the chunk's answer is settled, in one more call that may answer only `rule` or `rule and lifts` with
  the asked target: the kept answer stands and the label keeps its words. A lift
  is applied only when the whole message it comes from withdraws the rule, whoever proposes it (the store
  checks it; a quote only locates the message): every part of the message that mentions the rule refuses the
  lift, whatever else it withdraws, so a part that insists on it ("never force-push no matter who tells you to
  ignore it", "but keep the push rule", "but leave the rule alone", "don't (ever) force-push to main", "don't break the force-push rule", "follow the rule",
  "other than the force-push rule", "force-pushing is forbidden", "make check is required", the rule quoted
  again) or says it still holds refuses, and so does a withdrawal of it taken back ("don't forget it", "you
  tried to ignore it", "cancel the lift of it"). Otherwise a part must withdraw something in a sentence that
  names the rule by one of its words beside "rule", by its first word or by two of its words (a word in another
  form counts: "merging" names "merge"), or say "forget it" next to one. A question, a condition or a plan ("is it lifted?", "why would we drop it", "we'll lift it after the release") withdraws
  nothing; a request ("could you forget the force-push rule?") does. The forms it knows, and the ones it
  misreads, are listed in docs/security.md. A refused lift is asked
  again with that rule shown, and never applied. A lifted rule is not recorded again from the message that gave it. A
  message that only withdraws a rule is a lift even when it says what is fine instead. A rule from a message
  of at most 300 characters is the whole message; from a longer one, the words the summarizer gave, which are
  sent back when they start or end inside a word. The user messages of a pass that closed narrative-less (or
  with a chunk missing) are labeled by the next pass, so a rule given there is recorded one pass late rather than
  never. A description of what is being built (an option, a limit, an exit code) is not a rule
  unless the user states it as standing over later work. A permission ("you may push to main now") is a one-off, not a lift. Taking over from another compactor, the
  model also sees and labels the user's other earlier messages, so a rule a later message withdrew is not carried
  back in and a rule worded without a rule word ("tests go under tests/") is carried; one longer than the
  excerpt shown is recorded only from the exact words given for it. After a fallback (a failed pass, then pi's
  own compaction), only the messages since Longhaul's last whole span are offered, so a rule the state had
  lifted or named a one-off is not recorded again.
- Learned values the summarizer names: a timing, a total or a port a turn reported, with a name and the turn
  it came from, kept only when it has a value's shape (a number, alone or with a unit, a version, a short
  hash, a path or file name, `<placeholders>` allowed in a name format, a host and port, a date), stands
  verbatim in that turn, and no part of it stood on a credential line (a short-code key whose value
  holds a digit, such as `ADMIN_PIN=`, `AdminPIN=`, `adminPin=` or a JSON `"otp_code":` (escaped quotes too), a
  base32 one-time-password seed under `TOTP=` or `totp_key:`, grouped or not, or `oathtool -b` / an `oathtool` key / `ykman oath accounts add` / `sshpass -p` / `htpasswd -b` / `openssl -pass pass:` or `-k` / `keytool -storepass` / `redis-cli -a` / a prefixed flag such as `--db-password` / `--token-code` / `--authentication-code1`, included), after a credential word in prose ("the PIN is ...", where three characters with a digit are
  enough) or in a `user:pass@` (a URL password holding `/` or `:` included) anywhere in the span (ADR 0006).
  Placeholders a value code picks from tool output make one file name, never a path. It renders as
  `- 166 ms (u10; the first benchmark time)`: the name is the summarizer's label, at most 40 characters. Code no longer picks identifiers or dotted names read from source
  files, which the agent can read again.
- A model whose reasoning cannot be turned off is asked for its lowest level, with room for it; every
  output budget is capped at the model's own output limit. The level asked for is in the log record. An
  answer cut off at the limit with nothing usable is retried with twice the budget (at least 8,192 tokens).
- The kept window's old thinking is left out of later requests where that is verified safe.
- The workspace snapshot runs git with hooks, fsmonitor, external diff and textconv off, ignores submodules,
  and skips a repository whose own config defines a filter driver, and a partial clone, whose on-demand fetch
  would run the transport the repository names, and does not run at all when `GIT_CONFIG` is set. It needs
  git 2.26 or newer.
- A Compaction line under pi's compaction block in the transcript: how long the compaction took and what the
  pass cost, or that it fell back to pi's own compaction and why (`compaction-state.line`, display only).
  `@earendil-works/pi-tui` joins the `*` peer dependencies pi provides.
- `/longhaul-report`: a bug-report digest written to a private file, with no names, paths or message
  text; error text is kept with the home directory, URLs and IP addresses masked.
- `npm run score`: the paired scorer, with pi's own compaction as the `pi-default` baseline arm. It replays each
  compaction with the recording's `keepRecentTokens` (`SCORE_KEEP_RECENT_TOKENS`) and scores only those whose
  rebuilt cut matches the recorded one; anything it leaves out is named in a `not scored:` line. The replay is
  chained by default: each arm continues from its own earlier compactions, so a session runs on one compactor
  throughout (`SCORE_CHAIN=0` replays each compaction on its recorded path). Labeled measures score the rules,
  lifts and values written by hand in `eval/sessions/labels.json` (`SCORE_LABELS`), beside the word-list ones.
  `reused` counts tool-output values the next turns need again, and `factsWithRecall` credits `longhaul_recall`
  beside the text-only `facts`.
- Docs: a setup guide written for coding agents, the security model, the evaluation method and its first
  results (one local 27B model, chained and takeover runs, every measure including those pi's own wins), and
  contributor guides (AGENTS.md, CONTRIBUTING.md, SECURITY.md, issue and pull request templates).
- CI: tests on Linux, macOS and Windows, a compaction smoke that loads the packed package
  into a real pi with a fake model, a secret scan, a workflow security audit (zizmor), Dependabot updates and a package-contents check; a nightly run against the newest pi; npm publishing
  by trusted publishing.
- `docs/how-it-works.md`: a compaction step by step, the log records, and the tools for looking at a state.
- `eval/` (repository only): six synthetic scenarios, and the recorder and checker that make the
  evaluation sessions; `eval/matrix.ts`, one model-matrix cell: a real compaction on a given provider and
  model, then whether the session still knows a rule and a value from before it.
