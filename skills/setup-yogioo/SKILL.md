---
name: setup-yogioo
description: Post-install setup for Yogioo's agent toolkit. Runs pstack's model setup, then validates the role table with `agent-tools subagent doctor` and fixes what it reports. Use after installing the toolkit, after `/setup-pstack`, when a subagent arm fails on an unknown model, or for "set up my toolkit".
---

# Setup Yogioo

Two steps, in this order. First let pstack choose the roles, then let the toolkit
check that the table it wrote can actually run.

**Use when:** the toolkit was just installed, `/setup-pstack` was just run or
re-run, an arm failed with an unknown model or an ambiguous provider, or the user
asks to set up this toolkit.

**Do not use for:** choosing the budget or the per-role models. That is pstack's
job, and this skill must not duplicate it.

## 1. Keep this skill current

This skill is either a local checkout or a copy the skills CLI installed. Tell the
two apart before touching anything. `npx skills add` replaces an existing symlink
with a real directory, so running it on a development junction silently cuts the
skill off from the checkout that was feeding it.

Resolve the path this SKILL.md was loaded from (usually
`~/.agents/skills/setup-yogioo`, but a project `.pi/skills` or a plugin directory
is possible) and check it:

```bash
node -e "const fs=require('fs'),p=require('os').homedir()+'/.agents/skills/setup-yogioo',s=fs.lstatSync(p,{throwIfNoEntry:false});console.log(s?(s.isSymbolicLink()?'link':'dir'):'absent')"
```

| Result | What it means | Do |
| --- | --- | --- |
| `link` | a local checkout feeds this skill | Nothing. Say the skill tracks the local repo. |
| `dir` | the CLI installed it | `npx skills update setup-yogioo -g -y` |
| `absent` | not installed at the user level | `npx skills add Yogioo/agent-skills --skill setup-yogioo -g -y` |

The CLI also writes for every other agent it detects, and it may print a failed
line for one that cannot take a global skill (PromptScript does this). That line
is not a failure of this step. Re-run the check command above and trust its
answer, not the summary line.

## 2. Confirm the runtime

```powershell
agent-tools --help
```

If that fails, install it from the local checkout and stop if it still fails.

```powershell
npm install -g C:\projects\agent-skills
```

## 3. Let pstack write the role table

Invoke `/setup-pstack` and let it run its own steps. It writes
`~/.agents/pstack-models.md` in a non-Cursor harness, and it is the only thing
that should decide the budget and the per-role models. `large` is pstack's
default budget.

With no pstack installed, write the table yourself rather than skipping this
step, because every later step checks it. `agent-tools subagent models` lists the
real rows and doctor's `missing-roles` lists the canonical role names. Start from
`# budget: large (xhigh)` and `# runner: pi`, then let doctor verify each line.

## 4. Check the table

```powershell
agent-tools subagent doctor
```

Exit 0 means no errors. Exit 1 means the table has errors, and every one of them
is a run that would fail or misroute. Read the findings, do not skim them.

A `no-role-file` finding means there is no table to check at all. Stop and go back
to step 3. Do not report success from an empty check.

## 5. Fix what it reports

Change only the named line. Then run doctor again until it exits 0.

| Finding | What to do |
| --- | --- |
| `unknown-model` | Pick a real row from `agent-tools subagent models` and rewrite that line. |
| `ambiguous-provider` | Write it as `<provider>/<model>-<effort>`. Without a provider the harness fuzzy-matches and can route to another vendor. |
| `unknown-role` | Delete the line, or rename it to a canonical role from `missing-roles`. |
| `duplicate-role` | Delete the later line. The first one wins, so the later one is dead. |
| `below-budget` | Raise the effort to what the budget asks, or change the `# budget:` line if the lower effort is deliberate. |
| `fast-unsupported` | Drop the `-fast` suffix. No runner here has a speed mode. |
| `panel-duplicate`, `panel-same-provider` | Give each panel entry a different vendor. A panel of one family is not a panel. |
| `no-model-list` | The runner could not list models. Check `pi --list-models` by hand, or pass `--models-file`. |
| `bad-line` | Fix that line to `<role>: <value>`. |
| `no-role-file` | The table does not exist. Run `/setup-pstack`, or pass `--roles-file`. Nothing else can be checked until it exists. |
| `no-budget`, `unknown-budget` | Add or correct the `# budget:` line. |
| `missing-roles` | Information only. Those roles fall back to the skill defaults. Add them to pin them. |

## 6. Prove one arm runs

A clean doctor proves the table parses. It does not prove the runner and the
credentials work. Spend one cheap turn on it.

```powershell
agent-tools subagent run --role "swarm workers" --prompt-file <a one-line brief> `
  --out-dir cache/setup-smoke --sandbox read-only
```

Read `status` in the output. `ok` means the arm produced text. Anything else is a
failed setup, and the arm's `events.jsonl` names the reason.

## 7. Report

Name the file written, the budget, each role as `provider/model@effort`, every
finding that was fixed, and the smoke arm's status. If a line was left alone on
purpose, say which and why.
