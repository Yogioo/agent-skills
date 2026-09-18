# afk-watch 配置

优先级：**CLI > `--config` 文件 > `~/.afk/<项目名_UID>/config.json` > `~/.afk/config.json` > 内置**。

`<项目名_UID>` 中 UID 是 workdir 规范化绝对路径的 sha256 前 8 位，避免同名目录撞车。标签默认是文件夹名，init 时可改；加载时按 UID 匹配目录。

可用环境变量 `AFK_HOME` 改根目录（默认 `~/.afk`）。

**单文件分区**：同一字段只出现一次。`task` 由 afk-watch / afk-run 共用，`watch` / `run` / `execReview` 各归其主。本技能读 `task` + `watch`。

项目层与全局层**递归**合并（项目覆盖全局，嵌套对象也合并）。

**配置文件必须存在**——两层都没有就直接报错退出（提示跑 `afk-init` 或 `--config`），不做兜底；文件里**缺的键**才走内置默认。

技能根没有配置文件。`~/.afk/config.json` 用 [`afk-init`](../../afk-init/SKILL.md) 的 `scripts/init-project.mjs` 生成（该技能 `disable-model-invocation`，需显式加载）；字段菜单见 [`../../afk-init/config.example.json`](../../afk-init/config.example.json)。

`workdir` 必须由 `--workdir` 传入。

## `task`（与 afk-run 共用）

| 字段 | 默认 | 说明 |
|---|---|---|
| `task.source` | `beads` | 传给任务源工厂的名字。watcher 不内置 tracker 规则 |
| `task.repo` | `''` | GitHub `owner/name`；空则从 workdir git remote 推断 |
| `task.maxTasks` | `1` | 每个执行批次交给 afk-run 的 `--max-tasks`。`0` 表示沿用 afk-run 自己的上限 |
| `task.maxFailures` | `3` | 传给 afk-run |
| `task.retry` | `1` | 传给 afk-run |
| `task.allowDirty` | `false` | 工作区不干净时仍启动 |
| `task.stopFile` | `''` | 空则使用 `workdir/afk-stop` |
| `task.tapd.claimMode` | `''` | 显式 `atomic` / `best-effort` / `unsupported`。空则按字段是否够认领来决定 |
| `task.tapd.statusField` | `''` | 状态字段名，由工作区自己声明 |
| `task.tapd.ownerField` | `''` | 负责人字段名。空表示不写负责人 |
| `task.tapd.readyValue` / `claimedValue` / `doneValue` / `failedValue` | `''` | 上述字段对应的值 |
| `task.tapd.ownerValue` | `''` | 认领时写入 owner 字段的值 |
| `task.tapd.customFields` | `{}` | 额外要写入的字段，键就是 TAPD 字段名 |

## `watch`

| 字段 | 默认 | 说明 |
|---|---|---|
| `watch.pollIntervalMs` | `15000` | 就绪列表为空，或认领竞争失败后，到下一次轮询的等待 |
| `watch.backoffInitialMs` | `1000` | 任务源错误的第一次退避 |
| `watch.backoffMaxMs` | `60000` | 退避上限 |
| `watch.backoffFactor` | `2` | 每次源错误后的倍数，直到上限。成功查询或执行批次结束后回到初始值 |
| `watch.requireAtomicClaim` | `false` | 为 true 且 `claimMode !== atomic` 时，在启动执行批次之前退出 |
| `watch.serve.enabled` | `true` | watcher 自己拉起看板。执行批次始终 `--no-serve`，避免和执行批次抢看板进程 |
| `watch.serve.port` | `0` | `0` 时按 workdir 派生，基数 9700 |
| `watch.serve.open` | `false` | 看板起来后是否打开浏览器 |

## 本技能不读的分区

`run`（afk-run 自己的）与 `execReview`（exec-review 的）都在同一份 `config.json` 里。watcher 只把 `task` 相关的值展开成 afk-run 的 CLI 参数，其余由 afk-run / exec-review 各自读同一份文件——所以 `--config <路径>` 也会原样传给执行批次。

## 停止

- 运行中按 Ctrl+C 或 SIGTERM
- 创建停止文件
- `node watch.mjs --stop --workdir <目录>`

停止时只结束本 watcher 登记的 afk-run 子进程和看板进程。
