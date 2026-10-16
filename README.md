# Yogioo's Agent Skills

Personal agent skills plus a private local toolkit, `@yogioo/agent-tools`.

Three layers live here and are installed differently:

| Layer | Where | What it is |
|-------|-------|------------|
| Library | `lib/` | Reusable ESM modules with explicit inputs; import via package subpaths |
| CLI | `tools/`, `bin/` | Executable Node CLIs behind one `agent-tools` dispatcher |
| Skills | `skills/` | Thin routing instructions for an agent, not implementation |

The runtime is a single private Node package (Node >= 20, no external
dependencies). It is never published to a registry; install it from this repo or
from a locally packed tarball.

## Layout

```
package.json          private @yogioo/agent-tools
bin/agent-tools.mjs   one dispatcher: agent-tools <component> [options]
lib/                  reusable modules (the source of truth)
tools/<name>/         executable CLIs (import lib/, never skills/)
skills/               SKILL.md routing wrappers + legacy workflows
tests/<component>/    component and packaging tests
scripts/sync-links.ps1  local dev junctions
```

## Install the runtime

CLI use, global install from a local checkout or packed tarball:

```powershell
# from the repo
npm install -g C:\projects\agent-skills
# or pack once and install the artifact
npm pack            # produces yogioo-agent-tools-0.1.0.tgz
npm install -g .\yogioo-agent-tools-0.1.0.tgz
agent-tools --help
```

Library use, add it to a project so subpath imports resolve:

```powershell
npm install C:\projects\agent-skills               # local path
npm install .\yogioo-agent-tools-0.1.0.tgz         # packed tarball
```

```js
import { runAgentTurn } from '@yogioo/agent-tools/agent-run'
import { runArms, parseRoleTable, classifyTurn } from '@yogioo/agent-tools/subagent'
import { capabilities } from '@yogioo/agent-tools/agent-run/runners'
import { normalizeEvent } from '@yogioo/agent-tools/agent-events'
import { acquireLease, mergeConfigFiles } from '@yogioo/agent-tools/runtime'
import { captureWorkspace, diff } from '@yogioo/agent-tools/workspace-diff'
import { assemblePrompt } from '@yogioo/agent-tools/prompt-compose'
import { writeEvent, ackEvent } from '@yogioo/agent-tools/event-inbox'
import { createRequirement } from '@yogioo/agent-tools/requirement-store'
import { parseQuestionnaire } from '@yogioo/agent-tools/questionnaire'
import { createWorkSource } from '@yogioo/agent-tools/work-items'
```

Each component's exact options and exit codes are authoritative in its CLI help:

```powershell
agent-tools agent-run --help
agent-tools subagent --help
agent-tools work-items --help
agent-tools questionnaire serve --help   # or: poll --help
agent-tools xlsx-cell-diff --help
```

## Skills

Skills are routing instructions for an agent. The four toolkit wrappers call the
installed `agent-tools` command; they contain no implementation and assume the
runtime is installed separately. A copied wrapper alone does **not** include the
runtime.

Install each wrapper by name (the runtime still comes from the local package
above):

```bash
npx skills add Yogioo/agent-skills --skill questionnaire -g -y
```

| Skill | Routes to |
|-------|-----------|
| [agent-run](./skills/agent-run/SKILL.md) | one agent turn + event normalization |
| [subagent-run](./skills/subagent-run/SKILL.md) | one or more turns from a pstack role table |
| [work-items](./skills/work-items/SKILL.md) | beads / GitHub / TAPD work items |
| [questionnaire](./skills/questionnaire/SKILL.md) | local web form, one submission |
| [xlsx-cell-diff](./skills/xlsx-cell-diff/SKILL.md) | xlsx display-value diff / merge |

The six legacy workflow skills keep their existing implementations and
configuration. They are unrelated to the toolkit runtime and are not migrated by
it: [afk-init](./skills/afk-init/SKILL.md), [afk-run](./skills/afk-run/SKILL.md),
[afk-watch](./skills/afk-watch/SKILL.md),
[afk-requirement-assistant](./skills/afk-requirement-assistant/SKILL.md),
[exec-review](./skills/exec-review/SKILL.md),
[to-questionnaire-web](./skills/to-questionnaire-web/SKILL.md).

## Local development (live junctions)

Junction the active skills into the agents directory so the agent reads this repo
directly. `-Prune` removes only retired junctions that point exactly at this
repo's `skills/<name>` and no longer contain `SKILL.md`; foreign links and real
directories are never touched.

```powershell
cd C:\projects\agent-skills
pwsh -File .\scripts\sync-links.ps1
pwsh -File .\scripts\sync-links.ps1 -Prune
pwsh -File .\scripts\sync-links.ps1 -Force            # replace a real directory
pwsh -File .\scripts\sync-links.ps1 -WhatIf           # show, change nothing
pwsh -File .\scripts\sync-links.ps1 -Destination $env:TEMP\agents-skills   # isolated target
```

## Tests

```powershell
npm test
node scripts/test-components.mjs agent-run subagent work-items questionnaire xlsx-cell-diff
node scripts/test-components.mjs components layers
node scripts/test-components.mjs packaging
```

Component and packaging tests use local fakes for remote transports and never
call remote services.
