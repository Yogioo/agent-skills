# 配置（`config.json`）

技能根目录的 [`config.json`](../config.json) 声明**默认**执行引擎与模型相关选项。默认 runner 为 **codex**。

## 优先级（高 → 低）

1. CLI 参数（如 `--runner`、`--executor-model`、`--thinking`）
2. 环境变量（如 `EXEC_REVIEW_RUNNER`、`EXEC_REVIEW_EXECUTOR_MODEL`）
3. `config.json`（角色段 → 顶层回落）
4. 内置默认（`runner=codex`；`model` / `thinking` 不传，用各 CLI 自己的默认）

## 字段

```json
{
  "runner": "codex",
  "sandbox": "workspace-write",
  "approve": true,
  "gitCommit": true,
  "serve": true,
  "port": 0,
  "returnLevel": 0,
  "heartbeatMs": 10000,
  "executor": {
    "runner": "codex",
    "bin": "",
    "model": "",
    "provider": "",
    "thinking": ""
  },
  "reviewer": {
    "runner": "codex",
    "bin": "",
    "model": "",
    "provider": "",
    "thinking": ""
  }
}
```

| 字段 | 含义 |
|------|------|
| `runner` | 顶层默认 CLI：`codex` \| `pi` \| `agent`；角色未写时回落这里 |
| `executor.*` / `reviewer.*` | 执行端 / 审查端各自覆盖 |
| `bin` | 可执行文件；空 = `codex` / `pi` / `agent`（或对应环境变量） |
| `model` | 模型 id；**空 = 不传，用 CLI 默认模型** |
| `provider` | 仅 pi：`--provider`；空 = 不传 |
| `thinking` | 思考等级；**空 = 不传**。pi → `--thinking`；codex → `-c model_reasoning_effort=…`；agent → 折进 `--model …[effort=…]`（需同时有 model） |
| `sandbox` / `approve` | 全局默认（仍可被 CLI 覆盖） |
| `gitCommit` | git 仓库中是否允许执行端/审查端自行 commit；默认 `true`，`false` 或非 git 场景由调用方提交 |
| `serve` | 是否启动独立实时进度服务（默认 `true`） |
| `port` | 进度服务端口；`0` = 由 workdir 自动派生（避免多工作区冲突） |
| `returnLevel` | 摘要里附带进度投影的深度；`0` = 不附带（极简） |
| `heartbeatMs` | 存活心跳间隔（毫秒） |

> **注意（gitCommit 与 sandbox）**：执行端自行 `git commit` 需要能写入 `.git` 目录的沙箱。默认 `sandbox: "danger-full-access"` 可正常提交；若改用 `workspace-write`，`.git` 目录只读，执行端会报 `index.lock: Permission denied` 而 `blocked`（修复已完成但无法提交）。需要提交时请保持 `danger-full-access`。

`thinking` 常见取值（视模型而定）：`off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max`。

## 示例

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

- `--config <path>`：改用另一份配置文件
- `--runner`：同时覆盖两端 runner（仍可被更细的角色参数盖住）
- `--executor-runner` / `--reviewer-runner`
- `--model` / `--executor-model` / `--reviewer-model`
- `--thinking` / `--executor-thinking` / `--reviewer-thinking`
- `--provider` / `--executor-provider` / `--reviewer-provider`
- `--git-commit <true|false>`：覆盖 `gitCommit`（环境变量为 `EXEC_REVIEW_GIT_COMMIT`）

## 实时可视化（`serve`）

loop 运行时会启动一个**独立进程**（`scripts/serve.mjs`），把单条进度事件流 `progress.jsonl` 经 SSE 推给浏览器，渲染成**实时进度页**（进度条、阶段（执行/审查）、阶段时间线、存活心跳、实时日志）。

- 启动时在 stderr 打印 URL（也可从摘要 JSON 的 `serveUrl` 取）
- `--no-serve`：不启动；`--port <端口>`：指定端口（默认按 workdir 派生）
- `--heartbeat-ms <ms>`：心跳间隔

> 单次 执行→审查 无回炉循环；`--max-rounds` 已废弃（仍被解析但不再影响行为）。改动检测用 `workspace.mjs` 的内容快照。

## 渐进式披露（给调用方 Agent）

所有观测者订阅**同一根** `progress.jsonl` 事件流，差异只在订阅深度。事件带 `level`（0=settle/heartbeat、1=run_start 运行里程碑、2=单步转换）。

- 默认摘要**只回指针**：`serveUrl` + `progressFile`，不塞冗余事件 → 目标上下文保持极简
- `--return-level <0-3>`：把 `level <= N` 的事件作为 `progress` 数组附进摘要（按需拉取，不默认推送）
- 需要更细时，直接读 `progressFile`（`scripts/progress.mjs` 的 `loadEvents`）
