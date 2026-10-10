@AGENTS.md

## Integration Surface & Consumers

What Longhaul exposes, and who depends on it. The README's *Versioning* section is the SemVer contract; this
list adds who reads each part, so a change can update them in the same piece of work.

**Exposes**

- The npm package `pi-longhaul`: the pi extension entry `src/index.ts` (`package.json` `pi.extensions`) and the
  shipped files in `package.json` `files`. The TypeScript modules are not an importable API.
- `longhaul.json` in pi's agent dir (keys in `config.example.json`). `summarizerHeaders` has the same shape as
  pi-session-affinity's `headers`, on purpose.
- Environment variables `PI_COMPACTOR`, `PI_COMPACT_STATE_*` and `PI_COMPACTOR_STATE_LOADED` (set by Longhaul
  while loaded, so another compactor extension can defer to it).
- The `/longhaul-report` command, the tools `longhaul_remember` and `longhaul_recall` and their parameters.
- Persisted transcript entries: `compaction-state.event`, `compaction-state.span`, `compaction-state.line` and
  the compaction entry's details. An older transcript must still resume.
- The log's event types (`logs/compaction-state.jsonl` by default).
- `pi-compat.json`: the pi release lines Longhaul is verified against.

**Consumers**

- pi users who install the package, and their transcripts (resumed across Longhaul versions).
- Tools that read pi transcripts and filter custom entries by type: they must keep the entry types above.
- pi-session-affinity's README points to `summarizerHeaders` for compaction calls, and documents the same
  header shape; renaming the key or changing its shape is a change there too.
- Another compactor extension that reads `PI_COMPACTOR` / `PI_COMPACTOR_STATE_LOADED` to stand down.
- The maintainer's private operations repo carries an in-tree copy of this extension and a pre-push guard for
  this clone; a contract change is also a change there.
- Docs that describe the surface: README (*Configuration*, *Tools*, *Versioning*), `docs/how-it-works.md`,
  `docs/security.md`, `docs/evaluation.md`, `docs/setup-with-an-agent.md`, `CONTEXT.md`, `CHANGELOG.md`.
