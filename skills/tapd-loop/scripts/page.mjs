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
#ctl .cards{display:grid;gap:10px;margin:0 0 12px;grid-template-columns:repeat(auto-fill,minmax(300px,1fr))}
#ctl .cards:empty{display:none}
#ctl .card{background:#11161f;border:1px solid #21262d;border-radius:8px;padding:10px 12px;display:flex;flex-direction:column;gap:9px;max-width:560px;min-width:0}
#ctl .chips{display:flex;gap:6px;flex-wrap:wrap}
#ctl .chip{font-size:11px;padding:2px 9px;border-radius:10px;border:1px solid #21262d;background:#0d1117;color:#c9d1d9;white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis}
#ctl .chip.ok{color:#3fb950;border-color:#3fb95055;background:#3fb95011}
#ctl .chip.run{color:#58a6ff;border-color:#1f6feb66;background:#1f6feb14}
#ctl .chip.bad{color:#f85149;border-color:#f8514955;background:#f8514911}
#ctl .chip.dim{color:#8b949e}
#ctl .card-body a{color:#58a6ff;text-decoration:none}
#ctl .card-body a:hover{text-decoration:underline}
#ctl .autobar{border:0;background:none;padding:0;gap:10px;align-items:stretch}
#ctl .autobar .ab-title{color:#8b949e;font-weight:600;align-self:center;letter-spacing:1px;font-size:11px;text-transform:uppercase}
/* 三个开关各占一张小卡：开着蓝底+左侧亮条，关着整块压暗——一眼能看出哪个在干活。 */
#ctl .autobar .seg{display:flex;align-items:center;gap:7px;flex:1 1 320px;min-width:280px;
  border:1px solid #30363d;border-radius:8px;background:#161b22;padding:8px 10px;
  transition:border-color .15s,background .15s,box-shadow .15s}
#ctl .autobar .seg.on{border-color:#1f6feb;background:#132a4d;box-shadow:inset 3px 0 0 #388bfd}
#ctl .autobar .seg:not(.on){opacity:.6}
#ctl .autobar .seg label{color:#e6edf3;font-weight:600;white-space:nowrap}
#ctl .autobar .seg:not(.on) label{color:#c9d1d9}
#ctl .autobar input[type=checkbox]{width:15px;height:15px}
#ctl .autobar .ab-hint{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#8b949e}
#ctl .autobar .seg.on .ab-hint{color:#a5d6ff}
#ctl .card.run{border-color:#1f6feb88}
#ctl .card.bad{border-color:#f8514988}
#ctl .card-top{display:flex;align-items:center;justify-content:space-between;gap:8px}
#ctl .card-name{font-size:14px;color:#e6edf3;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#ctl .card-body{font-size:12px;color:#8b949e;line-height:1.5;min-height:2.8em}
#ctl .card-body .t{color:#c9d1d9}
#ctl .card-actions{display:flex;gap:6px;margin-top:auto;flex-wrap:wrap}
#ctl .card-actions button{flex:1 1 auto;white-space:nowrap}
#ctl .fail{color:#f85149}
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
#cMain .cards{display:grid;gap:8px;grid-template-columns:minmax(0,1fr)}
/* 主树卡要铺满整行：它的状态/失败原因/按钮都比工位卡多，窄了就全靠换行 */
#cMain .cards .card{max-width:none}
#fileview{position:fixed;inset:0;display:none;z-index:60}
#fileview.on{display:block}
#fileview .fv-mask{position:absolute;inset:0;background:#000a}
#fileview .fv-panel{position:absolute;inset:6vh 6vw;background:#0d1117;border:1px solid #30363d;border-radius:10px;display:flex;flex-direction:column;gap:8px;padding:12px 14px;box-shadow:0 10px 40px #000b}
#fileview .fv-top{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
#fileview .fv-name{font-size:14px;color:#e6edf3;font-weight:600}
#fileview .fv-meta{font-size:12px;color:#8b949e}
#fileview .fv-body{flex:1;margin:0;overflow:auto;background:#010409;border:1px solid #21262d;border-radius:6px;padding:8px 10px;font-family:ui-monospace,Consolas,monospace;font-size:12px;line-height:1.5;color:#c9d1d9;white-space:pre-wrap}
#fileview .fv-actions{display:flex;gap:8px;justify-content:flex-end}
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
      <button id="cPickOne" title="现在就派一轮：从 TAPD 拉就绪卡，派给空闲工位（不打开定时器）">现在接一单</button>
    </div>
  </div>
  <div id="cMsg"></div>
  <div class="row autobar" id="cAutoBar">
    <span class="ab-title">自动化</span>
    <div class="seg" id="segWatch">
      <label title="定时去 TAPD 看有没有就绪卡，有就派给空闲工位（空着就不开工）"><input type="checkbox" id="cWatch">自动接单</label>
      <span>每</span><input id="cPollSec" type="number" min="30" max="86400" step="30" style="width:4.5em"><span>秒</span>
      <span id="cNext" class="ab-hint dim"></span>
    </div>
    <div class="seg" id="segAutoPush">
      <label title="主树有没推的提交时，自己跑 collect --resume：导表 → 验证门 → 推送 → 回写 TAPD"><input type="checkbox" id="cAutoPush">自动验证并推送</label>
      <span>每</span><input id="cAutoPushSec" type="number" min="30" max="86400" step="30" style="width:4.5em"><span>秒</span>
      <span id="cAutoPushHint" class="ab-hint dim"></span>
    </div>
    <div class="seg" id="segAutoMerge">
      <label title="有工位攒了未合入提交时，自己 cherry-pick 进主树 → 导表 → 验证门 → 推送 → 回写 TAPD（一次只合一个工位，默认关）"><input type="checkbox" id="cAutoMerge">自动合入工位提交</label>
      <span>每</span><input id="cAutoMergeSec" type="number" min="30" max="86400" step="30" style="width:4.5em"><span>秒</span>
      <span id="cAutoMergeHint" class="ab-hint dim"></span>
    </div>
  </div>
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
    </div>
    <div class="row">
      <label><input type="checkbox" id="cAllowDirty">允许脏工作区（脏改动会被算进本卡提交）</label>
      <label><input type="checkbox" id="cNoWrite">只演练（不写 TAPD、不提交）</label>
    </div>
    <div class="row">
      <button id="cQueue" title="查一次 TAPD：列出就绪的卡，以及被状态/前置依赖挡住的卡">刷新队列</button>
      <button id="cRun" title="用上面的参数（处理人 / 一批最多 / 松散开关）跑一批 loop.mjs">按当前项目开跑一批</button>
      <button id="cStop" title="写停止标记：当前卡跑完后不再接新卡，不会杀掉正在跑的批次">全部停止（下一张前）</button>
    </div>
    <div class="row">
      <span>指定工单</span>
      <input id="cRef" placeholder="贴 TAPD 需求链接（…/story/detail/…），或直接填需求 id" spellcheck="false">
      <button id="cRefPeek" title="只读：认一下这张卡现在的状态、标签、能不能接（不认领、不评论）">看看这张</button>
      <button id="cRefRun" title="只跑这一张：认领 + 跑内循环 + 回写（会真改 TAPD、真提交代码）">接这张</button>
    </div>
    <div id="cRefBox"></div>
    <div class="row">
      <span>新建工位</span>
      <input id="cStationName" placeholder="名字，如 a" spellcheck="false">
      <button id="cStationCreate" title="新建一个工位 worktree（几分钟；首次 Unity 导入更久）">建一棵</button>
      <span>或</span>
      <input id="cStationPath" placeholder="已有 worktree 的绝对路径" spellcheck="false">
      <button id="cStationRegister" title="把已经存在的 worktree 登记进来，不新建、不动磁盘">登记已有</button>
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
