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

配置从低到高叠三层，都没有就只用内置默认值加 CLI 参数：

```
~/.tapd-loop/config.json            机器级默认（处理人、看板端口、默认 skillPath）
<git-common-dir>/tapd-loop.json     仓库级（导表钩子、verify、sync、push）
--config <path> / $TAPD_LOOP_CONFIG 额外追加一份（优先级最高）
```

仓库级配置住在 **`.git/` 里，不在工作区**：`git status` 永远干净，也不会因为忘加 `.gitignore` 而被人误提交。用 `--git-common-dir` 而不是 `--git-dir`，所以**同一仓库的所有 worktree 共用一份配置**，`DigitDoor` 和 `DigitDoor-wt-alpha` 读的是同一个文件。

看当前生效的是哪份：`--dry-run` 的 `sources` 会打出三层路径和 `repoExists`。

老位置（仓库根 `.tapd-loop.json`）仍然能读，但会打一行告警：它在工作区里，会被 git 看到。搬过去用 `--migrate-config`，它会把 JSON 原样写到 `<git-common-dir>/tapd-loop.json` 并删掉旧文件；目标已存在时拒绝覆盖。`.git/` 里有了之后就以新的为准，老文件被忽略。

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
    "skillPath": "C:/Users/EDY/.agents/skills/yogioo-mode",
    "sync": { "enabled": true, "retries": 1 },
    "afterSync": "bash Tools/GitHooks/Luban/after-update.sh",
    "push": { "enabled": true, "retries": 3 }
  }
}
```

`verify` 是每张卡跑完后外循环自己执行的命令，不通过就整张回滚。留空则只要求工作区有改动。

`sync` 打开后每张卡开工前先 `git pull --rebase`，让内循环从最新基线开工。只在卡边界拉，不在内循环跑着的时候拉。

`afterSync` 在同步之后、取基线之前跑一次，不通过就**这张卡不开工**（整批停下）。它不只在 sync 真的 rebase 了才跑，而是无条件跑一次。

为什么不靠 git 钩子补这一刀（实测）：`git pull --rebase` **从不**触发 `post-merge`；`post-checkout` 确实会触发，但那一刻 `.git/rebase-merge` 还在，仓库自己的守卫（如 DigitDoor 的 `after-update.sh`）会走「序列进行中，跳过」分支。所以 rebase 之后没有任何钩子能补导表/重建。无条件每卡跑一次还顺手兜住了人在外面 rebase / cherry-pick / reset 留下的脏导出。

代价可以接受的前提是脚本自己会秒退：DigitDoor 的 `after-update.sh` 先比状态，导出本来就新时 1~2 秒退出。

两条硬约束：

- 它**不允许在工作区留下改动**——那些改动会被 `git add -A` 算进本卡提交。产物该进 `.gitignore`。
- 它只管**开工前**。内循环自己在 turn 里 rebase/pull 造成的脏导出由内循环负责（项目规则里已经写了改完表要导表），外循环不替它兜。

命令走 `shell: true`，Windows 上就是 **cmd.exe**：值里不要写 POSIX 的 `;` 和 `&&`（用 `&`），要跑 sh 脚本就显式写 `bash <路径>`。输出按 UTF-8 解不出来时自动回退 GBK（cmd/powershell 的中文走控制台代码页），落在 `after-sync.log`。

`statuses` 是允许接单的状态 key，默认 `developing`（开发中）与 `status_11`（实现中）。TAPD 的状态 key 按项目自定义，`--list` 会打印 `key(中文名)` 的对照，不确定就先跑它。

## 一张卡的一生

1. `listReady` 拉 `owner=<assignee>`、带 `readyLabel`、不含机器标签、且状态在 `statuses` 里的需求，按优先级再按 id 排序
2. 加 `afk-claimed` 占住（best-effort，先到先得）；认领时再查一次状态，防止列表之后被人改回「已完成」
3. 读描述和全部评论，拼成 brief；正文里的 `/tfl/` 内嵌图经 `tapd-cli attachment get-image` 拿签名地址后下载到本地，正文换成 `![图片](images/img-N.png)`
4. 同时落一份 `card.md`（标题、状态、链接、描述、评论，图片相对路径），brief 里用绝对路径引用同一批图片
5. 起一次 `pi --print --mode json`，技能的**正文由 pi 读进系统提示**（`--append-system-prompt <SKILL.md>`），brief 只描述这张卡与边界，不再叫它去读技能
6. 判定：进程正常结束 → 有 git 改动（或新 commit）→ `verify` 通过
7. 通过则提交；**提交之后再同步一次并 `git push`**（`publish`，默认关闭），然后撤 `afk-claimed`、加 `afk-delivered`、评论总结与最终提交号
8. 判定失败则 `git reset --hard <基线>` + `git clean -fd`，加 `afk-failed` 并评论原因

内循环的启动参数（实测过，别改回去）：技能正文靠 `--append-system-prompt <SKILL.md 路径>` 注入，pi 给路径时读的是文件内容。只给 `--skill` 不够：它**只**在系统提示里登记 name/description/path，不注入正文，而 yogioo-mode 的 frontmatter 还带 `disable-model-invocation: true`，连自动选择都关掉了。只给 `--skill` 时系统提示里搜不到 `Non-negotiables`；加上 `--append-system-prompt` 后正文进了 system message，整轮 **零工具调用**。brief 里因此不需要（也不应该）再写「先 read SKILL.md」。

状态检查通过之后、**取基线之前**还有一段前置（`preflight`）：`sync`（`git pull --rebase`）→ `afterSync`。顺序不能换：rebase 会改写历史，基线若取在它前面，失败回滚 `reset --hard <基线>` 会把刚拉到的上游 commit 一起抹掉。

前置失败分两种，区别是「这张卡的问题」还是「环境的问题」：

- **同步遇到冲突**（或未跟踪文件挡住上游同名文件）→ 回退 rebase、不动 TAPD、整批停（`blocked`）。在同一个陈旧基线上继续开下一张只会重复浪费内循环。
- **同步只是网络/没 upstream/detached HEAD/已跟踪文件有改动** → 只是一句告警，照常开工，不阻塞。
- **afterSync 红**，或它留下工作区改动 → 整批停（`blocked`）。导出是旧的，开了工也白做；改动留着会被算进本卡提交。

## 推送

`push.enabled` 打开后，第 7 步多一道 `publish`：**提交之后、回写之前**先 `git pull --rebase` 一遍，再 `git push <remote> <branch>`。卡跑了十几到几十分钟，这期间别人可能又推了，所以推之前必须再对一次上游；失败了就重来一轮（`push.retries`，默认 3 轮）。

两条硬约束：

- **永不 `--force`。** 共享分支上强推等于删别人的提交。
- **`verify` 为空时拒推。** 没有验证过的改动不该自己进共享分支；确实要这样，显式写 `push.allowUnverified: true`。这条在启动时就报错，不是等一张卡跑完二十分钟才告诉你。

失败时的分界线是**提交有没有发生**：

- 提交之前（超时 / 没 settled / 无改动 / verify 红）→ 回滚到基线，工作区的活丢掉，加 `afk-failed`。
- 提交之后（推送前同步冲突 / 远端拒绝 / 分支保护）→ **不丢活，也不留在当前分支上**。当前分支退回提交的父节点（等于这张卡没发生过），提交挪到 `tapd-loop-unpushed/<卡片id>`，加 `afk-failed`，评论里写出分支名和 sha。

为什么不留当前分支：下一张卡的 `publish` 会把它一起推上去，而 TAPD 上写的是「未推送」。一条已经失效的记录不如没有。

推成功的卡片，评论里的 sha 是**推送后**的 HEAD，格式 `提交：<sha10>（已推送 origin/<branch>）`。这一步不能省：rebase 会改写 sha，commit 那一刻的 sha 在推完之后可能已经不存在于远端。

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
- 前置失败（`blocked`）：同步冲突 / afterSync 红 / afterSync 留下改动，立刻停整批，不打 TAPD 标签
- 队列为空（没有 `--watch` 时退出，有则轮询 `pollSec`）
- 停止文件出现就退出：`<git-dir>/tapd-loop-stop`（主树是 `.git/tapd-loop-stop`，每棵树各自一份，停一棵不影响其他）

## 输出

- 标准输出一行 JSON 摘要
- `<runDir>/report.md` 每张卡的结果
- `<runDir>/<卡片id>/` 该卡的 `card.md`、`images/`、`brief.md`、`card.json`、`events.jsonl`、`pi.log`、`verify.log`、`after-sync.log`

`--fetch` 的单卡产物落在 `~/.tapd-loop/cards/<需求id>/`。

图片下载失败只降级成 `[图片下载失败: 路径]`，不阻断开工。单张卡最多取 30 张图。

默认 `runDir` 为 `~/.tapd-loop/runs/run-<时间戳>`。

## 回写

评论正文按句子边界截到 2000 字（超了加 `…`），不按字数硬切；路径在评论里统一写成正斜杠，因为 Markdown 会把 `\.` 当转义、把 `C:\Users\EDY\.tapd-loop` 吞成 `C:\Users\EDY.tapd-loop`。

tapd-cli 各命令的回执形状不统一：读命令（`story list`、`comment list`…）给 `{status:1,data,info}`，写命令里 `comment add` 只回一个不带 `status` 的壳。所以读命令要求 `status===1` 或带 `data`，写命令按 lenient 判（exit 0 且没有明确的失败体就算成功）；API 真失败时 tapd-cli 是 **exit 1 + stderr**，不会落到这条路径上。

report 里出现「回写异常」时，用 `TAPD_LOOP_DEBUG=1` 重跑一次，stderr 会打出 tapd-cli 的原始 stdout 回执；同时去 TAPD 上人工确认评论与标签，别只信 report。

## 边界

- 只写机器标签，不改 TAPD 状态和处理人。验收流转由人做。
- `push` 打开后它会往共享分支推东西。先确认 `verify` 真的能拦住坏改动，再开。
- 状态不是「开发中 / 实现中」就不接单，标签挂着也不接。`--list` 的 `rejected` 会列出被状态挡住的卡与原因。
- 描述与评论都为空时不认领，直接标失败并评论，让人补充后撤销标签重跑。
- 同一项目多份拷贝并行时靠 `afk-claimed` 互斥，谁先加谁拿到。
