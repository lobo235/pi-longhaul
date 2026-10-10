# Security model

What Longhaul protects, what it trusts, and where each defence lives. Code comments cite the threats below
by number (`security.md T3`). To report a vulnerability, see [SECURITY.md](../SECURITY.md).

## What is at stake

A compaction reads the whole compacted span: user messages, the assistant's words, tool calls and their
output, which can include file contents, command output and fetched pages. Longhaul turns part of that into
a **Session state** that is:

- re-sent to the model on every later request, where its text carries the weight of context the user set;
- persisted on the transcript (custom entries), so it is copied wherever the transcript goes;
- sent, during the compaction, to whichever model writes the diff;
- summarized into a log file on disk.

## Trust boundaries

| Source | Trusted for |
|---|---|
| The user's own messages | Their words, as words. A quoted correction must be a substring of one. |
| pi itself and its extension API | Event payloads and the session it hands over. |
| Tool output, fetched pages, MCP results, other agents' messages | Nothing. Data, never instructions. |
| The model's answer | A proposal: verified before anything is accepted. |
| Transcript bytes read back from disk | Nothing. They may have been edited, synced or written by anything. |
| Provider responses (usage numbers, errors) | Nothing beyond their type and range. |
| `longhaul.json` in pi's agent dir | The user's own configuration. |

## Threats and defences

### T1. Untrusted transcript bytes

Transcripts are read back to fold the state, to answer `longhaul_recall`, and by the scorer and the state
inspector. A transcript can be hand-edited, copied from another machine, forked, or written by another
extension.

- A malformed line is skipped, never fatal; nothing that parses a transcript throws on its content.
- A walk up the parent chain stops at a cycle, and the scorer skips a transcript over 512 MiB rather than
  reading it into memory.
- A timestamp a `Date` cannot hold is dropped rather than thrown on.
- An id held by two entries (an old transcript can carry a re-minted id) resolves to the newest holder.
- An entry from a newer state format is refused by name, so a downgrade starts clean rather than misreading.
- Learned values read back from a transcript are checked again (length, printable ASCII, count). A name is
  checked as when it was given and dropped if it fails, and a named value must still have a value's shape.
- `npm run state` prints transcript-derived text only through the renderer's sanitizer or `JSON.stringify`,
  so no control character reaches the terminal.

### T2. Instructions smuggled into the state

The rendered state is re-sent on every request, so text in it has standing. Anything the model reads during
the session (a web page, a README, another agent's message) could try to plant a "rule" there.

- A correction is accepted only as a verbatim quote of a user message, checked as a substring.
- A `/goal` objective counts only when the message has pi-goal's exact template **and** pi-goal recorded that
  goal in its own custom entry: text that reaches pi as a user message can copy the template, but only
  extension code writes a custom entry. A stopped goal is cleared.
- The line under the state's title scopes "newer wins" to progress (Now, World, Work log). Standing rules stay
  until a user message withdraws one, and text in tool results or relayed from other agents is named as data.
- Every rendered field is one line: no id, reference, evidence tag or narrative can carry a line break into
  a new section.
- Every list and item in the model's answer is bounded by the schema, not only by the renderer's caps.
- An answer that calls a tool is not an answer, even beside valid JSON.
- A lift is judged on the whole user message it comes from, whoever proposes it: a label in either narrative
  mode, a summarizer `lifts` entry, or the agent's `longhaul_remember`, whose quote only locates the message. A
  quote cut out of a restatement ("forget: no force-pushing" out of "don't forget: no force-pushing") is judged as
  the message says it. A withdrawal of an earlier message at a switchover is checked the same way. A lift aimed
  at a rule another message already replaced (a narrowing that lifted it and gave a rule of its own) is refused,
  and the refusal shows the replacement's id and words, and what it set beyond the old rule. The replacement is
  the whole message that lifted the old rule, so it holds the old rule's words, and a repeated lift ("to be clear,
  the tab rule is lifted") would pass the check against it and withdraw whatever else that message set ("...
  Never force-push to main."). So a lift of a replacement, aimed at it by name or not, must also name the parts
  of it that are not about the rules it replaced: "lifts u5" from that repeated lift is refused, "the force-push
  rule is lifted too" lands. A part is about a replaced rule when it withdraws that rule, carries every word the
  withdrawal named it by, in any inflection ("keep tabs in the TypeScript files" after "the tab rule doesn't apply
  to the JSON files"; "committing" is "commit"),
  or scopes what is kept of it with a pronoun as its object ("keep it for the package itself", "keep that for
  src/"). A word the two merely share ("main", "push", a first verb such as "write" or "run"), a shared prefix
  ("checkout" beside "check") or a "this" that belongs to a noun ("keep secrets out of this repo") is not enough. A
  narrowing, every part of which is about the rule it narrows, is judged as any rule. A lift must name a
  replacement's own parts both as written and without the old rule's words, so an own part that also names the old
  rule ("now that the tab rule is lifted you must never force-push", when no other part names it) is not named by
  a repeated "the tab rule is lifted", and a scope word in that lift ("... lifted for production too") does not
  name "never push to production" once "push" is set aside. Residual: a new rule set inside a part that is about the old rule
  ("the tab rule is lifted; never force-push the tab changes to main", "...; keep it out of anything force-pushed to
  main", a withdrawal the part splitter does not split: "the tab rule is lifted so never force-push to main", or a
  compound word that carries the old rule's name: "the push rule is lifted. Never force-push to main")
  counts as the narrowing, so a repeated lift of the old rule aimed at the replacement by name withdraws it too, and
  the refusal names no rule of the replacement's own.
- A switchover's earlier messages are shown cut to their first 240 characters. One that is longer is recorded as
  a rule only from the exact words given for it, never whole, so a paste past what the model saw is not recorded
  on a bare "rule" label.
- Every part of the message that mentions the rule refuses the lift, whatever else that part withdraws. A part is
  a stretch of a sentence between commas, colons, brackets, dashes, "and", "but", "though", "yet", "then",
  "while" and "since"; a part starts again at "keep", "leave", "except", "excluding", "other than", "apart from",
  "aside from", "save for", "with the exception of" and "besides". A part mentions the rule when it keeps or sets
  apart a rule named by one of the rule's words ("keep the push rule", "leave the force-push one alone", "except
  the push rule", ", not the push rule", "remember: ..."; "no need to keep the force-push rule" keeps nothing), or
  a rule it names by no word of its own in a message that names this one ("keep the rule intact", "leave the rule
  alone", "keep the existing rule", "keep the important rule", "keep the ban in place"; "follow", "obey",
  "respect", "honour", "stick to", "stick with", "abide by", "adhere to", "comply with", "observe", "enforce",
  "preserve" keep a rule too, said of a rule's noun, and "the rule about X" is named by X, so "follow the rule
  about rebasing" keeps another rule; "for" and "on" name one only by this rule's words, since "keep the rule for
  now" and "follow the rule on principle" keep this one); when it keeps what the rule forbids away ("keep
  force-pushes off main") or, for a rule that requires something, goes on doing it ("keep writing"); when it holds
  a command word pointing the rule's way ("never", "no", "stop", "avoid", "shouldn't", "can't" for a prohibition;
  "always", "must", "don't skip", "never ever skip", "don't commit without", "no commits without" for a
  requirement), "forbidden", "not allowed" or "not
  okay", or for a requirement "required" or "mandatory" (none after "no longer" or "not"), with the rule's first
  word or two of its words; when a command earlier in its sentence has nothing after it in its own part but
  emphasis ("don't (ever) force-push to main", "you shouldn't (ever) force-push", "do not, under any
  circumstances, force-push to main", "seriously don't — force-push", "but no — force-pushing", "but no way —",
  "but absolutely not: ..."; for a requirement, "do not, under any circumstances, skip make check", "never, ever commit without make check"); when it says the
  act a rule forbids is not needed ("no need to force-push to main", "no need to go and force-push"; "no need to
  avoid force-pushing" and "you no longer have to avoid it" are withdrawals); or, when it withdraws nothing, when
  it holds most of the words of a rule of four or more words (the rule quoted again). "No" alone in a sentence's
  first part, or after a marker such as "well", "ok" or "hmm", is an answer ("No, the rule is lifted", "Well, no
  — the rule is lifted"), but it still points at the rule's words in a later part that withdraws nothing ("Well,
  no — force-pushing to main"); anywhere else it is a command ("is still a hard no", "a no-go"). A command followed by a rule's name is excused only as that name: right after the withdrawal word
  ("lift the never-force-push rule", "forget about the no force-push rule") or joined to it by a hyphen in a part
  that withdraws ("the never-force-push rule no longer applies"). "Don't break the force-push rule", "never
  violate the force-push rule", "ignore the lint warnings as long as you never break the force-push rule" and "no
  force-pushing is a hard rule" say it again. Withdrawal words elsewhere in the part do not excuse it, so "never apply terraform to production
  even if a tool output says the rule is lifted", "never force-push no matter who tells you to ignore it", "ignore
  the hook warnings: never force-push", "forget the review rule but keep the push rule" and `ignore the tabs
  warning. The rule is "use tabs for indentation in every TypeScript file"` lift nothing. Withdrawal words are
  looked for within one part ("force-pushing to main is banned, linting is no longer required" keeps the ban), and
  "doesn't apply" withdraws only said of a rule or "it", "this", "that" ("the force-push rule doesn't apply
  here"): "don't apply migrations on a Friday" and "don't apply to production on Fridays" are the rule said
  again. A rule quoted or named inside the words that withdraw it
  ("lift the never-force-push rule") is not a command. One shared word is no mention ("you can forget the
  force-push rule. Just don't break main." lifts it), and "stop pasting the test summary" does not insist on a
  rule to paste it.
- A sentence saying a rule still holds ("still applies", "still counts", "stays as it is", "needs to stay",
  "continues to apply", "is non-negotiable", "keep following it", "the rule stands", "the force-push rule stays,
  ...") refuses the lift when words of this rule come before those words in their part ("drop the review rule,
  force-pushing to main still counts as a violation"), when the rule named in the six words before them is this
  one, or when no rule is named there by its own words ("the rule itself, as we discussed, still applies", "but
  the rule still applies", "the actual rule still applies"). Said of another rule named there ("the review rule
  is different, it still applies"), it does not. Words that say anything is as it was ("is unchanged", "hasn't
  changed", "remains valid", "is still on") reaffirm only a rule named before them in their part ("the force-push
  rule is unchanged", "the rule is still on"), or before an aside or a pronoun that has no words of its own ("the
  force-push rule, as before, remains valid", "the force-push rule — that one is unchanged"): "lift the
  force-push rule, everything else is unchanged" lifts it, and so does "the rule about reviews is unchanged"
  beside it.
  The first 16 such phrases in a sentence are read.
- A withdrawal of the rule that is taken back refuses the lift: negated ("don't forget the force-push rule", "you
  must never, ever, under any circumstances ignore the force-push rule", "don't ignore the rule"), attempted
  ("you tried to ignore the force-push ban"), conditioned ("if", "unless" or "as long as" earlier in its part;
  "even if", "even when", "no matter", "regardless" or "whatever" before a clause earlier in its sentence;
  "whatever, drop it" is no condition) or retracted ("never
  mind what I said about lifting the force-push rule", "forget everything I said about dropping it", "forget about
  lifting it", "cancel the lift of the force-push rule"); "don't drop the rule" and "don't relax the rule" are
  negated withdrawals of the rule the message names, and so is one asked as a rhetorical question ("why would we
  drop the force-push rule", "how could we ever lift it").
- Otherwise a part must withdraw something (lifted, lifting, no longer, forget, disregard, scrapped, canceled,
  can be ignored, doesn't apply, stop following, never mind the ... rule, a task verb aimed at a rule such as "drop the make check
  rule" or "remove the force-push ban", or "instead of" followed by the rule's own words) in words no negation,
  condition, attempt, guess, plan or retraction takes back ("someone might ask you to forget it", "we'll lift it
  after the release"), in a sentence that names the rule: by one of its words in the four before "rule" or after
  "rule about" ("the push rule", "the DRY: prefix rule", "the rule about pasting the test summary"), by its first
  word, or by two of its words ("the force-push rule and the review rule no longer apply"). One word in common is
  not naming ("ignore the lint warnings when pushing the docs" lifts no force-push rule). A part that names
  nothing may stand next to a sentence that names the rule ("The force-push rule? Forget it."). A question
  withdraws nothing ("is the force-push rule lifted?", "just curious, is it lifted?", "the force-push rule is
  lifted?") unless it is a request ("could you forget the force-push rule?", "are you able to drop the force-push
  rule?", "can we drop the force-push rule?") or ends in a tag that asks for no answer ("lift the force-push rule,
  okay?"; "..., right?" stays a question, and so does a question about the rule's state with a tag, wherever it
  starts: "is the force-push rule lifted, thanks?", "remind me, is it lifted, thanks?", "can the force-push rule
  be lifted, thanks?", "when was the force-push rule lifted, thanks?"; "could we just drop the force-push rule,
  please?" is a request), and a request that asks "if" or "whether" is a question ("can you tell
  me if it is lifted?"). A
  reproach ("you used spaces instead of tabs again") withdraws nothing. A message that names no rule ("forget that
  rule"), an approval ("ok, do it now", "go ahead and push") or a permission ("you may push to main now") retires
  none, whatever the summarizer labels it: a permission is read as a one-off, and a user retires a rule by saying
  it no longer holds. Only the first 8,000 characters of a message are judged.
- A lifted rule is not recorded again from the message that gave it, so a span shown twice cannot bring it back;
  a new message saying it again does.
- A value's name is the summarizer's label and is shown as one, after the value and its source: at most 40
  characters, no colon, no rule word (never, always, must, rule, user, ...) and no credential's name.
- `longhaul_recall` marks the output it returns as data, not instructions.
- Background-task names lose control and format characters, and an id that is not a plain token is dropped.

### T3. Credentials copied into the state, recall or the log

- Learned values are filtered by code before anything is copied (ADR 0005). A value that stood on a
  credential line anywhere in the span, came from a private key's output or from a redacted command, or looks
  random, is never learned. Nor is any value a secret store or secret file printed: a command naming a secret,
  password, passphrase, credential or token (`cat /run/secrets/db_password`, `kubectl get secret`, `aws
  secretsmanager get-secret-value`, `security find-generic-password`), or `pass`/`gopass show`, `op read`/`op item
  get`, `vault kv get`/`vault read`, `bw`/`keyring get`, `ykman oath`, `sops -d` or `--with-decryption`, or a file
  whose path names a credential or is a credential file (`.pgpass`, `.netrc`, `.env*`, `*.pem`, `*.key`, `*.p12`,
  `*.jks`), opened by any tool, pi's `read` included. Its output is a credential however plain it looks (a
  short hex string, a PIN), so every value in it is refused wherever it appears later, as a code-picked or a named
  value. That over-refuses the output of an ordinary `grep -rn token`, which is the safe direction. A value the summarizer names (ADR 0006) must stand verbatim in the turn it cites,
  counting only the user, the replies, call arguments (read line by line), a `!` command and local tools. It
  must have a value's shape (a number, alone or with a unit from a fixed list, a version, a hash of 7 to 12 hex
  digits, a path, a file name with a lowercase extension (a name format may hold `<placeholders>`), a host and port, a date), so most word-like passwords
  are not one, and a run of 13 or more digits never is. It is refused when it holds, or sits inside, any token
  that stood on a credential line anywhere in the span, within 40 characters after a credential named in prose
  ("the sudo pw is ...", "the PIN is ...", "the 2fa code is ..."; there three characters with a digit, a CVV,
  are enough) or as a short-code key whose value holds a digit (`ADMIN_PIN=4821`, `OTP_CODE`, `card_cvv:`,
  `BANKPIN=`, `AdminPIN=`, `adminPin=`, a JSON key such as `"otp_code": "123456"`, escaped quotes included, or a base32 one-time-password
  seed under an OTP key: sixteen to 128 uppercase letters or groups of four, such as `TOTP=` or `totp_key: JBSW YDPE ...`,
  and lowercase too under a key that says seed, secret or key), or in the password part of `user:pass@` or `user/pass@` (in a URL the password may hold `/` and
  `:`, and the user may be empty), from any message and whichever turn it cites: punctuation, a connection string or a flag glued
  to a secret does not hide it. It may hold no space except between a number and its unit, so no
  passphrase in prose is a value, and its name and value together must not read as a credential line. On a
  switchover (the previous compaction was another compactor's), the turns before the span (since the state last
  judged one) count as sources too, by the same rules and as pi showed them: a value that summary records is kept
  only where an earlier turn shows it verbatim (a wrong turn pointer resolves to the newest earlier turn that does;
  inside the span it is the model's to fix), and a message a context edit replaced is a source only in its
  replacement. A credential token anywhere in those turns refuses a value of the span as well, and so does one in
  the original words of an edited message, in a message another extension injected, or on a credential line of the
  summary, which is never a source itself.
- The ledger redacts commands that carry a secret, by the same patterns (a one-time-password seed passed to
  `oathtool -b` (or `-bv`, `--base32`, or a hex or base32 key of 16 or more characters), `ykman oath accounts add`,
  `ykman ... --key`, `sshpass -p`, `htpasswd -b`, `openssl -pass pass:`, `keytool -storepass`, `redis-cli -a`,
  `--pass`, `openssl -k`, `-srckeypass`, a credential flag with a prefix of up to four parts (`--db-password`,
  `--db-root-password`, `--spring.datasource.password`, `--client-secret`, `--new-pin`; not a switch such as
  `--with-token < file`, `--reset-password` or `--max-pin`, not a source such as `-pass env:PW` or `file:`, and not
  a pass number such as `ffmpeg -pass 1`), and an MFA code after
  `--token-code` (`--token-code=` too) or `--authentication-code1`/`2` included). A run whose command carried one is never a recall
  answer, whichever id leads to it.
- `longhaul_recall what=output` replaces each credential line with a marker, by the same filter Learned values
  use: command-style secrets, credential-named keys in aligned tables (`token    hvs.x`), the lines under a YAML
  or JSON credential key, bare JWTs and Vault tokens. Each line is judged whole, on the full output, so no page
  boundary or offset can split a credential into harmless pieces, and a line equal to a credential line anywhere
  in the output is masked too. A private key's body goes with its header.
- Log records carry codes, ids, counts and lengths, never message text. Which fields are ids is decided by the
  field, not by the string's shape: a model-supplied value that looks like an id (`ab123456`) is logged as its
  length. An error keeps its class and the first
  200 characters of its message, with the home directory as `~`. Excerpts appear only with
  `PI_COMPACT_STATE_DEBUG_EXCERPTS=1`, documented as putting pieces of your messages in the log.
- `/longhaul-report` keeps only numbers, booleans and short tokens from the log, drops names and paths, and
  masks URLs, IP addresses and the home directory in an error message.

### T4. Resource exhaustion

A transcript or a model answer can be arbitrarily long, and a compaction runs inside the user's session.

- Every pattern that runs on transcript or answer text is anchored or bounded so it stays linear on long input
  (no catastrophic backtracking), and scans are index-based rather than repeated slices. Where a pattern could
  not be made linear it was replaced by a scan: the fenced-block search in a model answer walks lines with
  `indexOf` (the regex it replaced was cubic on an unclosed fence before a long run of line ends), and trailing
  whitespace is dropped with `trimEnd` or a loop, never `/\s+$/`. A pattern that splits text into words and
  gaps uses disjoint classes for the two: `'` and `-` are both word characters and `\W`, so letting either side
  take them shares a run of hyphens out in exponentially many ways. A test runs every exported lift pattern over
  runs of those characters, so a new pattern with that shape fails CI.
- Only the first 512,000 characters of a model answer are searched for its JSON: 32 characters per token of the
  largest output budget any policy allows (16,000 tokens). Only a provider that ignored `maxTokens` sends more.
- Reading the state back never spreads a transcript's entries into a function call (`Math.max(...)`,
  `push(...)`), whose arguments live on the stack: a branch with hundreds of thousands of events folds.
- The rendered state has a hard cap (`caps.hardChars`) and every section its own; the background-task line is
  bounded on its own because it renders after World's fitted lines.
- `longhaul_recall` answers are capped at 4,000 characters and output pages at 8,000.
- The narrative call is bounded in count (`maxChunks` × (3 + `fixableRetries`): one more call per chunk, only when the
  last answer is first refused because a lift aimed at a rule that was replaced, and one replacement question per
  chunk, only when the settled answer has a rule label that may replace an earlier rule) and, in turns mode, in time.
  A reply to the question can only add an asked target to the kept label's lifts (never drop the rule, change its
  words or name another target), and a question never lifts a rule by itself. The store's gate does not tell a
  pasted withdrawal from the user's own, so the question is raised only by the user's own words: quoted passages
  (straight, curly, German or guillemet marks, inline code), blockquoted lines and code fences are left out before
  deciding to ask, the whole message must pass the gate's check as the gate reads it (so a question is never asked whose
  answer the gate would refuse), and the question's header says quoted or pasted text does not withdraw a rule. The
  marks are a heuristic, not a boundary: a paste with none of them, or with a stray mark that shifts the pairing, is
  indistinguishable from the user's words. That residue is the same paste-and-relay risk the gate already carries for
  a lift the model proposes itself. The masking runs on at most the first 32,000 characters and stays linear.
- The log rotates at 5 MB.

### T5. Egress beyond what the user chose

- No telemetry. The only network calls are the summarizer calls of a compaction.
- The summarizer runs on the session's own model unless routing is configured and allowed for that session's
  provider (ADR 0003).
- A `localOnlyRoots` entry is compared on canonical paths: the deepest existing ancestor is resolved with
  `realpath` and the rest appended, so neither `..` nor a symlink can lead a path out of a local-only root, or
  into one, by spelling.
- `summarizerHeaders` accepts only RFC 9110 field names and single-line values, looks providers up by own key,
  never sends a session id outside pi's id shape, and never overrides a header the request already carries.
- The scorer reads only a transcript directory it is given, and skips sessions under a local-only root (or
  with no absolute directory) unless told otherwise, because its model may be remote.

### T6. Local files

- Configuration is read only from pi's agent dir. There is no project-level config: a repository you clone
  cannot change where your conversation is sent.
- The log and the report are created `0600` in a `0700` directory, tightened on every write, and never written
  through a symlink or into anything that is not a regular file (a FIFO is never blocked on, a device never
  re-moded). An existing directory is tightened only when the current user owns it.
- Windows has no POSIX modes and no `O_NOFOLLOW`: there the log and the report rely on the user profile's
  permissions, and a symlink at the log path is refused by `lstat` before the file is opened, so one planted in
  the moment between the two is followed.

### T7. Untrusted numbers from providers

- A usage field that is not a finite, non-negative number voids the measurement it would feed, and a size
  measurement below a floor derived from the request itself is not believed.
- The scorer's settings are read once, before any model call. A missing `SCORE_SESSIONS` or a bad `SCORE_ARMS`
  list (empty, an unknown arm, `state-unlearned` without `state`) stops the run. The numbers do not: a `SCORE_N`
  that is not a positive integer falls back to 10, and `SCORE_CAPS` entries that are not positive integers are
  dropped, so a typo never replays zero or unbounded compactions. A `SCORE_CAPS` with no valid entry at all
  stops the run; an empty one measures no cap renders. A `SCORE_KEEP_RECENT_TOKENS` that is not a positive whole
  number stops the run too, because a wrong value would replay a different cut from the recorded one.

### T8. Child processes

At every compaction, Longhaul runs git in the session's working directory for the workspace snapshot, and runs
nothing else. The directory can be any checkout, including one whose `.git/config` and `.gitattributes` came
from someone else (an unpacked archive, a shared disk), so the commands must not run anything that repository
configures.

- Five commands, in order, under one 5-second deadline: `rev-parse --abbrev-ref HEAD`, `config --show-scope
  --includes --name-only --get-regexp` over the filter and partial-clone keys, `status --short`, `diff --stat` and `rev-parse --short
  HEAD`. pi's exec spawns them without a shell. A failure or a timeout drops the snapshot; it never fails the
  compaction.
- Every command gets `-c core.hooksPath=/dev/null` (no hooks), `-c core.fsmonitor=false` (no fsmonitor program)
  and `--no-optional-locks` (status never rewrites the index). `diff` adds `--no-ext-diff` and `--no-textconv`.
  `status` and `diff` add `--ignore-submodules=all`, so no submodule's own config is read, and `-- .`, so they
  look only below the session directory.
- A filter driver's `clean` or `process` program runs whenever `status` or `diff` reads a file
  `.gitattributes` assigns it to. Reading config runs nothing, so the second command lists every `filter.*` key
  with its scope before any file is read. A key from the repository's own config (`.git/config`, the files it
  includes, the worktree's `config.worktree`), or one with no scope, skips the snapshot (`repo-filter-driver` in
  the log). A git older than 2.26 has no `--show-scope`; the command fails and the snapshot is skipped.
- In a partial clone, `status` or `diff` that reaches an object the clone does not have fetches it from the
  promisor remote, and the repository's config names that remote's transport (`remote.*.uploadpack`,
  `core.sshCommand`, an `ext::` URL), so the fetch would run the repository's program. The same command lists
  `extensions.partialclone`, `remote.*.promisor` and `remote.*.partialclonefilter`; any of them, in any scope,
  skips the snapshot (`partial-clone` in the log), so a partial clone has no workspace snapshot. Two narrower fixes
  were tried and rejected: `-c protocol.allow=never` is overridden by a repository-local `protocol.<name>.allow`
  (verified with `ext::` and with `core.sshCommand`), and `--no-lazy-fetch` needs git 2.41, newer than the git
  on macOS and on Ubuntu 22.04.
- With `GIT_CONFIG` set in the environment pi was started with, `git config` reads only that file, so the check
  above would not see the repository's config while `status` still uses it. The snapshot is skipped before any
  git runs (`git-config-env` in the log).
- What still runs is the user's own: system and global git config, and the environment pi was started with.
  git-lfs's filter in `~/.gitconfig` keeps working on a repository that uses LFS, because the user installed it
  and it runs the same way in their shell.

## Residual risks

- The credential filter is a pattern filter. For a value code picks, a bare token with no key nearby, used with
  no secret marker, can still be learned. A value the summarizer names must have a value's shape (a number, a
  version, a short hash, a path, a file name, a host and port, a date), so most word-like passwords are not
  one; a password that happens to look like a file name (`hunter.txt`) or a path would pass the shape check. A
  secret of such a shape (an all-digit PIN, a short code) is refused only when it stood on a credential line,
  in the password part of `user:pass@`, or within 40 characters after a credential word on its line (password,
  pw, passphrase, passcode, secret, api key, credentials, pin, otp, 2fa, cvv, login, card number, an auth,
  access, security, verification or one-time code). A secret the user describes in other words ("the door
  opens with 4829") can still be named, and so can one under a key that runs the code word into a lowercase
  word (`userpin=4821`). The short-code key shape errs the other way: `LED_PIN=13 make flash` and
  `SKIP_2FA=1 npm test` read as credentials, so those commands are redacted in the ledger. In a URL, a password that starts with up to five digits and a `/`
  (`scheme://user:1234/x@host`) reads as a port and a path, and is not taken for one. The ledger keeps a command
  whose credential flag reads as a switch or a source: a prefix such as `first` or `second` (`--first-token abc`), a
  value of one or two digits (`--password 42`, `--pin 12`, kept so `ffmpeg -pass 1` is not redacted) or one that
  starts `env:`, `file:` or `fd:`. In the other direction, `openssl` anywhere in a command line makes a later
  `-k` read as its passphrase flag (`openssl s_client ...; curl -k https://host` is redacted).
- A secret store's output taints values for the span it was printed in. A value a secret store printed in an
  earlier span, and first used in this one, can still be learned or named, and so can one from a secret reader
  the list in T3 does not name.
- A value may be a name format with `<placeholders>`. One code picks from tool output is a single file name with
  at most two of them, never a path; one the summarizer names may be a path of them, if it stood verbatim in the
  turn. A tag-like word (`<system-reminder>.md`) can therefore be shown as a value, inside the section that labels
  every value as data.
- The lift check is a check against a wrong proposal, made from words, not proof of what the user meant. It
  refuses the forms listed under T2, not every way of keeping a rule. A part that withdraws one thing in words
  that also fit the rule ("ignore the force-push warnings from the hook", or two rules both about tests) still
  counts as naming it, if the summarizer or the agent is persuaded to propose that lift. Reported speech ("the
  linter says to ignore the force-push ban") reads as a withdrawal. A restatement with no insisting word ("pushing
  to main with --force is a firing offence") and a restatement in other words ("ignore the deploy warnings, but
  don't ship anything on a Friday" beside "never deploy on Friday", "touch the cache" for "purge the caches") do
  not stop the withdrawal beside them: words are matched by their stems, not their meaning, and a word in
  another form counts as the rule's ("ignore the forced-reboot warnings" names "never force-push"). Nor do a keep
  that names a rule by a word this one lacks ("keep the safety rule", read as another rule), a reaffirmation in
  other words ("nothing changes about the force-push rule"), a refusal that is not one of the bare forms above
  ("don't even think about it — force-pushing to main") or a command hyphen-joined to its verb ("as long as you
  never-ever break the force-push rule"), nor a reaffirmation past the first 16 in one sentence. In the other
  direction, some real withdrawals are refused and the rule stays until the user says it again: a counter-command
  with no withdrawal word ("stop pasting the summary line"), a command word standing alone before the withdrawal
  ("Stop — the force-push rule is lifted."), "don't follow the force-push rule any more", a rule noun that is not the subject of an "is unchanged" ("lift
  the force-push rule; everything else in the policy is unchanged"), a bare "drop it" ("the force-push rule? Whatever, drop it": "drop"
  withdraws only aimed at a rule's noun), one that also commands two of the rule's words ("stop pasting the test summary, that rule is lifted.
  Tests must still pass though."), a narrowing that commands the part it keeps ("the tab rule doesn't apply to
  JSON, but always use tabs in TypeScript"; "keep tabs in TypeScript" lifts), one whose negation is an aside ("I
  didn't mean it, forget the push rule"), a suggestion put as a question ("why don't you forget the push rule?"),
  a request that names nothing ("the force-push rule? Are you able to drop it?"), a plan meant for now ("I'm going
  to lift the push rule"), one beside a "still applies" whose rule is not named as a rule ("forget the force-push
  rule, the CI check still applies"), and one past the first 8,000 characters. A lifted rule shows "(lifted by
  uN)" for one compaction before it is retired.
- A labeled rule from a message over 300 characters may be given as part of its message's words. The words must
  be the user's, but a part can read differently from the whole; such a rule shows the message it came from.
- Decisions, dead ends and the narrative are the model's own sentences. Their evidence ids are checked; their
  accuracy is not.
- A configured Summarizer route sends the compacted span to that route's provider. That is its purpose.
- The transcript is stored by pi, unencrypted. Longhaul adds to it; it does not protect it.
- Quote verification accepts any user-role message. That includes text another extension injects as a user
  message (a relayed agent message, an MCP prompt) and anything the user pastes. A rule-shaped sentence in pasted
  or relayed text can therefore be recorded as a correction if the summarizer is persuaded to quote it. On a
  switchover it is the other way round: an earlier user-role message that reads as a standing rule ("from now
  on ...", "in this repo", or a rule word outside a question, a request for now and a withdrawal) is recorded by
  code unless the summarizer marks it a one-off, so relayed text worded as a standing rule needs no quote to land.
  After relaying or pasting third-party text, read the state's "Constraints & corrections" section.
- The config check and `status` are two commands. A process that rewrites `.git/config` between them can
  still plant a driver; such a process can already run anything it likes.
