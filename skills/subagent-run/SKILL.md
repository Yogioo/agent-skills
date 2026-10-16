---
name: subagent-run
description: Spawn one or more agent turns from a pstack role table, resolving each role to a runner, provider, model and thinking level. Use when a workflow says to spawn a Task subagent, or when several arms must run on different models.
---

# Subagent Run

Route every "spawn a subagent" instruction through `agent-tools subagent`. It reads
the pstack role table, turns a role into a `(runner, provider, model, thinking)`
arm, runs the arms with bounded concurrency, and reports what actually happened.

**Use when:** a workflow says `Task`, `Agent` or `spawn_agent`, or asks for N
parallel workers, an explorer plus an explainer, or a reviewer panel. A harness's
own subagent tool can only spawn its own vendor's models, so this command is the
only way to run one brief across different model families.

**Do not use for:** deciding whether the work is done or good, retrying a failed
task, committing, or notifying anyone. `status: ok` means the turn produced text.
It never means the work is correct.

## Command

```powershell
agent-tools subagent roles|plan|run ...

# one arm
agent-tools subagent run --role "how explorer" --prompt-file brief.md `
  --out-dir cache/run-1 --sandbox read-only

# a panel or a fan-out: one arm per brief, optionally one model per arm
agent-tools subagent run --manifest arms.json --out-dir cache/review-1

# resolve without spawning, to check the table and the model routing
agent-tools subagent plan --role "interrogate reviewers"
agent-tools subagent roles
```

Every command prints one JSON object. `run` also writes `<out-dir>/report.jsonl`,
one record per arm, and `<out-dir>/<label>/` holds that arm's `output.txt`,
`events.jsonl` and `log.txt`.

## Mapping pstack's words to this command

| pstack says | here |
| --- | --- |
| `Task` subagent | this command |
| `subagent_type: generalPurpose` | no equivalent, drop it |
| `model`, effort baked in (`grok-4.7-xhigh-fast`) | the table splits the slug into `--model` and `--thinking` for you |
| `readonly: true`, an explorer or a critic | `--sandbox read-only` |
| one subagent per panel entry | `--manifest` with one arm per entry |
| spawn all explorers in a single message | one `run` with `--concurrency N` |
| `environment: "cloud"` | no equivalent, give each writing arm its own `--workdir` |

## Rules that matter

- **`status` is the verdict, `exitCode` is not.** The child's exit code is pi's,
  Codex's or Cursor's, not the turn's. A model that fails every retry can still
  exit 0. Read `status`: `ok`, `empty`, `error`, `timeout` or `aborted`. Treat
  anything but `ok` as a failed arm and say so.
- **Read `report.jsonl`, then read the arm's `output.txt`.** The report carries
  facts and paths, never the prose. `chars: 0` means the arm said nothing.
- **One arm per brief.** An arm with its own angle gets its own prompt file. Do not
  put three reviewers in one prompt and call it a panel.
- **Prefer a native subagent when the harness has one and one model will do.** It
  is cheaper and shares context. Reach for this command for panels, for fan-out,
  and whenever the arms must differ by model family.
- **Writing arms need separate workdirs.** Pass `--workdir` per arm, usually one
  git worktree each. Reading arms can share the workspace with `--sandbox read-only`.

## The role table

`agent-tools subagent` reads `~/.agents/pstack-models.md`, then
`~/.cursor/rules/pstack-models.mdc`. That file is what `/setup-pstack` writes and
what the other pstack skills read, so the roles stay in one place across harnesses.

Two comment lines are honoured on top of the pstack format:

```
# budget: large (xhigh)
# runner: pi                 # pi | codex | agent, default pi
feature, refactoring: grok-4.7-xhigh-fast
interrogate reviewers: claude-opus-5-5-xhigh, grok-4.7-xhigh-fast
```

A role that lists several values is a panel: one arm per value, in order. `auto`
and `inherit-parent` mean the arm runs on the parent chat model, so no model is
passed. With no table at all, pass `--model` and `--thinking` per arm.

The provider is not in the table, because a model id alone does not name one. It
is resolved from the runner's model list when exactly one provider serves that id.
An id that several providers serve is rejected rather than guessed, and printing
the candidates to pick from.
