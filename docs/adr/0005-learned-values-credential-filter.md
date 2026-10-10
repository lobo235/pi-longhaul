# Learned values are copied by code, from local tools only, behind a credential filter

The state's *Learned values* section carries values the session learned from tool output and went on to use
(a hash, a path, a version, an id), verbatim, with where each came from, because a summary paraphrases
exactly these. That section is re-sent on every request and persisted on the transcript, so a credential
copied into it would spread to every later request and every copy of the session. Therefore code writes the
section, never the model. Only local tools teach (bash, read, grep, find, ls), never a web page, an MCP server
or another agent, whose output outlives the context that showed where it came from. A value is never learned
when it stood on a credential line anywhere in the span: a key or a token in output, prose or a call argument;
a private key's output; a command the ledger redacted. Nor is a value that looks random: a long mixed-case
identifier, or hex longer than a short hash except from one plain `git` command.

## Consequences

This is a pattern filter. A bare token with no key nearby, used with no secret marker, can still pass; the
README says so, and `docs/security.md` treats it as residual risk. The filter also drops some legitimate
random-looking ids, which is the cheaper error.

The summarizer may now also name values, checked against the turn they cite: see ADR 0006.
