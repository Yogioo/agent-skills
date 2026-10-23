/** 看板页面骨架：皮肤在 /assets/theme.css，渲染逻辑在 page-app.js，控制面板在 control.js。 */

import { modalShell, pageHead } from '../../../lib/web-ui/assets.mjs'

// 只写这张页面的布局差异：表头列宽 + 控制面板。弹窗下钻布局在 theme.css。
const SHELL_CSS = `<style>
table{table-layout:fixed}
th:nth-child(1),td:nth-child(1){width:50%}
th:nth-child(2),td:nth-child(2){width:35%}
th:nth-child(3),td:nth-child(3){width:8%;white-space:nowrap;color:#8b949e}
th:nth-child(4),td:nth-child(4){width:7%;white-space:nowrap}

#ctl{background:#0d1117;border:1px solid #21262d;border-radius:8px;padding:12px 14px;margin:0 0 14px}
#ctl .row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0 0 8px;font-size:12px;color:#8b949e}
#ctl .row:last-child{margin-bottom:0}
#ctl input,#ctl select{background:#11161f;color:#e6edf3;border:1px solid #21262d;border-radius:6px;padding:3px 7px;font:inherit;min-width:0}
#ctl input[type=checkbox]{accent-color:#388bfd}
#ctl input#cWorkdirText,#ctl input#cShareUrl{flex:1 1 320px}
#ctl button{background:#11161f;color:#c9d1d9;border:1px solid #21262d;border-radius:6px;padding:4px 12px;font:inherit;cursor:pointer}
#ctl button:hover:not(:disabled){border-color:#30363d;color:#e6edf3}
#ctl button.primary{background:#1f6feb;border-color:#1f6feb;color:#fff}
#ctl button.primary:hover:not(:disabled){background:#388bfd}
#ctl button:disabled{opacity:.45;cursor:not-allowed}
#ctl label{display:flex;align-items:center;gap:5px;cursor:pointer}
#ctl .runline{margin:0 0 8px;font-size:12px;color:#c9d1d9;background:#11161f;border:1px solid #1f6feb66;border-radius:6px;padding:6px 10px}
#cQueueBox:empty{display:none}
#cQueueBox{margin:10px 0 0;border-top:1px solid #21262d;padding-top:8px}
#cQueueBox .qhead{font-size:12px;color:#8b949e;margin:0 0 6px}
#cQueueBox .qrow{display:grid;grid-template-columns:150px minmax(0,1fr) 150px 96px;gap:10px;align-items:center;padding:4px 0;border-top:1px solid #161b22;font-size:12px}
#cQueueBox .qrow:first-of-type{border-top:0}
#cQueueBox .qid{color:#6e7681}
#cQueueBox .qtitle{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#cQueueBox .qrej{margin-top:8px}
#cQueueBox .qrej summary{color:#8b949e;font-size:12px;cursor:pointer}
#ctl input#cRef{flex:1 1 420px}
#cRefBox:empty{display:none}
#cRefBox{margin:0 0 8px;padding:8px 10px;border:1px solid #21262d;border-radius:6px;background:#11161f;font-size:12px}
#cRefBox .rtitle{color:#e6edf3}
#cRefBox .rmeta{color:#8b949e;margin-top:2px}
#cRefBox a{color:#58a6ff}
</style>`

export function pageHtml() {
  return pageHead('tapd-loop', SHELL_CSS) + `
<body>
<h1>tapd-loop</h1><div id="meta">连接中…</div>
<div id="warn"></div>
<section id="ctl">
  <div class="row">
    <span>工作目录</span>
    <select id="cWorkdir"></select>
    <input id="cWorkdirText" placeholder="绝对路径，比如 C:/projects/DigitDoor" spellcheck="false">
  </div>
  <div class="row">
    <span>处理人</span><input id="cAssignee" size="8" placeholder="TAPD 处理人">
    <span>本批最多</span><input id="cMaxTasks" type="number" min="1" max="20" style="width:4.5em"><span>张</span>
    <label><input type="checkbox" id="cAllowDirty">允许脏工作区</label>
    <label><input type="checkbox" id="cNoWrite">只演练（不写 TAPD）</label>
  </div>
  <div class="row">
    <label><input type="checkbox" id="cWatch">定时查看 TAPD 并接单</label>
    <span>每</span><input id="cPollSec" type="number" min="30" max="86400" step="30" style="width:6.5em"><span>秒</span>
    <span id="cNext" class="dim"></span>
  </div>
  <div class="row">
    <button id="cQueue">查看 TAPD 队列</button>
    <button id="cRun" class="primary">接单开跑</button>
    <button id="cStop">停止（下一张前）</button>
    <span id="cMsg" class="dim"></span>
  </div>
  <div class="row">
    <span>指定工单</span>
    <input id="cRef" placeholder="贴 TAPD 需求链接（…/story/detail/…），或直接填需求 id" spellcheck="false">
    <button id="cRefPeek">查看这张</button>
    <button id="cRefRun" class="primary">接这张开跑</button>
  </div>
  <div id="cRefBox"></div>
  <div id="cRunning"></div>
  <div class="row" id="cShare"></div>
  <div id="cQueueBox"></div>
</section>
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
