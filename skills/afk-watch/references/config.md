# afk-watch 配置

配置文件：技能根 `config.json`。优先级：**CLI > config > 内置**。

`workdir` 必须由 `--workdir` 传入。

## 字段

| 字段 | 默认 | 说明 |
|---|---|---|
| `source` | `beads`（仓库 config 为 `gh`） | 传给任务源工厂的名字。watcher 不内置 tracker 规则 |
| `maxTasks` | `1` | 每个执行批次交给 afk-run 的 `--max-tasks`。`0` 表示沿用 afk-run 自己的上限 |
| `maxFailures` | `3` | 传给 afk-run |
| `retry` | `1` | 传给 afk-run |
| `pollIntervalMs` | `15000` | 就绪列表为空，或认领竞争失败后，到下一次轮询的等待 |
| `backoffInitialMs` | `1000` | 任务源错误的第一次退避 |
| `backoffMaxMs` | `60000` | 退避上限 |
| `backoffFactor` | `2` | 每次源错误后的倍数，直到上限。成功查询或执行批次结束后回到初始值 |
| `requireAtomicClaim` | `false` | 为 true 且 `claimMode !== atomic` 时，在启动执行批次之前退出 |
| `allowDirty` | `false` | 工作区不干净时仍启动 |
| `stopFile` | `''` | 空则使用 `workdir/afk-stop` |
| `serve.enabled` | `true` | watcher 自己拉起看板。执行批次始终 `--no-serve`，避免和执行批次抢看板进程 |
| `serve.port` | `0` | `0` 时按 workdir 派生，基数 9700 |
| `serve.open` | `false` | 看板起来后是否打开浏览器 |
| `execReview.*` | 空 | 非空字段传给 afk-run |
| `tapd.claimMode` | `''` | 显式 `atomic` / `best-effort` / `unsupported`。空则按字段是否够认领来决定 |
| `tapd.statusField` | `''` | 状态字段名，由工作区自己声明 |
| `tapd.ownerField` | `''` | 负责人字段名。空表示不写负责人 |
| `tapd.readyValue` / `claimedValue` / `doneValue` / `failedValue` | `''` | 上述字段对应的值 |
| `tapd.ownerValue` | `''` | 认领时写入 owner 字段的值 |
| `tapd.customFields` | `{}` | 额外要写入的字段，键就是 TAPD 字段名 |

## 停止

- 运行中按 Ctrl+C 或 SIGTERM
- 创建停止文件
- `node watch.mjs --stop --workdir <目录>`

停止时只结束本 watcher 登记的 afk-run 子进程和看板进程。
