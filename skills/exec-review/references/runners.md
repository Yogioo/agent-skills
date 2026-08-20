# Runners（执行引擎）

`run-task.mjs` 的循环逻辑与摘要契约不绑定具体 CLI。一次 agent turn 通过 **runner** 完成。

默认值优先读技能根 [`config.json`](../config.json)（见 [config.md](config.md)）；未配置时内置默认 **codex**。

## 选择

| runner | 二进制默认 | 说明 |
|--------|------------|------|
| `codex`（默认） | `codex` / `$CODEX_BIN` | `codex exec`；支持 `--output-schema` 与 `-s` sandbox；`thinking` → `-c model_reasoning_effort=…` |
| `pi` | `pi` / `$PI_BIN` | `pi -p --no-session`；用 `@promptFile` 喂入；`thinking` → `--thinking` |

执行端与审查端可以不同 runner（`executor.runner` / `reviewer.runner`，或 `--executor-runner` / `--reviewer-runner`）。

## 模型与思考

- `model` 为空：不传 `-m` / `--model`，使用该 CLI 自己的默认模型
- `thinking` 为空：不传思考相关参数
- pi 另可选 `provider`（`--provider`）

## 其它参数

- `--bin` / 角色级 `--executor-bin`：覆盖可执行文件
- `--sandbox …`：Codex 原样传给 `-s`；pi 在 `read-only` 或 `role=reviewer` 时 `--exclude-tools write,edit`
- `--dry-run`：不真正调用 CLI，只验证脚本与缓存布局
- `--codex-bin`：兼容旧参数（当作 bin 覆盖）

## pi 注意

- 默认带 `--approve`（可用 `--no-approve` / config `approve: false` 关闭）
- 无 `--output-schema`；靠 prompts 要求 JSON + 脚本 `extractJson`

## 扩展新 runner

在 `scripts/runners/` 增加模块，实现：

```js
{
  name: '…',
  runTurn({ role, workdir, prompt, promptFile, outFile, logFile, schemaFile, sandbox, model, provider, thinking, dryRun })
}
```

并在 `scripts/runners/index.mjs` 注册。
