---
name: xlsx-cell-diff
description: xlsx 显示值 diff 与 overlay 合并。触发：源配置表格比对、xlsx 合并冲突、提交里有xlsx修改
---

# xlsx 显示值 diff

通过已安装的 `agent-tools` 运行本 CLI。按 **显示值** 比对、overlay **源配置**
工作簿；共享字符串下标、XML 前缀、used-range、列宽、主题不算变更。表格比对走
本 CLI，不走 GUI merger。

## 路由

**何时用：** 需要判断哪些工作簿有显示值变化、生成单元格级 diff / 三路冲突报告、
或把变更 overlay 到 local 模板。

**不要用：** 导表本身、GUI 合并、或把整份报告读进对话。

动词：`status`（哪些工作簿有变化）、`diff`（单元格级）、`conflicts`（三路只读）、
`merge`（叠到 local 模板）。输入三选一：`--left/--right`、`--commit`/`--range`、
或工作区对 HEAD。需要脚本化后续步骤时加 `--json`。

```powershell
Set-Location <repo>
agent-tools xlsx-cell-diff status
agent-tools xlsx-cell-diff diff --commit <sha> [--json]
agent-tools xlsx-cell-diff merge ... --resolve take-local|take-remote|<json>
```

`merge` 写成功、冲突（退出码 `4`）或结构拒绝（退出码 `5`）；仍有冲突或
sheet/行/列增删时不写目标文件。用户点名的一格交给 `officecli set <xlsx> <ref>
--prop value="..."`。改过源配置后提醒人跑仓库既有导表（DigitDoor：
`LubanData/gen.bat`）；本 CLI 不导表。

先安装本地 toolkit（`npm install -g <repo-or-tarball>`），再确认
`agent-tools xlsx-cell-diff --help` 的 flags 与退出码。
