---
name: tapd-loop
description: 把 TAPD 需求当队列，自动跑「拉卡 → 内循环（yogioo-mode）→ git/验证判定 → 回写标签与评论」。不依赖 afk-run / exec-review。用户要无人值守跑 TAPD、或要一个自己的外循环时加载。
disable-model-invocation: true
---

# TAPD 外循环

一条命令把 TAPD 上带 `ready-for-agent` 的需求交给内循环，跑完按证据回写。

外循环只做确定性的事：取卡、占住、判定、回写。做没做对**不看模型自述**，看 git 改动和验证命令。

## 前置

- `node` 可用；`tapd-cli` 已安装并配好 `TAPD_TOKEN` / `TAPD_API_ENDPOINT` / `TAPD_WORKSPACE_IDS`
- 工作目录是 git 仓库，且启动时干净
- 内循环技能存在，默认 `~/.agents/skills/yogioo-mode`

## 调用

```powershell
node <技能根>/scripts/loop.mjs --workdir <仓库> --assignee <TAPD处理人> --list
node <技能根>/scripts/loop.mjs --workdir <仓库> --assignee <处理人> --max-tasks 1
node <技能根>/scripts/loop.mjs --workdir <仓库> --watch --max-tasks 10
node <技能根>/scripts/loop.mjs --workdir <仓库> --fetch <需求id>
```

`--list` 只看队列，`--fetch` 只抓一张卡的标题、详情、评论和图片到本地，不跑内循环。真跑前先用 `--max-tasks 1` 跑一张，读 report 与 `events.jsonl`。

常用参数：`--card <id>`、`--max-tasks`、`--watch`、`--verify <命令>`、`--model`、`--thinking`、`--comment-author`、`--allow-dirty`。

## 配置

`<仓库>/.tapd-loop.json` 覆盖 `~/.tapd-loop/config.json`，都没有就只用默认值加 CLI 参数。

```json
{
  "task": {
    "assignee": "彭云洁",
    "commentAuthor": "彭云洁",
    "workspaceId": "",
    "statuses": ["developing", "status_11"],
    "labels": { "readyLabel": "ready-for-agent", "claimedLabel": "afk-claimed" }
  },
  "run": {
    "maxTasks": 1,
    "timeoutSec": 3600,
    "verify": "node tools/check.mjs",
    "skillPath": "C:/Users/EDY/.agents/skills/yogioo-mode"
  }
}
```

`verify` 是每张卡跑完后外循环自己执行的命令，不通过就整张回滚。留空则只要求工作区有改动。

`statuses` 是允许接单的状态 key，默认 `developing`（开发中）与 `status_11`（实现中）。TAPD 的状态 key 按项目自定义，`--list` 会打印 `key(中文名)` 的对照，不确定就先跑它。

## 一张卡的一生

1. `listReady` 拉 `owner=<assignee>`、带 `readyLabel`、不含机器标签、且状态在 `statuses` 里的需求，按优先级再按 id 排序
2. 加 `afk-claimed` 占住（best-effort，先到先得）；认领时再查一次状态，防止列表之后被人改回「已完成」
3. 读描述和全部评论，拼成 brief；正文里的 `/tfl/` 内嵌图经 `tapd-cli attachment get-image` 拿签名地址后下载到本地，正文换成 `![图片](images/img-N.png)`
4. 同时落一份 `card.md`（标题、状态、链接、描述、评论，图片相对路径），brief 里用绝对路径引用同一批图片
5. 起一次 `pi --print --mode json`，brief 指向内循环 SKILL.md
6. 判定：进程正常结束 → 有 git 改动（或新 commit）→ `verify` 通过
7. 通过则提交、撤 `afk-claimed`、加 `afk-delivered`、评论总结与提交号
8. 任一判定失败则 `git reset --hard <基线>` + `git clean -fd`，加 `afk-failed` 并评论原因

## 提交信息

外循环内置项目 `digitdoor-git-commit` 的格式：`<type>:<7位工单号> <中文描述>`，例如 `feat: 1005050 数字门受击逻辑`。

brief 要求内循环最后输出 `COMMIT: <type>:<7位工单号> <描述>`。外循环校验工单号必须是卡片 id 的后 7 位，对不上就用卡片标题兜底。不带 AI 署名，不写 19 位全 id。

标签是多选字段，多值用竖线分隔。每次写完都回读校验，不一致就报错。

## 看板

```powershell
node <技能根>/scripts/start-board.mjs            # 起一个常驻的，已在跑就复用
node <技能根>/scripts/start-board.mjs --status   # 在哪、活着没
node <技能根>/scripts/start-board.mjs --stop
```

`start-board` 用 detached 子进程拉起 `serve.mjs`，自己的进程退出了网页也不会关。地址固定写进 `~/.tapd-loop/board.json`，重复执行只返回同一个 URL。日志在 `~/.tapd-loop/board.log`。

每次跑 loop 都会先确认看板在跑：没起就自动起，已在跑就复用。stdout 第一行就是 `board: <url>`，结束时的 JSON 摘要里也有 `board` 字段。不想要看板加 `--no-board`。

页面只读，绑 `127.0.0.1`。左边是每个 run 的卡片队列，点一张卡开内部窗口，里面依次是工单（含图片）、主 Agent 结论、brief、验证输出、改动 diff、进程日志尾部、子代理，以及内循环事件时间线。每 2 秒刷新。run 结束后页面继续在，变成历史 run。

子代理点开是第二层窗口，左上角「返回」回到卡片，Esc 退一层。每个 arm 都有自己的 think / say / tool 时间线。

这些区块默认收起，展开状态记在浏览器本地，刷新不丢。改动 diff 逐行红绿着色，可切单列/双列，模式也记住。

时间线里主 Agent 的发言和思考默认折叠，点一下展开；完整结论在「主 Agent 结论」区，不用滚时间线。

深链可以直接选中一张卡：`http://127.0.0.1:7317/?run=run-<时间戳>&id=<需求id>`。

默认读 `~/.tapd-loop/runs`，配置了 `run.cacheDir` 就用 `--root <目录>` 指过去。

## 停止

- 批次数到 `maxTasks`
- 连续失败到 `maxFailures`
- 队列为空（没有 `--watch` 时退出，有则轮询 `pollSec`）
- 仓库根出现 `.tapd-loop-stop` 文件，下一轮退出

## 输出

- 标准输出一行 JSON 摘要
- `<runDir>/report.md` 每张卡的结果
- `<runDir>/<卡片id>/` 该卡的 `card.md`、`images/`、`brief.md`、`card.json`、`events.jsonl`、`pi.log`、`verify.log`

`--fetch` 的单卡产物落在 `~/.tapd-loop/cards/<需求id>/`。

图片下载失败只降级成 `[图片下载失败: 路径]`，不阻断开工。单张卡最多取 30 张图。

默认 `runDir` 为 `~/.tapd-loop/runs/run-<时间戳>`。

## 回写

评论正文按句子边界截到 2000 字（超了加 `…`），不按字数硬切；路径在评论里统一写成正斜杠，因为 Markdown 会把 `\.` 当转义、把 `C:\Users\EDY\.tapd-loop` 吞成 `C:\Users\EDY.tapd-loop`。

tapd-cli 各命令的回执形状不统一：读命令（`story list`、`comment list`…）给 `{status:1,data,info}`，写命令里 `comment add` 只回一个不带 `status` 的壳。所以读命令要求 `status===1` 或带 `data`，写命令按 lenient 判（exit 0 且没有明确的失败体就算成功）；API 真失败时 tapd-cli 是 **exit 1 + stderr**，不会落到这条路径上。

report 里出现「回写异常」时，用 `TAPD_LOOP_DEBUG=1` 重跑一次，stderr 会打出 tapd-cli 的原始 stdout 回执；同时去 TAPD 上人工确认评论与标签，别只信 report。

## 边界

- 只写机器标签，不改 TAPD 状态和处理人。验收流转由人做。
- 状态不是「开发中 / 实现中」就不接单，标签挂着也不接。`--list` 的 `rejected` 会列出被状态挡住的卡与原因。
- 描述与评论都为空时不认领，直接标失败并评论，让人补充后撤销标签重跑。
- 同一项目多份拷贝并行时靠 `afk-claimed` 互斥，谁先加谁拿到。
