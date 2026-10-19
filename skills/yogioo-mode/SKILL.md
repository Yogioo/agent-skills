---
name: yogioo-mode
description: Run a task the pstack way on this machine. Routes to a poteto-mode playbook, then executes every "spawn a subagent" step through agent-tools instead of doing it in the lead thread. Prefer this over /poteto-mode in this harness, for any nontrivial change, investigation, bug fix, refactor, perf work or PR.
---

# Yogioo Mode

poteto-mode, with its harness layer replaced.

The playbook list, the principles, the routing, the autonomy rules and the reply
style all come from poteto-mode and stay upstream. This file owns one thing. How
work gets delegated on this machine, where no `Task` tool exists and
`agent-tools subagent` does.

**Read both, in this order.** This file, then
`~/.agents/skills/poteto-mode/SKILL.md` in full. Then open the matched playbook at
`~/.agents/skills/poteto-mode/playbooks/<title>.md` and copy its steps into the
list verbatim, as poteto-mode asks.

## The override

poteto-mode's Harness section ends its Subagents bullet with this sentence.

> If your harness has no subagent tool, as in Pi without an extension, do each
> delegated step yourself, one after another.

That sentence is why this skill exists. It reads as true here and it is not. Pi
ships no `Task` tool, but this machine has `agent-tools subagent`, which is a
subagent tool. So:

- `Task`, `Agent`, `spawn_agent` and `subagent_type` in any playbook mean
  `agent-tools subagent run`. The word-for-word mapping is in
  `/skill:subagent-run`. Read it once per session before the first arm, and do not
  re-derive it.
- `run_in_background` has no equivalent. One `run --manifest` with
  `--concurrency N` is the parallel form.
- There is no todo tool. Where a playbook says to open a todolist, write the
  copied steps as a numbered list in the reply and rewrite it at each phase
  boundary.
- `subagent_type` is registered nowhere. Open the brief with the sentence
  poteto-mode asks for. `Read ~/.agents/skills/poteto-mode/SKILL.md in full,
  including its Principles section, before any work.`
- Resume and follow-up do not exist. A fix round is a fresh arm with the original
  brief, its later directives and the previous arm's report. That is poteto-mode's
  own default anyway.
- "Do each delegated step yourself" holds only where `agent-tools --help` fails.
  Check it instead of assuming it.

## The failure this replaces

On this machine, 10 sessions loaded poteto-mode and 3 ever ran an arm. One
code-writing session made 13 edits with zero arms, while Feature step 4 calls
delegation mandatory and says the Laziness Protocol does not override it.

A playbook that writes code and reaches its first `edit` with no arm running is a
defect, not a saving. Either the arm is running, or the throughput checkpoint says
why one worker is right. Feature step 4's own escape stays intact. An arm
forbidden to spawn satisfies it by owning the diff with review separation. What is
not allowed is writing the diff in the lead thread and calling it reviewed.

## Show the dispatch

A Pi bash call that returns `{"status":"ok"}` looks like nothing happened, which is
why this went unnoticed for weeks. Print one line per arm when it returns.

```
arm <role> -> <status>, <n> files changed, <one clause on what came back>
```

Read `status`, never `exitCode`, and name any arm that came back `error`,
`timeout` or `empty`. An unreported arm is indistinguishable from one that never
ran.

## What stays upstream

Everything else, and do not restate it here: the playbook list and its steps, the
Principles, Autonomy, the model tiers, Writing the reply, Comments, and the
always-pause list.

Do not edit anything under `~/.agents/skills/poteto-mode/`. Local deltas belong in
this file, or in `~/.pi/agent/AGENTS.md` for rules that must hold without the
skill loaded.

Models come from `~/.agents/pstack-models.md` by role name, so do not invent a
model in a brief. A missing or unusable role is fixed by `/skill:setup-yogioo`,
not by a guess.
