# The watcher owns a status page that outlives execution runs

Status: accepted

The watcher starts one status page when it starts and stops that page when it exits, including while polling or backing off. An execution run is a section of that page, not a reason to start or kill the page. `--no-serve` still means there is no page. ADR-0001 gave the watcher polling, backoff, and watcher status, but the HTTP page stayed tied to each execution run; this decision changes that.

## Consequences

- The page shows the watcher phase: `polling`, `backing-off`, `running`, `stopping`, or `stopped`. After an idle or claim-skipped event the phase is `polling`. There is no claiming phase.
- The page is the existing execution-run page, extended to follow the watcher. It is not a second server.
- Ready, in-progress, and blocked work items on the page come from the poll the watcher already made. The page does not query the task source. Starting an execution run still depends only on a ready work item.
- That poll is `describeBlocked()` when the task source provides it. The watcher uses its `ready` list to decide whether to start work. `listReady()` alone is the fallback when `describeBlocked` is missing.
- The last successful poll is written as `pool.json` in the current watch session directory. The watcher registry stays small: phase, pids, and the current execution-run pointer.
- While the watcher phase is `running`, those three columns come from the execution run. While it is `polling` or `backing-off`, they come from the last successful poll snapshot, including its age.
- Execution runs from earlier watch sessions on the same workdir are part of the page's history. The default view is the current watch session plus the most recent finished execution run. Older runs stay behind a filter.
- Console visibility (URL print and phase lines) ships with the resident page, not as a separate first release.
- The first delivery is slices 1–4: console visibility, resident page, current execution-run section, and the work-item pool. Cross-session history (slice 5) follows. For that history, each `run_start` / `run_end` event must record the execution-run directory (and exit code on end) so the page can list past runs from watch-session events.
- While no execution run is active, the execution-run section is empty.
- Stopping the watcher closes the page.
