# The watcher runs detached by default

Status: accepted

`afk-watch` is started through `scripts/start-background.mjs`, which spawns `watch.mjs` detached, sends that process's output to a per-workdir log file, and answers each call with one JSON line. The foreground `watch.mjs` entry stays for reading console lines while debugging. This replaces afk-watch-design.md's "first implementation is a foreground process" — a watcher that only lives in a terminal makes the developer its process supervisor.

## Considered Options

- **Windows service or scheduled task.** Rejected for now: it adds a machine-level install step and a second way to start the same watcher, while a detached process plus the existing single-instance registry already removes the terminal.
- **Foreground, with a second terminal as the documented practice.** Rejected: the terminal is the cost being removed.

## Consequences

- Status comes from the watcher registry instead of a terminal, so a caller reads phase, pids, dashboard URL, and pool counts without owning the process.
- Starting, asking for status, and stopping are three modes of one entry point, each with its own exit code; `start-background.mjs --help` is authoritative for the code list and the JSON fields.
- The startup banner survives only in the detached log, so `--status` reports the log path the URL can be recovered from.
- The single-instance registry and the stop file keep their meaning, and the launcher owns no processes: claiming, stopping, and cleanup stay in `watch.mjs`.
