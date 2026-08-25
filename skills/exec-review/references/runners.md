# Runners（执行引擎）

`run-task.mjs` 的执行流程与摘要契约不绑定具体 CLI。一次 agent turn 通过 **runner** 完成。单次任务 = 一次执行 turn + 一次审查 turn（审查端直接改进，不循环）。两端都只改工作区文件、**不提交**（提交由调用方负责）。

默认值优先读技能根 [`config.json`](../config.json)（见 [config.md](config.md)）；未配置时内置默认 **codex**。

## 选择

| runner | 二进制默认 | 说明 |
|--------|------------|------|
| `codex`（默认） | `codex` / `$CODEX_BIN` | `codex exec`；支持 `--output-schema` 与 `-s` sandbox；`thinking` → `-c model_reasoning_effort=…` |
| `pi` | `pi` / `$PI_BIN` | `pi -p --no-session`；用 `@promptFile` 喂入；`thinking` → `--thinking` |
| `agent` | `agent` / `$AGENT_BIN` / `$CURSOR_AGENT_BIN` | Cursor CLI `agent -p`；用 prompt 文件指针喂入；`thinking` → 折进 `--model …[effort=…]` |

执行端与审查端可以不同 runner（`executor.runner` / `reviewer.runner`，或 `--executor-runner` / `--reviewer-runner`）。

## 模型与思考

- `model` 为空：不传 `-m` / `--model`，使用该 CLI 自己的默认模型
- `thinking` 为空：不传思考相关参数
- pi 另可选 `provider`（`--provider`）
- **agent**：仅当同时有 `model` 时才应用 `thinking`（写成 `model[effort=…]`）；已有 `effort=` 则不覆盖

## 其它参数

- `--bin` / 角色级 `--executor-bin`：覆盖可执行文件
- `--sandbox …`：
  - Codex：原样传给 `-s`
  - pi：在 `read-only` 或 `role=reviewer` 时 `--exclude-tools write,edit`
  - agent：`read-only` → `--mode ask`；`danger-full-access` → `--sandbox disabled`；其余 → `--sandbox enabled`
- `--dry-run`：不真正调用 CLI，只验证脚本与缓存布局
- `--codex-bin`：兼容旧参数（当作 bin 覆盖）

## pi 注意

- 默认带 `--approve`（可用 `--no-approve` / config `approve: false` 关闭）
- 无 `--output-schema`；靠 prompts 要求 JSON + 脚本 `extractJson`

## agent 注意

- 非交互：始终 `--trust`；`approve` 为 true（默认）时加 `--force` 与 `--approve-mcps`
- 无 `--output-schema`；靠 prompts 要求 JSON + 脚本 `extractJson`
- 长 prompt 通过「打开 prompt 文件」短指令喂入，避免 Windows 命令行长度限制
- Windows 下优先解析 `%LOCALAPPDATA%\cursor-agent\versions\<最新>\index.js`，避免 `.cmd`/PowerShell 包装器 + 管道 stdio 出问题

## 扩展新 runner

在 `scripts/runners/` 增加模块，实现：

```js
{
  name: '…',
  runTurn({ role, workdir, prompt, promptFile, outFile, logFile, schemaFile, sandbox, model, provider, thinking, dryRun })
}
```

并在 `scripts/runners/index.mjs` 注册。
