# lib/web-ui

两个只读看板共用的皮肤和浏览器积木：agent runs（`lib/run-runtime/board.mjs`）与 tapd-loop（`skills/tapd-loop/scripts/page.mjs`）。改一次，两边同时生效。

## 文件

- `theme.css` 调色板与全部通用组件：表格、筛选、markdown、时间线、面板、弹窗、diff。
- `markdown.mjs` `esc` / `inlineM` / `md`。图片默认关，TAPD 页面传 `{images:true}`。
- `format.mjs` `dur` / `clock` / `rel` / `msText` / `project`。
- `events.mjs` 时间线事件的唯一形状，以及 progress / pi 两种来源的归一化。纯函数，浏览器也能 import。
- `client.mjs` 浏览器侧渲染：`describeEvent`、`timelineHtml`、`paneHtml`、`diffHtml`、localStorage 小工具。
- `assets.mjs` 服务端白名单与 `pageHead`。请求路径只在字面量表里查，永远不拼文件路径。

## 边界

共享层只认识时间线事件和中立词汇，不认识 run、card、TAPD、端口、家目录。这些留在各自页面：

- `lib/run-runtime/board-app.js`：run 行、输入面板、用时每秒自走、深链 `?run=`。
- `skills/tapd-loop/scripts/page-app.js`：卡片行、弹窗栈、工单/brief/verify/diff/log 面板、子臂下钻、`images/` 改写。

事件形状：

```
{ t, kind, text?, name?, detail?, ms?, arm?, status?, reason?, tokens?, error? }
kind: say | think | tool | tool_end | arm_start | arm_end | note
```

## 页面怎么拿到这些文件

两个服务都提供：

- `GET /assets/theme.css`
- `GET /assets/client.mjs`
- `GET /assets/events.mjs`
- `GET /assets/markdown.mjs`
- `GET /assets/format.mjs`
- `GET /app.js`：该页面自己的 app 模块

页面骨架用 `pageHead(title, extraHead)`，然后 `<script type="module" src="/app.js">`。浏览器模块只用相对 URL（`/assets/client.mjs`），不要出现 `node:`、`process`、`require`；`tests/web-ui/units.test.mjs` 会拦。

## 迭代规则

- 视觉/格式/时间线/面板/diff 的改动只改这里，两边一起看。
- 只属于一张页面的排版（列宽、弹窗里 flex 怎么分）写回该页面的 `<style>`，不要塞进共享层。
- 新事件来源在 `events.mjs` 里加一个归一化函数，不要在页面里判断上游字段。
- 改完跑 `node --test tests/web-ui/`，再用真实页面看一眼（`node --test` 不做视觉断言）。
