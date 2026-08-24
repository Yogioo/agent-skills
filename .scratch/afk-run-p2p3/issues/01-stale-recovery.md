# 01 — 中断重启自动恢复（in-progress stale recovery）

**What to build:** 循环进程中断/崩溃后重启时，上一次运行卡在 `in_progress` 的工单自动识别为 stale 并重置回可拉取状态；循环启动即自愈，无需人工 `--reset-stale`。

**Blocked by:** None — can start immediately.

## 背景与现状

- P1 行为：重启后 `in_progress` 工单被 `bd ready` 天然排除（已验证）→ **永久卡死**，只能人工处理。当时约定"中断重启后面再讨论"，现定方案。
- 已实测的 beads 事实：
  - `bd update <id> --claim` 置 `in_progress`，且不再出现在 `bd ready`。
  - **`started_at` 语义是"首次进入 in_progress"，重置后再 claim 不刷新**（实测保留旧值）→ 不能用作 stale 判定。
  - `bd list --json` 含 `updated_at`，claim 时刷新 → **stale 判定用 `updated_at`**。
  - 重置命令：**`bd update <id> --status open`**（实测有效；`bd set-state <id> status=open` 只改 label 不改 status，不可用）。
- **前置假设（已定）**：单 loop —— 一个仓库同一时间只有一个 afk 循环在跑。多 loop / 真人认领后长期不更新工单的竞态不在本期范围。

## 方案

- **stale 判定（纯数据，无心跳）**：`status=in_progress` 且 `updated_at` 距今超过阈值 → stale。
- **阈值**：默认 `2 × (execReview.timeout + hardTimeoutExtra)`（单任务最坏时长 × 2 留缓冲），config 可配（如 `staleThresholdSec`，0 = 关闭自动恢复）。
- **重置**：`bd update <id> --status open` + `bd comment` 审计（"afk stale 自动重置: 卡了 N 分钟，updated_at=…"）。
- **放置**：adapter 接口加可选方法 `recoverStale(thresholdSec, now = Date.now)`（gh adapter 可 no-op，本期不实现）；loop 侧 `typeof source.recoverStale === 'function'` 才调用；**loop 启动装配后、runLoop 前调用一次**（非每轮）。
- **实现约定**：`now` 可注入（默认 `Date.now`）→ 单测造假时钟、集成测试用 `bd sql` 回拨 `updated_at` 拿确定性，**不靠长 sleep**。
- **失败语义**：recoverStale 抛错即 fail-fast（启动期与 listReady 一致，直接抛，不吞错）。
- 重置的工单下一轮 `listReady` 即可被正常拉取。
- **顺带修复**：`describeBlocked` 现在把 `in_progress` 算进 stuck 报告（语义误导，实为"进行中"非"阻塞"）；本期把它分成"进行中"与"阻塞"两类（recoverStale 后此问题更显眼，同文件顺手改）。

## 验收标准

- [ ] 造 in_progress 超阈值 → 重启循环 → 自动重置 + 被执行
- [ ] 未超阈值 → 保持跳过（不误重置）
- [ ] 阈值可配置；0 = 关闭（回归 P1 行为）
- [ ] 重置有审计 comment
- [ ] describeBlocked 报告把 in_progress 从 stuck 中分开（"进行中" ≠ "阻塞"）
- [ ] 单测：recoverStale 调用时机（fake adapter）+ beads 集成实测（真实 bd 命令）
- [ ] recoverStale 抛错 → 启动 fail-fast（不静默吞错）

## 待讨论/待验证

- 阈值默认值是否合适（2× 还是更大）。
- 重置后工单重新执行，若再次失败走 afk-failed（不会无限循环——有 max-failures 熔断兜底）。
- ~~多 loop 竞态~~ 已定：单 loop 前提，不在本期范围。
- ~~额外护栏（"仅回收上次运行前认领的工单"）~~ 已定：不加，保持纯数据判定。
- ~~gh adapter 的 recoverStale~~ 已定：本期 no-op，不实现。