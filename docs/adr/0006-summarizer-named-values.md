# The summarizer may name values; code keeps one only when it stands in the turn it cites

ADR 0005 let only code write Learned values, and only values of a fact shape (a hash, a version, a number of four
digits or more) that a local tool printed and the session used again. The labeled evaluation showed what that
misses: the values a later turn asks for are often a measurement the assistant reported ("166 ms"), a total
("2768.48"), or a port the user gave ("8090"). None has a fact shape, or none came from a tool. pi's own summary
kept more of them than Longhaul did. At the same time the section filled with code names read from source files
(`lines.append`, `assertEqual`) that the agent can read again.

So the summarizer's answer may now carry `values`: each a name, the value, and the turn it came from. Code keeps a
value only when it stands verbatim in that turn's text: the user's message, the replies, call arguments and local
tools' output, up to the next user message. Only the shapes the section is for: a number with or without its unit,
a version, a short hash, a path or file name (a format the user chose may hold `<placeholders>`, as in
`<source-basename>-YYYYMMDD-HHMMSS.tar.gz`), a host and port, a date. Nothing that stood on a credential line
anywhere in the span, nothing that looks random. A misquote is a fixable error and costs a retry.
The name is a short label (40 characters, no colon, no rule word, no credential's name), rendered after the value
and its source as the summarizer's: `- 166 ms (u10; the first benchmark time)`. Code still picks values as before, but
no longer identifiers or dotted names without a directory, unless a `<placeholder>` makes the name a name format: one
file name with at most two, never a path (tool output can be a fetched page).

## Considered

- Widening the code's fact shapes to short numbers with units. Rejected: every "16 ms" in every test run would be
  picked, and nothing says which one a later turn needs.
- Letting the summarizer write values unverified. Rejected: an invented value is worse than a missing one.

## Consequences

The name is the summarizer's words and its meaning is not verified, only its shape; the value is. A pre-release
security review reproduced a password reaching the state four ways through the first version of this path
(wrapped in words, cited from a later turn, inside a written file's arguments, a passphrase in prose); each is now
a test. A second review found more phrasings ("my sudo pw is ...", a password on the line after its key,
one-line JSON); rather than chase each, a named value was limited to the shapes above, which no word-like
password has. A value the summarizer does not name is
still lost unless code picks it. Values from a web page or another agent stay out, as in ADR 0005.
