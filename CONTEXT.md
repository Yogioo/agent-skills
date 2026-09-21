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

**Watch session**:
One watcher process from start to stop, together with the execution runs that process started.
_Avoid_: watch run, batch (批次), loop

**Watcher phase**:
The watcher's current situation: `polling`, `backing-off`, `running`, `stopping`, or `stopped`.
_Avoid_: idle (an event: the poll returned no ready work item), claiming

**Claim**:
The task-source operation that reserves a work item for one execution environment before agent work begins.
_Avoid_: lock (a local process lock is a different concept)

**Claim mode**:
The guarantee offered by a task source when reserving a work item: `atomic`, `best-effort`, or `unsupported`.

**Ready work item**:
A work item that satisfies the task source's eligibility and dependency rules and may be claimed.
_Avoid_: available issue (not all sources use issues)

**In-progress work item**:
A work item the task source has reserved with a claim, so it is no longer ready. It does not by itself stop the watcher from starting an execution run.
_Avoid_: remote lock

**Blocked work item**:
A work item that is not ready and not in progress. The reason is source-specific: an unfinished dependency, or a label a human must clear before it can be claimed again.
_Avoid_: exec-review blocked status (the executor could not finish)

**Work item reference**:
A work item named as a pair: its task source and its id. Ids are strings, and two task sources can use the same string, so the pair is the only safe key.
_Avoid_: story id, issue number (both are source-specific), id alone

**Work-item pool**:
The watcher's last successful poll of ready, in-progress, and blocked work items for one execution environment.
_Avoid_: queue (the execution-run page already uses that word for its own columns), backlog

**Execution environment**:
The local work directory and its associated `afk-watch` or `afk-run` processes that perform agent work.
_Avoid_: machine (the same machine may host multiple environments)

## 提示词定制

**AFK home**：
某个执行环境对应的 AFK 文件目录：全局根（`~/.afk`，可用 `AFK_HOME` 覆盖）或项目目录（`<label>_<uid>`）。
_Avoid_：skill root（所有执行环境共用）

**Prompt overlay**：
AFK home 里固定文件名的 markdown——`standards.md`、`<role>.append.md` 或 `<role>.prompt.md`——由 `exec-review` 组装进该环境的执行端 / 审查端提示词。由操作者按需自建；init 从不写空的覆盖文件。
_Avoid_：prompt config（覆盖不是 `config.json` 字段）、prompt template（技能内置基座，可被 `<role>.prompt.md` 整段替换）

**Role**：
exec-review 的两个提示词目标之一：`executor` 或 `reviewer`；覆盖文件名固定为这两个角色名。
_Avoid_：agent name（runner 选型是另一回事）

## TAPD task source

**Story**:
TAPD's 需求 entity. The only TAPD work-item kind this context automates.
_Avoid_: ticket (TAPD has three entity kinds), issue

**Label queue**:
A ready-item rule that derives eligibility from labels instead of a status: a story is ready when it carries the queue label and no machine label. The requirement assistant owns the queue label; execution runs own the machine labels.
_Avoid_: status queue (TAPD workflows commonly have no "not started" status to reserve)

**Queue label**:
The label `ready-for-agent`. The requirement assistant adds it to hand a story to an execution environment, and removes it when the story leaves the agent's hands.
_Avoid_: ready status

**Machine label**:
One of `afk-claimed`, `afk-delivered`, `afk-failed`. Written by an execution run to report its own lifecycle on a story. Clearing a machine label re-arms the story. A run never writes the queue label, and a human never writes a machine label.
_Avoid_: afk label (three distinct labels), flag

**Acceptance flow**:
The transition that moves a story to its next workflow stage and reassigns it, performed by the requirement assistant once the developer accepts the result. Validation stays local (ADR-0003), so the assistant performs the transition while the developer's part is the accept-or-reject decision.
_Avoid_: handoff, ticket transition

## Requirement lifecycle

**Requirement assistant**:
The long-lived session that manages one requirement end to end: clarification, spec, tickets, execution handoff, and delivery bookkeeping. It schedules other skills and CLIs, and implements no code.
_Avoid_: project manager (it does not own scope), orchestrator (it is one requirement's session, not a scheduler)

**Two steps**:
The developer's whole share of a requirement: state it, and accept the result. Everything between the two belongs to the requirement assistant (ADR-0006).
_Avoid_: laziness contract (a heading, not a term), phase gate

**Stop-and-ask**:
The closed list of conditions on which the requirement assistant interrupts the developer instead of acting. An action that reaches the developer from outside that list is a bug in the list.
_Avoid_: approval (the assistant does not request approval), confirmation flow

## Requirement record and inbox

**Requirement record**:
One file per requirement, at `<AFK home>/<projectKey>/requirements/<requirement id>.json`. It holds the requirement's identity when no session is open: workdir, runner, the session reference, the work items the requirement spawned, and the assistant's heartbeat. It is the requirement's durable form; a session is a view of it.
_Avoid_: requirement file, spec (a spec is a separate artifact), ticket list

**Session reference**:
The runner-specific handle for a requirement's session, stored in the requirement record as an opaque string. Only the runner interprets it. Every other component copies it unchanged.
_Avoid_: session id (only some runners use ids), thread, pane

**Inbox item**:
One file describing one thing that happened and needs a decision: an execution run ended, a watch session stopped, or a questionnaire was submitted. A producer writes it and knows no reader. It carries the requirement record it belongs to, or a work item reference when no requirement claims it yet. Its state moves `unread` → `seen` → `done`, and only an explicit acknowledgement moves it to `done`.
_Avoid_: notification (an inbox item is durable, a notification is best-effort), queue (the work-item pool owns that word), event
