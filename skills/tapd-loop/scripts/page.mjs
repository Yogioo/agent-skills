/** 看板页面骨架：皮肤在 /assets/theme.css，渲染逻辑在 page-app.js，控制面板在 control.js。 */

import { modalShell, pageHead } from '../../../lib/web-ui/assets.mjs'

// 只写这张页面的布局差异：表头列宽 + 控制面板。弹窗下钻布局在 theme.css。
const SHELL_CSS = `<style>
table{table-layout:fixed}
th:nth-child(1),td:nth-child(1){width:50%}
th:nth-child(2),td:nth-child(2){width:35%}
/* 后两列内容定长（用时、状态），用 ch 而不是百分比：窄屏按百分比算出来的宽度比文字还窄，
   文字就会撑破表格把整页拉出横向滚动条。 */
th:nth-child(3),td:nth-child(3){width:10ch;white-space:nowrap;color:#8b949e}
th:nth-child(4),td:nth-child(4){width:15ch;white-space:nowrap}

#ctl{background:#0d1117;border:1px solid #21262d;border-radius:8px;padding:14px 16px;margin:0 0 14px}
.ctl-ui .row{display:flex;align-items:center;gap:10px 8px;flex-wrap:wrap;margin:0 0 10px;font-size:12.5px;line-height:1.7;color:#8b949e}
.ctl-ui .row:last-child{margin-bottom:0}
.ctl-ui input,.ctl-ui select{background:#11161f;color:#e6edf3;border:1px solid #21262d;border-radius:6px;padding:4px 8px;font:inherit;min-width:0}
/* 勾选框自己画：原生那个在深色底上就是个黑方块，看不出有没有勾（accent-color 只管已勾状态）。 */
.ctl-ui input[type=checkbox]{appearance:none;width:15px;height:15px;flex:0 0 auto;padding:0;margin:0;
  border:1px solid #30363d;border-radius:4px;background:#0d1117;cursor:pointer;transition:background .12s,border-color .12s}
.ctl-ui input[type=checkbox]:hover{border-color:#58a6ff}
.ctl-ui input[type=checkbox]:checked{border-color:#1f6feb;
  background:#1f6feb url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='%23fff' stroke-width='2.4' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M3.5 8.4l3 3 6-6.6'/%3E%3C/svg%3E") center/12px 12px no-repeat}
.ctl-ui input[type=checkbox]:focus-visible{outline:2px solid #388bfd;outline-offset:2px}
.ctl-ui input#cWorkdirText,.ctl-ui input#cShareUrl{flex:1 1 320px}
.ctl-ui button{background:#11161f;color:#c9d1d9;border:1px solid #21262d;border-radius:6px;padding:4px 12px;font:inherit;cursor:pointer}
.ctl-ui button:hover:not(:disabled){border-color:#30363d;color:#e6edf3}
.ctl-ui button.primary{background:#1f6feb;border-color:#1f6feb;color:#fff}
.ctl-ui button.primary:hover:not(:disabled){background:#388bfd}
.ctl-ui button:disabled{opacity:.45;cursor:not-allowed}
.ctl-ui label{display:flex;align-items:center;gap:5px;cursor:pointer}
#ctl .hero{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin:0 0 10px}
#ctl .hero-state{font-size:13px;color:#8b949e;flex:1 1 320px;line-height:1.6}
#ctl .hero-state b{color:#e6edf3;font-size:15px}
#ctl .hero-act{display:flex;gap:8px;flex-wrap:wrap}
#ctl .hero-act button{font-size:13px;padding:7px 18px}
/* 操作结果消息条（toast）：固定右下角。以前是控制面板里一行 12px 灰字，卡在 hero 和
   「自动化」中间，看着像那一块的说明，也不会消失。 */
#toasts{position:fixed;right:18px;bottom:18px;z-index:70;display:flex;flex-direction:column;gap:8px;
  max-width:min(460px,calc(100vw - 36px));pointer-events:none}
.toast{pointer-events:auto;display:flex;align-items:flex-start;gap:8px;padding:9px 10px 9px 11px;
  border:1px solid #30363d;border-left-width:3px;border-radius:8px;background:#161b22;color:#c9d1d9;
  box-shadow:0 10px 28px #000000a6;font-size:12.5px;line-height:1.5;overflow-wrap:anywhere}
.toast .ic{flex:0 0 auto;width:1.1em;font-weight:700;text-align:center;opacity:.95}
.toast .tx{flex:1 1 auto;min-width:0}
.toast .x{flex:0 0 auto;background:transparent;border:0;padding:0 2px;margin:-2px 0 0;cursor:pointer;
  color:#6e7681;font-size:15px;line-height:1.1}
.toast .x:hover{color:#e6edf3;border:0}
.toast.ok{border-left-color:#3fb950;background:#0d2318;color:#7ee787}
.toast.warn{border-left-color:#d29922;background:#241d0e;color:#e3b341}
.toast.bad{border-left-color:#f85149;background:#261012;color:#ff9d96}
.toast.dim{border-left-color:#30363d;color:#a9b4c0}
.toast.in{animation:toastIn .16s ease-out}
@keyframes toastIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
#ctl .cards{display:grid;gap:10px;margin:0 0 12px;grid-template-columns:repeat(auto-fill,minmax(min(100%,300px),1fr))}
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
/* 三个开关各占一张小卡：开着蓝底+左侧亮条，关着整块压暗——一眼能看出哪个在干活。
   用显式 3 / 2 / 1 列而不是 flex 单行：窗口窄了就整张卡换行，
   不让「每 N 秒」和状态句挤在同一行里互相顶（auto-fit 还会多算一条空轨道，宽屏上三张卡只占 3/4 宽）。 */
#ctl .autobar{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;align-items:stretch}
@media (max-width:1120px){#ctl .autobar{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:720px){#ctl .autobar{grid-template-columns:minmax(0,1fr)}}
#ctl .autobar .ab-title{grid-column:1/-1;color:#8b949e;font-weight:600;letter-spacing:1px;font-size:11px;text-transform:uppercase}
/* 每张卡两行：上面「勾选 + 名字 + 间隔」，下面留给状态句。状态句不再被挤成一条省略号。 */
#ctl .autobar .seg{display:flex;flex-direction:column;justify-content:center;gap:7px;min-width:0;
  border:1px solid #30363d;border-radius:8px;background:#161b22;padding:10px 12px;
  transition:border-color .15s,background .15s,box-shadow .15s}
#ctl .autobar .seg.on{border-color:#1f6feb;background:#132a4d;box-shadow:inset 3px 0 0 #388bfd}
#ctl .autobar .seg:not(.on){opacity:.72}
#ctl .autobar .seg-top{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
#ctl .autobar .seg-top label{color:#e6edf3;font-weight:600;white-space:nowrap;gap:7px}
#ctl .autobar .seg:not(.on) .seg-top label{color:#c9d1d9}
#ctl .autobar .seg-every{display:flex;align-items:center;gap:5px;white-space:nowrap;color:#8b949e}
#ctl .autobar input[type=number]{width:5.6em;text-align:center;padding:2px 4px}
/* 状态句最多两行：路径/失败原因这类长句换行读，实在超了截断，全文放 title 里。 */
#ctl .autobar .ab-hint{font-size:11.5px;line-height:1.5;min-width:0;overflow-wrap:anywhere;color:#8b949e;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
#ctl .autobar .ab-hint:empty{display:none}
#ctl .autobar .seg.on .ab-hint{color:#a5d6ff}
#ctl .autobar .seg.on .ab-hint.warn,#ctl .autobar .ab-hint.warn{color:#d29922}
#ctl .card.run{border-color:#1f6feb88}
#ctl .card.bad{border-color:#f8514988}
#ctl .card-top{display:flex;align-items:center;justify-content:space-between;gap:8px}
#ctl .card-name{font-size:14px;color:#e6edf3;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#ctl .card-body{font-size:12px;color:#8b949e;line-height:1.5;min-height:2.8em}
#ctl .card-body .t{color:#c9d1d9}
#ctl .card-actions{display:flex;gap:6px;margin-top:auto;flex-wrap:wrap}
#ctl .card-actions button{flex:1 1 auto;white-space:nowrap}
/* 接活开关：放在卡片左上角、工位名左边。勾上 = 会派卡（文字转绿），取消 = 暂停（灰掉）。 */
#ctl .card-left{display:flex;align-items:center;gap:8px;min-width:0}
#ctl .card-top .toggle{flex:0 0 auto;white-space:nowrap;font-size:12px;gap:4px;color:#8b949e;user-select:none}
#ctl .card-top .toggle:hover{color:#e6edf3}
#ctl .card-top .toggle.on{color:#3fb950}
#ctl .fail{color:#f85149}
#ctl .badge{font-size:11px;padding:2px 9px;border-radius:10px;border:1px solid #21262d;white-space:nowrap;flex:0 0 auto}
#ctl .badge.ok{color:#3fb950;border-color:#3fb95055;background:#3fb95011}
#ctl .badge.run{color:#58a6ff;border-color:#1f6feb66;background:#1f6feb14}
#ctl .badge.bad{color:#f85149;border-color:#f8514955;background:#f8514911}
/* 已暂停：不是错误、不是空闲，人为压暗——一眼能看出来它不领卡。 */
#ctl .badge.dim{color:#8b949e;border-color:#30363d;background:#161b22}
#cQueueBox:empty{display:none}
#cQueueBox{margin:10px 0 0;border-top:1px solid #21262d;padding-top:8px}
#cQueueBox .qhead{font-size:12px;color:#8b949e;margin:0 0 6px}
#cQueueBox .qrow{display:grid;grid-template-columns:150px minmax(0,1fr) 150px 96px;gap:10px;align-items:center;padding:6px 0;border-top:1px solid #161b22;font-size:12.5px;line-height:1.6}
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
#cStations .srow{display:grid;grid-template-columns:64px minmax(0,1fr) 100px 150px 196px;gap:10px;align-items:center;padding:6px 0;border-top:1px solid #161b22;font-size:12.5px;line-height:1.6}
#cStations .srow:first-child{border-top:0}
#cStations .sname{color:#e6edf3}
#cStations .spath{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#6e7681}
#cStations .sact{display:flex;gap:6px}
#cStations .sjob{font-size:12px;margin-top:4px;color:#8b949e}
.ctl-ui input#cStationPath{flex:1 1 260px}
.ctl-ui input#cStationName{width:8em}

/* 「统计」「高级设置」是弹窗面板：面板节点平时藏在 #panelHome 里，打开时搬进 #mbody。
   共享表单样式因此从 #ctl 改挂到 .ctl-ui（#ctl 自己也带这个 class），搬来搬去长相不变。 */
.panel{overflow:auto;flex:1 1 auto;min-height:0;padding:2px 2px 0}
#panelHome[hidden],[hidden]{display:none !important}
#viewbar{display:flex;gap:8px;margin:0 0 14px;flex-wrap:wrap}
#viewbar button{background:#11161f;color:#c9d1d9;border:1px solid #21262d;border-radius:6px;padding:4px 14px;font:inherit;font-size:12.5px;cursor:pointer}
#viewbar button:hover{border-color:#30363d;color:#e6edf3}
#viewbar button.on{background:#1f6feb;border-color:#1f6feb;color:#fff}
#statsPanel .stats-body{margin-top:10px}
#statsPanel .chips{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 12px}
#statsPanel .chip{border:1px solid #21262d;border-radius:6px;padding:4px 10px;font-size:12px;color:#c9d1d9;background:#11161f;white-space:nowrap}
#statsPanel .chip b{color:#e6edf3;font-size:14px;margin-right:4px;font-variant-numeric:tabular-nums}
#statsPanel .chip.ok{border-color:#3fb95055;background:#0d2318;color:#7ee787}
#statsPanel .chip.warn{border-color:#d2992255;background:#241d0e;color:#e3b341}
#statsPanel .chip.bad{border-color:#f8514955;background:#261012;color:#ff9d96}
#statsPanel h4{margin:14px 0 6px;font-size:11.5px;color:#8b949e;font-weight:600;letter-spacing:.5px}
#statsPanel table{table-layout:auto;width:100%;border-collapse:collapse;font-size:12px}
#statsPanel th{width:auto;text-align:left;color:#6e7681;font-weight:500;padding:3px 6px;border-bottom:1px solid #21262d;white-space:nowrap}
#statsPanel td{width:auto;padding:3px 6px;border-bottom:1px solid #161b22;color:#c9d1d9;vertical-align:top}
#statsPanel td.num,#statsPanel th.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;padding-right:12px}
#statsPanel td.mono{font-family:ui-monospace,Consolas,monospace;font-size:11px;color:#8b949e}
#statsPanel .track{background:#161b22;border-radius:4px;width:100%;min-width:50px;height:8px;overflow:hidden}
#statsPanel .bar{height:8px;border-radius:4px;background:#1f6feb}
#statsPanel .bar.warn{background:#d29922}
#statsPanel button{background:#11161f;color:#c9d1d9;border:1px solid #21262d;border-radius:6px;padding:2px 10px;font:inherit;font-size:12px;cursor:pointer}
#statsPanel button:hover{border-color:#30363d;color:#e6edf3}
#statsPanel .dim{color:#6e7681}
</style>`

export function pageHtml() {
  return pageHead('tapd-loop', SHELL_CSS) + `
<body>
<h1>tapd-loop</h1><div id="meta">连接中…</div>
<div id="viewbar"><button id="openStats" title="全局吞吐 / 重试 / 失败原因（数据来自 ~/.tapd-loop/index.jsonl）">统计</button><button id="openAdvanced" title="项目 / 处理人 / 工位 / 指定工单">高级设置</button></div>
<div id="warn"></div>
<section id="ctl" class="ctl-ui">
  <div class="hero">
    <div class="hero-state" id="cSummary">连接中…</div>
    <div class="hero-act">
      <button id="cAuto" class="primary">开始自动接单</button>
      <button id="cPickOne" title="现在就派一轮：从 TAPD 拉就绪卡，派给空闲工位（不打开定时器）">现在接一单</button>
    </div>
  </div>
  <div class="autobar" id="cAutoBar">
    <div class="ab-title">自动化</div>
    <div class="seg" id="segWatch">
      <div class="seg-top">
        <label title="定时去 TAPD 看有没有就绪卡，有就派给空闲工位（空着就不开工）"><input type="checkbox" id="cWatch">自动接单</label>
        <span class="seg-every">每<input id="cPollSec" type="number" min="30" max="86400" step="30" title="多少秒去看一次 TAPD">秒</span>
      </div>
      <div id="cNext" class="ab-hint dim"></div>
    </div>
    <div class="seg" id="segAutoPush">
      <div class="seg-top">
        <label title="主树有没推的提交时，自己跑 collect --resume：导表 → 验证门 → 推送 → 回写 TAPD"><input type="checkbox" id="cAutoPush">自动验证并推送</label>
        <span class="seg-every">每<input id="cAutoPushSec" type="number" min="30" max="86400" step="30" title="多少秒看一次主树">秒</span>
      </div>
      <div id="cAutoPushHint" class="ab-hint dim"></div>
    </div>
    <div class="seg" id="segAutoMerge">
      <div class="seg-top">
        <label title="有工位攒了未合入提交时，自己 cherry-pick 进主树 → 导表 → 验证门 → 推送 → 回写 TAPD（一次只合一个工位，默认关）"><input type="checkbox" id="cAutoMerge">自动合入工位提交</label>
        <span class="seg-every">每<input id="cAutoMergeSec" type="number" min="30" max="86400" step="30" title="多少秒挑一个工位合一次">秒</span>
      </div>
      <div id="cAutoMergeHint" class="ab-hint dim"></div>
    </div>
  </div>
  <div id="cConflict"></div>
  <div id="cMain"></div>
  <div id="cStations"></div>
  <div id="cQueueBox"></div>
  <div id="advancedPanel" class="ctl-ui panel" hidden>
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
      <button id="cStop" title="写停止标记：当前卡跑完后不再接新卡，不会杀掉正在跑的批次">本批跑完就停（不杀进程）</button>
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
  </div>
</section>
<div id="panelHome" hidden></div>
<div id="statsPanel" class="panel" hidden>
  <div id="statsBody" class="stats-body"><div class="dim">加载中…</div></div>
</div>
<div id="toasts" role="status" aria-live="polite"></div>
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
