# afk-watch 看板计划

状态：**片 1–4 已实现**；片 5（跨 session 历史）未做。

术语见根目录 [`CONTEXT.md`](../CONTEXT.md)。页面归属见 [`docs/adr/0005-watcher-owns-the-status-page.md`](adr/0005-watcher-owns-the-status-page.md)。

## 问题

无人值守跑 Watcher 时，人处于盲飞状态。三处缺口：

1. **空闲时没有页面。** 页面只在 Execution run 期间存在：`startDashboard` 在 `spawnRun()` 内才调用，下一次 `spawnRun` 会先杀掉它。轮询占大部分时间，却没有页面进程。
2. **页面地址从不打印。** `loop-serve` 会打印 URL，但 Watcher 用 `stdio: 'ignore'` 起它，URL 被丢掉。`watch.serve.open` 默认 `false`，端口只能猜。
3. **Watcher 状态机没有渲染器。** 事件只写入 Watch session 的 `events.jsonl`，没有任何读者。

## 目标 / 非目标

**目标**
- Watcher 从启动到停止，任何时刻（含 `polling`、`backing-off`）都有可打开的页面。
- 页面能回答：它在干什么？等多久？Work-item pool 里有什么？上一批结果如何？
- 启动时打印页面 URL；Watcher phase 变化在控制台留痕。
- 不新增运行时依赖。
- 页面不查任务源；Watcher 每轮至多一次池子查询（优先 `describeBlocked()`）。

**非目标**
- 不重写 Execution run 内部渲染——扩展现有 `loop-serve`。
- 不做跨 Execution environment（workdir）聚合。**已由 [ADR-0009](adr/0009-human-surface-is-one-page.md) 推翻**：总览页是另一个页面，不是这个页面的；这个页面仍然只管它自己那个 workdir。
- 不做远程访问/鉴权（仍绑 `127.0.0.1`）。

## 页面区块

| 区块 | 内容 |
|---|---|
| **Watcher phase** | `polling` / `backing-off` / `running` / `stopping` / `stopped` + 已持续多久。`idle` / `claim_skipped` 是事件，不是 phase |
| **运行环境** | workdir、source、claim mode、watcher pid、childPid、配置路径、stop file |
| **轮询** | 上次成功轮询时刻、下次倒计时、`pollIntervalMs`、当前退避 |
| **Work-item pool** | ready / in-progress / blocked。`polling` 与 `backing-off` 用上次成功快照（含时间）；`running` 时三列改听当前 Execution run |
| **当前 Execution run** | 注册表里的 `execRunDir`；复用 loop-serve 现有渲染 |
| **Execution run 历史** | 同 workdir 全部 Watch session（片 5）。默认：本 session + 最近一次已结束的 run；可筛选 |
| **事件流** | 当前 Watch session 的 `events.jsonl` 最近 N 条 |

## 数据来源

| 页面数据 | 来源 |
|---|---|
| phase、pid、childPid、execRunDir、claim mode | Watcher 注册表 |
| 事件流 / 退避 | 当前 Watch session 的 `events.jsonl`（`run_start` / `run_end` 须带 exec 目录；结束带 exit code） |
| Execution run 阶段与心跳 | 该 run 的 `loop-progress.jsonl` + `task-*.progress.jsonl` |
| Work-item pool | 当前 Watch session 的 `pool.json`（Watcher 每轮写入；有 `describeBlocked` 则只调它，用其 `ready` 决定是否开工） |

## 已拍板的设计

1. 页面归 Watcher，常驻到退出（ADR-0005）。不是 ADR-0001 的推论。
2. 当前 Execution run 以注册表为唯一指针；页面跟注册表走，不重启。
3. 扩展现有 `loop-serve`，不另起第二个服务。中文。
4. 启动打印最终 URL；端口占用则递增探测。
5. 控制台 phase 留痕；`--no-serve` 仍无页面，但留痕保留。
6. 停止时收掉 owned 页面进程；释放注册表后页面不可用。
7. 第一版 = 片 1–4。片 5（跨 session 历史）第二刀。

## 分片

| 片 | 内容 | 第一版 |
|---|---|---|
| **1** | 控制台：URL + phase 行 | ✅ |
| **2** | 常驻页面 + Watcher 状态区 | ✅ |
| **3** | 当前 Execution run 区（注册表指针） | ✅ |
| **4** | Work-item pool（`describeBlocked` → `pool.json`） | ✅ |
| **5** | 跨 session 历史 + 筛选（默认本 session + 最近一批） | 随后 |

## 验收要点

- 空闲时 `curl` 页面可见 `polling` 与倒计时。
- `running` 时页面同时有 pool/队列与 exec 阶段心跳。
- `pool.json` 等于该轮 `describeBlocked()`（假任务源）；不增加 TAPD 调用次数相对「只调一次列表」。
- `--stop` 后端口不再监听、注册表消失。
- `node --test`，无新依赖。

## 风险

- `loop-serve` 硬编码单个 runDir；片 3 要改成跟注册表切换——主要返工点。
- beads 上 `describeBlocked` 比单用 `listReady` 略贵；TAPD 次数持平。
- 多 workdir：端口与注册表均按 workdir 派生/键控，不得串读。
