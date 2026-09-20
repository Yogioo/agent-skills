# AFK 配置（{{SCOPE}}）

> 本文件由 `afk-init` 生成/刷新；`config.json` 是四个 AFK 技能**唯一**的配置来源，改字段直接编辑它。
> 生成时间：{{GENERATED_AT}}　source：`{{SOURCE}}`　AFK home：`{{AFK_HOME}}`
> 本目录：`{{AFK_DIR}}`　workdir：`{{WORKDIR}}`

## 目录里有什么

| 文件 | 说明 |
|---|---|
| `config.json` | 唯一配置来源，分区见下 |
| `meta.json` | 本执行环境的元信息（workdir / projectKey / uid） |
| `README.md` | 本文件 |
| `standards.md`、`*.append.md`、`*.prompt.md` | 提示词覆盖，**按需自建**（见下） |

提示词覆盖文件 `afk-init` **不会**创建空壳：没有就是没有，prompt 走内置默认。

## config.json 分区

单文件分区，同一字段只出现一次：`task` 由 afk-watch / afk-run 共用，`watch` / `run` / `execReview` 各归其主。
项目层（`~/.afk/<label>_<uid>/config.json`）覆盖全局层（`~/.afk/config.json`），嵌套对象递归合并；文件里缺的键走内置默认。

### `task`（watch / run 共用）

| 字段 | 默认 | 说明 |
|---|---|---|
| `source` | `beads` | 任务源：`beads` / `gh` / `tapd` |
| `repo` | `''` | GitHub `owner/name`（`gh`；空则从 git remote 推断） |
| `maxTasks` | `1` | 一批最多处理几张单子；`0` = 不限（停止文件/熔断仍生效） |
| `maxFailures` | `3` | 连续失败熔断阈值；`0` = 不熔断 |
| `retry` | `1` | 单张单子失败后的重试次数 |
| `allowDirty` | `false` | 启动时工作区有未提交改动是否放行 |
| `stopFile` | `''` | 停止文件路径；空 = `<workdir>/afk-stop` |
| `tapd.*` | — | TAPD 标签队列：`assignee` / `readyLabel` / `claimedLabel` / `deliveredLabel` / `failedLabel` / `commentAuthor` |

### `watch`

| 字段 | 默认 | 说明 |
|---|---|---|
| `pollIntervalMs` | `15000` | 轮询间隔（毫秒） |
| `backoffInitialMs` / `backoffMaxMs` / `backoffFactor` | `1000` / `60000` / `2` | 查询/认领出错时的指数退避 |
| `requireAtomicClaim` | `false` | 只跑能原子认领的任务源（`beads` 为 `true`） |
| `serve.enabled` / `serve.port` / `serve.open` | `true` / `0` / `false` | watcher 常驻看板 |

### `run`

| 字段 | 默认 | 说明 |
|---|---|---|
| `hardTimeoutExtra` | `120` | loop 兜底超时 = `execReview.timeout` + 该值（秒） |
| `staleThresholdSec` | `2 × (execReview.timeout + hardTimeoutExtra)` | 启动时回收超期 in-progress 工单的阈值；`0` = 关闭 |
| `git.useBotIdentity` / `git.name` / `git.email` | `false` / `AFK Bot` / `afk@local` | 是否用机器人身份写 **local** git 配置 |
| `serve.enabled` / `serve.port` / `serve.open` | `true` / `0` / `false` | run 看板 |

### `execReview`

| 字段 | 默认 | 说明 |
|---|---|---|
| `runner` | `pi` | **必填**引擎：`codex` / `pi` / `agent`；留空又不用 CLI/env 指定会直接报错 |
| `review` | `false` | 是否跑审查端（`true` = 执行 → 审查） |
| `gitCommit` | `true` | git 仓库里是否允许两端自行 commit / amend |
| `sandbox` | `danger-full-access` | 需要提交时必须可写 `.git`；改 `workspace-write` 会让提交全部 `blocked` |
| `approve` | `true` | 传给 runner 的自动批准 |
| `timeout` | `600` | 每阶段超时秒数；`0` = 不限 |
| `serve` / `port` / `openBrowser` | `true` / `0` / — | 实时进度页 |
| `returnLevel` / `heartbeatMs` | `0` / `10000` | 摘要披露深度 / 存活心跳 |
| `structuredContext` / `streamPartialOutput` | `true` / `false` | 进度页上下文形态 |
| `executor.*` / `reviewer.*` | 空 | 角色级覆盖：`runner` / `bin` / `model` / `provider` / `thinking` |

完整字段说明与示例见各技能 `references/config.md`。

## 提示词覆盖（AFK home overlay）

执行端 / 审查端的提示词可以按执行环境定制：**固定文件名**放在本目录（与 `config.json` 同层），不需要改技能文件，也不需要新的配置键。

| 文件 | 作用 |
|---|---|
| `standards.md` | 非空时注入**两个角色**（项目专属规范写这里） |
| `executor.append.md` / `reviewer.append.md` | 追加到对应角色，不替换基础模板 |
| `executor.prompt.md` / `reviewer.prompt.md` | **整段替换**该角色的基础提示词 |
| 缺失 / 空白 | 视为「没有」，跳过该层，不产生空段 |

堆叠顺序（每个角色）：

1. base：项目 `*.prompt.md` → 全局 `*.prompt.md` → 技能内置模板
2. 注入 `standards.md`：全局 → 项目
3. 注入 `*.append.md`：全局 → 项目
4. 渲染任务变量（标题 / 正文 / 要求 / git 上下文）
5. 自定义替换也照常补上强制 footer（JSON 结论契约 + git 分工与 amend 规则）

「全局」= `~/.afk/`（或 `AFK_HOME`），「项目」= 本目录。同一角色同时存在时项目盖过全局。
覆盖只由 `exec-review` 组装；`afk-watch` / `afk-run` 不感知提示词，也不需要额外参数。

## 常用命令

```powershell
node <afk-watch>/scripts/watch.mjs --workdir {{WORKDIR}}
node <afk-run>/scripts/loop.mjs --workdir {{WORKDIR}} --max-tasks 1
node <exec-review>/scripts/run-task.mjs --workdir {{WORKDIR}} --task-file <task.md>
node <afk-init>/scripts/init-project.mjs --workdir {{WORKDIR}} --source {{SOURCE}} --force
```

配置检查：`config.json` 里的 `execReview.runner` 必须能解析到可执行文件；`sandbox` 必须允许写 `.git` 才能自动提交。
