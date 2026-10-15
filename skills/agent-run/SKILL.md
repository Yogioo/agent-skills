---
name: agent-run
description: Use agent-tools to invoke a single pi, Codex or Cursor agent turn, inspect runner capabilities, or normalize captured agent events.
---

# Agent Run

Route agent invocation through the installed `agent-tools` runtime. Use this when
the caller needs exactly one agent turn and its invocation facts, not workflow
policy.

**Use when:** you must run one turn (pi/codex/Cursor), inspect runner
capabilities, or normalize captured raw JSONL events.

**Do not use for:** retries, workdir locking, UI, auto-commit, notification, or
deciding task acceptance. Results report `exitCode`, `timedOut`, `aborted` and
artifact paths only; they never mean "done" or "approved".

```powershell
agent-tools agent-run capabilities
agent-tools agent-run run --runner pi --workdir <dir> `
  --prompt-file <prompt.md> --out-dir <new-cache-dir> --sandbox workspace-write
agent-tools agent-run normalize --runner pi `
  --input <raw-events.jsonl> --output <new-normalized.jsonl>
```

`run` requires `--runner` and a prompt file, and creates a brand-new `--out-dir`
(rejecting an existing one). The caller chooses runner, prompt, sandbox and
session. Unsupported runner/flag combinations are rejected, not ignored. Exit
codes: `0` success, `1` operational failure or nonzero child exit, `2` invalid
arguments or malformed JSONL.

Prerequisite: install the local toolkit once (`npm install -g <repo-or-tarball>`),
then confirm `agent-tools agent-run --help`.
