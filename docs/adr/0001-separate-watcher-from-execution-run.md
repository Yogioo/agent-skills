# Separate the watcher from the execution run

Status: accepted

Long-lived polling belongs to a new `afk-watch` skill, while `afk-run` remains a bounded batch executor. The watcher starts serialized execution runs and owns polling, backoff, process lifecycle, and watcher status; task-source adapters own ready-item selection and claim semantics. This preserves existing `afk-run` behavior, supports beads, GitHub, TAPD, and future sources without tracker-specific rules in the watcher, and lets strict deployments require `atomic` claim mode while permitting explicitly reported `best-effort` sources by default.

## Consequences

- A local execution environment is mutually exclusive, but a task source's remote `in-progress` state does not prevent other ready work from being processed.
- Each source must report whether claiming is `atomic`, `best-effort`, or unsupported.
- The Windows entry point is a foreground BAT launcher; service registration is left to the host process manager.
