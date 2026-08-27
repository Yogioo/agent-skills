# 任务源约定

afk-run 通过 adapter 消费任务源。**怎么写工单才能被正确消费**，两种源的约定如下。

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

## 通用语义

- `listReady()` 只返回**就绪**（无未完成前置）且**按优先级排好**的工单；loop 不做任何排序。
- 失败任务通过 `afk-failed` 标记排除出就绪池；**宁可漏跑，不可重跑**。
