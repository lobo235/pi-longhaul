# Security policy

## Reporting a vulnerability

Report it privately through GitHub: the repository's **Security** tab, then **Report a vulnerability**. Do not
open a public issue, discussion or pull request for it.

Include the Longhaul and pi versions, what an attacker controls, and what they gain. A minimal synthetic
transcript or input that shows it is ideal. **Do not send real transcripts, logs or keys**; if the problem only
shows on real data, describe its shape instead.

You should get an acknowledgement within 7 days. A fix is released as a patch version, and the advisory is
published once a fixed version is available, crediting you unless you prefer otherwise.

## Supported versions

The latest release. Before 1.0.0, the latest release candidate.

## Scope

In scope: anything where Longhaul itself turns untrusted input into harm. The threats are listed in
[docs/security.md](docs/security.md). For example:

- text from tool output, a web page or another agent becoming a standing rule in the Session state (T2);
- a credential reaching the Session state, a Learned value, a `longhaul_recall` answer, the log or the
  `/longhaul-report` file (T3);
- a transcript or model answer that hangs or crashes a compaction (T4);
- the conversation reaching a model other than the one the user configured (T5);
- the log or report written somewhere other than intended, or readable by other users (T6).

Out of scope: pi itself and other extensions (report those to their projects), a model provider's handling of
what it is sent, a user who configures a route to a provider on purpose, and the residual risks listed at the
end of docs/security.md.
