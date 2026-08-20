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

## Skills

| Skill | Description |
|-------|-------------|
| [exec-review](./skills/exec-review/SKILL.md) | Run an execute → review loop for one task via Codex; rework until approved or escalate |
