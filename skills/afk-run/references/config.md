# afk-run 配置

优先级：**CLI > env > `--config` 文件 > `~/.afk/<项目名_UID>/config.json` > `~/.afk/config.json` > 内置**。

`<项目名_UID>` 中 UID 是 workdir 规范化绝对路径的 sha256 前 8 位，避免同名目录撞车。标签默认是文件夹名，init 时可改；加载时按 UID 匹配目录。

可用环境变量 `AFK_HOME` 改根目录（默认 `~/.afk`）。

**单文件分区**：同一字段只出现一次。`task` 由 afk-run / afk-watch 共用，`watch` / `run` / `execReview` 各归其主。本技能读 `task` + `run`，另借 `execReview.timeout` 算兜底超时。

项目层与全局层**递归**合并（项目覆盖全局，嵌套对象也合并）；都没有则用内置。

技能根没有配置文件。`~/.afk/config.json` 用 [`afk-init`](../../afk-init/SKILL.md) 的 `scripts/init-project.mjs` 生成（该技能 `disable-model-invocation`，需显式加载）；字段菜单见 [`../../afk-init/config.example.json`](../../afk-init/config.example.json)。

> `workdir` 不在此配置：必须由调用方通过 CLI `--workdir` 传入（Agent 按当前任务目录决定）。

## `task`（与 afk-watch 共用）

| 字段 | 默认 | 说明 |
|---|---|---|
| `task.source` | `beads` | 任务源 adapter 名 |
| `task.repo` | `''` | GitHub `owner/name`；空则从 workdir git remote 推断 |
| `task.maxTasks` | `0` | 全局任务数上限；0 = 不限（但停止文件/熔断仍生效）。afk-watch 的默认是 `1` |
| `task.maxFailures` | `3` | 连续失败熔断阈值；0 = 不熔断 |
| `task.retry` | `1` | 每任务失败重试次数（最多执行 1+retry 次） |
| `task.allowDirty` | `false` | 启动时工作区有未提交改动时放行（默认拒绝） |
| `task.stopFile` | `''` | 停止文件路径；空 = 默认 `workdir/afk-stop` |
| `task.tapd.*` | 空 | TAPD 认领映射，字段同 [afk-watch 配置](../../afk-watch/references/config.md) |

## `run`

| 字段 | 默认 | 说明 |
|---|---|---|
| `run.hardTimeoutExtra` | `120` | loop 层兜底超时 = `execReview.timeout` + 该值（防 exec-review 自身挂死） |
| `run.staleThresholdSec` | `2 × (execReview.timeout + run.hardTimeoutExtra)` | 启动时回收 `updated_at` 超过此秒数的 beads `in_progress` 工单；`0` = 关闭自动恢复 |
| `run.git.useBotIdentity` | `false` | 为 `true` 时写入 **local** `user.name` / `user.email`（机器人身份）；默认 `false`，提交沿用用户全局 git 身份 |
| `run.git.name` | `AFK Bot` | `useBotIdentity: true` 时的 local 提交名；CLI `--git-name` 可覆盖 |
| `run.git.email` | `afk@local` | `useBotIdentity: true` 时的 local 邮箱；CLI `--git-email` 可覆盖 |
| `run.serve.enabled` | `true` | 是否启动 loop 级只读实时看板；CLI `--no-serve` 可关闭 |
| `run.serve.port` | `0` | 看板端口；0 = 按 workdir 派生端口（基数 8700） |
| `run.serve.open` | `false` | 启动后是否自动打开浏览器；CLI `--no-open` 可关闭 |

## 借用的 `execReview.timeout`

| 字段 | 默认 | 说明 |
|---|---|---|
| `execReview.timeout` | `600` | 每阶段（执行/审查）超时秒数；loop 用它算兜底超时，实际执行上限由 exec-review 自己读同一分区。`0` = 无（不推荐 AFK） |

`execReview` 分区的其余字段（runner / 模型 / sandbox / review 开关等）归 [exec-review 配置](../../exec-review/references/config.md)，afk-run 不读也不透传——exec-review 启动时读的是同一份文件。afk-run 的 CLI 覆盖（`--runner`、`--executor-model` 等）仍会透传下去。

## 注意

- **git 身份**：默认**不**改仓库 local 配置，提交用用户全局身份。需要机器人提交时设 `run.git.useBotIdentity: true`（或 CLI `--use-bot-identity`），并可配 `run.git.name` / `run.git.email`。若某次 AFK 曾写入 local `AFK Bot`，用 `git config --local --unset user.name` / `user.email` 清掉即可恢复全局身份。
- **no_change 算失败**：执行端回报"无改动"会走失败分支（重试→放弃），不会假装完成。
- **失败任务打 `afk-failed` label**（beads）：listReady 不再拉取；人工去掉 label 可重试。
- **Parent 容器误进队列**：若 parent 仍带 `ready-for-agent` 且有 open 子 ticket，会被 beads adapter 跳过并在 stderr 打印 `[afk-run] beads: skipped ...`。
- **超时语义**：主超时在 exec-review 层（AbortController 杀进程树）；loop 层兜底只防 exec-review 自身挂死。
- **中断重启**：启动仅一次检查 stale；beads 使用 `updated_at`（而非首次 claim 后不刷新的 `started_at`），重置为 open 并写审计 comment。GitHub source 本期不回收。
- **实时看板**：URL 会写入 stdout 摘要的 `serveUrl`；看板仅读取 append-only 事件流，不提供停止按钮。停止仍通过 `stopFile` 完成。
