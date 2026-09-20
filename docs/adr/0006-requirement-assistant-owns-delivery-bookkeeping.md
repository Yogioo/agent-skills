# The requirement assistant owns delivery bookkeeping

Status: accepted

Everything between the developer stating a requirement and the developer accepting the result belongs to the requirement assistant session; its ownership table in `skills/afk-requirement-assistant/SKILL.md` is authoritative for which step is whose. ADR-0003's constraint on execution runs stands unchanged (labels and comments only, never status, never assignee) — this decision moves the actor on the human side of that boundary, so the acceptance transition becomes the assistant's action on the developer's decision rather than a manual transition.

The developer has two steps: state the requirement, and accept the result (CONTEXT.md: Two steps).

## Considered Options

- **Keep the developer clicking TAPD.** Rejected: `tapd-cli` plus the assistant's existing write permissions make those actions mechanical, so the clicks bought no judgement.
- **Let an execution run write status or assignee.** Still rejected (ADR-0003): a run cannot know the local acceptance result.
- **Let the assistant write machine labels.** Rejected: `afk-claimed` / `afk-delivered` / `afk-failed` report an execution run's own lifecycle, so an assistant writing them would make the watcher's state unattributable.

## Consequences

- The stop-and-ask list is the assistant's whole interruption budget: an action that reaches the developer from outside that list is a bug in the list (CONTEXT.md: Stop-and-ask).
- The queue label becomes the assistant's to write and clear (CONTEXT.md: Queue label); clearing a machine label to re-arm a story is also the assistant's action.
- The developer reads the assistant's report instead of performing transitions, so a missing report is a real failure to fix rather than a cosmetic gap.
