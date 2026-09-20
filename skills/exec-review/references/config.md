# 配置（`~/.afk/config.json` 的 `execReview` 分区）

本技能不读技能根的任何配置文件。设置来自 `~/.afk/config.json` 的 `execReview` 分区（项目层 `~/.afk/<项目名_UID>/config.json` 覆盖全局层）。

**配置文件必须存在，`runner` 必须有来源**——两者缺一就直接报错退出，不猜引擎（内置只有一个错不了的 `runner` 默认值也没有）。

该文件由 [`afk-init`](../../afk-init/SKILL.md) 生成，字段菜单见 [`../../afk-init/config.example.json`](../../afk-init/config.example.json)；`workdir` 决定命中哪个项目层，必须由 `--workdir` 传入。

## 优先级（高 → 低）

1. CLI 参数（如 `--runner`、`--executor-model`、`--thinking`）
2. 环境变量（如 `EXEC_REVIEW_RUNNER`、`EXEC_REVIEW_EXECUTOR_MODEL`）
3. `execReview` 分区（项目层 → 全局层；角色段 → 顶层回落）
4. 分区内其余字段的内置默认（`model` / `thinking` 留空 = 不传，用各 CLI 自己的默认）

> `runner` 在第 1–3 层都没有时就报错：`未指定 executor runner：…`。所以 `execReview.runner` 留空、又不用 CLI / env 指定，是跑不起来的。

## 字段

```json
{
  "runner": "pi",
  "sandbox": "danger-full-access",
  "approve": true,
  "gitCommit": true,
  "review": false,
  "serve": true,
  "port": 0,
  "returnLevel": 0,
  "heartbeatMs": 10000,
  "structuredContext": true,
  "streamPartialOutput": false,
  "executor": {
    "runner": "",
    "bin": "",
    "model": "",
    "provider": "",
    "thinking": ""
  },
  "reviewer": {
    "runner": "",
    "bin": "",
    "model": "",
    "provider": "",
    "thinking": ""
  }
}
```

| 字段 | 含义 |
|------|------|
| `runner` | 顶层默认 CLI：`codex` \| `pi` \| `agent`；**必填**（或由 CLI / env 给），角色未写时回落这里 |
| `executor.*` / `reviewer.*` | 执行端 / 审查端各自覆盖 |
| `bin` | 可执行文件；空 = `codex` / `pi` / `agent`（或对应环境变量） |
| `model` | 模型 id；**空 = 不传，用 CLI 默认模型** |
| `provider` | 仅 pi：`--provider`；空 = 不传 |
| `thinking` | 思考等级；**空 = 不传**。pi → `--thinking`；codex → `-c model_reasoning_effort=…`；agent → 折进 `--model …[effort=…]`（需同时有 model） |
| `sandbox` / `approve` | 全局默认（仍可被 CLI 覆盖） |
| `gitCommit` | git 仓库中是否允许执行端/审查端自行 commit；默认 `true`，`false` 或非 git 场景由调用方提交 |
| `review` | 是否跑审查端；默认 `false`（只执行，定案 `done`，`review.status=skipped`）；`true` 时跑审查端 |
| `serve` | 是否启动独立实时进度服务（默认 `true`） |
| `port` | 进度服务端口；`0` = 由 workdir 自动派生（避免多工作区冲突） |
| `returnLevel` | 摘要里附带进度投影的深度；`0` = 不附带（极简） |
| `heartbeatMs` | 存活心跳间隔（毫秒） |
| `structuredContext` | 进度页是否使用 normalized events tail（默认 `true`；`false` 回退 legacy log 行 tail） |
| `streamPartialOutput` | agent runner 是否传 `--stream-partial-output`（默认 `false`）；启用后进度页合并 partial assistant 文本 |

> **注意（gitCommit 与 sandbox）**：执行端自行 `git commit` 需要能写入 `.git` 目录的沙箱。默认 `sandbox: "danger-full-access"` 可正常提交；若改用 `workspace-write`，`.git` 目录只读，执行端会报 `index.lock: Permission denied` 而 `blocked`（修复已完成但无法提交）。需要提交时请保持 `danger-full-access`。

`thinking` 常见取值（视模型而定）：`off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max`。

## 示例

以下是 `execReview` **分区的内容**（写进 `~/.afk/config.json` 时放在 `"execReview": { … }` 里）。

两边都用 Codex，审查用更高思考、不改模型（跟 Codex 配置默认）：

```json
{
  "runner": "codex",
  "executor": { "runner": "codex" },
  "reviewer": { "runner": "codex", "thinking": "high" }
}
```

执行用 Codex、审查用 pi：

```json
{
  "executor": { "runner": "codex" },
  "reviewer": { "runner": "pi", "provider": "deepseek", "thinking": "medium" }
}
```

两端都用 Cursor `agent`：

```json
{
  "runner": "agent",
  "executor": { "runner": "agent", "model": "composer-2.5" },
  "reviewer": { "runner": "agent", "model": "composer-2.5", "thinking": "high" }
}
```

## CLI 覆盖（常用）

- `--config <path>`：改用另一份完整 config.json（**只读它**，忽略 `~/.afk` 的两层）
- `--runner`：同时覆盖两端 runner（仍可被更细的角色参数盖住）
- `--executor-runner` / `--reviewer-runner`
- `--model` / `--executor-model` / `--reviewer-model`
- `--thinking` / `--executor-thinking` / `--reviewer-thinking`
- `--provider` / `--executor-provider` / `--reviewer-provider`
- `--git-commit <true|false>`：覆盖 `gitCommit`（环境变量为 `EXEC_REVIEW_GIT_COMMIT`）
- `--review <true|false>` / `--no-review`：覆盖 `review`（环境变量为 `EXEC_REVIEW_REVIEW`）

## 提示词覆盖（不在 `config.json` 里）

执行端 / 审查端的提示词按执行环境定制：固定名字的 markdown 放在 AFK home 同层（无配置键）。

| 文件 | 作用 |
|---|---|
| `standards.md` | 非空时注入两个角色（全局 → 项目） |
| `executor.append.md` / `reviewer.append.md` | 追加到对应角色（全局 → 项目） |
| `executor.prompt.md` / `reviewer.prompt.md` | 整段替换该角色基础模板（项目 → 全局 → 内置） |

组装顺序与强制 footer（结论 JSON 契约 + git 分工）见 [SKILL.md 的「提示词覆盖」](../SKILL.md)。

## 实时可视化（`serve`）

loop 运行时会启动一个**独立进程**（`scripts/serve.mjs`），把单条进度事件流 `progress.jsonl` 经 SSE 推给浏览器，渲染成**实时进度页**（进度条、阶段（执行/审查）、阶段时间线、存活心跳、实时日志）。

- 启动时在 stderr 打印 URL（也可从摘要 JSON 的 `serveUrl` 取）
- **同一 workdir 再次启动时**，会先回收上一轮残留的 run-task / serve 进程树并释放端口（锁文件：`%TEMP%/exec-review/locks/<hash>.json`）
- `--no-serve`：不启动；`--port <端口>`：指定端口（默认按 workdir 派生）
- `--heartbeat-ms <ms>`：心跳间隔

> 默认只执行；`--review true` 时再跑审查。`--max-rounds` 已废弃（仍被解析但不再影响行为）。改动检测用 `workspace.mjs` 的内容快照。

## 渐进式披露（给调用方 Agent）

所有观测者订阅**同一根** `progress.jsonl` 事件流，差异只在订阅深度。事件带 `level`（0=settle/heartbeat、1=run_start 运行里程碑、2=单步转换）。

- 默认摘要**只回指针**：`serveUrl` + `progressFile`，不塞冗余事件 → 目标上下文保持极简
- `--return-level <0-3>`：把 `level <= N` 的事件作为 `progress` 数组附进摘要（按需拉取，不默认推送）
- 需要更细时，直接读 `progressFile`（`scripts/progress.mjs` 的 `loadEvents`）
