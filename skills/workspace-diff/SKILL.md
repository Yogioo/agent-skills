---
name: workspace-diff
description: Compare file contents in a directory before and after a task using saved fingerprints. Use to identify added, modified, and deleted files across Git commits or in ordinary document folders. For a Git revision diff, use Git directly.
---

# Workspace Diff

Capture the same directory before and after work, then report its content changes.
Requires Node.js; Git is optional. No AFK configuration is needed.

Use `node <skill>/scripts/cli.mjs --help` for options and exit codes.

```powershell
node <skill>/scripts/cli.mjs snapshot --workdir <directory> --out <cache>/before.json
# Perform the requested work.
node <skill>/scripts/cli.mjs snapshot --workdir <directory> --out <cache>/after.json
node <skill>/scripts/cli.mjs compare --before <cache>/before.json --after <cache>/after.json
```

Choose new snapshot filenames in an existing directory outside the captured directory.
Use identical root, mode and exclusions for both captures. A snapshot contains paths
and fingerprints, not file contents; it cannot restore files. If the before snapshot
is missing, changes made earlier cannot be reconstructed by this tool.
Capture while the directory is idle; scanning is not an atomic filesystem snapshot.

Git mode includes tracked files and nonignored untracked files, comparing Git-normalized
contents (including line-ending conversion). Use `--mode walk` for raw file bytes.
Unsupported Git filters or index states fail explicitly; walk mode scans a different
scope and requires a new pair of snapshots. In ordinary directories,
use repeatable `--skip <name>` for generated folders; only version-control metadata is
excluded by default. Changes are content-only: a rename appears as deletion plus addition;
file permission changes are outside the result. Capture errors require investigation,
not an empty change report.

Completion: read the successful compare JSON and report `added`, `changed`, and `removed`.
An empty result means no observed content change within that scope, not that the task
has passed tests or met its acceptance criteria.

For programmatic composition, `scripts/workspace.mjs` exports `captureWorkspace()`
and `diff()`. It is self-contained and does not import the legacy execution skill.
