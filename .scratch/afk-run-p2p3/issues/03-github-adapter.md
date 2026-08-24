# 03 — GitHub Issues adapter

**What to build:** `--source gh` 从 GitHub Issues 拉取就绪任务（P 标签映射优先级 + body task list 映射依赖），完成/失败回写 issue。loop 本体零改动（P1 接口 sealed 的证明）。

**Blocked by:** None — can start immediately.（实现上可复用 01 的 `recoverStale` 接口签名；本期可 no-op）

## 背景与现状

- P1 已确认的约定（对话中讲过、已认可）：
  - **优先级**：标签 `P0`~`P4`（0=Critical / 4=Backlog，无标签默认 P2）→ 升序 + number 升序排序。
  - **依赖**：body 里 task list：`- [ ] #N`（未完成）/ `- [x] #N`（完成）；ready = 所有引用项已勾选或对应 issue 已 close。同仓库限定（`owner/repo#N` 跨仓库本期不支持）。
  - **回写**：markInProgress=`edit --add-label in-progress`；markDone=`close --comment "afk: <status> — <摘要>"`；markFailed=`comment` + `--add-label afk-failed`。
- gh CLI 事实：`gh` 是真二进制（execFileSync 可直接用，无 bd 的 .cmd 问题）；rate limit 5000/h；`gh issue list --json number,title,body,labels` 可用。

## 方案

- **listReady**：`gh issue list --state open --json number,title,body,labels`（分页拉全量，`--limit 100` + 翻页）→ openSet 内存判断 blocker 状态（在 openSet = 未完成）→ 排序返回。
- **getDetail**：列表已含 body，直接复用（无需单独 view 调用）。
- **仓库来源**：`--repo owner/name` 参数，默认从 workdir 的 git remote 推断。
- **CLI 封装**：execFileSync + 网络错误重试 3 次（退避）；统一错误信息。
- **测试**：依赖/优先级解析纯函数单测；集成用 **fake gh 脚本注入 PATH**（不依赖真实 GitHub 网络，可断言调用序列与回写参数）。
- **文档**：references/task-sources.md 补 gh 约定（P 标签 + task list 写法）。

## 验收标准

- [ ] 测试仓库（fake gh）全链路：P 标签排序正确、`- [ ] #N` 阻塞过滤正确、`[x]` 解锁正确
- [ ] 完成/失败回写正确（close+comment / afk-failed 标签）
- [ ] 网络抖动重试（fake gh 模拟失败）
- [ ] loop 本体零改动
- [ ] 分页拉全量正确（>100 个 issue 场景）

## 待讨论/待验证

- `recoverStale` 的 gh 实现：`updatedAt` + in-progress label 近似（无原生 started 语义）vs 本期 no-op。
- 依赖引用指向已删除/不存在 issue 的处理（视为已满足？报错？）。
- fake gh 脚本的注入方式（PATH 前置 vs 配置项）。