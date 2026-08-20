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
  "maxRounds": 3,
  "approve": true,
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
| `runner` | 顶层默认 CLI：`codex` \| `pi`；角色未写时回落这里 |
| `executor.*` / `reviewer.*` | 执行端 / 审查端各自覆盖 |
| `bin` | 可执行文件；空 = `codex` / `pi`（或对应环境变量） |
| `model` | 模型 id；**空 = 不传，用 CLI 默认模型** |
| `provider` | 仅 pi：`--provider`；空 = 不传 |
| `thinking` | 思考等级；**空 = 不传**。pi → `--thinking`；codex → `-c model_reasoning_effort=…` |
| `sandbox` / `maxRounds` / `approve` | 全局默认（仍可被 CLI 覆盖） |

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

## CLI 覆盖（常用）

- `--config <path>`：改用另一份配置文件
- `--runner`：同时覆盖两端 runner（仍可被更细的角色参数盖住）
- `--executor-runner` / `--reviewer-runner`
- `--model` / `--executor-model` / `--reviewer-model`
- `--thinking` / `--executor-thinking` / `--reviewer-thinking`
- `--provider` / `--executor-provider` / `--reviewer-provider`
