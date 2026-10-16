---
name: setup-yogioo
description: Post-install setup for Yogioo's agent toolkit. Writes a valid pstack role table for this harness, probes which models actually work, then verifies with `agent-tools subagent doctor`.
disable-model-invocation: true
---

# Setup Yogioo

Configure the toolkit for this machine, in this order: pick the runner, write a
table that is valid before you know which models work, probe the models you want,
then verify.

**Use when:** the toolkit was just installed, an arm failed with an unknown model,
a 403, or an ambiguous provider, or the user asks to set up this toolkit.

**Do not use for:** inventing a model mapping. Which roles need which model
strength comes from pstack. Which models actually work comes from `probe`.

## 1. Keep this skill current

This skill is either a local checkout or a copy the skills CLI installed. Tell the
two apart before touching anything. `npx skills add` replaces an existing symlink
with a real directory, so running it on a development junction silently cuts the
skill off from the checkout feeding it.

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

## 3. Ask three things before writing anything

Ask these together, once. Do not decide any of them for the user.

**Runner.** Which CLI should the arms run on: `pi`, `codex` or `agent` (Cursor).
Ask **per role family**, not once, because the three CLIs spend three different
quota pools, and one of them cannot be reached any other way: a Cursor
subscription is not a provider `pi` can route to, so Cursor credits can only be
spent by running the Cursor CLI.

Write the choice into the value:

| Value | Runs on |
| --- | --- |
| `cursor:composer-2.5` | the Cursor CLI (`cursor` is an alias for `agent`) |
| `codex:gpt-5.1-codex-xhigh` | the Codex CLI |
| `opencode-go/grok-4.7-xhigh` | whatever `# runner:` names, here `pi` |

The three do not behave alike, so the shape of a value differs:

| Runner | Models come from | Reasoning effort | Provider |
| --- | --- | --- | --- |
| `pi` | `pi --list-models` | a separate flag, so write the `-xhigh` suffix | has providers |
| `codex` | nothing to list, probe is the only check | a separate parameter | no providers |
| `agent` / `cursor` | `agent --list-models` | part of the model id, so write the id whole | no providers |

Never write an effort suffix on a Cursor value: `gpt-5.3-codex-xhigh` is one model
id, and splitting it would spend the quota on a different model than the one the
user picked. `cursor:auto` is Cursor's own `auto` model; a bare `auto` is the
"run on this chat's model" alias.

**Budget.** Which reasoning budget: `unlimited` (max), `large` (xhigh, pstack's
default), `medium` (high) or `small` (medium). This rewrites the effort token on
every role, so it is the user's call, not yours.

**Models.** Whether to use this chat's model for every role, or to probe real
models and assign them per role. The default answer is this chat's model, written
as `inherit-parent`. It needs no probe, costs nothing extra, and cannot 403.

Two things are not evidence that a model works, and must never be presented as if
they were:

- The id appearing in `agent-tools subagent models`.
- A credential existing in the harness's auth store.

Both were true on this machine for two models that answer 403: one provider has no
subscription, the other refuses the request outright. Only `probe` decides.

## 4. Write a valid table

Write the skeleton first, so the table is valid before any model is chosen:

```powershell
agent-tools subagent init --out $HOME\.agents\pstack-models.md --budget large --runner pi
```

Every role starts on `inherit-parent`, and `doctor` passes it with no errors. Add
`--force` only to overwrite an existing table.

pstack's own `/setup-pstack` writes this same file, and it is worth running when
the user wants pstack's intent for which role needs which strength. Its default
values are Cursor-shaped (`claude-opus-5-5-xhigh`), which do not exist in this
harness, so treat its output as a list of roles to fill in, never as a table to
keep. Probe before writing any real model it names.

## 5. Probe before assigning a real model

A model may be written into the table only if `probe` returned it in `usable`
during this session.

```powershell
agent-tools subagent probe --out-dir cache\setup-probe `
  --model <provider>/<model> --model <provider>/<model>
```

Probe the model this chat runs on first: it is the one target already known to
work (`PI_PROVIDER` and `PI_MODEL` name it in pi). Then probe the candidates the
user cares about. Read `usable` and
`unusable` from the output; `unusable` carries the provider's own error, which is
the reason to report. Exit 1 just means some candidate failed, which is the normal
outcome of probing and is not a failure of this step.

Probe spends one cheap read-only turn per distinct target, deduplicated, at the
lowest reasoning level.

## 6. Upgrade roles from the probed list

Edit `~/.agents/pstack-models.md`. Prefer `set` over rewriting the file by hand:
it touches only the roles you name, splits a shared line when it has to, and
leaves every other line and the order alone.

```powershell
agent-tools subagent set --role "interrogate reviewers" `
  --value "cursor:claude-opus-5-thinking-high, commandcode/deepseek/deepseek-v4.1-flash-xhigh"
```

Then read the pool split back: `agent-tools subagent plan --role ...` reports
`byRunner`, which says how many arms each CLI will spend. Use only values from
`usable`, in a shape that runner accepts (the table in step 3).

Panel roles (`arena runners`, `arena cross-judge pool`, `architect runners`,
`interrogate reviewers`) take one entry per model and should span providers.

Leave a role on `inherit-parent` when nothing was probed for it. That is a correct
end state, not an unfinished one.

## 7. Check the table

```powershell
agent-tools subagent doctor
```

Exit 0 means no errors. Exit 1 means the table has errors, and every one of them is
a run that would fail or misroute. Fix, then run doctor again until it exits 0.

| Finding | What to do |
| --- | --- |
| `no-role-file` | The table does not exist. Go back to step 4. Nothing else can be checked until it exists. |
| `unknown-model` | Pick a real row from `agent-tools subagent models`, or fall back to `inherit-parent`. |
| `unverified-runner` | That CLI has no model list to check against (Codex). Probe the role, or leave it undecided. |
| `provider-unsupported` | The runner has no provider concept. Drop the `<provider>/` prefix. |
| `alias-shadowed` | `auto` is also a real model id there. Write `<runner>:auto` for the literal model, or `pi:auto` for the alias. |
| `ambiguous-provider` | Write it as `<provider>/<model>-<effort>`. A bare id can fuzzy-match to another vendor. |
| `unknown-role` | Delete the line, or rename it to a canonical role from `missing-roles`. |
| `duplicate-role` | Delete the later line. The first one wins, so the later one is dead. |
| `below-budget` | Raise the effort to what the budget asks, or change the `# budget:` line if the lower effort is deliberate. |
| `fast-unsupported` | Drop the `-fast` suffix. No runner here has a speed mode. |
| `panel-duplicate`, `panel-same-vendor` | Give each panel entry a different vendor. A panel of one family is not a panel. |
| `no-model-list` | The runner could not list models. Check `pi --list-models` by hand, or pass `--models-file`. |
| `bad-line` | Fix that line to `<role>: <value>`. |
| `no-budget`, `unknown-budget` | Add or correct the `# budget:` line. |
| `missing-roles` | Information only. Those roles fall back to the skill defaults. |

## 8. Prove one arm runs

A clean doctor proves the table parses. It does not prove the runner and the
credentials work. Spend one cheap turn on it.

```powershell
agent-tools subagent run --role "swarm workers" --prompt-file <a one-line brief> `
  --out-dir cache\setup-smoke --sandbox read-only
```

Read `status` in the output. `ok` means the arm produced text. Anything else is a
failed setup, and the arm's `events.jsonl` names the reason. This step is also the
first real check of credentials, which is why a probed model in the table matters.

## 9. Report

Name the runner, the budget, the file written, each role as
`provider/model@effort` or `inherit-parent`, every probed target with its result,
every finding that was fixed, and the smoke arm's status. Say which roles were
left on `inherit-parent` on purpose.
