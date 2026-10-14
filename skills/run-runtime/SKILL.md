---
name: run-runtime
description: Standalone local run support - ownership-based workdir leases, append-only progress JSONL with a read-only viewer, layered JSON config and project identity, owned child-process handles, and Git baseline checkpoints with explicit restore. Independent of AFK; no task selection, acceptance, retry or notification.
---

# run-runtime

Reusable mechanics for running work locally. It does not choose tasks, decide
acceptance, retry, notify, or read AFK configuration. Every path is explicit.

Requires Node.js. Use `node <skill>/scripts/cli.mjs --help` for the full command
list and exit codes. A successful command prints one JSON value to stdout;
diagnostics go to stderr; invalid arguments or malformed records exit 2 and
operational failures exit 1.

## CLI

```powershell
# Explicit workdir lease (registry dir + canonical workdir)
node <skill>/scripts/cli.mjs lease acquire  --registry-dir <dir> --workdir <dir> --pid <LIVE_PID> [--label L] [--steal-stale]
node <skill>/scripts/cli.mjs lease status   --registry-dir <dir> --workdir <dir> [--pid N]
node <skill>/scripts/cli.mjs lease release  --registry-dir <dir> --workdir <dir> --token <token>
node <skill>/scripts/cli.mjs lease recover  --registry-dir <dir> --workdir <dir>

# Progress JSONL
node <skill>/scripts/cli.mjs progress append --file <events.jsonl> --event run_start [--level N] [--data '{"k":1}']
node <skill>/scripts/cli.mjs progress read   --file <events.jsonl> [--after N]
node <skill>/scripts/cli.mjs serve           --events-file <events.jsonl> [--host 127.0.0.1] [--port 0]

# Layered config and identity
node <skill>/scripts/cli.mjs config merge    --file a.json [--file b.json] [--output merged.json] [--show-secrets]
node <skill>/scripts/cli.mjs config identity --workdir <dir>

# Git checkpoint / explicit restore (state must be outside the worktree)
node <skill>/scripts/cli.mjs checkpoint create  --workdir <dir> --state <state.json> [--exclude PATH ...]
node <skill>/scripts/cli.mjs checkpoint status  --state <state.json> [--workdir <dir>]
node <skill>/scripts/cli.mjs checkpoint restore --state <state.json> [--workdir <dir>] [--clean-untracked] [--exclude PATH ...]
```

## Behaviour and boundaries

Run explicit stale-lock recovery with other launchers stopped. It is a maintenance
operation; normal acquisition never clears a busy mutex, and known live owners
are refused during recovery.

- **Lease.** Stored as `<hash-of-canonical-workdir>.json` under the explicit
  registry dir. Acquisition and release are serialised by an on-disk mutex whose
  owner is recorded, so a crashed mutex can be cleared explicitly while a live
  owner's mutex is never broken. A live owner (token + PID, cross-host aware) is
  never replaced. The CLI requires an explicit `--pid` of a live owner process
  (the CLI itself is short-lived); the programmatic API defaults to the caller
  PID. An invalid or dead owner PID is never treated as safely stale: a record
  with a missing/bad token, PID or host is malformed and requires the explicit
  `lease recover`. `acquire` fails with `reason: "stale"` for a dead owner unless
  `--steal-stale` is given. `release` always requires the owner token; there is
  no force override. No port inspection and no PID killing anywhere in this
  skill.
- **Progress.** Records are `{ t, level, event, ...callerFields }`; extra fields
  are supplied through `data`, which cannot override `t`, `level`, or `event`. Reads report
  malformed lines instead of dropping them. The viewer is read-only, binds to
  loopback and renders with `textContent` using no external resources.
- **Config.** Caller-supplied files merge in argument order (objects deep-merge,
  arrays/scalars replace). No implicit sections, no home lookup. Unreadable or
  malformed layers are listed and exit 2. `config merge` redacts secret-looking
  keys unless `--show-secrets`; `--output` writes the raw merged JSON and prints
  only a summary. `config identity` returns the canonical workdir hash and, for
  Git, separates the worktree (`gitDir`) from the shared `commonDir`/`repoHash`.
- **Checkpoint.** Requires an existing Git worktree with a clean status and a
  commit; never runs `git init`. The state file must be new, must live outside
  the target worktree (junction aliases are canonicalised), and records root,
  common repository identity (`commonDir` + `repoHash`), HEAD, ownership and
  caller-supplied exclusions. Git always runs with `GIT_DIR`, `GIT_WORK_TREE`,
  `GIT_INDEX_FILE` and `GIT_COMMON_DIR` removed so inherited environment cannot
  redirect a destructive command. Restore refuses a root, repository or HEAD
  mismatch (so concurrent commits are not wiped), resets tracked files, and only
  removes untracked files with `--clean-untracked` (honouring `--exclude`).
  Before resetting it refuses when an untracked or ignored path obstructs a
  tracked path, because `git reset --hard` would delete that path regardless of
  exclusions or ignore rules. Rollback covers tracked contents in the worktree,
  plus untracked files when requested; it does not restore ignored files,
  external paths, Git history or external side effects.
- **Child processes.** `startOwnedProcess` returns a handle that can cancel
  exactly its own process tree or be awaited. `cancel()` is asynchronous: it
  waits for the owned child to terminate, escalates only that tree if a graceful
  signal is not enough, and preserves output flush. An `AbortSignal` is accepted;
  a pre-aborted signal never starts a process. There is no kill-by-PID API.

Programmatic API: `scripts/index.mjs` re-exports everything. Notable entry
points: `acquireLease`/`statusLease`/`releaseLease`/`recoverLease` (plus
`validateLeaseRecord` and `breakStaleLock`), `appendEvent`/`readEvents`/
`createViewerServer`, `mergeConfigFiles`/`projectIdentity`/`redactSecrets`,
`createCheckpoint`/`restoreCheckpoint`/`findResetObstructions`, and
`startOwnedProcess`.
