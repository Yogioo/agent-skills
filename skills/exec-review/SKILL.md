---
name: exec-review
description: '对一段任务说明跑执行→审查（可插 runner，默认 Codex，可选 pi；exec/review 可分别配置）。审查端在同一工作区直接改进，无需执行端新开上下文回炉。git 仓库默认允许执行端提交，`gitCommit: false` 或非 git 场景由调用方提交。日志进缓存，标准输出只给摘要。用户给出任务文本或任务文件时加载。'
---

# 执行审查（单次任务）

对**一段任务说明**：**执行 → 审查** 一次运行即可。审查发现问题时由**审查端直接改进**，不把结论交回执行端新开上下文。

- **执行**：改工作区文件，报告简单 JSON outcome
- **审查**：对照任务说明与仓库规范，审查执行端改动涉及的文件并**直接改进**；若已干净则不改

**高度可复用：** 不假设目标目录是 git 仓库（改动检测用内容快照，跳过 `.git`/`node_modules`）。git 仓库默认允许执行端提交；`gitCommit: false` 或非 git 场景由调用方提交。让审查端直接改，是为了避免「审查端只报结论 → 执行端新开一次上下文处理」的低效往返。

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
node <技能根>/scripts/run-task.mjs --workdir <目录> --task-file <task.md>
node <技能根>/scripts/run-task.mjs --workdir <目录> --task-file <task.md> --runner pi
```

任务文本格式见 [references/task-format.md](references/task-format.md)。也可用：

```powershell
Get-Content task.md -Raw | node …/run-task.mjs --workdir <目录> --stdin
node …/run-task.mjs --workdir <目录> --id 可选标签 --title "…" --body "…" --requirements "…"
```

常用可选参数：`--config`、`--runner` / `--executor-runner` / `--reviewer-runner`、`--model` / `--thinking`（及角色级变体）、`--bin`、`--provider`（pi）、`--git-commit <true|false>`、`--cache-dir`、`--sandbox`、`--dry-run`、`--no-open`。`--codex-bin` 仍兼容。

进度相关：`--no-serve` / `--port` / `--return-level` / `--heartbeat-ms` / `--progress-file`（额外镜像一份进度流，不替换自身 `progress.jsonl`）。

优先级：**CLI > 环境变量 > config.json > 内置**。`model` / `thinking` 留空则不传，使用各 CLI 默认。

Shell 等待时间设长（常见数分钟到十余分钟）。同一工作区同一时间只跑一个本脚本。

## 通信格式（简洁、清晰）

两端都返回**一个简单 JSON 对象**：

- **执行端**：`{"status":"done|no_change|blocked|empty","taskId":"…","note":"可选"}`
- **审查端**：`{"status":"clean|refined","note":"可选"}`

## 实时进度（用户可视化）

loop 会启动一个**独立进程**（`scripts/serve.mjs`）提供实时进度页：进度条、当前阶段（执行 / 审查）、阶段时间线、存活心跳、实时日志。URL 在 stderr 打印，也在摘要 `serveUrl` 字段里。**默认启动后会自动调用系统 `open` 打开默认浏览器**（`--no-open` 关掉；`EXEC_REVIEW_OPEN_BROWSER=0` 或 config `openBrowser:false` 亦可）。

- **推荐后台运行**：`nohup node …/run-task.mjs … &`（PowerShell 用 `Start-Process`），并**把 `serveUrl`/URL 交给用户打开网页查看**。前台直接跑虽然也能看，但日志输出容易被忽略，且一旦命令行进程被中止，serve 会随之消亡、网页就没了。
- `--no-serve` 关掉服务；`--port` 指定端口（默认按 workdir 派生）；`--no-open` 只关自动打开（URL 仍打印）。
- 事件流落在 `<runDir>/progress.jsonl`（单条 append-only，带 `level`）。

## 渐进式披露（给调用方 Agent）

给上层/后续 agent 的摘要保持**极简**：默认只回 `serveUrl` + `progressFile` 两个指针，不塞冗余事件。需要细节时按需拉取：`--return-level <0-3>` 会把 `level <= N` 的事件作为 `progress` 附进摘要，或直接读 `progressFile`。

## 读结果

- **标准输出**：仅摘要 JSON（含 `status`、`changedFiles`、`reviewChangedFiles`、`summary`、`review`、`outcome`）
- **`cacheDir`**：`task.md`、`settings.json`（本次实际生效配置）、执行与审查的提示词/输出/日志、`main.log`
- git 仓库且 `gitCommit` 为 `true` 时，执行端可在完成后自行提交；`gitCommit: false` 或非 git 场景的改动由调用方提交

| `status` | 含义 / 下一步 |
|----------|--------------|
| `approved` | 执行已实现，审查端（可能）直接改进后通过 → 向用户汇报通过（提交行为按 `gitCommit` 模式决定） |
| `no_change` | 无需改代码（执行端回报 done 但工作区无改动） |
| `blocked` / `empty` | 执行端做不完 / 无事可做 → 记录原因；`blocked` 考虑升级问人 |
| `executor_failed` / `error` | 先看 `cacheDir`，查清再开下一次 |

单次运行**不循环回炉**：审查端在同一工作区直接改，所以不存在「执行端新开上下文处理审查意见」这一步。若审查端发现必须大改、超出单次改进范围，可在 `review.note` 说明，由上层决定是否新开一次任务。

摘要 JSON 固定含 `serveUrl` + `progressFile` 指针（渐进式披露，不塞冗余）。

## 多次任务

需要一张接一张跑时：由上层准备任务文件、串行调用本脚本、读摘要并决定是否问人。复用面就是本脚本的输入格式 + 摘要 JSON（不必改核心流程）。

## 目录

- `config.json` — 默认 runner / 模型 / 思考等级（exec、review 可分开）+ gitCommit + serve / returnLevel / heartbeatMs
- `scripts/run-task.mjs` — 入口（单次 执行→审查；按 `gitCommit` 注入 git 只读上下文与执行端提交规则）
- `scripts/workspace.mjs` — 内容快照改动检测
- `scripts/progress.mjs` — 单条进度事件流（level + 心跳）
- `scripts/serve.mjs` — 独立实时进度服务（SSE → HTML，两阶段视图）
- `scripts/runners/` — `codex` / `pi` adapters
- `prompts/executor.md`、`prompts/reviewer.md`（审查端直接改、不提交）
- `schemas/outcome.schema.json`、`schemas/review.schema.json`
- `references/config.md`、`references/runners.md`、`references/task-format.md`
