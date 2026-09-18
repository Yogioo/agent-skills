# Agent Task Automation Context

This context defines the shared language for discovering, claiming, and executing work items through agent skills.

## Task Processing

**Task source**:
An external system that lists work items, provides their details, and records claim, completion, and failure results.
_Avoid_: issue tracker (some sources are not issue trackers)

**Execution run**:
A bounded batch in which `afk-run` selects and processes ready work items until a configured stop condition.
_Avoid_: watcher, daemon

**Watcher**:
A long-lived process that polls a task source and starts execution runs when work is available.
_Avoid_: loop (too broad), daemon (describes process lifetime rather than its role)

**Claim**:
The task-source operation that reserves a work item for one execution environment before agent work begins.
_Avoid_: lock (a local process lock is a different concept)

**Claim mode**:
The guarantee offered by a task source when reserving a work item: `atomic`, `best-effort`, or `unsupported`.

**Ready work item**:
A work item that satisfies the task source's eligibility and dependency rules and may be claimed.
_Avoid_: available issue (not all sources use issues)

**Execution environment**:
The local work directory and its associated `afk-watch` or `afk-run` processes that perform agent work.
_Avoid_: machine (the same machine may host multiple environments)

## TAPD task source

**Story**:
TAPD's 需求 entity. The only TAPD work-item kind this context automates.
_Avoid_: ticket (TAPD has three entity kinds), issue

**Label queue**:
A ready-item rule that derives eligibility from labels instead of a status: a story is ready when it carries the queue label and no machine label. Humans own the queue label; execution runs own the machine labels.
_Avoid_: status queue (TAPD workflows commonly have no "not started" status to reserve)

**Queue label**:
The label `ready-for-agent`. A human adds it to hand a story to an agent, and removes it when the story leaves the agent's hands.
_Avoid_: ready status

**Machine label**:
One of `afk-claimed`, `afk-delivered`, `afk-failed`. Written by an execution run to report its own lifecycle on a story. Clearing a machine label re-arms the story. A run never writes the queue label, and a human never writes a machine label.
_Avoid_: afk label (three distinct labels), flag

**Acceptance flow**:
The human transition that moves a story to its next workflow stage and reassigns it. Outside this context: no skill performs it.
_Avoid_: handoff, ticket transition
