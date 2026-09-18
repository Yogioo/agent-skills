# afk-watch 看板计划

状态：**计划，未实现**。等用户许可后按"分片实施"逐片做。

## 问题

无人值守跑 `afk-watch` 时，人处于**盲飞**状态。三处具体缺口（都有出处）：

1. **空闲时没有页面。** 看板只在批次运行期间存在：`watch.mjs:560` 的 `startDashboard` 在 `spawnRun()` 内部才被调用，且下一次 `spawnRun` 会先 `killOwnedProcess(dashboardPid)`。轮询等单阶段（无人值守的大部分时间）根本没有看板进程。
2. **看板地址从不打印。** `loop-serve.mjs:556` 用 `console.error('afk-run 实时看板: http://…')` 打印 URL，但 watcher 起它时用的是 `stdio: 'ignore'`（`watch.mjs:563`）→ URL 被丢掉。`watch.serve.open` 默认 `false`，于是端口 `9700 + hash(workdir)%1000` 只能靠猜或翻进程列表。
3. **watcher 自己的状态机没有任何渲染器。** `idle / claim_skipped / run_start / run_end / source_error{waitMs}` 这些事件只写进 `watch-run-*/events.jsonl`（`watch.mjs:741`），全局只有 `watch-state.mjs` 写它，**没有任何代码读它**。

实证：本次实跑中 watcher 的日志文件在批次已经开始的 40 秒内是 **0 字节**，整轮只出现一行 `[afk-run] 已终止 workdir 上一 loop`——因为 `watch.mjs:531/532` 只是把 afk-run 子进程的 stdout/stderr 原样转发，而 afk-run 在 watcher 传入的 `--no-serve` 下主要写文件、不打印。

## 目标 / 非目标

**目标**
- watcher 从启动到停止，**任何时刻**（含空闲、退避）都有一个可打开的页面。
- 页面上能回答四个问题：它在干什么？等多久？池子里有什么？上一批结果如何？
- 启动时把看板 URL 打到控制台，并让状态变化在控制台留痕。
- 不新增运行时依赖（只用 node 内置 + 仓库现有模块）。
- 不增加任务源 API 调用（见"数据来源"）。

**非目标**
- 不做执行端内部的看板重写——复用 `loop-serve.mjs` 已有的批次渲染与 SSE。
- 不做跨 workdir 的聚合总览。
- 不做远程访问/鉴权（仍绑 `127.0.0.1`）。

## 页面上要显示什么

| 区块 | 内容 |
|---|---|
| **状态徽章** | `polling` / `claiming` / `backing-off` / `running` / `stopping` / `stopped` + 当前状态已持续多久 |
| **运行环境** | workdir、source、`claimMode`、watcher pid、childPid、配置文件路径、stop file |
| **轮询** | 上次轮询时刻、下次轮询倒计时、`pollIntervalMs`、当前退避（第几次 / 下次间隔 ms） |
| **就绪池** | ready N 条（id / title / priority）、in-progress（已认领）、blocked（含原因） |
| **当前批次** | runDir、exec runDir、任务 id/title、exec-review 阶段与心跳、已耗时 ← *直接复用 loop-serve 现有渲染* |
| **批次历史** | 本 watcher 起过的每一批：id、开始/结束时刻、结果、耗时、runDir 链接 |
| **事件流** | `events.jsonl` 最近 N 条，按类型着色 |

## 数据来源

**关键约束：不新增任务源调用。** 现在 watcher 每轮已经调用 `listReady()`；把那一轮的结果**顺手落盘**，页面只读文件。

| 页面数据 | 来源 | 现状 |
|---|---|---|
| 状态、pid、childPid、runDir、execRunDir、claimMode、startedAt/updatedAt | watcher 注册表 `readWatcherRegistry(cacheRoot, workdir)` | ✅ 已存在，字段见 `watch-state.mjs:109-121` |
| 事件流 / 退避次数 / 上次轮询 | `watch-run-*/events.jsonl`（`watch_start / idle / source_error{waitMs} / claim_skipped / run_start / run_end / watch_stop / watch_end`） | ✅ 已存在，缺读者 |
| 批次阶段、任务进度、心跳 | 批次的 `loop-progress.jsonl` + `task-*.progress.jsonl` | ✅ 已存在，`loop-serve` 已在渲染 |
| 就绪池 / blocked | **需新增**：watcher 每轮把 `listReady()` / `describeBlocked()` 的结果写进 `watch-run-*/pool.json`（或注册表字段） | ⚠️ 新增写入，零新增 API 调用 |

## 设计决策

1. **看板常驻，不在批次之间反复起停。** watcher 启动时起**一个** `loop-serve`，活到 watcher 退出；批次切换只换指针，不重启页面。（这是本计划的核心改动，也是 ADR-0001"看板归 watcher"的延续。）
2. **指针来自注册表，不来自启动参数。** 看板新增一个数据源参数（如 `--watch-registry <路径>`），自己从注册表读当前 `runDir` / `execRunDir` / `state`。这样"当前批次是谁"只有一处真相，不用 watcher 通知页面。
3. **`loop-serve` 增量扩展，而不是新写一个服务。** 它已经有 1 秒 tick、SSE 广播、`createProgressWatcher` 复用（`loop-serve.mjs:450/504/508/521`）。新增：一个"watch 视图"区块 + 可选注册表数据源；批区块沿用现有渲染。若扩展后职责过载，再抽公共渲染模块。
4. **URL 必须打印。** watcher 起看板时把 `stdio` 从 `'ignore'` 改成继承/管道并把 URL 透出来，或在 watcher 自己启动日志里打印一次 `看板: http://127.0.0.1:<port>/`。顺带解决缺口 2。
5. **控制台留痕（可与看板解耦，先做）。** 状态变化时打一行：`idle(ready=0)` / `claim <id>` / `run_start <id>` / `run_end <id> code=0` / `backoff #n <ms>` / `stop <reason>`。
6. **端口冲突要有回退。** 派生端口可能撞别的程序；`listen` 失败时递增探测（或落到随机端口）并把最终端口打印出来。
7. **停止时收干净。** 常驻看板登记为 owned（注册表已有 `dashboardPid`），`--stop` / Ctrl+C / 停止文件都要收掉它；释放注册表后页面应打不开。
8. **`--no-serve` 语义保持不变**：关掉看板，但控制台留痕（决策 5）仍然生效。

## 分片实施（每片独立可验收）

| 片 | 内容 | 验收 |
|---|---|---|
| **1** | 控制台可见性：启动打印看板 URL；状态变化打一行日志 | 终端在空闲期也有心跳；一眼能看到 URL |
| **2** | 看板常驻 + watcher 状态区（读注册表 + events.jsonl） | **空闲时**打开页面能看到 `polling`、上次轮询、下次倒计时、退避次数 |
| **3** | 当前批次区（指向注册表里的 runDir，复用 loop-serve 渲染） | 批次跑起来后页面同时显示队列与执行端阶段/心跳 |
| **4** | 就绪池 / blocked 区（watcher 每轮落盘快照，页面只读） | 页面显示 ready N / in-progress / blocked+原因，且**不产生额外 TAPD 调用** |
| **5** | 批次历史 + 报告链接 | 页面能看到本 watcher 起过的每一批及其结果 |

建议顺序：**1 → 2 →（3 可独立于 4/5 先上）→ 4 → 5**。片 1 单独就有价值，且改动最小、风险最低。

## 验收与测试

沿用 `tests/afk-watch/watch.test.mjs` 的现有风格（spawn CLI + 断言 stdout/HTTP）：

- `--dry-run` 输出里带上看板 URL 与端口。
- 片 2：起 watcher（无批次）→ `curl` 页面 → 断言含 `polling` 与倒计时字段。
- 片 7 停止：`--stop` 后端口不再监听、注册表文件消失。
- 片 4：断言 `pool.json` 被写入且内容等于该轮 `listReady()` 结果（用假任务源，不打真 API）。
- 全程不引入依赖：`node --test` 可跑。

## 风险与待定

- **`loop-serve` 现在假设"一个 runDir"**（`loop-serve.mjs:475` 硬编码 `${runDir}/loop-progress.jsonl`）。常驻模式需要把它改成"跟着注册表切换"——这是片 3 里唯一有返工风险的地方。
- **零 API 增量是硬要求**：TAPD 有每日调用上限，页面**绝不能**自己查任务源。
- **多 workdir 多 watcher**：端口按 workdir 派生，天然错开；但要确认两个实例不会互相读错注册表。
- **可能要补一条 ADR**（或更新 ADR-0001 的 Consequences）："看板是 watcher 的常驻进程，空闲时也存在"——这与现在"每批起一个"的实现不同，值得留痕以免以后被"优化"回去。

## 需要你拍板的开放问题

1. **空闲时的页面要不要显示就绪池？** 显示更有用，但要 watcher 每轮多写一个快照文件（**零 API 增量**）。不显示则页面更轻。
2. **批次历史保留多少？** 全部保留（按 `watch-run-*` 目录）、最近 N 批、还是只留当前 watcher 生命周期内的？
3. **片 1 要不要先单独上？** 它不依赖看板常驻，几十行就能消掉"长时间静默"。
4. **页面语言**：中文与现有 watcher 文档一致；若要跟 `loop-serve` 现有页面统一，也可以英文。

## 相关文件

| 文件 | 涉及改动 |
|---|---|
| `skills/afk-watch/scripts/watch.mjs` | 常驻看板生命周期、URL 打印、状态日志 |
| `skills/afk-watch/scripts/watch-state.mjs` | 注册表字段（如需 pool 快照） |
| `skills/afk-run/scripts/loop-serve.mjs` | 新增 watch 视图 + 可选注册表数据源 |
| `skills/afk-watch/SKILL.md`、`references/config.md` | 看板行为与 `watch.serve.*` 语义 |
| `tests/afk-watch/watch.test.mjs` | 新增验收用例 |
| `docs/adr/` | 可能需要一条新 ADR 或更新 0001 |
