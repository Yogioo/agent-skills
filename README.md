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

## Skills

| Skill | Description |
|-------|-------------|
| [exec-review](./skills/exec-review/SKILL.md) | Run a single execute → review pass for one task via Codex with a live progress view; the reviewer directly refines the workspace in the same run (no rework loop; the agents edit files, the caller commits) |
