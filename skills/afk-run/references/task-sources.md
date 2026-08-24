# 任务源约定

afk-run 通过 adapter 消费任务源。**怎么写工单才能被正确消费**，两种源的约定如下。

## beads（默认）

- **优先级**：`bd create "标题" -t task -p <0-4>`（0=Critical / 4=Backlog）。排序取数值升序。
- **依赖**：`bd dep add <被阻塞> <前置>`（即"B 依赖 A"=`bd dep add B A`）。只有所有前置都 closed 的工单才 ready。
- **状态流转（由循环自动执行）**：
  - 开始：`bd update <id> --claim`（置 in_progress）
  - 完成：`bd close <id> --reason "afk: <status> — <摘要>"`
  - 失败：`bd label add <id> afk-failed` + `bd comment <id> "afk failed: <原因>"`
- **重试失败任务**：去掉 `afk-failed` label 即可被重新拉取。
- **注意**：beads 的 AI 集成（AGENTS.md/钩子）可能让执行端自己 close 工单——loop 仍按自身判定流转，以 exec-review 结果为准。

## GitHub Issues（规划中，P3）

- **优先级**：约定标签 `P0`~`P4`（映射 0-4；无标签默认 P2）。
- **依赖**：issue body 里的 task list：`- [ ] #123` = 被 #123 阻塞（未完成），`- [x] #123` = 已完成。ready = body 中所有引用都已勾选/对应 issue 已 close。仅同仓库引用。
- **状态流转**：in-progress 标签 / close + comment / afk-failed 标签 + comment。

## 通用语义

- `listReady()` 只返回**就绪**（无未完成前置）且**按优先级排好**的工单；loop 不做任何排序。
- 失败任务通过 `afk-failed` 标记排除出就绪池；**宁可漏跑，不可重跑**。