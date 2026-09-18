---
name: afk-watch
description: 长时间轮询任务源，有就绪工单时启动一次 afk-run 执行批次并等待结束。用户要持续无人值守处理队列、启动 watcher、或要求 atomic claim 时加载。
disable-model-invocation: true
---

# Watcher（持续轮询并启动执行批次）

前台监督进程：轮询任务源，有就绪工单就启动**一次** `afk-run`，等它退出再轮询。执行、回滚、报告仍由 afk-run 负责。

## 完成标准 / 前置

- `node` 可用
- 目标 workdir 存在；是 git 仓库时工作区要干净，除非 `--allow-dirty`
- 同目录的 afk-run 技能在 `../afk-run`

完成标准：进程停在前台，停止后注册表被释放，且只清理本次登记的子进程和看板。

## 调用

```powershell
node <技能根>/scripts/watch.mjs --workdir <目录>
node <技能根>/scripts/watch.mjs --workdir <目录> --source gh --repo owner/name --require-atomic-claim
<技能根>/start-watch.bat --workdir <目录>
node <技能根>/scripts/watch.mjs --stop --workdir <目录>
```

Windows 也可用 `start-watch.bat`，它会把全部参数转给 `node scripts/watch.mjs`。

常用参数：`--source`、`--repo`、`--max-tasks`、`--poll-interval`、`--require-atomic-claim`、`--stop-file`、`--allow-dirty`、`--no-serve`、`--dry-run`。配置见 [`~/.afk/config.json`](references/config.md)（本项目读 `task` + `watch` 分区；技能根没有配置文件）。任务源认领语义见 [../afk-run/references/task-sources.md](../afk-run/references/task-sources.md)。

## 行为

1. 校验 workdir。不干净且未放行则退出。完成标准：未启动轮询。
2. 读取任务源的 `claimMode`。`--require-atomic-claim` 且不是 `atomic` 时，在启动执行批次之前退出。完成标准：没有 afk-run 子进程。
3. 占用本 workdir 的 watcher 注册表。另一个活着的 watcher 已占用时退出。完成标准：注册表 pid 是当前进程。
4. `listReady()` 为空则等待 `pollIntervalMs`。远程 in-progress 不作为本地锁。完成标准：仍有其它就绪工单时会启动执行批次。
5. 有就绪工单则 `tryClaim`。`already-claimed` 跳过这一轮，下次轮询继续。`claimed` 后启动一次 afk-run，并把该工单作为 pinned id 传入。完成标准：同一时刻只有一个执行批次。
6. 任务源查询或认领出错时按有上限的指数退避等待。成功查询或批次结束后退避回到初始值。完成标准：等待不超过 `backoffMaxMs`。
7. Ctrl+C、停止文件或 `--stop`：终止登记的子进程和看板，写最终事件，释放注册表。完成标准：注册表文件消失，未登记的 pid 不被杀掉。

事件写在缓存目录的 `watch-run-*` / `events.jsonl`。执行报告仍在 afk-run 的 run 目录。
