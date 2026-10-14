---
name: work-items
description: Read and mutate work items in beads, GitHub Issues, or TAPD through one explicit interface. Use to list issue facts without policy filtering, select ready work with explicit options, fetch full task content (including TAPD comments and images), claim, comment, edit labels, close, or TAPD-deliver. Standalone; no AFK loop, watch, or configuration coupling.
---

# Work Items

A thin, standalone adapter over three task sources. It reads facts, applies
selection only when you ask, and exposes each mutation as its own command.

Use `node <skill>/scripts/cli.mjs --help` for options and exit codes.

```powershell
node <skill>/scripts/cli.mjs capabilities --source beads
node <skill>/scripts/cli.mjs list --source beads --workdir <repo-with-.beads>
node <skill>/scripts/cli.mjs list --source beads --workdir <dir> --ready --ready-label ready-for-agent
node <skill>/scripts/cli.mjs get --source tapd --config <config.json> --id 123 --image-dir <cache>
node <skill>/scripts/cli.mjs claim --source gh --workdir <repo> --id 42
node <skill>/scripts/cli.mjs labels --source gh --workdir <repo> --id 42 --add triaged
node <skill>/scripts/cli.mjs close --source beads --workdir <dir> --id afk-1 --comment "done"
```

## Facts before policy

`list` returns every non-closed item it can read and never filters by the AFK
`ready-for-agent` label or by machine labels on its own. `selectReady` (and
`list --ready`) applies only the options you pass: `--ready-label`,
`--exclude-label`, `--assignee`, `--priority-max`, and dependency readiness.
Dependency and priority semantics differ by source:

Selection flags require `--ready`. `--state`/`--limit` are GitHub-only;
`--exclude-machine-labels` is TAPD-only. TAPD has no `--include-blocked`;
GitHub assignee selection is not supported by this adapter. Unsupported CLI
combinations fail before accessing the source.

- **beads**: numeric priority `0` (highest) to `4` (backlog); readiness means no
  open `blocks` dependency; parent items with open children are containers.
- **gh**: priority from `P0`-`P4` labels (default `2`); readiness means every
  `- [ ] #n` task-list reference is checked or points at a closed issue.
- **tapd**: Chinese priority labels (`高`/`中`/`低`); the server filters by
  `owner`, and `--assignee` is required. TAPD has no dependency graph here.

## Reads and mutations are separate

Reads: `list`, `get`. Mutations: `claim`, `comment`, `labels`, `close`,
`deliver`. `get` never writes labels or comments; a blank TAPD requirement is
reported as an error by `claim` without marking it failed.

`claim` returns `claimMode`: `atomic` only for beads (the CLI claim is
exclusive); `gh` and `tapd` are `best-effort` and do not guarantee exclusivity.
The default beads actor is derived from the full workdir identity, not a
basename.

`close` is offered only where the source supports it (beads, gh). TAPD delivery
is `deliver`: it replaces the claim label with the delivered label and adds a
comment. TAPD has no `close`; the command fails before any mutation.

## TAPD notes

All tapd-cli parameters use underscores. Labels are pipe-separated and written
by full replacement with read-back verification, so a separator mistake is an
error rather than a silent new label. Images are downloaded only when
`--image-dir` is explicit; download failures appear in `images.errors` and can
be made fatal. Writing comments requires `commentAuthor` in the config or
`TAPD_NPC_ROLE` in the environment; credentials are never printed or stored.

## Programmatic use

`scripts/index.mjs` exports `createWorkSource(name, options)` and the three
factories. Adapters accept an injected `run(args)` command runner and an
injected `fetch` for image downloads, and the modules export their parsing and
selection helpers. All source code is self-contained (Node built-ins only).
