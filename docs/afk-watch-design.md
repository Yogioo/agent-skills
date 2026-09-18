# afk-watch implementation design

`afk-watch` is a foreground supervisor around `afk-run`. It polls a configured task source, starts one bounded execution run when ready work exists, waits while that child is active, and resumes polling after the child exits.

## Responsibilities

- `afk-watch`: polling, idle wait, error backoff, child-process lifecycle, stop handling, watcher registry, watcher events, and claim-mode enforcement.
- `afk-run`: one bounded batch of work items, task execution, rollback, task-source state transitions, and execution reports.
- Task-source adapter: ready-item selection, task details, claim operation, completion/failure updates, and optional stale recovery.

The watcher must not treat remote `in-progress` items as a local process lock. It only waits when its own execution-run child is alive. A remote in-progress item is simply excluded by the task source while other ready items remain eligible.

## Task-source claim contract

The adapter exposes:

```text
listReady() -> [{ id, title, priority }]
tryClaim(id) -> { status: claimed | already-claimed | unsupported, claimMode }
getDetail(id)
markDone(id, result)
markFailed(id, note)
recoverStale?(thresholdSec, now)
```

`tryClaim` is the boundary for beads, GitHub, TAPD, and future sources. The watcher accepts `best-effort` by default and exits before work begins when `--require-atomic-claim` is set and the source cannot provide an atomic claim. A claim race returns `already-claimed`; the current run is skipped and the next poll continues.

## Process and state

Planned files:

```text
skills/afk-watch/
  SKILL.md
  references/config.md
  scripts/watch.mjs
  scripts/watch-state.mjs
  start-watch.bat
```

Per-project config lives in the shared `~/.afk/config.json`, under the `task` and `watch` sections (project override: `~/.afk/<label>_<uid>/config.json`; created by afk-init `scripts/init-project.mjs`). UID is derived from the workdir absolute path.

The watcher registry is separate from the existing `afk-run` registry and is keyed by workdir. It records the watcher PID, child PID, run directory, state, claim mode, and timestamps. A watcher stops only the child and dashboard processes it owns. Historical watcher events are append-only under a `watch-run-*` directory; execution-run reports remain owned by `afk-run`.

## Lifecycle

1. Validate the workdir and local cleanliness.
2. Claim the watcher instance for the workdir.
3. Poll `listReady()`.
4. If the list is empty, wait for `pollInterval`.
5. If ready work exists, start `afk-run` with the configured batch limit and inherited source settings.
6. Forward child output and record child exit status.
7. Reset the idle backoff after a successful source query or completed run; exponentially back off source errors up to the configured maximum.
8. On `Ctrl+C`, stop file, or explicit stop command, terminate the owned child, stop the owned dashboard, write a final event, and release the watcher registry.

The first implementation is a foreground process. Windows users can run `start-watch.bat`; the BAT file is ASCII-only and forwards all arguments to `node scripts/watch.mjs`.

## Open implementation dependencies

- Add `tryClaim` to existing adapters without changing the current `afk-run` batch semantics.
- Define TAPD adapter field mapping as configuration; do not assume a universal TAPD status or owner field.
- Reuse existing dashboard serving code only after separating dashboard ownership from execution-run ownership.
