/** 看板页面骨架：皮肤在 /assets/theme.css，渲染逻辑在 page-app.js。 */

import { modalShell, pageHead } from '../../../lib/web-ui/assets.mjs'

// 只写这张页面的布局差异：表头列宽。弹窗下钻布局在 theme.css。
const SHELL_CSS = `<style>
table{table-layout:fixed}
th:nth-child(1),td:nth-child(1){width:50%}
th:nth-child(2),td:nth-child(2){width:35%}
th:nth-child(3),td:nth-child(3){width:8%;white-space:nowrap;color:#8b949e}
th:nth-child(4),td:nth-child(4){width:7%;white-space:nowrap}
</style>`

export function pageHtml() {
  return pageHead('tapd-loop', SHELL_CSS) + `
<body>
<h1>tapd-loop</h1><div id="meta">连接中…</div>
<div id="filters">
  <button data-days="0" class="on">全部</button>
  <button data-days="1">近 1 天</button>
  <button data-days="7">近 7 天</button>
  <label style="margin-left:6px"><input type="checkbox" id="onlyAlive">只看运行中</label>
</div>
<table><thead><tr><th>卡片</th><th>现在</th><th>用时</th><th>状态</th></tr></thead>
<tbody id="rows"></tbody></table>
${modalShell()}
<script type="module" src="/app.js"></script></body></html>`
}
