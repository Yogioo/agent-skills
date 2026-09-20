---
name: afk-init
description: >-
  写入 ~/.afk/config.json（全局，或 <名称>_<uid> 项目覆盖）。AFK 三个技能都要求这份配置存在，缺了会直接报错。
  仅在用户明确要求加载 afk-init 时使用；不要因「配置 / 初始化」等泛化说法自动加载。
disable-model-invocation: true
---

# AFK 配置初始化

顺序固定：**先讲清这套东西怎么跑 → 收集线索 → 推断并请用户拍板 → 跑脚本写入 → 回报路径**。用户在听到流程说明之前，不看到任何问题。

## 完成标准 / 前置

- `node` 可用；本技能自带 `config.example.json`（四分区字段菜单），且兄弟目录 `afk-run` / `afk-watch` / `exec-review` 存在
- 已知目标 `workdir`（默认当前任务仓库根）
- 本技能是 AFK 三个技能的**唯一配置入口**：`~/.afk/config.json` 缺失时，`afk-run` / `afk-watch` / `exec-review` 都会报错并指向这里（没有内置兜底）
- 完成标准：流程说明已发出，用户随后明确认可 source 与 scope；目标目录下写出 `config.json`；project 范围另有 `meta.json`；同层刷新 `README.md`；stdout 有 JSON 摘要

## 步骤

1. **讲清流程（提问之前做完）**

   用日常话一次讲完下面三块。每句话先落地，再上名词；`remote` / `source` / `claim` 这类词第一次出现时跟一句日常解释。

   **谁干嘛：**

   - `afk-init`：写设置文件。写一次就完事，它不拿单子、不干活。
   - `afk-watch`：一直守着。隔几秒看一眼有没有能干的单子，有就占住并开工。
   - `afk-run`：干一批。一次只拿一张单子，交给 `exec-review`。
   - `exec-review`：派一个 agent 动手写，再派另一个 agent 检查。

   **一张单子的一生：**

   1. 有人写单子、贴到单子来源、打「可以让电脑干」的标签
   2. watch 隔一会看一眼：有没有能干的
   3. 有就先**占住**（防止两台电脑抢同一张）
   4. watch 叫 run 起来；run 一次只拿一张，转给 exec-review
   5. exec-review 派一个写，再派一个查
   6. 查过 → 标记完成、改动留下；没过 → 这次改动**全部撤销**，回到干净状态
   7. 连着砸好几张 → 熔断停下
   8. 这批干完 → run 出报告后退出 → watch 回去继续看（外层是个圈）

   **afk-init 卡在哪：**

   watch 要去看单子，得先知道两件事：单子放在哪里、这份设置管多大范围。这两件事记在 `~/.afk/config.json` 里（单文件分区：`task` 共用，`watch` / `run` / `execReview` 各归其主）——就是本技能这一步要写的东西。这份文件是三个技能**唯一**的配置来源，缺了它们直接报错。

   完成标准：说明已发出，且覆盖「谁干嘛 / 单子的一生 / 设置里要填什么」。

2. **收集线索（只读，不改任何东西）**

   摆一张表，每行一句话结论，让用户看到推断的依据：

   | 线索 | 怎么看 |
   |---|---|
   | 有没有本机单子文件夹 | `.beads/` 是否存在 |
   | 项目连到网上哪个地址 | `git remote -v` |
   | 项目文档怎么写单子的事 | 例如 `docs/agents/issue-tracker.md` |
   | 命令行工具是否可用 | `gh auth status`、`bd` |
   | 有没有已存好的设置 | `~/.afk` 是否存在 |

   完成标准：表里每行都有结果。

3. **推断 → 一次问全两个问题（禁止静默选定）**

   先摆事实，再给**一条**推断（带依据），然后把两个必问一起问出来：日常话在前，括号里的取值供脚本用。

   - **单子放在哪里？** → GitHub（`gh`）/ 本机文件夹（`beads`）/ TAPD（`tapd`）
   - **这份设置管多大范围？** → 只这一个项目（`project`）/ 你电脑上所有项目共用（`global`）

   措辞示例：

   > 我看了上面那张表：项目连到 GitHub 上的 `owner/name`，项目文档也写单子贴 GitHub。
   > 所以我猜单子放在 **GitHub** 上。
   > 请拍板两件事：①单子放在哪（GitHub / 本机文件夹 / TAPD）？②这份设置只管这个项目，还是你电脑上所有项目共用？

   - `gh`：确认时一并敲定 `--repo`（可给从地址推出的候选）
   - `tapd`：确认时一并敲定 `--tapd-assignee`（**必填**，TAPD 处理人）；标签名 `--tapd-*-label` 有默认值，不动即可

   完成标准：用户已明确认可的 `source` ∈ beads|gh|tapd，且 `scope` 已选定（及必要的 repo / tapd 处理人）。

4. **写入配置（禁止手写 JSON 替代脚本）**

```powershell
node <技能根>/scripts/init-project.mjs --workdir <绝对路径> --source <beads|gh|tapd>
node <技能根>/scripts/init-project.mjs --scope global --source beads
node <技能根>/scripts/init-project.mjs --workdir <路径> --source gh --repo owner/name --force
```

默认：`task.maxTasks=1`；`watch.requireAtomicClaim` 仅 `beads` 为 true；`execReview.runner=pi`（**必填**——留空又不用 CLI/env 指定时，exec-review 直接报错）；`execReview.sandbox=danger-full-access`（改回 `workspace-write` 会写不了 `.git`，提交全部 `blocked`）；`serve.open` / `task.allowDirty` 默认 false。
已有 `config.json` 需确认后加 `--force`。摘要里 `legacyFiles` 非空时说明该目录还有旧版 `run.json` / `watch.json`，它们已不再加载。
脚本同时在**同一目录**写/刷新 `README.md`（模板 `readme.template.md`）：记录四个配置分区与常用字段、提示词覆盖文件名与堆叠顺序、常用命令；`files.readme` 是它的路径。
完成标准：退出码 0，摘要含 `afkDir` / `files`（`config` / `meta` / `readme`）。

5. **向用户汇报**
   - 写出的路径：`~/.afk/config.json`（project 范围是 `~/.afk/<项目名_UID>/config.json`）
   - 同层的 `README.md`：配置分区、提示词覆盖文件名与堆叠顺序都写在里面
   - `source`、`requireAtomicClaim`
   - 「其余字段（runner / sandbox / 模型）直接编辑这份 `config.json`」——它是机器本地文件，不入库
   - 需要按环境定制执行端/审查端提示词时，在同层新建 `standards.md` / `executor.append.md` / `reviewer.append.md` / `executor.prompt.md` / `reviewer.prompt.md`（脚本只写 README，**不建这些空壳**）；装配规则见 `../exec-review/SKILL.md` 的「提示词覆盖」
   - 启动：`node <afk-watch>/scripts/watch.mjs --workdir <路径>`
   完成标准：用户知道配置在哪、怎么开 watch、改哪个字段该编辑哪个分区。

## 不要做

- 不要在流程说明之前提问，也不要跳过说明直接抛问题
- 不要未确认就按推断写入 source
- 不要为「每批几单」「是否原子认领」再访谈
- 不要创建空的提示词覆盖文件（`standards.md` / `*.append.md` / `*.prompt.md` 只写进 README，让操作者按需自建）
- 不要写仓库内 `.afk/`（只写 `~/.afk` / `$AFK_HOME`）
- 不要在 gh/tapd 上把 `requireAtomicClaim` 写成 true

## 参考

- 字段菜单：`config.example.json`（本技能目录，四分区模板，永不自动加载）
- README 模板：`readme.template.md`（写入目标 AFK 目录，字段与覆盖约定都来自这里）
- 键算法与分区解析：`../afk-run/scripts/afk-home.mjs`
- 各分区字段：`../afk-watch/references/config.md`、`../afk-run/references/config.md`、`../exec-review/references/config.md`
- 流程细节：`../afk-run/SKILL.md`、`../afk-watch/SKILL.md`
