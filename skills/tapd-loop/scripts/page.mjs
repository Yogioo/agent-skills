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
#ctl .hero{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin:0 0 10px}
#ctl .hero-state{font-size:13px;color:#8b949e;flex:1 1 320px;line-height:1.6}
#ctl .hero-state b{color:#e6edf3;font-size:15px}
#ctl .hero-act{display:flex;gap:8px;flex-wrap:wrap}
#ctl .hero-act button{font-size:13px;padding:7px 18px}
#ctl #cMsg{font-size:12px;margin:0 0 10px;line-height:1.5}
#ctl #cMsg:empty{display:none}
#ctl .cards{display:flex;gap:10px;flex-wrap:wrap;margin:0 0 12px}
#ctl .cards:empty{display:none}
#ctl .card{flex:1 1 260px;min-width:236px;max-width:420px;background:#11161f;border:1px solid #21262d;border-radius:8px;padding:10px 12px;display:flex;flex-direction:column;gap:9px}
#ctl .card.run{border-color:#1f6feb88}
#ctl .card.bad{border-color:#f8514988}
#ctl .card-top{display:flex;align-items:center;justify-content:space-between;gap:8px}
#ctl .card-name{font-size:14px;color:#e6edf3;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#ctl .card-body{font-size:12px;color:#8b949e;line-height:1.5;min-height:2.8em}
#ctl .card-body .t{color:#c9d1d9}
#ctl .card-actions{display:flex;gap:6px;margin-top:auto}
#ctl .card-actions button{flex:1}
#ctl .badge{font-size:11px;padding:2px 9px;border-radius:10px;border:1px solid #21262d;white-space:nowrap;flex:0 0 auto}
#ctl .badge.ok{color:#3fb950;border-color:#3fb95055;background:#3fb95011}
#ctl .badge.run{color:#58a6ff;border-color:#1f6feb66;background:#1f6feb14}
#ctl .badge.bad{color:#f85149;border-color:#f8514955;background:#f8514911}
#ctl details#cAdvanced{border-top:1px solid #21262d;padding-top:8px;margin-top:4px}
#ctl details#cAdvanced summary{cursor:pointer;color:#8b949e;font-size:12px;list-style:none}
#ctl details#cAdvanced summary::-webkit-details-marker{display:none}
#ctl details#cAdvanced summary::before{content:'▸ '}
#ctl details#cAdvanced[open] summary::before{content:'▾ '}
#ctl details#cAdvanced[open] summary{margin-bottom:10px}
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
#cStations:empty{display:none}
#cMain:empty{display:none}
#cMain{margin:10px 0 0}
#cMain .cards{display:flex;gap:8px;flex-wrap:wrap}
#cStations{margin:10px 0 0;border-top:1px solid #21262d;padding-top:8px}
#cStations .shead{display:flex;align-items:center;gap:10px;font-size:12px;color:#8b949e;margin:0 0 6px;flex-wrap:wrap}
#cStations .slist{display:flex;flex-direction:column}
#cStations .srow{display:grid;grid-template-columns:64px minmax(0,1fr) 100px 150px 196px;gap:10px;align-items:center;padding:4px 0;border-top:1px solid #161b22;font-size:12px}
#cStations .srow:first-child{border-top:0}
#cStations .sname{color:#e6edf3}
#cStations .spath{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#6e7681}
#cStations .sact{display:flex;gap:6px}
#cStations .sjob{font-size:12px;margin-top:4px;color:#8b949e}
#ctl input#cStationPath{flex:1 1 260px}
#ctl input#cStationName{width:8em}
</style>`

export function pageHtml() {
  return pageHead('tapd-loop', SHELL_CSS) + `
<body>
<h1>tapd-loop</h1><div id="meta">连接中…</div>
<div id="warn"></div>
<section id="ctl">
  <div class="hero">
    <div class="hero-state" id="cSummary">连接中…</div>
    <div class="hero-act">
      <button id="cAuto" class="primary">开始自动接单</button>
      <button id="cPickOne">现在接一单</button>
    </div>
  </div>
  <div id="cMsg"></div>
  <div id="cConflict"></div>
  <div id="cMain"></div>
  <div id="cStations"></div>
  <div id="cQueueBox"></div>
  <details id="cAdvanced">
    <summary>高级设置</summary>
    <div class="row">
      <span>项目（主树）</span>
      <select id="cWorkdir"></select>
      <input id="cWorkdirText" placeholder="绝对路径，比如 C:/projects/DigitDoor" spellcheck="false">
    </div>
    <div class="row">
      <span>处理人</span><input id="cAssignee" size="8" placeholder="TAPD 处理人">
      <span>一批最多</span><input id="cMaxTasks" type="number" min="1" max="20" style="width:4.5em"><span>张</span>
      <label><input type="checkbox" id="cWatch">自动接单</label>
      <span>每</span><input id="cPollSec" type="number" min="30" max="86400" step="30" style="width:6.5em"><span>秒</span>
      <span id="cNext" class="dim"></span>
    </div>
    <div class="row">
      <label><input type="checkbox" id="cAllowDirty">允许脏工作区（脏改动会被算进本卡提交）</label>
      <label><input type="checkbox" id="cNoWrite">只演练（不写 TAPD、不提交）</label>
    </div>
    <div class="row">
      <button id="cQueue">刷新队列</button>
      <button id="cRun">按当前项目开跑一批</button>
      <button id="cStop">全部停止（下一张前）</button>
    </div>
    <div class="row">
      <span>指定工单</span>
      <input id="cRef" placeholder="贴 TAPD 需求链接（…/story/detail/…），或直接填需求 id" spellcheck="false">
      <button id="cRefPeek">看看这张</button>
      <button id="cRefRun">接这张</button>
    </div>
    <div id="cRefBox"></div>
    <div class="row">
      <span>新建工位</span>
      <input id="cStationName" placeholder="名字，如 a" spellcheck="false">
      <button id="cStationCreate">建一棵</button>
      <span>或</span>
      <input id="cStationPath" placeholder="已有 worktree 的绝对路径" spellcheck="false">
      <button id="cStationRegister">登记已有</button>
    </div>
    <div id="cRunning"></div>
    <div class="row" id="cShare"></div>
  </details>
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
