---
name: work-items
description: Use agent-tools to read, select, claim or explicitly update beads, GitHub Issues and TAPD work items, including TAPD comments and images.
---

# Work Items

Route work-item access through the installed `agent-tools` runtime. Use this to
read and mutate beads, GitHub Issues or TAPD facts without workflow policy.

**Use when:** you need to list, select, fetch, claim, comment on, label, close
or TAPD-deliver work items.

**Do not use for:** AFK loops, watch dashboards, notifications, or deciding
acceptance. Fact reads and mutations are separate: `list`/`get` never write;
`claim`/`comment`/`labels`/`close`/`deliver` are explicit. `claim` is `atomic`
only for beads; `gh` and `tapd` are `best-effort`. TAPD has no `close`.

```powershell
agent-tools work-items list --source beads --workdir <repo-with-.beads>
agent-tools work-items list --source beads --workdir <dir> --ready --ready-label ready-for-agent
agent-tools work-items get --source tapd --config <config.json> --id 123 --image-dir <cache>
agent-tools work-items claim --source gh --workdir <repo> --id 42
```

Selection flags require `--ready`; unsupported source/flag combinations fail
before accessing the source. Exit codes: `0` success, `1` operational failure,
`2` invalid arguments.

Prerequisite: install the local toolkit once (`npm install -g <repo-or-tarball>`),
then confirm `agent-tools work-items --help`.
