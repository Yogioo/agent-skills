# afk-run 配置

配置文件：技能根 `config.json`。优先级：**CLI > env > config > 内置**。

## 字段

| 字段 | 默认 | 说明 |
|---|---|---|
| `source` | `beads` | 任务源 adapter 名 |
| `workdir` | `''` | 目标工作区（CLI `--workdir` 必传或配置） |
| `maxTasks` | `0` | 全局任务数上限；0 = 不限（但停止文件/熔断仍生效） |
| `maxFailures` | `3` | 连续失败熔断阈值；0 = 不熔断 |
| `retry` | `1` | 每任务失败重试次数（最多执行 1+retry 次） |
| `allowDirty` | `false` | 启动时工作区有未提交改动时放行（默认拒绝） |
| `stopFile` | `''` | 停止文件路径；空 = 默认 `workdir/afk-stop` |
| `gitIdentity.name` | `AFK Bot` | 自动 init 时配置的 local git 身份 |
| `gitIdentity.email` | `afk@local` | 同上 |
| `execReview.timeout` | `600` | 每阶段（执行/审查）超时秒数，0 = 无（不推荐 AFK） |
| `execReview.hardTimeoutExtra` | `120` | loop 层兜底超时 = timeout + 该值（防 exec-review 自身挂死） |
| `execReview.runner` / `executorRunner` / `reviewerRunner` | `''` | 透传 exec-review 的 runner |
| `execReview.executorModel` / `reviewerModel` / `executorThinking` / `reviewerThinking` | `''` | 透传 exec-review 模型配置 |

## 注意

- **no_change 算失败**：执行端回报"无改动"会走失败分支（重试→放弃），不会假装完成。
- **失败任务打 `afk-failed` label**（beads）：listReady 不再拉取；人工去掉 label 可重试。
- **超时语义**：主超时在 exec-review 层（AbortController 杀进程树）；loop 层兜底只防 exec-review 自身挂死。