# Runners（执行引擎）

`run-task.mjs` 的执行流程与摘要契约不绑定具体 CLI。一次 agent turn 通过 **runner** 完成。单次任务 = 一次执行 turn + 一次审查 turn（审查端直接改进，不循环）。`gitCommit: true` 时执行端/审查端自行 commit；否则不提交。提交格式不在 exec-review 范围。

默认值优先读技能根 [`config.json`](../config.json)（见 [config.md](config.md)）；未配置时内置默认 **codex**。

## 选择

| runner | 二进制默认 | 说明 |
|--------|------------|------|
| `codex`（默认） | `codex` / `$CODEX_BIN` | `codex exec --json`；`-o` / `--output-schema` 写最终消息；stdout JSONL → normalized events；`thinking` → `-c model_reasoning_effort=…` |
| `pi` | `pi` / `$PI_BIN` | `pi -p --no-session --mode json`；用 `@promptFile` 喂入；stdout JSONL → normalized events；`thinking` → `--thinking` |
| `agent` | `agent` / `$AGENT_BIN` / `$CURSOR_AGENT_BIN` | Cursor CLI `agent -p --output-format stream-json`；用 prompt 文件指针喂入；`thinking` → 折进 `--model …[effort=…]` |

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
- `--structured-context <true|false>` / `--no-structured-context`：进度页是否 tail normalized events（默认 true；false 时回退 legacy log 行 tail）
- `--stream-partial-output` / `--no-stream-partial-output`：agent runner 是否启用字符级 partial 流（默认 false）
- `--codex-bin`：兼容旧参数（当作 bin 覆盖）

## codex 注意

- 启用 `--json`：stdout 为 JSONL 事件流，经 adapter 写入 `*.events.jsonl`（normalized）；raw stdout 仍 tee 到 `*.log`
- 最终 outcome 仍由 `-o` / `--output-schema` 写入 `*.out.md`（与 Phase 1 前行为一致）；`run-task` 优先从 events 提取，失败时降级 `extractJson` + out 文件
- 进度页 context 面板与 agent runner 共用同一 normalized 卡片 UI

## pi 注意

- 默认带 `--approve`（可用 `--no-approve` / config `approve: false` 关闭）
- 使用 `--mode json`（非 `text`）：stdout JSONL → normalized events；最终 assistant 文本写入 `*.out.md`
- 无 `--output-schema`；靠 prompts 要求 JSON + `extractJsonFromEventsFile` / `extractJson` 降级
- 进度页 context 面板与 agent/codex 共用同一 normalized 卡片 UI

## agent 注意

- 非交互：始终 `--trust`；`approve` 为 true（默认）时加 `--force` 与 `--approve-mcps`
- 使用 `--output-format stream-json`；raw stdout 仍 tee 到 `*.log`，同时 append-only 写入 `*.events.jsonl`（normalized，供进度页 UI）
- 无 `--output-schema`；靠 prompts 要求 JSON；`run-task` 优先从 events 提取 outcome/review，失败时降级 `extractJson`
- 进度页 context 面板：tool 卡片（start/done 按 call id 合并，默认折叠）、assistant 文本、outcome
- 长 prompt 通过「打开 prompt 文件」短指令喂入，避免 Windows 命令行长度限制
- Windows 下优先解析 `%LOCALAPPDATA%\cursor-agent\versions\<最新>\{node.exe,index.js}`
- 可选 `--stream-partial-output`（config `streamPartialOutput` 或 `EXEC_REVIEW_STREAM_PARTIAL_OUTPUT`）：CLI 逐 delta 输出 assistant 文本，进度页合并为单卡片（不刷屏）
- **已知限制**：
  - **thinking 不可见**：各 CLI 的思考/推理块不会进入 normalized events 或进度页（agent 需 `--show-thinking` 且仅 json 格式，exec-review 未接入）
  - **tool schema 不稳定**：Cursor `stream-json` 的 `tool_call` 键名（如 `readToolCall`）与字段随 CLI 版本变化；normalize 层做 best-effort 映射，UI 对未知工具回退 JSON dump

## 扩展新 runner

在 `scripts/runners/` 增加模块，实现：

```js
{
  name: '…',
  runTurn({ role, workdir, prompt, promptFile, outFile, logFile, eventsFile, schemaFile, sandbox, model, provider, thinking, dryRun })
}
```

并在 `scripts/runners/index.mjs` 注册。
