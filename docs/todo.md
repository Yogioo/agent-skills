## 现状
目前我们公司的工作流是 策划提单TAPD => TAPD + 飞书聊天记录 + 面对面对话讨论 实现需求基础对齐 => 开发者本机开个Agent Session 调用 grill-with-doc 技能传入TAPD和相关信息开始对齐 => 开发者+Agent 讨论需求,有问题问策划等策划返回信息, 确认需求 => 开发者调用 Agent 技能 to-spac 生成beads spec 工单=> 开发者调用 Agent技能 to-tickets 生成 beads ticket工单 => afk-run流程(Agent接单=>Agent实现=>Agent审查=>循环直到全部Tickets完成) => 开发者手动流转TAPD工单+push


最近我实现了一个 afk-watch 技能, 并支持对接了TAPD作为工单源, 然后发现工作流改成了: 策划TAPD提单 => 开发者本地调用 grill-with-doc 技能=> 与 AI+开发者, 有问题问策划等策划返回信息,三方对齐需求 => 助理在TAPD创建子工单并自己打 ready-for-agent + 责任人 => 后台 afk-watch 链路（不占终端） => 开发者本地测试 => 开发者本地修改 => 开发者手动工单流转并push

最近总感觉好像有点问题, 感觉不够爽利, 我分析可能还是太繁琐了, 没有那么所见即所得, 没那么顺的工作流感觉. 需要迭代, 我刚测试过, 用户可以本地分享网页,因为大家都是局域网, 所以我想可以利用这个自己搞所有内容 不依赖TAPD? 只把TAPD作为工单源头? 后期在本地浏览器中处理, 如果策划需要填信息让他直接访问局域网网页, 填合适的调差问卷? 需要考虑一下

我又深思熟虑了一下, 打算搞成一个需求一个 session, 然后这个session是一个助理session, 他不负责直接干活, 而是作为需求经理, 传话的.
他不深入需求细节, 只做需求生命周期管理.
1. 用户输入需求给助理
2. grill=>spec=>tickets 这个流程助理自己判断什么时候调用
3. 允许助理调用 各种cli 命令来完成任务, 助理本身几乎不做事情, 只聊天和管理需求生命周期

综上 我做了一个 afk-requirement-assistant 技能 作为我的助理, 再做了个 to-questionnaire-web 技能用于给策划提问,让他回答

## 偷懒指标

每需求的人工触碰次数。目标 **2**：说需求 + 点验收。其余都是可删项。

## P0（已做 2026-09-20）

1. `afk-requirement-assistant`：写死「人只做两件事」契约——建单/打标/责任人/起停 watcher/流转/push 默认由助理做完，只有「停机问人」清单上的动作才要一句确认。
2. `afk-watch`：新增 `scripts/start-background.mjs`——detached 启动 + `--status` + `--stop`，watcher 不再占终端。日志 `<cacheDir>/watch-<hash>.log`。

```powershell
node <afk-watch>/scripts/start-background.mjs --workdir <目录>
node <afk-watch>/scripts/start-background.mjs --status --workdir <目录>
node <afk-watch>/scripts/start-background.mjs --stop   --workdir <目录>
```

## P1（已做 2026-09-21）

1. **唤醒环**：一次 Execution run 结束 / watcher 异常停下 / 问卷提交 → 落 `~/.afk/inbox/*.json`；写者顺手 detached 踢一下 `drain.mjs`，drain 按需求本子路由，敲的是**原来那个 session**（runner 层负责翻译成各 CLI 的命令）。见 [ADR-0008](adr/0008-wake-ring-is-a-file-queue.md)。
2. **需求状态落盘**：需求本子 `<AFK home>/<项目>/requirements/<id>.json` 是唯一真相，session 只是视图——需求助理靠 session reference 认自己，不靠记忆。见 `CONTEXT.md` 的 Requirement record / Session reference / Inbox item。

脚本在 `skills/afk-run/scripts/`：`inbox.mjs`（收件箱读写）、`requirement.mjs`（需求本子 + 工单反查 + 心跳）、`drain.mjs`（一次性抽干 + 叫醒）、`checkin.mjs`（助理每轮报到）。

## 待办

- P2 验收证据化：助理出验收清单，agent 跑可自动化项并留证据，人只点收/退。
- P2 多需求总览页：聚合「待人工处理」列表。**这张页面本身就是通知**（[ADR-0009](adr/0009-human-surface-is-one-page.md)），它推翻了 `afk-watch-dashboard-plan.md` 里「不做跨 workdir 聚合」那条非目标。
- P3 飞书入向通道。
