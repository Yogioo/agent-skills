# 02 — 实时聚合进度页（loop 级 serve）

**What to build:** AFK 运行期间打开一个 URL 即可实时看到：任务队列（就绪/进行中/完成/失败）、当前任务的执行/审查阶段、心跳、失败原因与历史结果。

**Blocked by:** None — can start immediately.

**状态：** 方案与最终效果设计已定稿（本版为文档更新，记录了最终效果确认与待讨论项结论）；**实现未开工**，等按工单推进。实现前建议先出一个静态 HTML mockup 过目布局。

## 最终效果（已确认）：一个网页看板

最终交付物是 **loop 级实时网页看板**：运行中在浏览器打开一个 URL，看到一张**自动刷新、只读**的看板，无需手动 F5。直接复用 exec-review 已验证的模式（`scripts/serve.mjs`：自包含单 HTML，SSE/长轮询增量推送），从"单任务"放大到"整个 loop"。

页面结构与 exec-review 现状页面对照（已核对 serve.mjs 实际 HTML 结构）：

| 区块 | exec-review（现状，单任务页） | 本工单（loop 级看板） |
|---|---|---|
| 顶部 | grip + 标题 + 状态徽章 | 同上 + loop 启动时间 + config 摘要（来源/停止文件/runDir） |
| 主区 | hero：阶段圆点/文字 + 进度条 + 统计（耗时/阶段数/本阶段进行/心跳/上次事件） | **任务列表（核心）**：就绪 / 进行中 / 完成 / 失败 + 失败原因，滚动追加 |
| 当前任务 | —— | 内嵌 hero 区块：当前任务的执行/审查阶段条 + 心跳计数 + 本阶段耗时（复用 exec-review 同款组件） |
| 底部 | 实时日志 / Agent 上下文 | 停止文件提示（往哪放 `afk-stop`）+ 跑完的 `report.md` 链接 |
| 推送 | SSE / 长轮询增量 | 同左（长轮询增量） |

设计口径：**"能看"不是"盯"**——信息密度刻意做低，跑批时偶尔瞄一眼；不是运营大屏，不做视频级实时。

## 背景与现状

- P1 把每任务 serve 全关（`--no-serve --no-open`），运行中无任何可视反馈，只能跑完看 `report.md`。需求定位：能"看"，不是"盯"。
- 现有可复用资产：exec-review 的 serve.mjs 模式（独立进程 + append-only JSONL 事件流 + HTTP 长轮询）已验证成熟。

## 方案

- **loop 级 serve 进程**（`loop-serve.mjs`，独立进程、detached），默认开、`--no-serve` 关；URL 进 stdout 摘要（渐进式披露）。
- **事件源细化**（现状 `loop-progress.jsonl` 只有任务结束时一行，太粗）：
  - loop 事件流新增：`loop_start`（config 摘要）/ `task_start`（id/title/priority/attempt）/ `task_end`（现状已有）。
- **阶段可见性**：exec-review 加 `--progress-file <path>` 参数（小改动：ProgressWriter 额外写一份到 loop 指定路径）。loop 将每任务 progress 文件放 loop runDir 下，serve 聚合"执行/审查阶段 + 心跳"。
- loop 始终传 `--no-serve --no-open` 给 run-task（每任务 serve 保持关闭，避免进程爆炸）。
- **页面内容**：任务列表（就绪/进行中/完成/失败 + 原因）、当前任务阶段条、存活心跳、停止文件提示、报告链接。**本期只读，无"停止"按钮**（见待讨论③）。
- **测试**：HTML 静态渲染回归（仿 exec-review regression 测试模式：模板引用元素 id 存在性校验）+ 聚合逻辑单测（事件流 → 页面状态投影）。

## 验收标准

- [ ] 运行中打开 URL 实时看到任务列表与阶段更新（长轮询增量）
- [ ] 显示执行/审查阶段 + 心跳 + 失败原因
- [ ] `--no-serve` 关闭；URL 在 stdout 摘要输出
- [ ] exec-review 单任务 serve 不因聚合被连带启动
- [ ] 回归：P1 的 `--no-serve` 语义不破坏
- [ ] 页面只读（不提供写停止文件的入口）

## 待讨论/待验证（已核代码给结论）

- ~~exec-review `--progress-file` 的改动点（ProgressWriter 双写 vs 路径覆盖）~~ → **倾向：双写**。ProgressWriter（progress.mjs）持有单一 `stream`（`join(runDir,'progress.jsonl')`），`write()`/`heartbeat()` 全走它。exec-review 作为独立工具手动跑时仍需自己的 `progress.jsonl`，所以 `--progress-file` 应**多加一路输出**而非替换路径，保持 exec-review 自身语义不破坏。改动最小：构造器加可选第二目标路径，写主 stream 成功后同记录双写。备选：loop 侧用硬链接把 `progress.jsonl` 链到 runDir 下（零改 exec-review，但 Windows 硬链接需验证）。实现时二选一，默认双写。
- ~~心跳频率复用 exec-review 的 heartbeatMs 还是 loop 独立~~ → **倾向：复用**。ProgressWriter 已内建心跳（`startHeartbeat()`，默认 `heartbeatMs=10000`）；看板"存活"信号 = 各任务 progress 流里的 heartbeat + loop 自己的 `loop_start`/`task_end`。loop 不另起独立心跳，直接展示任务 progress 里的心跳；loop 级"活着"判定 = 距上次 loop_start/task_end 超过阈值则显示"无新事件"。
- ~~页面是否需要"停止"按钮（写停止文件）还是只读~~ → **已定：只读**。停止已有成熟机制（往 stop-file 放文件即停），按钮引入写路径 + 状态管理 + 权限问题，收益低。记入 future，本期不做。

## 实现后需同步的文档（避免实现完忘记）

- `SKILL.md`「输出」节：stdout 摘要加 `serveUrl`；「常用参数」加 loop 级 `--no-serve`；「无人值守要点」补"运行中可打开 URL 看板"。
- `references/config.md`：补 loop 级 serve 配置（如 `serve.port` / `serve.enabled` / `serve.no-open`）。
- 本工单不动 `references/task-sources.md`（不涉及任务源）。
