---
name: questionnaire
description: Expose a questionnaire Markdown file as a fillable local web form, wait in bounded segments for one final submission, and write JSON/Markdown/status artifacts. Use when a person must answer structured questions over a LAN.
---

# Questionnaire Web

Turn a Markdown questionnaire into a fillable page and collect exactly one
submission. No AFK home, requirement session or notification is involved.

The questionnaire format is preserved: `# Title` is the page title, paragraphs
before the first question are the intro, each `### Heading` is a question, and
the first `>` line below a question is its initial answer.

## Serve

```powershell
node <skill>/scripts/serve.mjs --file <questionnaire.md> --out-dir <artifacts> [--session <base>] [--host 0.0.0.0] [--port 0] [--open] [--force]
```

stdout is JSONL lifecycle only: `questionnaire_started` (with `url`, `lanUrls`,
`lanInterfaces`, `port` and artifact paths), then `questionnaire_submitted`.
Diagnostics go to stderr. `--open` explicitly opens this machine's browser;
nothing else contacts the outside world. The server accepts one submission,
writes the artifacts atomically, then exits.

Sessions are exclusive. Startup takes an atomic `<session>-lock.json` claim, so
two simultaneous servers cannot share one session. A live owner (a status file
with an alive pid, or a live lock) is always refused with exit `2`, even with
`--force`; a server never kills or replaces another. Without `--force`, any
existing session artifact (`<session>-status.json`, `-response.json` or
`-response.md`) is a collision and exits `2`. With `--force`, completed, stale
(dead pid) or malformed artifacts are replaced, but only after confirming no
live owner. The owning server releases its lock on normal exit and on error; an
old or corrupt lock needs a manual deletion after you confirm no server runs.

Artifacts (atomic, in `--out-dir`, names from the questionnaire basename or
`--session`): `*-response.json`, `*-response.md`, `*-status.json`. The status
file contains `state: waiting|submitted` and no access token. A malformed or
wrongly shaped status (for example a missing `pid`) is treated as corrupt, not
as an empty session.

## Poll

Stale-session replacement with `--force` is a maintenance operation: stop other
launchers for that session first. Normal simultaneous starts are serialized by
the session lock; a known live server is refused even with `--force`.

```powershell
# Use the exact path printed as statusFile by serve's questionnaire_started event:
node <skill>/scripts/poll.mjs --status <artifacts>/<session>-status.json [--timeout 60] [--interval 2]
# Or repeat serve's --file/--out-dir/--session so poll derives the same path:
node <skill>/scripts/poll.mjs --file <questionnaire.md> --out-dir <artifacts> [--session <base>] [--timeout 60]
```

The status path must match the running server; `--status` is the reliable choice
because serve prints it. Prints one JSON value and exits `0` submitted, `3` still
waiting, `2` no/invalid session, `1` malformed or wrongly shaped state. A missing
session is never treated as an empty one; a corrupt status object (bad `state`,
missing `pid`/`file`/`statusFile`) is reported as an error.

## Access and validation

Each server run generates a fresh access token, required for the page and the
submission endpoint. The URL embeds the token; the status file deliberately does
not. Submissions are validated against the known question ids: unknown ids,
non-string answers and non-object payloads are rejected, and client-supplied
question text is ignored so answers cannot rewrite the questions. A submission
reserves the session before reading its body, so exactly one of two concurrent
valid requests is accepted; the other gets `409`. The status file is written
last and is the commit point, so an I/O failure leaves the state `waiting` and
returns `500` with `retryable: true` instead of reporting false success.

## API

`scripts/questionnaire.mjs` exports `parseQuestionnaire`, `artifactPaths`,
`validateSubmission`, `buildResponseMarkdown`, `readStatusFile`,
`writeFileAtomic`, `lanAddresses` and related helpers. It is self-contained and
does not import the legacy AFK skills.
