---
name: xlsx-cell-diff
description: xlsx 显示值 diff 与 overlay 合并。触发：源配置表格比对、xlsx 合并冲突、提交里配置改了啥。
---

# xlsx 显示值 diff

按 **显示值** 比对、overlay **源配置** 工作簿。共享字符串下标、XML 前缀、used-range、列宽、主题不是变更。表格比对走本 CLI，不走 GUI merger。

入口：本目录 `scripts/cli.mjs`。flags 与退出码以 `node scripts/cli.mjs --help` 为准。

## 流程

1. 选动词。`status` 哪些工作簿有显示值变化；`diff` 单元格级变化；`conflicts` 三路只读报告；`merge` 叠到 local 模板。

   **完成：** 动词与用户问题一一对应。

2. 跑 CLI。输入三选一：`--left/--right`、`--commit` / `--range`、或工作区对 HEAD。DigitDoor 存在 `LubanData/Datas` 时默认只扫源配置。要脚本化后续步骤时加 `--json`。

   **完成：** stdout 是分组报告，或一份 spill 路径。对话里只消费这份输出。

3. 按报告作答。`status` 列出工作簿、表、主键；`diff` / `conflicts` / `merge` 按 workbook → sheet → 行主键分组，并带 `/Sheet/A1`。`conflicts` 的 Auto 段是可自动取的边；`merge` 写成功、冲突（退出码 4）、或结构拒绝（退出码 5）。

   **完成：** 报告里每一行都进了回答。若 stdout 是 spill 路径，只读匹配的 key/列，不把整份报告读进对话。

4. 源配置有写入时，提醒人跑仓库既有导表（DigitDoor：`LubanData/gen.bat`）。本 skill 不导表。

   **完成：** 已提醒，或本轮没有改源配置。

## 写入

- **用户点名的一格：** 报告里的 `path` 交给 officecli：`officecli set <xlsx> /CfgLanguage/C5 --prop value="林间小径"`
- **本 CLI 已经算出的多格 / 冲突选择：** `merge` overlay。以 local 为模板，显示值写成 inline 字符串，未改的 zip part 原样保留。`--resolve take-local|take-remote|<json>` 消化冲突。仍有冲突或 sheet/行/列增删时不写目标文件。
