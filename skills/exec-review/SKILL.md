---
name: exec-review
description: '对一段任务说明跑执行（可选再审查；runner 必填——由 `~/.afk/config.json` 的 `execReview.runner` 或 CLI/env 指定，example 给 pi，可选 codex / pi / agent；exec/review 可分别配置；默认 `review: false` 只执行，`--review true` 开启审查）。审查端在同一工作区直接改进，无需执行端新开上下文回炉。git 仓库默认允许执行端提交，`gitCommit: false` 或非 git 场景由调用方提交。日志进缓存，标准输出只给摘要。用户给出任务文本或任务文件时加载。'
---

# 执行审查（单次任务）

对**一段任务说明**：**执行**（默认）或 **执行 → 审查**（`review: true`）一次运行即可。审查发现问题时由**审查端直接改进**，不把结论交回执行端新开上下文。

- **执行**：改工作区文件，报告简单 JSON outcome
- **审查**（默认关，`--review true` 开启）：对照任务说明与仓库规范，审查执行端改动涉及的文件并**直接改进**

**高度可复用：** 不假设目标目录是 git 仓库——是 git 仓库就用 git 判改动（`git ls-files` + `git status`，只读真正脏了的文件），不是才退回内容快照遍历（跳过表默认只有版本控制元数据，项目自己的构建目录由 `execReview.workspaceSkip` 补）。git 仓库默认允许执行端提交；`gitCommit: false` 或非 git 场景由调用方提交。让审查端直接改，是为了避免「审查端只报结论 → 执行端新开一次上下文处理」的低效往返。

入口：本目录 `scripts/run-task.mjs`。**需要先有 `~/.afk/config.json`**（否则启动即报错，见下）。

- 配置：[`~/.afk/config.json`](references/config.md) 的 `execReview` 分区（`runner` 必填）— 详见 [references/config.md](references/config.md)
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
# runner=agent（Cursor CLI）
agent --version
agent status
```

**完成标准：** `node` 可用，且所选 runner 的 CLI 已就绪（Codex / agent 需已登录）；否则向用户报告具体阻塞。

## 调用

技能根目录即本文件夹。

```powershell
node <技能根>/scripts/run-task.mjs --workdir <目录> --task-file <task.md>
node <技能根>/scripts/run-task.mjs --workdir <目录> --task-file <task.md> --runner pi
node <技能根>/scripts/run-task.mjs --workdir <目录> --task-file <task.md> --runner agent
node <技能根>/scripts/run-task.mjs --workdir <目录> --task-file <task.md> --review true
```

任务文本格式见 [references/task-format.md](references/task-format.md)。也可用：

```powershell
Get-Content task.md -Raw | node …/run-task.mjs --workdir <目录> --stdin
node …/run-task.mjs --workdir <目录> --id 可选标签 --title "…" --body "…" --requirements "…"
```

常用可选参数：`--config`、`--runner` / `--executor-runner` / `--reviewer-runner`、`--model` / `--thinking`（及角色级变体）、`--bin`、`--provider`（pi）、`--git-commit <true|false>`、`--review <true|false>` / `--no-review`、`--cache-dir`、`--sandbox`、`--dry-run`、`--no-open`。`--codex-bin` 仍兼容。

进度相关：`--no-serve` / `--port` / `--return-level` / `--heartbeat-ms` / `--progress-file`（额外镜像一份进度流，不替换自身 `progress.jsonl`）。

优先级：**CLI > 环境变量 > `execReview` 分区（项目层 → 全局层）> 分区内其余字段的内置默认**。`model` / `thinking` 留空则不传，使用各 CLI 默认。

没有配置文件、或 `runner` 一处都没给，脚本直接 `exit 2` 并打印缺什么——不静默挑一个引擎。

Shell 等待时间设长（常见数分钟到十余分钟）。同一工作区同一时间只跑一个本脚本。

## 提示词覆盖（AFK home）

每个执行环境可在 AFK home（全局 `~/.afk/`，项目 `~/.afk/<名称>_<uid>/`）放**固定名字**的 markdown 定制角色提示词，由 `scripts/prompt-overlays.mjs` 装配（无配置键，约定优于配置）：

| 文件 | 作用 |
|---|---|
| `standards.md` | 非空时注入**两个角色**（全局 → 项目） |
| `executor.append.md` / `reviewer.append.md` | 追加到对应角色（全局 → 项目） |
| `executor.prompt.md` / `reviewer.prompt.md` | **整段替换**该角色基础模板（项目 → 全局 → 内置） |
| 缺失 / 空白 | 视为「没有」，跳过该层，不产生空段 |

每角色组装顺序：**base → standards → append → 渲染任务变量 → 强制 footer**。强制 footer（结论 JSON 契约 + git 分工）由代码追加，**整段替换也省略不掉** outcome / review 协议。

装配只在 exec-review 里做：`afk-watch` / `afk-run` 不感知提示词，也不需要额外参数（见 [ADR-0001](../../docs/adr/0001-separate-watcher-from-execution-run.md)）。审计本次实际收到的提示词：看 run cache 的 `executor.prompt.md` / `reviewer.prompt.md`，`main.log` 里另有一行 `prompt: ...` 记录 base 与用到的覆盖文件。

## 通信格式（简洁、清晰）

两端都返回**一个简单 JSON 对象**：

- **执行端**：`{"status":"done|no_change|blocked|empty","taskId":"…","note":"可选"}`
- **审查端**：`{"status":"clean|refined","note":"可选"}`（默认不跑；`review: true` 时才有）

## 实时进度（用户可视化）

loop 会启动一个**独立进程**（`scripts/serve.mjs`）提供实时进度页：进度条、当前阶段（执行 / 审查）、阶段时间线、存活心跳、实时日志。URL 在 stderr 打印，也在摘要 `serveUrl` 字段里。**默认启动后会自动调用系统 `open` 打开默认浏览器**（`--no-open` 关掉；`EXEC_REVIEW_OPEN_BROWSER=0` 或 config `openBrowser:false` 亦可）。

- **推荐后台运行**：`nohup node …/run-task.mjs … &`（PowerShell 用 `Start-Process`），并**把 `serveUrl`/URL 交给用户打开网页查看**。前台直接跑虽然也能看，但日志输出容易被忽略，且一旦命令行进程被中止，serve 会随之消亡、网页就没了。
- **同一 workdir 串行**：新 run 启动时会读取 `%TEMP%/exec-review/locks/<hash>.json`，自动 `taskkill` 上一轮残留的 **run-task + serve** 进程树，并释放占用的进度端口（避免网页仍显示旧工单）。
- `--no-serve` 关掉服务；`--port` 指定端口（默认按 workdir 派生）；`--no-open` 只关自动打开（URL 仍打印）。
- 事件流落在 `<runDir>/progress.jsonl`（单条 append-only，带 `level`）。

## 渐进式披露（给调用方 Agent）

给上层/后续 agent 的摘要保持**极简**：默认只回 `serveUrl` + `progressFile` 两个指针，不塞冗余事件。需要细节时按需拉取：`--return-level <0-3>` 会把 `level <= N` 的事件作为 `progress` 附进摘要，或直接读 `progressFile`。

## 读结果

- **标准输出**：仅摘要 JSON（含 `status`、`changedFiles`、`reviewChangedFiles`、`summary`、`review`、`outcome`）
- **`cacheDir`**：`task.md`、`settings.json`（本次实际生效配置）、执行与审查的提示词/输出/日志、`*.events.jsonl`（agent runner 结构化事件）、`main.log`
- git 仓库且 `gitCommit` 为 `true` 时：执行端/审查端自行 commit；`gitCommit: false` 或非 git 场景由调用方提交。提交格式不在本技能范围。

| `status` | 含义 / 下一步 |
|----------|--------------|
| `approved` | 执行已实现，审查端（可能）直接改进后通过（需 `review: true`） |
| `done` | 执行已实现且未跑审查（默认，或显式 `review: false`） |
| `no_change` | 无需改代码（执行端回报 done 但工作区无改动，或直接回报 no_change）。若需求已由现有提交满足，note 里写可核实的提交号，上位 loop 据此关单 |
| `blocked` / `empty` | 执行端做不完 / 无事可做 → 记录原因；`blocked` 考虑升级问人 |
| `executor_failed` / `error` | 先看 `cacheDir`，查清再开下一次 |

单次运行**不循环回炉**：审查端在同一工作区直接改，所以不存在「执行端新开上下文处理审查意见」这一步。若审查端发现必须大改、超出单次改进范围，可在 `review.note` 说明，由上层决定是否新开一次任务。

摘要 JSON 固定含 `serveUrl` + `progressFile` 指针（渐进式披露，不塞冗余）。

## 多次任务

需要一张接一张跑时：由上层准备任务文件、串行调用本脚本、读摘要并决定是否问人。复用面就是本脚本的输入格式 + 摘要 JSON（不必改核心流程）。

## 目录

- `~/.afk/config.json` 的 `execReview` 分区 — 默认 runner / 模型 / 思考等级（exec、review 可分开）+ `review` 开关 + gitCommit + sandbox + serve / returnLevel / heartbeatMs
- `scripts/run-task.mjs` — 入口（默认只执行；`review: true` 时再审查；`gitCommit` 时注入通用 git 指引）
- `scripts/commit-rules.mjs` — 仅 `gitCommit` 编排边界（何时 commit、BASE_HEAD、工作区干净）
- `scripts/workspace.mjs` — 工作区改动检测（git 模式 / walk 模式）
- `scripts/progress.mjs` — 单条进度事件流（level + 心跳）
- `scripts/progress-http.mjs` — 进度页 HTML + SSE（里程碑 + agent 结构化事件）
- `scripts/normalize-event.mjs` — 三 runner JSONL → NormalizedEvent（统一入口）
- `scripts/serve.mjs` — 独立实时进度服务（SSE → HTML，两阶段视图）
- `scripts/runners/` — `codex` / `pi` / `agent` adapters
- `scripts/prompt-overlays.mjs` — AFK home 提示词覆盖（standards / append / 整段替换 + 强制 footer）
- `prompts/executor.md`、`prompts/reviewer.md`（角色主体；结论契约与 git 分工在 `prompt-overlays.mjs` 的强制 footer 里）
- `schemas/outcome.schema.json`、`schemas/review.schema.json`
- `references/config.md`、`references/runners.md`、`references/task-format.md`
