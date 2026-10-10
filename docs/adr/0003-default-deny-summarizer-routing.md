# The summarizer runs on the session's own model unless routing is allowed

A compaction sends the whole compacted span (user messages, tool output, file contents) to whichever model
writes the diff. By default that is the session's own model, so a compaction reaches nobody the session was
not already talking to. A different model (a *Summarizer route*) is used only when all of these hold: a route
is configured, the session's provider is named in `routeProviders` by exact name, and the session's directory
is not under a `localOnlyRoots` entry. The environment variable `PI_COMPACT_STATE_MODEL` overrides all of it
for one invocation, because a person typing it is choosing on purpose.

## Considered options

- **A shipped default route** to a cheap hosted model. It would make compactions cheaper out of the box and
  send every user's conversation to a provider they never picked.
- **A provider pattern** instead of exact names. A pattern matches providers the user has not met yet;
  an exact list cannot.

## Consequences

Out of the box nothing is routed, so a session on an expensive model also summarizes on it. The README's
cost section shows how to route deliberately.
