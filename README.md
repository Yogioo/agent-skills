# Yogioo's Agent Skills

Personal agent skills I maintain and sync across machines.

## Install

```bash
npx skills add Yogioo/agent-skills -g -y
```

Install one skill only:

```bash
npx skills add Yogioo/agent-skills --skill exec-review -g -y
```

Update later:

```bash
npx skills update -g
# or
npx skills update exec-review -g
```

Browse the ecosystem: https://skills.sh/

## Develop on this machine (live edit)

Clone/work in this repo, then junction each skill into `~/.agents/skills` so Agent reads the repo files directly:

```powershell
cd C:\projects\agent-skills
pwsh -File .\scripts\sync-links.ps1
```

When you **add a new skill** under `skills/<name>/SKILL.md`, run `sync-links.ps1` once. You do not need to hand-write `mklink` each time.

If an old real copy already occupies `~/.agents/skills/<name>`:

```powershell
pwsh -File .\scripts\sync-links.ps1 -Force
```

Then commit/push as usual. Other machines still use `npx skills add/update` (install copies), not junctions.

## Reusable Components

| Skill | Description |
|-------|-------------|
| [workspace-diff](./skills/workspace-diff/SKILL.md) | Capture directory fingerprints and compare additions, modifications, and deletions |
| [agent-run](./skills/agent-run/SKILL.md) | Invoke one agent through pi, Codex, or Cursor; normalize events and report invocation facts |
| [work-items](./skills/work-items/SKILL.md) | Read, select, claim, and explicitly update beads, GitHub, or TAPD work items; localize TAPD images |
| [event-inbox](./skills/event-inbox/SKILL.md) | Persist, query, and acknowledge events without triggering notifications or agent wakeups |
| [requirement-store](./skills/requirement-store/SKILL.md) | Store requirements, opaque session references, work-item links, and heartbeats |
| [questionnaire](./skills/questionnaire/SKILL.md) | Collect questionnaire answers through a local web form and return persistent results |
| [prompt-compose](./skills/prompt-compose/SKILL.md) | Assemble prompts from explicit layers and variables, with source provenance |
| [run-runtime](./skills/run-runtime/SKILL.md) | Local leases, owned processes, progress, configuration layers, and explicit Git checkpoints |
| [xlsx-cell-diff](./skills/xlsx-cell-diff/SKILL.md) | xlsx 显示值 diff 与 overlay 合并（源配置表格比对、提交配置变更、三路冲突） |

Each component installs independently, uses explicit inputs, and documents its CLI
and tests. The extracted components do not import the legacy AFK skills or read
their configuration. An operation result is not a task acceptance decision.

## Existing Workflows

These entries keep their existing implementations and configuration. The extraction
does not switch or disable an existing workflow. Their local legacy copies remain
for compatibility; future migration can replace those copies with component calls.

| Skill | Responsibility |
|-------|----------------|
| [afk-requirement-assistant](./skills/afk-requirement-assistant/SKILL.md) | Long-lived requirement conversation and lifecycle routing |
| [exec-review](./skills/exec-review/SKILL.md) | Execute a task, optionally review it, and report the workflow result |
| [afk-run](./skills/afk-run/SKILL.md) | Run a task batch with its retry, rollback, and completion policies |
| [afk-watch](./skills/afk-watch/SKILL.md) | Poll a task source, start batches, and display workflow state |
| [afk-init](./skills/afk-init/SKILL.md) | Initialize the existing AFK configuration |
| [to-questionnaire-web](./skills/to-questionnaire-web/SKILL.md) | Existing questionnaire flow with AFK notification integration |

Scheduling, retries, automatic wakeups, acceptance, and task closing remain workflow
decisions. AFK queue and requirement dashboards remain views of those workflows;
the reusable runtime exposes the underlying progress and local run mechanics.

## Validation

Focused tests live under `tests/<component>/`. The composition examples exercise
multiple public component interfaces together without AFK configuration:

```bash
node --test tests/components/composition.test.mjs
```

Agent and remote work-item transports use local fakes in tests. These checks cover
adapter contracts and local composition; they do not certify live remote services.
