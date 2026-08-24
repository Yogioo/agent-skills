# 02 — 实时聚合进度页（loop 级 serve）

**What to build:** AFK 运行期间打开一个 URL 即可实时看到：任务队列（就绪/进行中/完成/失败）、当前任务的执行/审查阶段、心跳、失败原因与历史结果。

**Blocked by:** None — can start immediately.

## 背景与现状

- P1 把每任务 serve 全关（`--no-serve --no-open`），运行中无任何可视反馈，只能跑完看 `report.md`。需求定位：能"看"，不是"盯"。
- 现有可复用资产：exec-review 的 serve.mjs 模式（独立进程 + append-only JSONL 事件流 + HTTP 长轮询）已验证成熟。

## 方案

- **loop 级 serve 进程**（`loop-serve.mjs`，独立进程、detached），默认开、`--no-serve` 关；URL 进 stdout 摘要（渐进式披露）。
- **事件源细化**（现状 `loop-progress.jsonl` 只有任务结束时一行，太粗）：
  - loop 事件流新增：`loop_start`（config 摘要）/ `task_start`（id/title/priority/attempt）/ `task_end`（现状已有）。
  - **阶段可见性**：exec-review 加 `--progress-file <path>` 参数（小改动：ProgressWriter 额外写一份到 loop 指定路径）。loop 将每任务 progress 文件放 loop runDir 下，serve 聚合"执行/审查阶段 + 心跳"。
  - loop 始终传 `--no-serve --no-open` 给 run-task（每任务 serve 保持关闭，避免进程爆炸）。
- **页面内容**：任务列表（就绪/进行中/完成/失败 + 原因）、当前任务阶段条、存活心跳、停止文件提示、报告链接。
- **测试**：HTML 静态渲染回归（仿 exec-review regression 测试模式：模板引用元素 id 存在性校验）+ 聚合逻辑单测（事件流 → 页面状态投影）。

## 验收标准

- [ ] 运行中打开 URL 实时看到任务列表与阶段更新（长轮询增量）
- [ ] 显示执行/审查阶段 + 心跳 + 失败原因
- [ ] `--no-serve` 关闭；URL 在 stdout 摘要输出
- [ ] exec-review 单任务 serve 不因聚合被连带启动
- [ ] 回归：P1 的 `--no-serve` 语义不破坏

## 待讨论/待验证

- exec-review `--progress-file` 的改动点（ProgressWriter 双写 vs 路径覆盖）。
- 心跳频率复用 exec-review 的 heartbeatMs 还是 loop 独立。
- 页面是否需要"停止"按钮（写停止文件）还是只读。