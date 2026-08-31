---
name: afk-run
description: AFK（无人值守）任务执行循环。从任务源（默认 beads）拉取「就绪且优先级最高」的工单，逐个驱动 exec-review 执行→审查，循环负责回滚与护栏，结束出报告。用户需要无人值守跑完一批任务时加载。
---

# AFK 循环（无人值守任务执行）

在 exec-review（单次 执行→审查）外层套**确定性循环**：任务源 → 就绪+优先级排序 → 逐个执行 → 回滚/验收 → 报告。

## 完成标准 / 前置

- `node` 可用；使用 `--source beads` 时还需安装 `bd`（beads）且 workdir 能发现 `.beads` 库
- exec-review 技能在其兄弟目录（`../exec-review`）存在
- 目标 workdir 为 git 仓库（非 git 会自动 `git init`）；启动时要求工作区干净

## 调用

```powershell
node <技能根>/scripts/loop.mjs --workdir <目录>
node <技能根>/scripts/loop.mjs --workdir <目录> --max-tasks 5 --retry 0
node <技能根>/scripts/loop.mjs --workdir <目录> --timeout 600 --runner pi

`--workdir` 必传（由调用方/Agent 按当前任务目录传入，技能不配置固定目录）。
```

常用参数：`--source beads|gh`、`--repo owner/name`（gh 可选，默认从 workdir 的 git remote 推断）、`--max-tasks N`、`--max-failures N`、`--retry N`、`--stop-file <路径>`、`--allow-dirty`、`--dry-run`、`--no-serve`。提交身份默认用**用户全局 git**；需要机器人身份时加 `--use-bot-identity`（可配 `git.name` / `git.email` 或 `--git-name` / `--git-email`）。透传 exec-review：`--timeout`、`--runner`、`--executor-runner`、`--reviewer-runner`、`--executor-model`、`--reviewer-model`、`--executor-thinking`、`--reviewer-thinking`。

优先级：**CLI > env > config.json > 内置**。详见 [references/config.md](references/config.md)。

## 行为契约（确定性轨道）

- **任务选择**：`bd ready`（无未完成前置阻塞的工单）→ 过滤 **仅 `ready-for-agent` 标签** + **排除仍有 open 子 ticket 的 parent 容器** → `priority` 升序 + `id` 升序
- **每任务**：markInProgress → 生成 task.md → 调 exec-review（默认 `gitCommit: true`）→ 状态机
- **状态机**：`approved/done` → 校验工作区干净 → `markDone`（关子单）→ `closeEligibleParents`（beads：`bd epic close-eligible`）→ markDone 完成；失败路径不变
- **终止条件**：all-done / stuck（存在依赖阻塞）/ in-progress（只有进行中工单）/ max-tasks / 连续失败熔断（max-failures）/ 停止文件存在 / superseded（同 workdir 新 loop 抢占）

## 输出

- stdout：极简摘要 JSON（`reason/attempted/done/failed/runDir/reportFile/progressFile/serveUrl`）
- `<runDir>/report.md`：完成/失败表格 + 停止原因
- `<runDir>/loop-progress.jsonl`：loop 开始、队列、任务开始/结束、结束事件的审计流
- 默认 runDir：`%TEMP%/afk-run/run-<时间戳>`（`--cache-dir` 可改）

## 无人值守要点

- 停止开关：在 `--stop-file`（默认 workdir 下 `afk-stop`）放一个文件，下一轮循环即停
- 运行中可打开 stdout 摘要里的 `serveUrl` 查看只读看板；默认开启，`--no-serve` 可关闭。每个 exec-review 子任务仍固定关闭自己的 serve。
- 看板队列列：**就绪 / 进行中 / 阻塞 / 完成 / 失败**。`pipeline_snapshot` 每轮从 beads 拉取依赖阻塞工单（含 `blockedBy`）；**进行中**只展示可执行子 ticket（不含仍有 open 子级的 parent 容器，如 `2j9` vs `2j9.1`）。
- 总览页点击**已有 progress 文件**的工单（进行中/完成/失败）可跳转到同端口的 `/task/<id>`，即 exec-review 同款详情页（执行/审查阶段、日志、Agent 上下文）；阻塞/未启动工单无链接。
- **单实例**：同一 workdir 同时只允许一个 loop。新启动会先 **kill 旧 loop 进程树**（含 exec-review 子进程）及其看板，再注册自身；旧 loop 若仍在跑会在下一轮检测到 `superseded` 后退出
- 同一 workdir 复用固定端口时，**新 loop 会先停止上一轮注册的看板进程**，避免浏览器仍显示「已结束 · max-tasks」等陈旧终态；stdout 会打印当前 `run-<timestamp>` 目录名，请与看板页眉核对。
- 失败任务自动回滚，工作区保持干净基线；reset/clean 排除停止文件本身
- 中断重启：启动时一次性回收 `updated_at` 超过 `staleThresholdSec` 的 beads `in_progress` 工单，重置 open 并写审计 comment；默认阈值为 `2 × (timeout + hardTimeoutExtra)`，设为 `0` 可关闭
- 超时：exec-review 层 `--timeout` 为主；loop 层兜底 = timeout + `hardTimeoutExtra`（默认 120s）
