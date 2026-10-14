---
name: requirement-store
description: Persist requirement records (owner, session reference, linked work items, heartbeat, close state) in an explicit directory and look them up by id or work item. Use inside requirement/checkin workflows as a plain store. Standalone; no cwd project inference, no session wake-up, no checkin orchestration.
---

# Requirement Store

A durable record per requirement under an explicit `--dir`. A requirement
records its project key, workdir, runner, an opaque session reference, linked
work items, a heartbeat, and a close timestamp. The store only writes and reads
these records; it never resolves a project from the current directory, wakes a
session, or runs checkin.

Use `node <skill>/scripts/store.mjs --help` for options and exit codes.

```powershell
node <skill>/scripts/store.mjs create --dir <store> --project <key> --title "评估波次" --workdir <dir> [--runner pi] [--ref <sessionRef>] [--source tapd --item 1111]... [--allow-shared]
node <skill>/scripts/store.mjs get --dir <store> --id <id>
node <skill>/scripts/store.mjs list --dir <store> [--project <key>] [--state open|closed|all]
node <skill>/scripts/store.mjs link --dir <store> --id <id> --source tapd --item 1111 [--allow-shared]
node <skill>/scripts/store.mjs set-session --dir <store> --id <id> --runner pi --ref <sessionRef>
node <skill>/scripts/store.mjs heartbeat --dir <store> --id <id>
node <skill>/scripts/store.mjs close --dir <store> --id <id>
node <skill>/scripts/store.mjs where --dir <store> --source tapd --item 1111
```

## Contract

- `projectKey` is explicit caller-supplied metadata; nothing is inferred from
  the cwd or any config file. Records retain `id`, `title`, `workdir`,
  `projectKey`, `runner`, `sessionRef`, `workItems`, `createdAt`, `updatedAt`,
  `heartbeatAt`, `closedAt`.
- Requirement ids and work item references are validated; path traversal is
  rejected. A duplicate explicit id is an error and never overwrites a record.
- `link` deduplicates within a record. Linking a work item that another record
  already owns is an error unless `--allow-shared` is passed, so ownership is
  never silently reassigned. `create` enforces the same policy for initial
  `workItems` and accepts `--allow-shared` as the explicit escape hatch.
- Ownership checks and work-item reverse lookup read every record strictly: a
  corrupt record is reported as an error instead of being skipped, so
  uniqueness is never claimed over partial data. `list` still surfaces corrupt
  `.json` files in `invalid`.
- `where` returns every matching record and sets `ambiguous: true` when more
  than one requirement claims the work item. It never picks an owner for you.
- `close` only marks the local record (`closedAt`); it does not touch external
  work items. Repeated closes keep the first timestamp.
- Heartbeat freshness is exposed as a query (`isHeartbeatFresh`). No automatic
  wake, checkin orchestration, or owner inference is performed.
- Writes are atomic (unique temp file + rename). Mutations hold a per-store
  writer lock (`.write.lock`) across the full read-modify-write, including
  ownership checks; a lock held by a live process produces an explicit busy
  failure. Acquisition never reclaims an existing lock; after a crash, stop all
  writers before inspecting and removing a leftover `.write.lock`. `updatedAt`
  strictly increases on every real mutation and never moves backwards even
  when the clock does. Read-only commands take no lock.

## Programmatic use

`scripts/store.mjs` exports `createRequirement`, `getRequirement`,
`listRequirements`, `linkWorkItems`, `setSession`, `heartbeat`,
`closeRequirement`, `whereWorkItem`, `findRequirementsByWorkItem`,
`findRequirementsBySession`, `findRequirementBySession`, `isHeartbeatFresh`,
`workItemKey`, `DEFAULT_HEARTBEAT_MS`, and `RequirementStoreError`. All source
is self-contained (Node built-ins only).

Exit codes: `0` success (exactly one JSON value on stdout), `1` operational
failure (including a missing record), `2` invalid arguments or invalid/corrupt
records.
