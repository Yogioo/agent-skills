# 任务源约定

afk-run 通过 adapter 消费任务源。**怎么写工单才能被正确消费**，各任务源的约定如下。

## beads（默认）

- **可执行工单（AFK 会拉取）**：仅带 `ready-for-agent` 标签的 **叶子 ticket**（无 open 子 ticket 的 parent 不会被拉取）。
- **Parent / Spec（AFK 不会拉取）**：Epic/Spec 容器只放描述与子 ticket 依赖，**不要**打 `ready-for-agent`；需要时用 `bd update <parent> --claim` 保持 in_progress，避免与 `bd ready` 混淆。
- **优先级**：`bd create "标题" -t task -p <0-4>`（0=Critical / 4=Backlog）。排序取数值升序。
- **依赖**：`bd dep add <被阻塞> <前置>`（即"B 依赖 A"=`bd dep add B A`）。只有所有前置都 closed 的工单才 ready。
- **状态流转（由循环自动执行）**：
  - 开始：`bd update <id> --claim`（置 in_progress）
  - 完成：`bd close <id> --reason "afk: …"`，随后 `bd epic close-eligible`（所有子单 closed 的父 epic 自动收尾）
  - 失败：`bd label add <id> afk-failed` + comment
- **Parent epic**：`/to-spec` 建议 `--type epic`；子单 `--parent=<epic>`。父单不要 `ready-for-agent`。
- **重试失败任务**：去掉 `afk-failed` label 即可被重新拉取。
- **注意**：beads 的 AI 集成（AGENTS.md/钩子）可能让执行端自己 close 工单——loop 仍按自身判定流转，以 exec-review 结果为准。

## GitHub Issues（`--source gh`）

- **仓库**：`node .../loop.mjs --workdir <目录> --source gh --repo owner/name`；省略 `--repo` 时从 workdir 的 `remote.origin.url` 推断。GitHub Enterprise remote 使用 `HOST/OWNER/REPO` 形式传给 gh。
- **优先级**：标签 `P0`~`P4` 映射为 0-4；无标签默认 P2。多个 P 标签取数值较小者；ready 按优先级升序、issue number 升序返回。
- **依赖**：issue body 中每行写一个 task list 项，例如 `- [ ] #123` 表示被 #123 阻塞，`- [x] #123` 表示已完成。ready = 所有引用已勾选，或引用 issue 不在 open issue 集合中（已关闭/不存在视为满足）；只识别同仓库 `#N` 引用，`owner/repo#N` 不参与本期依赖判断。
- **状态流转**：开始 `in-progress` 标签；完成 `gh issue close`；失败 comment + `afk-failed`。无 beads 式 parent epic，`closeEligibleParents` 为空操作。

## TAPD（`--source tapd`）

- **前置**：本机装好 `tapd-cli`（见 tapd-cli 技能）并配好 `TAPD_TOKEN` / `TAPD_API_ENDPOINT`。找不到命令直接报错退出，不会退化成空列表。
- **就绪判据**：`处理人=task.tapd.assignee` 且标签含 `readyLabel`（默认 `ready-for-agent`）且**不含**任何机器标签（`afk-claimed` / `afk-delivered` / `afk-failed`）。前两项服务端过滤，机器标签在本地排除。
- **队列就是标签**：人加 `ready-for-agent` 把需求交给机器，人撤销它表示需求离开机器的手。
- **状态流转（由循环自动执行）**：
  - 开始：加 `afk-claimed`（出队即锁）
  - 完成：撤 `afk-claimed` + 加 `afk-delivered` + 评论 `[AFK] 开发完成，请验收。` + `提交：<短 hash>`
  - 失败：撤 `afk-claimed` + 加 `afk-failed` + 评论 `[AFK] 失败：…`
- **执行批次不写状态，也不写处理人**：TAPD 的状态与处理人属于人和策划的流程，验收流转由人做。见 [ADR-0002](../../../docs/adr/0002-tapd-transport-is-the-cli.md) / [ADR-0003](../../../docs/adr/0003-labels-are-the-tapd-queue.md)。
- **重跑**：撤销 `afk-delivered` 或 `afk-failed` 即可。`ready-for-agent` 一直挂着，需求自动重新入队。
- **多开安全**：同一项目的两份拷贝各自跑 watcher 时不会同时接单——谁先加上 `afk-claimed`，需求就从另一个环境的就绪池里消失。
- **命令细节**：所有 tapd-cli 参数必须用**下划线**（`entry_id` 而非 `entry-id`）；连字符形式会被静默丢弃，把带过滤的查询变成不带过滤的查询。

## 通用语义

- `listReady()` 只返回**就绪**（无未完成前置）且**按优先级排好**的工单；loop 不做任何排序。
- 失败任务通过 `afk-failed` 标记排除出就绪池；**宁可漏跑，不可重跑**。

## 认领（tryClaim）

`tryClaim(id)` 返回 `{ status, claimMode }`。`claimMode` 是 `atomic`、`best-effort` 或 `unsupported`。`status` 是 `claimed`、`already-claimed`、`unsupported` 或 `error`。

- **beads**：`claimMode` 为 `atomic`。`bd update --claim` 成功是 `claimed`（同一 actor 重复认领仍是 `claimed`）；其它 actor 已认领时是 `already-claimed`。
- **GitHub**：`claimMode` 为 `best-effort`。已有 `in-progress` 标签则 `already-claimed`，否则加标签并返回 `claimed`。两次添加之间没有比较并交换。
- **TAPD**：`claimMode` 为 `best-effort`。就绪由标签决定；`tryClaim` 加上 `afk-claimed` 标签，需求随即离开**所有**执行环境的就绪池。已带机器标签时返回 `already-claimed`，并在 message 里说明该撤销哪个标签。

afk-run 批次仍调用 `markInProgress`。watcher 在启动批次前调用 `tryClaim`；若工单因此离开就绪列表，watcher 会把该 id 作为 `--pinned-id` 传给这一次 afk-run（同一批次内每个 pinned id 只处理一次，不会被反复注入队列）。
