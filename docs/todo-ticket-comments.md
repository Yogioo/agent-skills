# TODO: 工单即需求，评论即接口

Status: 未开工。第一件事是写 ADR-0011，不是写代码。

Reader: 接手推进的 agent。先读完本文件，再读末尾「相关」里的四份。

## 形态

需求不是 session，是工单。四句话定死：

- **身份**：需求 id = 工单 id。工单结构自己就是映射，本地不再维护第二套。
- **接口**：工单评论。人在评论里说，机器人在评论里回。
- **session**：草稿纸。一个工单一个后台 session，装试探和半成品，人默认不进去。
- **session 可丢**：上下文的家是评论，丢了重开一个读评论即可。

人看不见 session，于是"开会话"这个动作消失——`docs/todo.md` 的偷懒指标写着目标 2 次（说需求 + 点验收），漏掉的正是这第三次。

## 为什么这么改

根因是上下文只活在对话里。于是 session 必须长命、身份必须挂在 session 上，代价是每需求开一次 pi、找回旧会话靠记忆、`findRequirementBySession` 在同一个 ref 命中多条时静默取最新（`skills/afk-run/scripts/requirement.mjs:316`）。

上下文搬进工单评论之后，这三条约束一起松开：session 降级成可丢的草稿，身份变成工单 id，ADR-0008 里"runner 必须能续会话"也不再是硬需求。

## 挡路的一个决定

**评论是公开面。策划和同事会看到每一句。**

- 要 → 继续。
- 不要 → 本文件作废，退回"本地卡 + 工单"两份，重复照旧。

先拿到这个答复，再动第 1 步。

## 已经有的（直接用）

| 能力 | 现成的 |
| --- | --- |
| 描述 + 评论拼成一段正文 | `skills/afk-run/scripts/task-sources/tapd.mjs:203` `renderTaskBody()`（时间升序、不限条数） |
| 写评论 | `tapd.mjs:344` `addComment()` |
| 机器留言的标记与署名 | `COMMENT_PREFIX`、`COMMENT_MAX`；署名取 `task.tapd.commentAuthor` 或 `TAPD_NPC_ROLE`，缺了会拒写（ADR-0002） |
| 唤醒通路 | `skills/afk-run/scripts/inbox.mjs:250` `emitInboxEvent()`——写事件 + 踢 drain |
| 轮询循环 | `skills/afk-watch/scripts/watch.mjs`，间隔 `watch.pollIntervalMs`（默认 15000） |
| 评论分页读 | `tapd.mjs:296` `fetchComments`，`PAGE_SIZE = 200` |

## 做

### 1. ADR-0011「工单评论是需求的接口」

写清身份、媒介、草稿与结论的分界，以及它改写 ADR-0008 的哪一条。

完成：`docs/adr/0011-*.md` 合入；`CONTEXT.md` 的 **Requirement assistant** 条目跟着改——它现在把自身定义成 "one requirement's session"，这里要换成 "one requirement's comment thread"。

### 2. 评论监听器 —— 唯一真正要新建的东西

现在没有任何地方记录"评论读到哪了"：`fetchComments` 每次全量分页。

- 存每张工单的 last-seen 游标。
- 发现人写的新评论 → `emitInboxEvent`。
- 按 `commentAuthor` 过滤掉机器人自己写的评论，否则自问自答成环。
- 挂进 `watch.mjs` 的轮询循环。
- **监听面要扩**：现在池子的定义是"`ready-for-agent` + 无机器标签 + 指派给我"（ADR-0003）。要听的是"有需求的单"，这个集合更大。

完成：人在工单上写一条评论 → 一个轮询周期内产生一条 inbox 事件；机器人自己的评论不产生事件。

### 3. 身份合并：需求 id = 工单 id

删掉第二套映射：`--link`、`resolveRequirementForWorkItem`、`buildWorkItemIndex`、`resolveEventRequirement`（都在 `skills/afk-run/scripts/requirement.mjs`）、`findRequirementBySession`。

理由：三种源都已经有父子表达——TAPD 的 story→task 是原生父子，beads 有 `parent`，gh 用 body 顶部的 `Part of #N`（`docs/agents/issue-tracker.md`）。

完成：这几条路径删除，全仓无引用；inbox 事件靠工单 id 直接路由。

### 4. 技能改写 `skills/afk-requirement-assistant/SKILL.md`

契约段留下：**两件事、Stop-and-ask、生命周期路由、交接规则**都媒介无关，而且在评论媒介下更该留——留言比说话更容易越界建单。

重写的是 I/O 两段：删「每轮先报到」「登记与挂单」，换成「被叫醒先读工单评论」。

完成：新 I/O 段能走通一遍，不再出现 `--ref` 与 `checkin.mjs`。

### 5. 顺带

- 建需求时 `pi --name "<工单号 标题>"`，让 `pi -r` 挑得出来。
- `to-questionnaire-web` 可能退休：策划在 TAPD 里直接答。
- `docs/adr/0009-human-surface-is-one-page.md` 补一笔：总览页从主界面退回监控盘。

## 代价（推进时带上）

1. **评论慢，惩罚追问。** 一个来回是"轮询 → drain → 读评论 → 回复"分钟级，而澄清的价值在多轮追问。靠「一次问全」扛；聊不细是真的损失。
2. **提问本身必须是评论**，绕不过去，所以工单上会出现 AI 的提问。把非结论的话压到最少，压不到零。
3. **想私下试探就 attach session**（`pi --session <id>`）。这是留着的后门。

## 完成标准

- ADR-0011 合入，`CONTEXT.md` 与 ADR-0008 / 0009 改完。
- 人评论工单 → 一个轮询周期内机器人评论回复。
- 一个需求的整个生命周期里，人没有开过 pi。
- `requirement.mjs` 的 sessionRef 反查路径删除，全仓无引用。

## 相关

- `CONTEXT.md` —— Requirement assistant / Requirement record / Inbox item
- `docs/adr/0008-wake-ring-is-a-file-queue.md` —— 唤醒环；"续会话"不再是硬需求
- `docs/adr/0009-human-surface-is-one-page.md` —— 人的界面
- `docs/agents/issue-tracker.md` —— 三种源的父子表达
- `docs/todo.md` —— 现状、偷懒指标、已完成
