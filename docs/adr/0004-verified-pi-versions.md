# Verify each pi release line, warn on others, never refuse

Longhaul depends on parts of pi that are not a stable API: the compaction preparation and its budget
arithmetic, the shape of the serialized conversation and of the bash tool's result, and the payloads of the
extension events it handles. (Only the scorer imports a module below pi's package root.) The pi versions it has
been verified against are listed in `pi-compat.json`. On a verified version, or another patch release of a
verified `major.minor` line, it runs silently. On any other pi it warns once per session and still runs. A
compaction it cannot make throws inside the hook, the hook returns nothing, and pi's own compaction does the
work, so a session is never left without one. A nightly CI job runs the tests and a real compaction against
the newest pi on npm and opens an issue when that fails.

## Considered options

- **Refuse on an unverified pi.** Safe for Longhaul, hostile to users: every pi update would switch it off
  until a release caught up.
- **No gate.** Breakage would show up as quietly worse compactions rather than as a warning.
