---
name: exec-review
description: 对一段任务说明跑执行→审查循环：可插 runner（默认 Codex，可选 pi；exec/review 可分别配置）实现并审查；审查要求修改则回炉再执行，最多若干轮；日志进缓存，标准输出只给摘要。用户给出任务文本或任务文件时加载。
---

# 执行审查（单次任务）

对**一段任务说明**：先执行、再审查；需要修改时**回炉执行**（把审查意见交回执行端），直到通过或达到轮次上限。

- **执行**：改代码并提交（通常一次提交）
- **审查**：对照任务说明与仓库规范，只出结论，本阶段不改代码
- **回炉**：不是第三个角色；就是带着审查意见再跑一轮执行

入口：本目录 `scripts/run-task.mjs`。

- 默认配置：[config.json](config.json)（默认 **codex**）— 详见 [references/config.md](references/config.md)
- Runner 细节：[references/runners.md](references/runners.md)

## 开工前

按所选 runner 检查：

```powershell
node --version
# runner=codex（默认）
codex --version
codex login status
# runner=pi
pi --version
```

**完成标准：** `node` 可用，且所选 runner 的 CLI 已就绪（Codex 需已登录）；否则向用户报告具体阻塞。

## 调用

技能根目录即本文件夹。

```powershell
node <技能根>/scripts/run-task.mjs --workdir <仓库> --task-file <task.md> --max-rounds 3
node <技能根>/scripts/run-task.mjs --workdir <仓库> --task-file <task.md> --runner pi
```

任务文本格式见 [references/task-format.md](references/task-format.md)。也可用：

```powershell
Get-Content task.md -Raw | node …/run-task.mjs --workdir <仓库> --stdin
node …/run-task.mjs --workdir <仓库> --id 可选标签 --title "…" --body "…" --requirements "…"
```

常用可选参数：`--config`、`--runner` / `--executor-runner` / `--reviewer-runner`、`--model` / `--thinking`（及角色级变体）、`--bin`、`--provider`（pi）、`--cache-dir`、`--sandbox`、`--dry-run`。`--codex-bin` 仍兼容。

优先级：**CLI > 环境变量 > config.json > 内置**。`model` / `thinking` 留空则不传，使用各 CLI 默认。

Shell 等待时间设长（常见数分钟到十余分钟）。同一仓库工作区同一时间只跑一个本脚本。

## 读结果

- **标准输出**：仅摘要 JSON（含 `status`、`round`、`baseSha`、`cacheDir`、`summary`，以及可选的 `review`）
- **`cacheDir`**：`task.md`、`settings.json`（本次实际生效配置）、每轮提示词与日志、`main.log`

| `status` | 下一步 |
|----------|--------|
| `approved` | 向用户汇报通过 |
| `escalate` | 多轮仍未通过 → 问用户（接受现状 / 人工改 / 暂停） |
| `blocked` / `no_change` / `empty` | 记录原因；`blocked` 考虑升级问人 |
| `executor_failed` / `error` | 先看 `cacheDir`，查清再开下一次 |

## 多次任务

需要一张接一张跑时：由上层准备任务文件、串行调用本脚本、读摘要并决定是否问人。复用面就是本脚本的输入格式 + 摘要 JSON（不必改核心循环）。

## 目录

- `config.json` — 默认 runner / 模型 / 思考等级（exec、review 可分开）
- `scripts/run-task.mjs` — 入口
- `scripts/runners/` — `codex` / `pi` adapters
- `prompts/executor.md`、`prompts/reviewer.md`
- `schemas/outcome.schema.json`、`schemas/review.schema.json`
- `references/config.md`、`references/runners.md`、`references/task-format.md`
