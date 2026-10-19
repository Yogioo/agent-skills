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
agent-tools subagent roles|plan|run|probe|doctor|init|set ...

# one arm
agent-tools subagent run --role "how explorer" --prompt-file brief.md `
  --out-dir cache/run-1 --sandbox read-only

# a panel or a fan-out: one arm per brief, optionally one model or CLI per arm
agent-tools subagent run --manifest arms.json --out-dir cache/review-1

# resolve without spawning: the table, the routing, and how each pool is spent
agent-tools subagent plan --role "interrogate reviewers"

# which models actually answer, one cheap read-only turn each
agent-tools subagent probe --out-dir cache/probe-1 --model cursor:auto

# change one role without hand-editing the table
agent-tools subagent set --role "swarm workers" --value "cursor:auto"
```

Every command prints one JSON object. `run` also writes `<out-dir>/report.jsonl`,
one record per arm, and `<out-dir>/<label>/` holds that arm's `output.txt`,
`events.jsonl` and `log.txt`.

## Which CLI runs an arm

Each role can name its own CLI, because each CLI spends a different quota pool and
some credits cannot be reached any other way. Write it as a prefix:

```
<value> := [<runner>:]<model>[-<effort>]
```

`cursor` is an alias for `agent`. A value with no prefix runs on the table's
`# runner:`. A leading word is only read as a runner when it names one, so a model
id that contains a colon stays intact.

Cursor is the simple case: `cursor:auto` is Cursor's own default model, so for it
nothing has to be chosen or kept in step with a subscription. Name a variant
(`cursor:gpt-5.3-codex-high`) only when there is a reason to.

| Runner | Effort | Provider |
| --- | --- | --- |
| `pi` | split off the value's `-xhigh` suffix and passed as a flag | has providers, resolved from `pi --list-models` |
| `codex` | split off and passed as a parameter | none |
| `agent` (alias `cursor`) | **part of the model id**: write it whole, or you spend quota on another model | none |

Two things the runner decides, not the caller: which model list is authoritative,
and whether a value is passed through untouched. `agent` has no separate effort
parameter, so `cursor:gpt-5.3-codex-xhigh` is passed as one string, and an explicit
`--thinking` is the only way to move its level.

`plan` prints `byRunner`, so you can see how many arms each pool will spend before
spending any of it.

## Reading the result

`status` is the verdict, not `exitCode`. Usage is reported only by the runners that
report it: a `pi` arm carries `tokens` and `cost`, a Cursor arm carries neither, so
an absent `cost` means unmeasured rather than free.

Every non-`ok` arm carries an `errorMessage`. When the CLI itself never reported a
reason, the tail of its stderr is used, and the whole of it is in that arm's
`log.txt`. So a failed arm is never a dead end.

## Watching a run (this is for the human, not for you)

A run takes minutes, and the human talking to you cannot see your terminal. Give
them the board URL **in the message you send before the tool call**, so the page is
already open when the work starts:

```
开跑了，进度在这里：http://192.168.18.34:7717/
```

The `run` result carries `{"board":{"url","runId"}}`. The board is an always-on
read-only page (one per machine, shared by every project) — it lists every live
run with its current phase and elapsed time. If it is not running yet, `run`
starts it; you never have to start it by hand.

- **Never `cat` an arm's `events.jsonl`.** One turn writes megabytes there. If you
  need the mid-run state, call the board's API instead: `GET /api/runs` (one line
  per run) or `GET /api/runs/<runId>` (last 40 progress records).
- Mid-run progress the user asked about is answered from `progress.jsonl`
  (`agent-tools run-runtime progress read --file <out-dir>/progress.jsonl`), which
  only holds `arm_start` / `tool` / `arm_end`.
- `--no-board` (or `AGENT_TOOLS_BOARD=off`) skips registration and the board.
- Board lifecycle: `agent-tools run-runtime board ensure|status|stop`. Only the
  `close`d run disappears from the page; a run whose process died is shown as
  **stale**, never as running.

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
- **A human watching a run gets a URL, not a summary.** `run` starts the board and
  returns `board.url`; say it out loud before the turn starts. See
  [Watching a run](#watching-a-run-this-is-for-the-human-not-for-you).
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
