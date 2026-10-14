---
name: agent-run
description: Run one role-neutral agent turn through the pi, codex or Cursor agent CLI, with raw JSONL event normalization and per-runner capability reporting. Standalone and independent of AFK.
---

# Agent Run

Invoke a single agent turn and turn its raw JSONL stream into normalized events.
Requires Node.js. It does not read AFK configuration, lock a workdir, serve a UI,
auto-commit, or decide whether a task is accepted. The caller chooses the runner,
prompt, sandbox and (where supported) session, then reads the returned facts.

Use `node <skill>/scripts/cli.mjs --help` for options and exit codes.

```powershell
node <skill>/scripts/cli.mjs capabilities
node <skill>/scripts/cli.mjs run --runner pi --workdir <dir> `
  --prompt-file <prompt.md> --out-dir <new-cache-dir> --sandbox workspace-write
node <skill>/scripts/cli.mjs normalize --runner pi `
  --input <raw-events.jsonl> --output <cache>/normalized.jsonl
```

`run` requires `--runner` and a prompt file, and creates a brand-new `--out-dir`
(rejecting an existing one). It prints one JSON object with `exitCode`, `timedOut`,
`aborted`, `outputFile`, `eventsFile` and `logFile`; it never reports `done` or
`approved`. A nonzero child exit makes the CLI exit 1, so a returned JSON object is
a record, not an acceptance signal. Invalid arguments or malformed JSONL exit 2.

## Runners

| Runner | Session | Output schema | Notes |
|--------|---------|---------------|-------|
| `pi` | `create-or-resume` (`--session-id`) | no | `--mode json`; `@promptFile`; `read-only` allows only read/grep/find/ls and disables extensions/MCP |
| `codex` | `resume` (`exec resume`, existing only) | yes | resume rejects `-C`/`-s`/`--color` and has no sandbox flag |
| `agent` | `none` | no | Cursor CLI; no verified resume; long prompts use a file pointer |

Unsupported requests are rejected instead of silently ignored: a `--session` on
`agent`, `--schema-file` on `pi`/`agent`, or an explicit sandbox override with Codex
resume, is an error. `--provider` applies to pi only. `--sandbox` defaults to
`workspace-write`; nothing hardcodes `danger-full-access`. `capabilities` lists the
exact supported values and enforcement limitations (for example that `read-only`
restricts tools rather than providing a kernel sandbox).

`--approve` maps to project trust in pi and approval flags in Cursor; it does not
provide a uniform security policy across runners. Codex uses its own settings. `--timeout`
aborts and kills only the owned child tree (`taskkill /T` on Windows, process group
elsewhere) and reports `timedOut: true`.

`run` already writes normalized events. `normalize` is for separately captured raw
JSONL and writes a new normalized JSONL file. Malformed
input is a visible error, never an empty success. Normalization is also available as
a library.

Programmatic API: `scripts/run-agent-turn.mjs` exports `runAgentTurn(options)`;
`scripts/runners/index.mjs` exports `createRunner(name, opts)`, `RUNNERS`,
`runnerSessionMode(name)` and `capabilities(name)`; `scripts/normalize-event.mjs`
exports `normalizeEvent(raw, runner)` plus the per-runner normalizers and
`extractJsonFromText`.
