# Labels are the TAPD queue; runs do not write status

Status: accepted

TAPD readiness, claim, and outcome are expressed entirely with labels: `ready-for-agent` is the human's queue label, and `afk-claimed` / `afk-delivered` / `afk-failed` are the run's machine labels. An execution run writes labels and comments only — never status, never assignee. Humans clear a machine label to re-arm a story, and perform the acceptance flow themselves.

## Considered Options

- **Status as the claim lock.** Rejected: this TAPD workflow has no "not started" status to reserve. Stories of the code-work type sit in 开发中 until someone works on them, so a status gate would either lock nothing or force a status the team does not use.
- **Let a run perform the acceptance flow.** Rejected: verification happens locally, so a run cannot know the result. Verification stays a human step.
- **Consuming the queue label on claim.** Rejected: the run would destroy the human's intent, so re-arming would mean re-tagging. Keeping human and machine labels separate makes re-arming a single label removal.

## Consequences

- Ready selection is `assignee` + queue label + no machine label. The label filter runs server-side; machine-label exclusion runs in the adapter.
- Two execution environments (for example two copies of the same project) cannot both claim a story, because adding a machine label removes it from every other environment's ready set.
- Re-arming a story is one action by a human: clear `afk-delivered` or `afk-failed`.
- Because the queue label stays on a story after delivery, a human must remove it when the story leaves the agent's hands. A stale `ready-for-agent` label on a story that returns to a ready-able state re-arms it.
