---
name: questionnaire
description: Expose a questionnaire Markdown file as a fillable local web form, wait in bounded segments for one final submission, and write JSON/Markdown/status artifacts. Use when a person must answer structured questions over a LAN.
---

# Questionnaire Web

Route questionnaire collection through the installed `agent-tools` runtime.

**Use when:** a person must answer a Markdown questionnaire over a local/LAN web
form, and the caller waits for one final submission.

**Do not use for:** AFK notification, requirement routing, or serving more than
one submission per session. Each server run accepts exactly one submission,
writes artifacts atomically, then exits. Sessions are exclusive; a live owner is
never replaced, even with `--force`.

```powershell
agent-tools questionnaire serve --file <questionnaire.md> --out-dir <artifacts> `
  [--session <base>] [--host 0.0.0.0] [--port 0] [--open] [--force]
# poll the exact statusFile printed by serve's questionnaire_started event:
agent-tools questionnaire poll --status <artifacts>/<session>-status.json [--timeout 60] [--interval 2]
```

`serve` prints JSONL lifecycle events on stdout (`questionnaire_started`, then
`questionnaire_submitted`); diagnostics go to stderr. `poll` prints one JSON
value and exits `0` submitted, `3` still waiting, `2` no/invalid session, `1`
malformed state. A missing session is never treated as an empty one.

Start the server in the background with stdout captured, give the user its usable
URL in your reply, and poll the returned status path in bounded intervals. Read
the submitted answers before continuing the parent task.

Prerequisite: install the local toolkit once (`npm install -g <repo-or-tarball>`),
then confirm `agent-tools questionnaire serve --help`.
