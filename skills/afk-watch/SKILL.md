---
name: afk-watch
description: 长时间轮询任务源，有就绪工单时启动一次 afk-run 执行批次并等待结束；也管整台机器的只读总览页（待人工处理 / 所有需求 / 执行环境）。用户要持续无人值守处理队列、启动 watcher、要求 atomic claim，或要看「什么在等我」时加载。
disable-model-invocation: true
---

# Watcher（持续轮询并启动执行批次）

前台监督进程：轮询任务源，有就绪工单就启动**一次** `afk-run`，等它退出再轮询。执行、回滚、报告仍由 afk-run 负责。

## 完成标准 / 前置

- `node` 可用
- 目标 workdir 存在；是 git 仓库时工作区要干净，除非 `--allow-dirty`
- 同目录的 afk-run 技能在 `../afk-run`

完成标准：后台启动后 `--status` 报 `running: true`；停止后注册表被释放，且只清理本次登记的子进程和看板。

## 总览页（整台机器一张，不属于某一个 workdir）

上面的看板是**一个 workdir 一张**，随 watcher 一起生灭。总览页回答的是另一个问题——「什么在等我」——所以它要跨 workdir、也要比 watcher 活得久（见 [ADR-0009](../../docs/adr/0009-human-surface-is-one-page.md)）：

```powershell
node <技能根>/scripts/start-overview.mjs [--port <端口>]
node <技能根>/scripts/start-overview.mjs --status
node <技能根>/scripts/start-overview.mjs --stop
```

三种模式与传统启动器一样只输出单行 JSON：`0` 成功 / `1` 启动后立刻退出（读 `logTail`）/ `2` 参数问题 / `3` 已在跑（复用输出里的 `pid`）/ `4` 没在跑。启动输出里的 `url` 就是给人打开的地址。常用参数：`--port`、`--cache-dir`。

三个区块：**待人工处理**（叫不醒的需求 / 无主事件 / 唤醒环已放弃的事件 / 叫醒了但一直没处理完的事件）、**需求**、**执行环境**（watcher phase、pool 计数、陈旧标记），最后是**最近唤醒**（drain 每轮的结论：敲了什么、为什么没敲）。默认 5 秒自动刷新，`?static=1` 关掉。

它只读收件箱、需求本子、唤醒记录（`<AFK home>/wake-log.jsonl`）、watcher 与 loop 注册表——**不读 `config.json`**，task source 的凭据不会流进浏览器。注册表还在、进程已死的会标成**陈旧**，不谎报在跑。

它**不替代**上面那份 per-workdir 看板（ADR-0005），只是在它之外多一个跨环境的视图。

## 调用

默认**后台启动**，watcher 不占人的终端；三种模式都只输出单行 JSON：

```powershell
node <技能根>/scripts/start-background.mjs --workdir <目录> [watcher 参数...]
node <技能根>/scripts/start-background.mjs --status --workdir <目录>
node <技能根>/scripts/start-background.mjs --stop   --workdir <目录>
```

- `--status` 回答「在不在跑、卡在哪一阶段、看板在哪、队列还剩什么」；退出码 `0` 在跑、`4` 没在跑。
- `--stop` 写停止文件，watcher 下个轮询周期退出并释放注册表。
- `3` 表示已有 watcher 在跑：复用输出里的 `pid`，不要另起一个；`1` 表示刚启动就退出，读输出的 `logTail` 排障。
- 其余退出码与字段清单是 `start-background.mjs --help` 的活，脚本自身权威。

要盯着控制台行或调试时用前台等价入口：

```powershell
node <技能根>/scripts/watch.mjs --workdir <目录>
<技能根>/start-watch.bat --workdir <目录>
node <技能根>/scripts/watch.mjs --stop --workdir <目录>
```

前台入口与后台启动器共用同一套语义（单实例注册表、停止文件、看板归属）；`start-watch.bat` 把全部参数转给 `node scripts/watch.mjs`。

常用参数：`--source`、`--repo`、`--max-tasks`、`--poll-interval`、`--require-atomic-claim`、`--stop-file`、`--allow-dirty`、`--no-serve`、`--dry-run`、`--requirement <需求 id>`。配置见 [`~/.afk/config.json`](references/config.md)（本项目读 `task` + `watch` 分区；技能根没有配置文件；两层都缺就报错，不做兜底）。任务源认领语义见 [../afk-run/references/task-sources.md](../afk-run/references/task-sources.md)。

执行端 / 审查端的提示词可由操作者按执行环境定制：放在 AFK home 同层的 `standards.md` / `*.append.md` / `*.prompt.md`，由 `exec-review` 装配——watcher 不感知提示词，也不需要额外参数（见 [../exec-review/SKILL.md](../exec-review/SKILL.md) 的「提示词覆盖」与 [ADR-0001](../../docs/adr/0001-separate-watcher-from-execution-run.md)）。

## 行为

1. 校验 workdir。不干净且未放行则退出。完成标准：未启动轮询。
2. 读取任务源的 `claimMode`。`--require-atomic-claim` 且不是 `atomic` 时，在启动执行批次之前退出。完成标准：没有 afk-run 子进程。
3. 占用本 workdir 的 watcher 注册表。另一个活着的 watcher 已占用时退出。完成标准：注册表 pid 是当前进程。
4. 轮询 Work-item pool（优先 `describeBlocked()`，否则 `listReady()`）。ready 为空则等待 `pollIntervalMs`。远程 in-progress 不作为本地锁。完成标准：仍有其它就绪工单时会启动执行批次。
5. 有就绪工单则 `tryClaim`。`already-claimed` 跳过这一轮，下次轮询继续。`claimed` 后启动一次 afk-run，并把该工单作为 pinned id 传入。完成标准：同一时刻只有一个执行批次。
6. 任务源查询或认领出错时按有上限的指数退避等待。成功查询或批次结束后退避回到初始值。完成标准：等待不超过 `backoffMaxMs`。
7. Watcher 启动时拉起常驻看板（`--no-serve` 除外），打印 URL；阶段变化打控制台行。批次切换不重启页面。完成标准：空闲时页面仍可打开。
8. Ctrl+C、停止文件或 `--stop`：终止登记的子进程和看板，写最终事件，释放注册表。完成标准：注册表文件消失，未登记的 pid 不被杀掉。

事件与 `pool.json` 写在缓存目录的 `watch-run-*`（Watch session）。执行报告仍在 afk-run 的 run 目录。页面归属见仓库 [`docs/adr/0005-watcher-owns-the-status-page.md`](../../docs/adr/0005-watcher-owns-the-status-page.md)。
