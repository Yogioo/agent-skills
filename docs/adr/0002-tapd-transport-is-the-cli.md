# Drive the TAPD task source through the tapd-cli binary

Status: accepted

The TAPD adapter shells out to the installed `tapd-cli` binary and parses its JSON, instead of calling the TAPD OpenAPI directly or importing anything from the `tapd-cli` skill. It depends only on that binary's command shape and output, which keeps authentication, pagination, and entity mapping upstream and leaves the skill as documentation.

## Considered Options

- **Direct OpenAPI calls.** Rejected: re-implements token handling, pagination, error codes, and field mapping that `tapd-cli` already maintains.
- **Depending on the `tapd-cli` skill directory.** Rejected: that skill is installed and versioned independently of this repo, so a path dependency breaks whenever it moves.
- **Vendoring the CLI.** Rejected: same duplication, plus an upgrade burden.

## Consequences

- Every TAPD read and write is a subprocess. A missing `tapd-cli` is a startup error, never an empty ready list — a silent empty list makes the watcher idle for a whole session.
- Parameter names must use underscores. `tapd-cli` silently drops hyphenated names, so `entry-id=X` returns unfiltered results instead of an error.
- Multi-value fields need their real separator. `label` is `|`-separated; a comma-joined write does not error, it makes TAPD create a label whose name is `a,b`. Every label write is therefore verified by re-reading the story, because only the read-back can tell the two apart.
- Neither the `tapd-cli` help text nor its skill documentation is authoritative; each command gets verified against the live API before it is relied on.
