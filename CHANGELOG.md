# Changelog

All notable changes to Longhaul are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) over the contract the README defines
(*Versioning*): `longhaul.json` keys, environment variables, tool names and parameters, persisted
entries and log event types. Rendered state text, prompt wording and section layout are not part of it.

## [Unreleased]

## [v1.1.0] - 2026-10-23

### Changed

- Standing rules no longer retire by count. Only the newest 8 corrections used to stay, so a long session lost its
  oldest rules, often its most basic ones, while requests mislabeled as rules kept their places. Now only your
  withdrawal retires a rule. When the state is over its hard cap, after the work log, decisions and dead ends, the
  oldest rules are shown as an 80-character excerpt that names the message holding them, instead of being dropped.
  `caps.corrections` in `longhaul.json` now defaults to 0, no limit up to a safety ceiling of 64 that no real
  session has come near; a number set there still retires the oldest past it. The log's `capFit` reports
  `condensedCorrections`.
- The summarizer's answer is bounded at 32 rules, lifts, decisions and dead ends each, and each rule's text in its
  prompt is cut to `caps.objectiveQuoteChars` with a pointer to the message, so many long rules cannot grow every
  compaction's prompt.
- The summarizer is told more precisely what is not a rule: a request for the work at hand however firmly worded
  ("make sure the banner is blue"), a question, a report of what you did ("I ran the script"), or an idea still
  under discussion. A rule is what still binds once the work asked for now is done. `longhaul_remember` says the
  same. When Longhaul takes over a session, an earlier request is not a rule either, even when it says how the
  result must behave ("add an export button that saves the report as CSV"). Prompt revisions `state-19` and
  `turns-11`.

### Fixed

- A `/skill:<name>` invocation's text became standing rules: pi expands the skill into the user message, and its
  rule-like lines ("Never push the tag before the commit") were recorded as the user's, six from one paste. Only the
  words typed after the skill can be quoted now, whoever proposes the rule, and the summarizer sees such a message
  as `[/skill:<name>] <your words>` (in turns mode too, with the skill's text behind `show`). A skill whose text
  carries its own closing tag or a /goal block cannot pass that text off as yours either. A prompt template
  (`/<name>`) leaves no such mark, so its text still reads as yours: docs/security.md names this limit.

## [v1.0.4] - 2026-10-22

### Fixed

- The summarizer copied credentials into the state it wrote: a password from a script's output into Resume, an API
  key or Bearer value into Now, decisions and the narrative. The state is sent with every later request, so the
  value went out again at every turn, and states on real sessions held live ones. What the summarizer writes is now
  scrubbed before it is recorded: each credential value becomes `<redacted>` and the rest of the line stays. A value
  is one when the span showed it as a credential (a credential key's value, symbols and all, a command's password
  argument, a value a secret store printed, `the password is …`), wherever the summarizer put it and however it
  wrapped it; when the text names it
  (`password=…`, `"api_key": "…"`, `Bearer …`, a `user:pass@` login, or a random-looking value just after a
  credential word, so `password (64-hex): <hex>` and `the gateway key (<uuid>)`); or when its shape is one wherever
  it stands (a JWT, a Vault token, AWS, GitHub, OpenAI-style, Slack and age keys). The span's credentials include
  what the previous summary and a switchover's earlier messages showed. A digest (`sha256:…`) is never one, and
  neither is a path, a count, a version or a date the text gives a key, nor, among the span's credentials, a name
  (`app-token`) under a token or secret key, an id or hash its label names (`Evaluation ID:`, `plan_hash`,
  `commit`), the rest of a command after a key whose value it computes (`TOKEN=$(vault kv get … | python3 …)`), a test
  name after `--- PASS:`, or a value after a credential word that is part of a file name (`~/.vault-token`): on real
  sessions the scrub took out the credentials and left versions, hashes, ids and names alone. A state written before this shows redacted from its session's next compaction
  on (the summary, the summarizer's prompt, `longhaul_recall`, `npm run state`), by every rule but the span's own
  credentials, which only the pass that wrote it had. Until then pi keeps sending the summary it stored, and a
  transcript keeps every summary and record it already holds, so a credential found in a state must be rotated. The compaction log records how many values a pass redacted
  (`redacted`), never the values. Both summarizer prompts also tell the model never to copy a credential's value
  and to say where it lives instead, and `longhaul_remember` refuses a decision or dead end that carries one.
- An error line naming a credential before its value (`ops-control password (64-hex): <value>`) was recorded as an
  open error and shown in every state; no command-style shape matched it. Such a line is now recorded with the value
  redacted, so the failure stays open, and one already carried is redacted at the next compaction.
- The credential rules found too little: a password key glued to its prefix (`PGPASSWORD=`, `MYSQL_PWD=`), short
  keys (`pw=`, `pass=`), `Authorization: Basic`, a private key's body past its first line, and GitLab, Google API,
  Stripe, npm and Hugging Face tokens, now in both the scrub and the command ledger's credential shapes.

## [v1.0.3] - 2026-10-22

### Changed

- Tested with pi 1.3.0, now recorded in `pi-compat.json`. No code changes to the extension for it.

### Fixed

- A span's record was lost whenever another extension wrote an entry between pi's compaction and Longhaul's span
  record. pi-goal does this at every compaction (its `goal-state`, sometimes a `goal-contract` message), active
  goal or not, so in a session with pi-goal installed most spans folded as narrative-less: the next state kept
  only the span just closed, and every earlier span's work-log line, Now, decisions, dead ends, objective moves and
  labelled rules were gone from it. The fold now passes over other extensions' entries until our record arrives; a
  message, a compaction or one of Longhaul's own event entries arriving first still means the record never
  landed. The records were always written, so an affected transcript gets its history back at its next
  compaction. While its records were lost, each pass was shown earlier messages again and recorded their rules
  again under new ids; with the records back, a rule recorded from the same message in near-duplicate words is
  one rule, under its newest id, and a lift of any copy lifts it. A rule the user withdrew while its record was
  lost could not be lifted then (the summarizer did not see it) and comes back now, so look over the
  constraints the first state after the upgrade shows.
- Spans whose records were written while earlier records were being lost can carry the same event seqs as an
  earlier span (each pass numbered from a fold that had lost events). The fold now treats a seq as unique within
  its span, so those spans fold too; a seq repeated inside one span is still refused as a duplicate. A correction
  `longhaul_recall` shows as lifted is now the one the lift landed on, never another span's event with the same
  seq.
- A replayed event whose span or seq is not a whole number from 1 is refused as malformed. A seq of `1e999`
  (Infinity) used to be accepted and broke the numbering of every event after it: a `longhaul_remember` write
  was then stored without a seq and dropped, with no anomaly, when the transcript was read back.
- The load smoke (`npm run load-smoke`, a development check that is not part of the package) resolved a
  wildcard `exports` target by replacing only its first `*`; it now replaces every one, as Node does (CodeQL
  `js/incomplete-sanitization`). No pi package uses a target with two, so the smoke's results are unchanged.

## [v1.0.2] - 2026-10-13

### Changed

- Tested with pi 1.2.0, now recorded in `pi-compat.json`. No code changes to the extension: 1.2.0 fires
  `before_agent_start` for runs a custom message starts as well (pi#5581), and Longhaul does not use that event. A
  test stand-in for pi-goal that read the event's prompt now skips the custom-message variant.

## [v1.0.1] - 2026-10-10

### Added

- A cross-version smoke (`npm run cross-version`), run by CI on every push and by the nightly job with the newest
  pi: one transcript handed through every pi in `pi-compat.json`, oldest to newest and back, with a Longhaul
  compaction by each. Every step must compact with an accepted diff, and the finished transcript must read back
  with one span per compaction and no anomaly.

### Changed

- Tested with pi 0.87.1, 0.99.0, 0.99.1, 0.99.2, 1.0.0, 1.0.1, 1.0.2, 1.0.3, 1.0.4 and 1.1.0; 0.99.0, 0.99.2 and
  1.0.3 are newly recorded in `pi-compat.json`. No code changes to the extension.
- Published from the release workflow through npm trusted publishing, so this version carries a provenance
  attestation linking it to its source commit. v1.0.0 was published by hand and has none.

## [v1.0.0] - 2026-10-10

### Added

- The Objective keeps the session's opening request as its Goal line once the Request moves to a later one (an
  active `/goal` takes the line instead), and the summarizer is told code keeps it. Before, the opening request
  was shown only while it was one of the two newest earlier requests, and over the six eval sessions compacted in
  a chain it was gone from 50 of 76 states. The scorer measures it as the labeled `goal`.
- `pi-compat.json`, the pi release lines Longhaul is verified against; on any other pi it runs and warns once
  per session, except in a session that opted out of it (`PI_COMPACTOR=pi`).
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
  lifted or named a one-off is not recorded again. Only an earlier message that reads as a standing rule is recorded
  without a label: a sentence, not a question, that says "from now on" and withdraws nothing, or
  has a clause with a rule word outside a request for now ("don't commit yet"), a withdrawal, "never mind" and a
  described feature ("an option that keeps only lines").
  Such a message may carry a label too, so one that replaced an earlier rule ("two-space indentation instead of
  tabs from now on") withdraws it; left unlabeled it is recorded
  in message order and a replacement it makes is asked about. A value the earlier summary records is kept when an
  earlier turn shows it verbatim, checked as a span's value is; the summary itself is never a source.
- The summarizer moves the objective only forward: quoting the objective's own message again changes nothing
  (or attaches the done-when it lacked), and a move back to an earlier message is refused; an explicit
  `longhaul_remember` may still point back. The scorer counts a move by the message quoted, and backward moves
  apart (`objectiveBack`).
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
  by trusted publishing, then a GitHub Release carrying the tag's changelog notes.
- `docs/how-it-works.md`: a compaction step by step, the log records, and the tools for looking at a state.
- `eval/` (repository only): six synthetic scenarios, and the recorder and checker that make the
  evaluation sessions; `eval/matrix.ts`, one model-matrix cell: a real compaction on a given provider and
  model, then whether the session still knows a rule and a value from before it.
