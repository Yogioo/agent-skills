# The wake ring is a file queue, not a resident pump

Status: accepted

A requirement assistant is a session a developer opens, not a resident process (CONTEXT.md: Requirement assistant), so nothing can be pushed into it while nobody is watching. ADR-0006 gave it the delivery bookkeeping and ADR-0007 removed the terminal the developer used to watch, so the work item that finishes with nobody present has no way to reach anyone.

Producers therefore write one JSON file per event into `<AFK home>/inbox/` and know no reader: an execution run ending, a watch session failing, a questionnaire being submitted. A one-shot `drain.mjs` reads unread items, resolves each to a requirement, and continues that requirement's session with a single runner turn.

The **requirement record** holds the identity, not the session: workdir, runner, session reference, the work items the requirement spawned, and the assistant's heartbeat (CONTEXT.md: Requirement record). Routing is by work item reference, so a producer that only knows its own work items still reaches the right requirement; an event that resolves to nothing stays unread and is reported rather than guessed at.

The assistant stamps the heartbeat and reads its inbox with one command at the start of every turn, so the convention is a command rather than two rules to remember. A fresh heartbeat means a developer is in the session, and the drain does not knock.

## Considered Options

- **A resident pump that polls the inbox.** Rejected: it would add a third long-lived process with its own registry and start/stop path beside the watcher and the execution run, and it holds no state the queue does not already hold. The writer kicks a detached drain instead; a lost kick loses nothing, because the next event drains the backlog.
- **Push into a socket the assistant listens on.** Rejected: the session is not resident, so for most of a requirement's life there is no listener to push into.
- **A second runner table for waking.** Rejected: `exec-review` already turns "start one CLI turn" into an adapter (`runners/`). Waking reuses it, so a new CLI costs one adapter rather than two.
- **Route by workdir.** Rejected: an execution environment hosts many requirements over its lifetime, and several can be in flight at once.
- **Let the drain perform the acceptance flow.** Rejected: accepting is the developer's second step (CONTEXT.md: Two steps), so a wake prepares the checklist and stops there.

## Consequences

- Producers stay ignorant of requirements and name only work items. A new producer is a few lines, not a routing table.
- Continuing a session is a runner capability, not a given: `pi` creates or resumes (`--session-id`), `codex` resumes only (`exec resume`), `agent` cannot yet. A wake against a runner that cannot continue must rehydrate context rather than claim the conversation continued.
- `stop` from the watcher is not an event: `--stop` and the stop file both land on it, and the developer who asked for the stop already knows. Watcher findings come from a whitelist of stop reasons, so a reason added later cannot start notifying on its own.
- Two writers on one session file are prevented by the heartbeat, so an event can wait but cannot collide.
- An unregistered session cannot be found by its session reference, so registration must record one; `checkin.mjs` reports that instead of guessing.
