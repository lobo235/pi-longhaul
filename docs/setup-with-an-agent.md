# Setting up Longhaul: instructions for an agent

You are a coding agent, and the person you work with asked you to set up **Longhaul** (npm `pi-longhaul`),
a state compactor for the pi coding agent. Follow these instructions in order. They are written for you, not
for the person; summarize them for the person only when that helps.

## Ground rules

1. **Ask one question at a time.** Each question comes with your recommendation and the reason for it, in one
   or two sentences. Wait for the answer before the next question.
2. **Read-only until a yes.** Detect first. Before you write or install anything, show the exact command or
   the exact diff, and wait for an explicit yes.
3. **Back up before you edit.** Before changing an existing file, copy it to `<file>.bak-<YYYYMMDDHHMMSS>` next
   to it, and say where the copy is.
4. **Never read secrets or conversations.** Do not open `auth.json`, any transcript under `sessions/`, or
   `.env` files. Never print an API key or the value of an environment variable that holds one. From
   `models.json` read provider names, API types and model ids only (the `jq` below does exactly that).
5. **Finish with a summary**: what you changed, where the backups are, how to undo each change, and anything
   you recommend but did not do.

Below, `AGENT_DIR` means `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}`.

## Step 1: Detect (read-only)

Run these and keep the results. Do not ask anything yet.

```bash
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
pi --version
pi list                                   # installed packages; is pi-longhaul among them?
ls "$AGENT_DIR/longhaul.json" 2>/dev/null && cat "$AGENT_DIR/longhaul.json"
jq '{defaultProvider, defaultModel, defaultThinkingLevel}' "$AGENT_DIR/settings.json" 2>/dev/null
jq '.providers // {} | to_entries | map({provider: .key, api: .value.api, models: [.value.models[]?.id]})' \
  "$AGENT_DIR/models.json" 2>/dev/null
```

Then work out:

- **pi version.** Compare `pi --version` with the versions in Longhaul's `pi-compat.json` (in the installed
  package, see below, or https://github.com/lobo235/pi-longhaul/blob/main/pi-compat.json). Same `major.minor` as
  a listed version: fine. Otherwise Longhaul still runs but warns once per session; tell the person.
- **Other compactors.** pi runs every installed `session_before_compact` handler on every compaction; each
  pays for its own model call, and the last answer wins by load order. Search the installed extensions for one:

  ```bash
  grep -RlI --include='*.ts' --include='*.js' --exclude-dir=node_modules 'session_before_compact' \
    "$AGENT_DIR"/npm/node_modules/*/ "$AGENT_DIR/extensions/" "$AGENT_DIR/git/" \
    .pi/npm/node_modules/*/ .pi/extensions/ .pi/git/ 2>/dev/null | grep -v '/pi-longhaul/'
  ```

  The `node_modules/*/` globs name each package, because `--exclude-dir=node_modules` would otherwise skip the
  starting directory itself; `-R` follows the symlinks `extensions/` often holds. A path that does not exist is
  skipped. A package installed from a local path is not under any of these: also search
  every local directory listed in `packages` in `$AGENT_DIR/settings.json` and `.pi/settings.json`.

  A hit handles that event, which does not yet make it a compactor: open the handler and check whether it can
  return a `compaction` result. Only one that can is a competing compactor. Name its package.
- **pi-goal.** If `pi list` shows pi-goal, Longhaul works with it, but see the README's *Known issues*: on
  pi-goal 0.54.9 or earlier, a prompt-cache miss after each compaction (updating pi-goal fixes it); on any
  version, one miss after a compaction in the middle of a goal run. Mention it; nothing else needs changing.
- **The default model.** Its provider, API type, and whether it can turn reasoning off. A `models.json` model
  whose `thinkingLevelMap.off` is `null` cannot; for a built-in model, say you do not know rather than guess.
- **The installed package directory**, if installed: `$AGENT_DIR/npm/node_modules/pi-longhaul` (installed for
  the user) or `.pi/npm/node_modules/pi-longhaul` (installed for this project).

Tell the person what you found in a few lines before asking anything.

## Step 2: Questions (only the ones that apply)

Skip every question the detection made irrelevant. Recommended answers are marked.

1. **Not installed yet:** "Install Longhaul for your user with `pi install npm:pi-longhaul`?" Recommend yes,
   for the user rather than one project, so every session gets it. Do not run it until they say yes.
2. **A competing compactor was found:** "Two compactors both run on every compaction and both cost a model
   call. Which should compact?" Options: remove the other one (`pi remove <its source>`, recommended if they
   installed Longhaul to replace it); keep it and turn Longhaul off (`PI_COMPACTOR=pi` in their shell
   profile); or keep both (not recommended: double cost, and which one wins depends on load order).
3. **The default model is expensive, or cannot turn its reasoning off:** "Should compactions use a cheaper
   model?" If yes, ask which model (it must appear in `pi --list-models`). Explain that a compaction sends the
   compacted part of the conversation to that model. Then ask which providers' sessions may use it
   (`routeProviders`, exact names). Recommend only the providers they actually use with this route in mind;
   a session on any other provider keeps summarizing on its own model.
4. **Only if they chose a route in question 3:** "Is there any project whose conversations must never be sent
   to that model?" Each answer is an absolute path or `~/...` for `localOnlyRoots`. Recommend listing
   anything under an NDA or with credentials in its working files.
5. **The default model's API is not `openai-completions`, and it is a reasoning model:** "Leave old reasoning
   in the messages kept after a compaction?" Recommend leaving `keptWindowThinking` unset (it keeps reasoning
   on APIs where removing it is not verified). Suggest `"strip"` only if they know their model re-reads old
   reasoning at a cost, and say that an in-progress tool turn is always left whole.
6. **The default model is a small local model** (roughly under 14B parameters): "Try the turns mode?"
   Recommend the default (`single`) first, and `"narrativeMode": "turns"` only if compactions log `fallback`
   or a narrative-less pass often; it makes more calls.

Do not ask about the other keys. Defaults are deliberate.

## Step 3: Write `longhaul.json`

Build the file from the answers. Include only keys whose answer differs from the default. If none do, write
nothing and say so. If the file exists, back it up and merge into it rather than replacing other keys. Show the
diff, wait for a yes, write it, then check it parses:

```bash
jq . "$AGENT_DIR/longhaul.json"
```

## Step 4: Load check (no model call)

```bash
pi --list-models > /dev/null
tail -n 1 "$AGENT_DIR/logs/compaction-state.jsonl"
```

The last record must be `"event":"extension-loaded"` with a `piVersion`. If the log does not exist,
`PI_COMPACT_STATE_DEBUG` may point elsewhere or turn it off; check `echo "${PI_COMPACT_STATE_DEBUG-unset}"`.
If `piVersionVerified` is `false`, the pi version is not verified: say so.

## Step 5: Live check (optional, one model call)

Ask first: "Run one real compaction on a small synthetic session (invented text, nothing of yours) to confirm
it works with your model? It costs one model call, two if the answer needs a retry." Only on a yes:

```bash
PKG="$AGENT_DIR/npm/node_modules/pi-longhaul"    # or .pi/npm/node_modules/pi-longhaul
CHECK="$(mktemp -d "${TMPDIR:-/tmp}/longhaul-check.XXXXXX")"
jq -c --arg dir "$CHECK" 'if .type == "session" then .cwd = $dir else . end' \
  "$PKG/fixtures/setup-check-session.jsonl" > "$CHECK/session.jsonl"
cd "$CHECK" && { echo '{"id":"check","type":"compact"}'; sleep 120; } \
  | timeout 130 pi --mode rpc --session "$CHECK/session.jsonl" \
  | jq -c 'select(.type == "response")' | head -n 1
tail -n 3 "$AGENT_DIR/logs/compaction-state.jsonl"
```

Add `--model <provider/id>` to the `pi` command to test a model other than the default. The response line
must show `"success":true`, and the log must have a `"event":"compaction"` record. A `"event":"fallback"`
record means Longhaul failed and pi's own compaction took over: run `/longhaul-report` in a pi session and
offer to help them open an issue with it. The scratch directory is safe to leave; tell them where it is.

## Step 6: Summary

Tell the person what changed, where the backups are, and how to undo each change:

- remove Longhaul: `pi remove npm:pi-longhaul`;
- turn it off for one shell: `PI_COMPACTOR=pi`;
- restore a backup: copy the `.bak-…` file back.

Mention that `/longhaul-report` produces a privacy-safe digest for bug reports, and that the README's
*Configuration* section explains every key you did not touch.
