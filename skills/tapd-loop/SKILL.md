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
  - 版本 **>= 1.16**：前置依赖检查要 `story time-relations`（1.9.x 没有这个子命令）。更老的版本不会报错，只会打一行 `依赖检查已跳过` 后照常跑卡。
- 工作目录是 git 仓库，且启动时干净
- 内循环技能存在，默认 `~/.agents/skills/yogioo-mode`

## 调用

```powershell
node <技能根>/scripts/loop.mjs --workdir <仓库> --assignee <TAPD处理人> --list
node <技能根>/scripts/loop.mjs --workdir <仓库> --assignee <处理人> --max-tasks 1
node <技能根>/scripts/loop.mjs --workdir <仓库> --watch --max-tasks 10
node <技能根>/scripts/loop.mjs --workdir <仓库> --fetch <需求id>
node <技能根>/scripts/loop.mjs --workdir <仓库> --show <需求id>
node <技能根>/scripts/loop.mjs --workdir <仓库> --retry <需求id> [--dry-run] [--force]
```

`--list` 只看队列，`--show` 只读地问一句「这张卡现在什么状态、能不能接」，`--fetch` 只抓一张卡的标题、详情、评论和图片到本地，`--retry` 只改标签（撕 `afk-claimed` / `afk-delivered` / `afk-failed`、加回 `ready-for-agent`，把卡放回队列，见「一张卡的一生」第 8 步），都不跑内循环。真跑前先用 `--max-tasks 1` 跑一张，读 report 与 `events.jsonl`。

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

`~/.tapd-loop/config.json` 里还可以写 `board`（只看板用，不影响 loop）：`{"board": {"host": "0.0.0.0", "port": 7317}}`。`start-board` 的顺序是 `--host/--port` > `$TAPD_LOOP_BOARD_HOST` > `board.host` > 内置默认。

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

### 前置依赖检查

TAPD 上给需求标了前后置关系（「A 完成后 B 才能开始」）时，前置没完成就不接这张卡——否则前端画完了才发现后端接口还没写。

- 数据来自 `tapd-cli story time-relations`，方向按记录里的 `workitem_id`(src) / `dst_workitem_id`(dst) 判：`relation_type=after`（默认）时 dst 被 src 挡；`before` 时反过来。
- 「前置算完成」的判定：配了 `task.doneStatuses` 就按它（状态 key 或中文名都能写，如 `["status_7", "已完成"]`）；没配就按状态中文名猜（含「已完成/已关闭/已发布/完成」等，且排除「待/未/不/非」开头）。
- 被挡住的卡进 `--list` 的 `rejected`，`reason` 写「前置未完成: <id>(<状态>)」；`--show <id>` 里是结构化的 `blockers` 数组。**不会静默跳过**。
- 两种关掉的方式：`task.checkDependencies: false`（整机关），或把 `task.doneStatuses` 写宽一点。
- 只认「前置已完成」，所以 `begin` 型依赖（前置只要开始就行）也按完成判，偏保守；觉得卡太严就按上面调。
- 依赖查询按进程缓存 60 秒，`listReady` / `listRejected` / 认领不会对同一张卡反复查。

## 一张卡的一生

1. `listReady` 拉 `owner=<assignee>`、带 `readyLabel`、不含机器标签、状态在 `statuses` 里、且前置依赖都已完成的需求，按优先级再按 id 排序
2. 加 `afk-claimed` 占住（best-effort，先到先得）；认领时再查一次状态，防止列表之后被人改回「已完成」
3. 读描述和全部评论，拼成 brief；正文里的 `/tfl/` 内嵌图经 `tapd-cli attachment get-image` 拿签名地址后下载到本地，正文换成 `![图片](images/img-N.png)`
4. 同时落一份 `card.md`（标题、状态、链接、描述、评论，图片相对路径），brief 里用绝对路径引用同一批图片
5. 起一次 `pi --print --mode json`，技能的**正文由 pi 读进系统提示**（`--append-system-prompt <SKILL.md>`），brief 只描述这张卡与边界，不再叫它去读技能
6. 判定：进程正常结束 → 有 git 改动（或新 commit）→ `verify` 通过
7. 通过则提交；**提交之后再同步一次并 `git push`**（`publish`，默认关闭），然后撤 `afk-claimed`、加 `afk-delivered`、评论总结与最终提交号
8. 判定失败则**先把工作区原样存成 `tapd-loop-failed/<卡片id>` 分支**，再 `git reset --hard <基线>` + `git clean -fd`，**撕 `afk-claimed` 和 `ready-for-agent`、加 `afk-failed`**，评论写清原因、改动存在哪个分支、以及「怎么重跑」

失败不等于白干：六个小时的活蒸发在 `reset --hard` 里比什么都贵。所以失败时先做一份存档提交（`--no-verify`，不走钩子），挂到 `tapd-loop-failed/<卡片id>`（同名已存在就 `-2`、`-3`…），再回滚到干净基线。工作区是干净的（不污染下一张卡），改动也还在：`git diff <基线>..tapd-loop-failed/<卡片id>`。`<runDir>/<卡片id>/diff.txt` 也留了一份。

失败为什么连 `ready-for-agent` 一起摘（2026-10-27 定的）：失败通常是拆卡、改配置、看环境这类要人先过一手的事；留着 ready 只会让下一批把同一张卡再踩一遍，还多花钱多占工位。摘掉之后想重跑：

```powershell
node <技能根>/scripts/loop.mjs --workdir <仓库> --retry <需求id>            # 撕 afk-claimed/afk-delivered/afk-failed，加回 ready-for-agent
node <技能根>/scripts/loop.mjs --workdir <仓库> --retry <需求id> --dry-run  # 只看会变成什么标签
```

`--retry` 只碰标签，不动状态、不动处理人；卡上还带 `afk-claimed` 时默认拒（可能别的批次正跑着），确认没在跑才加 `--force`。

内循环的启动参数（实测过，别改回去）：技能正文靠 `--append-system-prompt <SKILL.md 路径>` 注入，pi 给路径时读的是文件内容。只给 `--skill` 不够：它**只**在系统提示里登记 name/description/path，不注入正文，而 yogioo-mode 的 frontmatter 还带 `disable-model-invocation: true`，连自动选择都关掉了。只给 `--skill` 时系统提示里搜不到 `Non-negotiables`；加上 `--append-system-prompt` 后正文进了 system message，整轮 **零工具调用**。brief 里因此不需要（也不应该）再写「先 read SKILL.md」。

状态检查通过之后、**取基线之前**还有一段前置（`preflight`）：`salvage`（清掉上一批留下的脏工作区）→ `sync`（`git pull --rebase`）→ `afterSync`。顺序不能换：rebase 会改写历史，基线若取在它前面，失败回滚 `reset --hard <基线>` 会把刚拉到的上游 commit 一起抹掉；而脏工作区会让 rebase 直接被 git 拒掉。

`salvage` 是干什么的：被 `taskkill /F`、断电、关终端杀掉的那一批不会走失败收尾，工作区里就留着半截改动。那些东西既挡 rebase（于是整张卡干在陈旧基线上），又会被本卡的 `git add -A` 一起提交——`1005133` 那种「被杀的 run」就是这么污染下一张卡的。所以开工前先把它存成 `tapd-loop-orphan/<卡片id>` 分支（`<runDir>/<卡片id>/orphan.patch` 也落一份）再清干净；存不进去就整批停（`blocked`），宁可不跑也不让别人的 diff 混进来。不想要这个行为：`run.salvageDirty: false`。

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

- 提交之前（超时 / 没 settled / 无改动 / verify 红）→ 回滚到基线，工作区的活丢掉，**标签换成 `afk-failed` 并摘掉 `ready-for-agent`**（重跑用 `--retry`）。
- 提交之后（推送前同步冲突 / 远端拒绝 / 分支保护）→ **不丢活，也不留在当前分支上**。当前分支退回提交的父节点（等于这张卡没发生过），提交挪到 `tapd-loop-unpushed/<卡片id>`，同样换成 `afk-failed` + 摘 ready，评论里写出分支名和 sha。

为什么不留当前分支：下一张卡的 `publish` 会把它一起推上去，而 TAPD 上写的是「未推送」。一条已经失效的记录不如没有。

推成功的卡片，评论里的 sha 是**推送后**的 HEAD，格式 `提交：<sha10>（已推送 origin/<branch>）`。这一步不能省：rebase 会改写 sha，commit 那一刻的 sha 在推完之后可能已经不存在于远端。

**没推上去就不报 sha。** `push.enabled` 关着时（工位流程）评论只写「提交：本地已提交、未推远端；合入主树并推送后会在这张卡上补发最终提交号。」：那个 sha 只活在本仓库对象库里，主树 `collect.mjs` cherry-pick 之后会换成新的合并提交号，在 TAPD 上写它只会让人拿着查不到的 hash 去对代码。最终提交号由 collect 那一条评论给（`合并后提交 <新sha>（工位原始提交 <旧sha>）`）。

本地 sha 仍然记在 `<runDir>/<卡片id>/` 的 report / `card_done` 事件里：collect 靠它把合入的提交找回卡片。想让它出现在评论里，配 `run.writeBack.showLocalCommit: true`。

## 提交信息

外循环内置项目 `digitdoor-git-commit` 的格式：`<type>:<7位工单号> <中文描述>`，例如 `feat: 1005050 数字门受击逻辑`。

brief 要求内循环最后输出 `COMMIT: <type>:<7位工单号> <描述>`。外循环校验工单号必须是卡片 id 的后 7 位，对不上就用卡片标题兜底。不带 AI 署名，不写 19 位全 id。

标签是多选字段，多值用竖线分隔。每次写完都回读校验，不一致就报错。

## 看板

```powershell
node <技能根>/scripts/start-board.mjs            # 起一个常驻的，已在跑就复用；默认绑 0.0.0.0
node <技能根>/scripts/start-board.mjs --status   # 在哪、活着没、分享链接
node <技能根>/scripts/start-board.mjs --stop
node <技能根>/scripts/start-board.mjs --local     # 只本机可用（绑 127.0.0.1，不要密钥）
node <技能根>/scripts/start-board.mjs --port 7400 --host 192.168.1.5
```

`start-board` 用 detached 子进程拉起 `serve.mjs`，自己的进程退出了网页也不会关。地址固定写进 `~/.tapd-loop/board.json`，重复执行只返回同一个 URL。日志在 `~/.tapd-loop/board.log`。

每次跑 loop 都会先确认看板在跑：没起就自动起，已在跑就复用。stdout 第一行就是 `board: <url>`，结束时的 JSON 摘要里也有 `board` 字段。不想要看板加 `--no-board`。

### 页面能做的事

顶上那块面板就是 CLI 的按钮版，取卡/占卡/判定/回写一律走 `loop.mjs`，页面里没有第二套实现：

| 控件 | 等于 |
| --- | --- |
| 工作目录 + 处理人 + 本批最多 | `--workdir` / `--assignee` / `--max-tasks` |
| 允许脏工作区 / 只演练 | `--allow-dirty` / `--no-write` |
| 查看 TAPD 队列 | `--list`，列出就绪卡与「被状态挡住」的卡 |
| 接单开跑 / 只跑这张 | 真跑，等同 `loop.mjs --workdir … --max-tasks n [--card id]` |
| 本批跑完就停（不杀进程） | 写 `<git-dir>/tapd-loop-stop`，和 CLI 的 `--stop` 一样不杀当前卡。**只对主树上的多卡批次有效**（工位批次一张一批，没东西可停），没主树批次时按钮是灰的 |
| 定时查看 TAPD 并接单 | 开关 + 间隔秒（30 秒起，默认 300），等于 CLI 的 `--watch` 配 `run.pollSec` |
| 主树自动验证并推送 | 开关 + 间隔秒（30 秒起，默认 120）。主树领先 origin、没冲突、工作区干净、Unity 端点在线、没有别的主树任务在跑时，自己跑 `collect --resume`（导表 → verify → push → 回写 TAPD）；失败按 1/2/4/8/16/30 分钟退避，成功清零 |
| 主树自动合入工位提交 | 开关 + 间隔秒（30 秒起，默认 120）。主树干净、没冲突、Unity 在线、没有主树任务在跑、自动推送开着时主树没有未推提交，就挑一个「空闲 + 有未合入提交」的工位跑 `collect.mjs <分支> --resolve`（pick → 导表 → verify → push → 回写）；一次只合一个，退避按工位各记各的。**默认关**：它往共享分支写东西 |
| 指定工单：贴链接 + 查看这张 / 接这张开跑 | 先 `--show <id>` 看清楚，再 `--card <id>` 真跑（永远只跑一张） |
| 工位卡片上的「接活」开关（勾选框） | 勾上 = 调度器会派卡；取消 = 落一个持久的 `station.paused`，调度器直接跳过这个工位（**不影响**手上那张）；不是写停止文件 |

**一次只允许一批**：判活看 `progress.jsonl` 里的 pid，所以命令行起的批次也算，网页和 CLI 不会在同一个仓库上撞车。工作区不干净、目录不是 git 仓库、已经有一批在跑，都会在开跑前直接拒掉（不在 spawn 之后才失败）。

**「合入」和「验证并推送」是两件事，不要混**（混了就永远等不到自动合入）：

- **合入**（工位卡片上的「合入 N」，或开了自动合入）= `collect.mjs <分支>`：把工位提交 cherry-pick 进主树，再导表 → verify → push → 回写。**只有这条路径会 pick**。
- **验证并推送**（主树卡片上的按钮 / 自动推送）= `collect.mjs --resume`：提交已经在主树本地了、只是没推（典型：合入时 verify 挂了）才用它，它跳过 pick。

自动合入的门槛都是硬性的：主树干净 + 没冲突 + Unity 在线 + 没有主树任务在跑，一次只合一个工位（verify 只有一块 Unity，两棵树同时 pick 会互相踩）。冲突时 `--resolve` 保留现场并自动起 agent 解；**xlsx 表格冲突直接拒**（自动合会丢行），退避拉满 30 分钟等人来。

**collect 的退出码就是 job 的状态**：`0` 完成、`1` 真失败（代码/推送被拒）、`2` 冲突已保留现场（触发自动解冲突）、`3` 环境未就绪（这棵树的 Unity 端点不在线）。`3` 在页面上是 `⏸ 等环境/等人`，不是红——它不是代码问题，拿它去查代码只会白花时间。collect 自己在 pick/导表之前先探一次端点（缺 endpoint.json / pid 已死 / 端口连不上都算），不在线就不开工，不再「pick 完了才在 verify 那步炸」。

「指定工单」是给「别人在聊天里丢一条链接过来」用的：把 `https://www.tapd.cn/tapd_fe/<项目>/story/detail/<id>`、`.../prong/stories/view/<id>` 或者 19 位 id 直接贴进去。

- **查看这张**只调 `--show`：不认领、不评论、不建 runDir，先看清楚标题/状态/标签
- 认不出的链接会直说认不出；只在实在认不出时才退化成「取最长的一段数字」并标注猜的
- **接这张开跑**之前会再确认一次：卡上已经有 `afk-claimed` / `afk-delivered` / `afk-failed`，或者状态不是开发中/实现中，就直接拒掉并写出原因——不会 spawn 一个「拉起来就被跳过」的批次
- 真跑用的是 `--card <id>`，所以**只跑这一张**：`maxTasks` 被强制成 1（否则第二轮会重新把同一张卡拉出来再跳过一次）

「接单开跑」会顺手清掉上一次留下的停止标记：那个标记是「下一张之前停」的一次性开关，不清的话再点一次跑会在第一张卡之前直接退出，看着像坏了。

定时接单的定时器活在 `serve.mjs` 里：看板不开就没有定时接单。它每 `pollSec` 秒跑一次 `--list`，有就绪卡才开工；批次在跑时不查；查到但没有卡只更新「上次查到几张」。这个设置和上一批的状态一起落在 `~/.tapd-loop/board-control.json`（机器级，跟着看板走，不写仓库）。

### 局域网

默认绑 `0.0.0.0`，页面顶上会显示一条带密钥的分享链接。`serve.mjs` 的 `/api/*` 在出网时一律要密钥，页面骨架和静态资源不要：

- 密钥存在 `~/.tapd-loop/board-key`，只生成一次，重启不换，发出去的链接不会失效
- 只从打出来的 `?k=<key>` 进来一次，之后存浏览器 `localStorage`，每个请求带 `x-tapd-loop-key`
- 别人拿到的那条链接可以直接点「接单开跑」——这正是分享的目的，所以别丢到公共频道
- 只想本机用：`--local`，这时不要密钥

这个页面能让人替你在共享分支上提交代码，所以它跟只读的 agent runs 看板不是一个安全等级。绑 `0.0.0.0` 就意味着同网段的人拿到链接就能开跑。

### 看什么

左边是每个 run 的卡片队列，点一张卡开内部窗口，里面依次是工单（含图片）、主 Agent 结论、brief、验证输出、改动 diff、进程日志尾部、子代理，以及内循环事件时间线。每 2 秒刷新。run 结束后页面继续在，变成历史 run。

卡片窗口自己不滚动：横向铺满、纵向按内容长到 88vh 封顶，区块区和内循环时间线各自滚。

批次自己的 stdout/stderr 在 `~/.tapd-loop/board-batches/batch-<时间戳>.log`，跑完那行 JSON 摘要会解析进 `lastBatch.summary`，页面的「已开跑」消息和这里对得上。

接口（都要求密钥，除 `/healthz`）：`GET /api/state`、`/api/card`、`/api/arm`、`/api/control`、`/api/queue`、`/api/card-link`（贴链接先看一眼）、`POST /api/control`（存设置）、`POST /api/run`（带 `ref` 就先翻译成 id 并确认能接）、`POST /api/stop`。

### 中断的卡

进程被强杀（`taskkill /F`、关终端、断电）不会留下 `loop_end`，只读事件流就会永远显示「运行中」。所以存活按进程判：`loop_start` 里记了 `pid`，pid 不在了就把还在 `running` 的卡标成「已中断」、按最后一条事件停表、写明原因；pid 判不了（老 run 没记、EPERM、跨机）才退回「10 分钟没事件」。

loop 每 15 秒写一条 `heartbeat`，收到 SIGINT / SIGTERM / SIGBREAK 时先杀掉内循环子进程，再写 `card_interrupted` 与 `loop_end` 才退出。

子代理点开是第二层窗口，左上角「返回」回到卡片，Esc 退一层。每个 arm 都有自己的 think / say / tool 时间线。

这些区块默认收起，展开状态记在浏览器本地，刷新不丢。改动 diff 逐行红绿着色，可切单列/双列，模式也记住。

时间线里主 Agent 的发言和思考默认折叠，点一下展开；完整结论在「主 Agent 结论」区，不用滚时间线。

深链可以直接选中一张卡：`http://127.0.0.1:7317/?run=run-<时间戳>&id=<需求id>`（出网时再带 `&k=<key>`）。

默认读 `~/.tapd-loop/runs`，配置了 `run.cacheDir` 就用 `--root <目录>` 指过去。

## 停止

- 批次数到 `maxTasks`
- 连续失败到 `maxFailures`
- 前置失败（`blocked`）：同步冲突 / afterSync 红 / afterSync 留下改动，立刻停整批，不打 TAPD 标签
- 队列为空（没有 `--watch` 时退出，有则轮询 `pollSec`）
- 停止文件出现就退出：`<git-dir>/tapd-loop-stop`（主树是 `.git/tapd-loop-stop`，每棵树各自一份，停一棵不影响其他）。网页上的「停止」写的就是这个文件，「接单开跑」会把它清掉。

**工位上没有「停这一张」这个操作，也不该有**：看板派卡永远是一张一批（`--card` 直接把 `maxTasks` 强制成 1），loop 只在卡与卡之间读停止文件，所以那个标记对工位批次永远读不到——写了也白写（旧版页面上那个「跑完这张就停」就是这样，点了等于没点）。

想让它别再领新卡：把工位卡片上的「接活」开关取消勾选 → 存进 `stations[].paused`，调度器（`tick`）直接跳过它，在跑的那张照常跑完；再勾上就接回去。要在跑的那张本身，只能去工位里杀进程（本工具从不主动杀）。

## 输出

- 标准输出一行 JSON 摘要
- `<runDir>/report.md` 每张卡的结果
- `<runDir>/<卡片id>/` 该卡的 `card.md`、`images/`、`brief.md`、`card.json`、`events.jsonl`、`pi.log`、`verify.log`、`after-sync.log`

`--fetch` 的单卡产物落在 `~/.tapd-loop/cards/<需求id>/`。

图片下载失败只降级成 `[图片下载失败: 路径]`，不阻断开工。单张卡最多取 30 张图。

默认 `runDir` 为 `~/.tapd-loop/runs/run-<时间戳>`。

## 回写

评论正文按句子边界截到 2000 字（超了加 `…`），不按字数硬切；路径在评论里统一写成正斜杠，因为 Markdown 会把 `\.` 当转义、把 `C:\Users\EDY\.tapd-loop` 吞成 `C:\Users\EDY.tapd-loop`。

tapd-cli 各命令的回执形状不统一：读命令（`story list`、`comment list`…）给 `{status:1,data,info}`；写命令在 1.9.x 里 `comment add` 只回一个不带 `status` 的壳（1.16 起多数回 `{status:1}`）。所以读命令要求 `status===1` 或带 `data`，写命令一律按 lenient 判（exit 0 且没有明确的失败体就算成功），别把写命令改成严格校验；API 真失败时 tapd-cli 是 **exit 1 + stderr**，不会落到这条路径上。

评论正文由 tapd-cli 自己识别格式并转 HTML（1.16 起：纯文本自动包 `<p>`，Markdown 转 HTML），所以 note 里的 `##`、列表、`|` 表格在 TAPD 上是正常渲染的，不用自己拼 HTML。**写错的评论现在能改**：`comment update id=<评论id>`（`tapd.mjs` 有 `updateComment`），别再靠「再发一条更正」这种留垃圾的方式。

report 里出现「回写异常」时，用 `TAPD_LOOP_DEBUG=1` 重跑一次，stderr 会打出 tapd-cli 的原始 stdout 回执；同时去 TAPD 上人工确认评论与标签，别只信 report。

## 边界

- 只写机器标签（`afk-*` 和失败时的 `ready-for-agent`），不改 TAPD 状态和处理人。验收流转由人做。
- `push` 打开后它会往共享分支推东西。先确认 `verify` 真的能拦住坏改动，再开。
- 状态不是「开发中 / 实现中」就不接单，标签挂着也不接。`--list` 的 `rejected` 会列出被状态挡住的卡与原因。
- 前置依赖没完成的卡同样不接，`rejected` 的 `reason` 会写清是哪张前置在挡。认领时（`claim`）会再验一次，防止列表之后依赖关系变了。
- 描述与评论都为空时不认领，直接标失败并评论，让人补充后撤销标签重跑。
- 同一项目多份拷贝并行时靠 `afk-claimed` 互斥，谁先加谁拿到。
