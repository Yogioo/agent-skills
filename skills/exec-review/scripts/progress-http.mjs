/**
 * exec-review 进度页 HTTP 核心（HTML + SSE）。
 * 供 serve.mjs 独立进程与 afk-run loop-serve 子路径复用。
 */

import { watch, existsSync, statSync, openSync, readSync, closeSync, readFileSync } from 'node:fs'
import { loadEvents } from './progress.mjs'
import { clientContextUiSource, PAYLOAD_TRUNCATE } from './context-ui.mjs'

function escAttr(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
}

function normalizeBasePath(basePath = '') {
  const trimmed = String(basePath || '').replace(/\/+$/, '')
  return trimmed === '/' ? '' : trimmed
}

function joinPath(basePath, suffix) {
  const base = normalizeBasePath(basePath)
  const path = `${base}${suffix}`.replace(/\/+/g, '/')
  return path.startsWith('/') ? path : `/${path}`
}

/**
 * @param {{ basePath?: string, backLink?: string, progressFile?: string }} [opts]
 */
export function renderProgressHtml(opts = {}) {
  const basePath = normalizeBasePath(opts.basePath)
  const eventsPath = joinPath(basePath, '/events')
  const backLink = opts.backLink ? String(opts.backLink) : ''
  const progressFile = opts.progressFile ? String(opts.progressFile) : ''
  const backHtml = backLink
    ? `<div class="back"><a href="${escAttr(backLink)}">← 返回 AFK 总览</a></div>`
    : ''

  return `
<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>exec-review · 实时进度</title>
<style>
  :root {
    --bg:#0b0e14; --panel:#131722; --panel2:#171c28; --border:#222a3a;
    --text:#e6edf3; --muted:#8b949e; --dim:#5c6570;
    --blue:#58a6ff; --purple:#bc8cff; --amber:#d29922; --green:#3fb950; --red:#f85149;
    --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  }
  * { box-sizing:border-box; margin:0; padding:0; }
  body {
    background:radial-gradient(1200px 500px at 50% -8%, #141a26 0%, var(--bg) 60%);
    color:var(--text); font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
    min-height:100vh; padding:28px clamp(16px,4vw,56px) 64px;
  }
  .back { margin-bottom:10px; }
  .back a { color:var(--blue); font-size:13px; text-decoration:none; }
  .back a:hover { text-decoration:underline; }
  .grip { color:var(--dim); font-size:11px; letter-spacing:.14em; text-transform:uppercase; margin-bottom:14px; }
  h1 { font-size:24px; font-weight:650; letter-spacing:-.01em; }
  .sub { color:var(--muted); margin-top:6px; font-size:13px; word-break:break-all; }

  .status-badge {
    display:inline-block; margin-top:14px; padding:6px 14px; border-radius:999px;
    font-size:13px; font-weight:600; border:1px solid var(--border);
    background:var(--panel2); color:var(--muted); transition:all .3s;
  }
  .status-badge.run     { color:var(--blue);  border-color:color-mix(in srgb,var(--blue) 45%,transparent);  background:color-mix(in srgb,var(--blue) 12%,transparent); }
  .status-badge.approve { color:var(--green); border-color:color-mix(in srgb,var(--green) 45%,transparent); background:color-mix(in srgb,var(--green) 12%,transparent); }
  .status-badge.error   { color:var(--red);   border-color:color-mix(in srgb,var(--red) 45%,transparent);   background:color-mix(in srgb,var(--red) 12%,transparent); }

  .panel { background:var(--panel); border:1px solid var(--border); border-radius:14px; padding:20px; margin-top:18px; }
  .panel h2 { font-size:12px; letter-spacing:.1em; text-transform:uppercase; color:var(--dim); margin-bottom:16px; font-weight:600; }

  .hero { display:flex; gap:28px; flex-wrap:wrap; align-items:stretch; }
  .hero-main { flex:1 1 380px; display:flex; flex-direction:column; gap:16px; min-width:280px; }
  .stage-row { display:flex; align-items:center; gap:10px; }
  .dot { width:11px; height:11px; border-radius:50%; background:var(--dim); flex:none; transition:background .3s; }
  .dot.alive { background:var(--green); box-shadow:0 0 0 0 color-mix(in srgb,var(--green) 55%,transparent); animation:pulse 2s infinite; }
  .dot.stall { background:var(--amber); box-shadow:0 0 0 0 color-mix(in srgb,var(--amber) 55%,transparent); animation:pulse 1s infinite; }
  .dot.done  { background:var(--green); box-shadow:none; animation:none; }
  @keyframes pulse { 0%{box-shadow:0 0 0 0 color-mix(in srgb,currentColor 50%,transparent);} 70%{box-shadow:0 0 0 9px transparent;} 100%{box-shadow:0 0 0 0 transparent;} }
  .stage { font-size:20px; font-weight:650; letter-spacing:-.01em; }
  .stage-hint { color:var(--muted); font-size:13px; }

  .bar-track { height:10px; background:var(--panel2); border-radius:999px; overflow:hidden; border:1px solid var(--border); }
  .bar { height:100%; width:0%; border-radius:999px; background:linear-gradient(90deg,var(--blue),var(--purple)); transition:width .5s ease; }
  .bar-caption { color:var(--muted); font-size:12px; }

  .hero-stats { display:flex; flex-direction:column; gap:12px; flex:none; min-width:180px; justify-content:center; }
  .stat { display:flex; justify-content:space-between; gap:24px; padding:10px 14px; background:var(--panel2); border:1px solid var(--border); border-radius:10px; }
  .stat .k { color:var(--muted); font-size:12px; }
  .stat .v { font-family:var(--mono); font-size:15px; font-weight:600; }

  .phase { display:grid; grid-template-columns:64px 1fr auto; gap:14px; padding:14px 0; border-top:1px dashed var(--border); align-items:start; }
  .phase:first-of-type { border-top:none; }
  .phase-idx { font-family:var(--mono); color:var(--dim); font-weight:600; padding-top:2px; }
  .phase-body { min-width:0; }
  .phase-row { display:flex; gap:8px; align-items:center; font-size:13px; padding:3px 0; color:var(--muted); }
  .phase-row .lbl { color:var(--dim); width:44px; flex:none; }
  .phase-status { padding:2px 9px; border-radius:6px; font-size:11px; font-weight:700; letter-spacing:.05em; }
  .phase-status.refined { color:var(--green); background:color-mix(in srgb,var(--green) 14%,transparent); }
  .phase-status.clean   { color:var(--dim);  background:color-mix(in srgb,var(--dim) 14%,transparent); }

  .log-console { background:#0a0d12; border:1px solid var(--border); border-radius:10px; padding:14px 16px; height:260px; overflow:auto; }
  .log-console pre { font-family:var(--mono); font-size:12px; line-height:1.7; color:#9db0c8; white-space:pre-wrap; word-break:break-word; }
  .log-console .stamp { color:var(--dim); }
  .log-console .ev-approve { color:var(--green); }
  .log-console .ev-run,.log-console .ev-round { color:var(--blue); }
  .log-console .ev-error { color:var(--red); }

  .split { display:grid; grid-template-columns:1fr 1fr; gap:18px; }
  @media (max-width:900px){ .split{ grid-template-columns:1fr; } }
  .console { background:#0a0d12; border:1px solid var(--border); border-radius:10px; padding:14px 16px; height:320px; overflow:auto; }
  .console pre { font-family:var(--mono); font-size:12px; line-height:1.7; color:#9db0c8; white-space:pre-wrap; word-break:break-word; }
  .context-console .role-exec { color:var(--blue); font-weight:600; }
  .context-console .role-review { color:var(--purple); font-weight:600; }
  .context-console .ctx-sep { color:var(--dim); margin:8px 0; font-size:12px; }
  .ctx-cards { display:flex; flex-direction:column; gap:8px; }
  .ctx-card { border:1px solid var(--border); border-radius:8px; background:#0a0d12; overflow:hidden; }
  .ctx-card summary { cursor:pointer; padding:8px 12px; font-size:12px; color:var(--muted); list-style:none; }
  .ctx-card summary::-webkit-details-marker { display:none; }
  .ctx-card summary::before { content:'▸ '; color:var(--dim); }
  .ctx-card[open] summary::before { content:'▾ '; }
  .ctx-card.tool summary { color:var(--amber); }
  .ctx-card.assistant summary { color:var(--blue); }
  .ctx-card.outcome summary { color:var(--green); }
  .ctx-card.raw summary { color:var(--dim); }
  .ctx-card .body { padding:0 12px 10px; font-family:var(--mono); font-size:11px; line-height:1.6; color:#9db0c8; white-space:pre-wrap; word-break:break-word; }
  .ctx-mono { margin:0; padding:8px 10px; background:#07090e; border:1px solid var(--border); border-radius:6px; white-space:pre-wrap; word-break:break-word; font-family:var(--mono); font-size:11px; line-height:1.55; color:#9db0c8; }
  .ctx-trunc { margin-top:6px; }
  .ctx-trunc summary { cursor:pointer; color:var(--blue); font-size:11px; padding:4px 0; list-style:none; }
  .ctx-trunc summary::-webkit-details-marker { display:none; }
  .ctx-trunc-full { margin-top:6px; max-height:420px; overflow:auto; }
  .ctx-trunc-preview { max-height:180px; overflow:hidden; }
  .ctx-shell-cmd { color:var(--amber); font-weight:600; }
  .ctx-shell-exit { color:var(--muted); }
  .ctx-edit-head { color:var(--green); font-weight:600; }
  .ctx-card.tool.shell summary { color:var(--amber); }
  .ctx-card.tool.edit summary, .ctx-card.tool.write summary { color:var(--green); }
  .ctx-card.assistant .body, .ctx-card.outcome .body { display:block; padding:8px 12px 10px; }
  .ctx-card.assistant.streaming .body { opacity:.92; border-left:2px solid var(--blue); padding-left:10px; }
  .ctx-card.assistant, .ctx-card.outcome { border-color:color-mix(in srgb,var(--blue) 30%,var(--border)); }
  .ctx-card.outcome { border-color:color-mix(in srgb,var(--green) 30%,var(--border)); }

  footer { margin-top:18px; color:var(--dim); font-size:12px; font-family:var(--mono); word-break:break-all; }
  .empty { color:var(--dim); font-size:13px; }
</style>
</head>
<body>
  ${backHtml}
  <div class="grip">exec-review · 执行审查 · 实时进度</div>
  <h1 id="title">等待运行…</h1>
  <div class="sub" id="meta"></div>
  <div class="status-badge" id="status">准备中</div>

  <section class="hero panel">
    <div class="hero-main">
      <div class="stage-row">
        <span class="dot" id="dot"></span>
        <span class="stage" id="stage">等待运行开始…</span>
      </div>
      <div>
        <div class="bar-track"><div class="bar" id="bar"></div></div>
        <div class="bar-caption" id="barCaption">0 / 2</div>
      </div>
    </div>
    <div class="hero-stats">
      <div class="stat"><span class="k">耗时</span><span class="v" id="elapsed">0s</span></div>
      <div class="stat"><span class="k">阶段</span><span class="v" id="phaseCount">0</span></div>
      <div class="stat"><span class="k">本阶段进行</span><span class="v" id="stageDur">0s</span></div>
      <div class="stat"><span class="k">心跳</span><span class="v" id="heartbeatCount">0</span></div>
      <div class="stat"><span class="k">上次事件</span><span class="v" id="lastEvent">—</span></div>
    </div>
  </section>

  <section class="panel">
    <h2>阶段时间线</h2>
    <div id="phases"><div class="empty">尚无阶段。</div></div>
  </section>

  <section class="panel split">
    <div class="col">
      <h2>实时日志 · 主流程</h2>
      <div class="log-console console"><pre id="log"></pre></div>
    </div>
    <div class="col">
      <h2>Agent 上下文 · 结构化事件</h2>
      <div class="context-console console"><div class="ctx-cards" id="contextCards"></div></div>
    </div>
  </section>

  <footer id="footer"></footer>

<script>
(function () {
${clientContextUiSource()}
  const EVENTS_URL = ${JSON.stringify(eventsPath)};
  const PROGRESS_FILE = ${JSON.stringify(progressFile)};
  const PAYLOAD_LIMIT = ${PAYLOAD_TRUNCATE};
  const $ = (id) => document.getElementById(id);
  const events = [];
  const toolCards = {}; let ctxDirty = false;
  const assistantCards = []; const outcomeCards = []; const contextLines = [];
  const streamingAssistant = {};
  const MAX_PHASES = 2;
  const meta = { phases: {}, settled: false, status: '', lastT: Date.now(), started: Date.now(), heartbeats: 0, stageStart: Date.now() };

  const STAGE_LABEL = {
    idle:'空闲', preparing:'准备中', executing:'执行中', reviewing:'审查中',
    settle_approved:'已结束 · 已通过', settle_other:'已结束'
  };
  const STAGE_COLOR = {
    idle:'var(--dim)', preparing:'var(--blue)', executing:'var(--blue)', reviewing:'var(--purple)',
    settle_approved:'var(--green)', settle_other:'var(--red)'
  };

  function ts(t){ if (t == null || t === '') return ''; const d=new Date(t); return String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0')+':'+String(d.getSeconds()).padStart(2,'0'); }
  function dur(ms){ if(ms==null) return '—'; const s=Math.round(ms/1000); if(s<60) return s+'s'; const m=Math.floor(s/60); if(m<60) return m+'m '+ (s%60)+'s'; const h=Math.floor(m/60); return h+'h '+ (m%60)+'m'; }

  function stageNow(){
    for (let i=events.length-1;i>=0;i--){
      const e=events[i];
      if (e.event==='executor_start') return 'executing';
      if (e.event==='reviewer_start') return 'reviewing';
      if (e.event==='settle') return 'settle_'+(e.status==='approved'?'approved':'other');
    }
    return events.length? 'preparing':'idle';
  }

  function handleEvent(e){
    events.push(e); meta.lastT = e.t;
    if (e.event==='heartbeat'){ meta.heartbeats++; return; }
    if (e.event==='executor_start'||e.event==='reviewer_start'){ meta.stageStart=e.t; }
    if (e.event==='context_start'){ contextLines.push({role:e.role, line:'── '+(e.role==='reviewer'?'审查端':'执行端')+' 上下文 ──', t:e.t, sep:true}); ctxDirty=true; }
    if (e.event==='run_start'){ meta.title=e.title; meta.workdir=e.workdir; meta.runner=e.runner; meta.id=e.id; meta.runDir=e.runDir; }
    if (e.event==='executor_end'){ meta.phases.executor={status:e.status, changed:e.changed}; }
    if (e.event==='reviewer_end'){ meta.phases.reviewer={status:e.status, changed:e.changed}; }
    if (e.event==='settle'){ meta.settled=true; meta.status=e.status; }
  }

  function logLine(e){
    const st=ts(e.t);
    let cls='', txt='';
    switch(e.event){
      case 'run_start': cls='ev-run'; txt='运行开始 · '+ (e.title||e.id||'') + (e.runner?' · runner='+e.runner:''); break;
      case 'executor_start': txt='执行端启动'; break;
      case 'executor_end': cls='ev-round'; txt='执行端完成 · status='+e.status+' · 改动文件='+e.changed; break;
      case 'reviewer_start': txt='审查端启动'; break;
      case 'reviewer_end': cls=(e.status==='refined'?'ev-approve':'ev-round'); txt='审查端完成 · '+e.status+' · 改动文件='+e.changed; break;
      case 'settle': cls=(e.status==='approved'?'ev-approve':'ev-error'); txt='定案 · '+e.status; break;
      case 'heartbeat': return null;
      default: txt=e.event;
    }
    return '<span class="stamp">'+st+'</span>  '+txt;
  }

  function render(){
    const stage=stageNow();
    const stColor=STAGE_COLOR[stage];
    const sb=$('status');
    if (meta.settled){
      sb.textContent = meta.status==='approved' ? '✓ 已通过' : meta.status;
      sb.className='status-badge '+ (meta.status==='approved'?'approve':'error');
    } else {
      sb.textContent = STAGE_LABEL[stage] || stage;
      sb.className='status-badge run';
    }
    if (meta.title){ $('title').textContent=meta.title; $('meta').textContent=(meta.id?('id '+meta.id+' · '):'')+(meta.workdir||''); }
    $('stage').textContent = meta.settled ? (STAGE_LABEL['settle_'+ (meta.status==='approved'?'approved':'other')]) : (STAGE_LABEL[stage]||stage);
    $('stage').style.color = stColor;
    const dot=$('dot');
    if (meta.settled) dot.className='dot done';
    else {
      const gap=Date.now()-meta.lastT;
      const stall = gap > 25000;
      dot.className='dot '+(stall?'stall':'alive');
      dot.style.color = stall?'var(--amber)':'var(--green)';
    }
    const phasesDone = Object.keys(meta.phases).length;
    const pct = meta.settled ? 100 : Math.min(100, Math.round((phasesDone/MAX_PHASES)*100));
    $('bar').style.width=pct+'%';
    $('barCaption').textContent = meta.settled
      ? ('完成 · '+phasesDone+'/'+MAX_PHASES+' 阶段')
      : (phasesDone+' / '+MAX_PHASES+' 阶段');
    $('phaseCount').textContent=phasesDone;
    $('elapsed').textContent = dur((meta.settled?meta.lastT:Date.now())-meta.started);
    $('stageDur').textContent = dur(Date.now() - (meta.stageStart||meta.started));
    $('heartbeatCount').textContent = meta.heartbeats;
    const lastAgo = Math.max(0, Math.round((Date.now()-meta.lastT)/1000));
    const le=$('lastEvent');
    le.textContent = meta.settled ? '已结束' : (lastAgo+'s 前');
    le.style.color = meta.settled?'var(--green)':(lastAgo>25?'var(--amber)':'var(--green)');
    const pBox=$('phases');
    const keys=Object.keys(meta.phases);
    if (!keys.length){ pBox.innerHTML='<div class="empty">尚无阶段。</div>'; }
    else {
      pBox.innerHTML = keys.map((k)=>{
        const p=meta.phases[k];
        const stt = p.status ? '<span class="phase-status '+(p.status==='refined'?'refined':'clean')+'">'+p.status+'</span>' : '<span class="phase-status">…</span>';
        const changeInfo = (p.changed!=null && p.changed>0) ? (' · '+p.changed+' 文件改动') : '';
        return '<div class="phase"><div class="phase-idx">'+k+'</div>'+
          '<div class="phase-body">'+
            '<div class="phase-row"><span class="lbl">结果</span>'+stt+changeInfo+'</div>'+
          '</div>'+
          '<div class="phase-idx">'+(k==='executor'?'执行':'审查')+'</div>'+
        '</div>';
      }).join('');
    }
    const lines = events.map(logLine).filter(Boolean);
    const logEl=$('log');
    logEl.innerHTML = lines.map(l=>'<span>'+l+'</span>').join(String.fromCharCode(10));
    logEl.parentElement.scrollTop = logEl.parentElement.scrollHeight;
    $('footer').textContent = 'progress: '+(PROGRESS_FILE || meta.runDir || '—');
  }

  function esc(s){ return String(s||'').replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

  function fmtBody(ev){
    if (ev.kind === 'assistant' || ev.kind === 'outcome') return ev.text || '';
    return JSON.stringify(ev.payload || ev, null, 2);
  }

  function handleAgentEvent(e){
    const role = e.role || 'executor';
    const ev = e.event || {};
    if (ev.kind === 'tool') {
      const id = ev.callId || ('tool-'+Object.keys(toolCards).length);
      if (!toolCards[id]) toolCards[id] = { role, start: null, done: null };
      if (ev.phase === 'start') toolCards[id].start = ev;
      else toolCards[id].done = ev;
      ctxDirty = true;
      return;
    }
    if (ev.kind === 'assistant_partial') {
      const delta = ev.text || '';
      if (!streamingAssistant[role]) {
        streamingAssistant[role] = { text: delta, idx: assistantCards.length };
        assistantCards.push({ role, ev: { text: delta }, streaming: true });
      } else {
        streamingAssistant[role].text += delta;
        assistantCards[streamingAssistant[role].idx].ev.text = streamingAssistant[role].text;
      }
      ctxDirty = true;
      return;
    }
    if (ev.kind === 'assistant') {
      if (streamingAssistant[role]) {
        const idx = streamingAssistant[role].idx;
        assistantCards[idx].ev.text = ev.text || streamingAssistant[role].text;
        assistantCards[idx].streaming = false;
        delete streamingAssistant[role];
      } else {
        assistantCards.push({ role, ev });
      }
      ctxDirty = true;
      return;
    }
    if (ev.kind === 'outcome') { outcomeCards.push({ role, ev }); ctxDirty = true; return; }
    contextLines.push({ role, line: fmtBody(ev), t: e.t }); ctxDirty = true;
  }

  function renderContext(){
    const box = $('contextCards');
    const panel = box.parentElement;
    const wasAtBottom = panel.scrollHeight - panel.scrollTop - panel.clientHeight < 48;
    const html = [];
    for (const id of Object.keys(toolCards)) {
      const card = toolCards[id];
      const ev = card.done || card.start || {};
      const toolKind = mapToolName(ev.toolName || 'tool');
      const label = '['+(card.role==='reviewer'?'审查':'执行')+'] '+fmtToolSummary(ev);
      const body = formatToolBody(card.start, card.done, ev.toolName || 'tool', 'tool-'+id, esc);
      html.push('<details class="ctx-card tool ctx-tool-'+esc(toolKind)+'"><summary>'+esc(label)+'</summary><div class="body">'+body+'</div></details>');
    }
    for (const item of assistantCards) {
      const streamCls = item.streaming ? ' streaming' : '';
      const text = item.ev.text || '';
      const body = text.length > PAYLOAD_LIMIT
        ? renderTruncBlock(text, 'asst-'+assistantCards.indexOf(item), esc, PAYLOAD_LIMIT)
        : esc(text);
      html.push('<div class="ctx-card assistant'+streamCls+'"><div class="body"><span class="'+(item.role==='reviewer'?'role-review':'role-exec')+'">['+(item.role==='reviewer'?'审查':'执行')+']</span> '+body+'</div></div>');
    }
    for (const item of outcomeCards) {
      html.push('<div class="ctx-card outcome"><div class="body"><span class="'+(item.role==='reviewer'?'role-review':'role-exec')+'">['+(item.role==='reviewer'?'审查':'执行')+'] outcome</span>'+String.fromCharCode(10)+esc(item.ev.text||'')+'</div></div>');
    }
    for (const l of contextLines) {
      if (l.sep) html.push('<div class="ctx-sep">'+esc(l.line)+'</div>');
      else html.push('<div class="ctx-card raw"><div class="body"><span class="'+(l.role==='reviewer'?'role-review':'role-exec')+'">['+(l.role==='reviewer'?'审查':'执行')+']</span> '+esc(l.line)+'</div></div>');
    }
    box.innerHTML = html.join('');
    if (wasAtBottom) panel.scrollTop = panel.scrollHeight;
  }
  setInterval(()=>{ if(ctxDirty){ renderContext(); ctxDirty=false; } }, 150);

  const es = new EventSource(EVENTS_URL);
  es.onmessage = (m)=>{ try{ const e=JSON.parse(m.data); if(e.type==='agent_event'){ handleAgentEvent(e); return; } if(e.type==='context'){ contextLines.push({role:e.role,line:e.line||'',t:typeof e.t==='number'?e.t:null}); ctxDirty=true; return; } handleEvent(e); render(); }catch(err){} };
  es.onerror = ()=>{ const le=$('lastEvent'); if(le) le.textContent='连接中断'; };

  setInterval(()=>{ if(!meta.settled){ render(); } }, 1000);
})();
</script>
</body>
</html>
`.replace(/^\s+/gm, '')
}

/**
 * @param {string} progressFile
 */
export function createProgressWatcher(progressFile) {
  const clients = new Set()
  let sentCount = 0
  const contextFiles = {}
  const contextPos = {}
  const contextRemain = {}
  const registeredFiles = new Set()
  const contextEventsFiles = {}
  const contextEventsPos = {}
  const contextEventsRemain = {}
  const registeredEventsFiles = new Set()

  function registerContextFiles(evs) {
    for (const e of evs) {
      if (e.event !== 'context_start' || !e.role) continue
      if (e.file && !registeredFiles.has(e.file)) {
        registeredFiles.add(e.file)
        contextFiles[e.role] = e.file
        contextPos[e.file] = 0
        contextRemain[e.file] = ''
      }
      if (e.eventsFile && !registeredEventsFiles.has(e.eventsFile)) {
        registeredEventsFiles.add(e.eventsFile)
        contextEventsFiles[e.role] = e.eventsFile
        contextEventsPos[e.eventsFile] = 0
        contextEventsRemain[e.eventsFile] = ''
      }
    }
  }

  function broadcast() {
    const evs = loadEvents(progressFile)
    registerContextFiles(evs)
    if (evs.length === sentCount) return
    const fresh = evs.slice(sentCount)
    sentCount = evs.length
    if (!fresh.length) return
    const payload = fresh.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')
    for (const res of clients) {
      try {
        res.write(payload)
      } catch {
        /* ignore */
      }
    }
  }

  function emitContext(role, line) {
    const payload = `data: ${JSON.stringify({ type: 'context', role, line, t: Date.now() })}\n\n`
    for (const res of clients) {
      try {
        res.write(payload)
      } catch {
        /* ignore */
      }
    }
  }

  function emitAgentEvent(role, event) {
    const payload = `data: ${JSON.stringify({ type: 'agent_event', role, event, t: Date.now() })}\n\n`
    for (const res of clients) {
      try {
        res.write(payload)
      } catch {
        /* ignore */
      }
    }
  }

  function parseEventsChunk(role, file, text) {
    const combined = (contextEventsRemain[file] || '') + text
    const lines = combined.split('\n')
    contextEventsRemain[file] = lines.pop() || ''
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const event = JSON.parse(line)
        emitAgentEvent(role, event)
      } catch {
        /* ignore bad lines */
      }
    }
  }

  function writeEventsReplay(res) {
    for (const role of Object.keys(contextEventsFiles)) {
      const file = contextEventsFiles[role]
      if (!file) continue
      try {
        const text = readFileSync(file, 'utf8')
        for (const line of text.split('\n')) {
          if (!line.trim()) continue
          try {
            const event = JSON.parse(line)
            res.write(
              `data: ${JSON.stringify({ type: 'agent_event', role, event, t: Date.now() })}\n\n`,
            )
          } catch {
            /* ignore */
          }
        }
        const st = statSync(file)
        contextEventsPos[file] = st.size
        contextEventsRemain[file] = ''
      } catch {
        /* events file not ready */
      }
    }
  }

  function writeContextReplay(res) {
    for (const role of Object.keys(contextFiles)) {
      const file = contextFiles[role]
      if (!file) continue
      if (contextEventsFiles[role]) continue
      try {
        const text = readFileSync(file, 'utf8')
        for (const line of text.split('\n')) {
          if (line.trim().length) {
            res.write(`data: ${JSON.stringify({ type: 'context', role, line })}\n\n`)
          }
        }
        const st = statSync(file)
        contextPos[file] = st.size
        contextRemain[file] = ''
      } catch {
        /* log not ready */
      }
    }
  }

  function tailContext() {
    for (const role of Object.keys(contextFiles)) {
      const file = contextFiles[role]
      if (contextEventsFiles[role]) continue
      let text = ''
      try {
        const st = statSync(file)
        const pos = contextPos[file] || 0
        if (st.size < pos) {
          contextPos[file] = 0
          contextRemain[file] = ''
          continue
        }
        if (st.size === pos) continue
        const fd = openSync(file, 'r')
        const buf = Buffer.alloc(st.size - pos)
        readSync(fd, buf, 0, buf.length, pos)
        closeSync(fd)
        contextPos[file] = st.size
        text = buf.toString('utf8')
      } catch {
        continue
      }
      const combined = (contextRemain[file] || '') + text
      const lines = combined.split('\n')
      contextRemain[file] = lines.pop() || ''
      for (const line of lines) {
        if (line.trim().length) emitContext(role, line)
      }
    }
  }

  function tailEvents() {
    for (const role of Object.keys(contextEventsFiles)) {
      const file = contextEventsFiles[role]
      let text = ''
      try {
        const st = statSync(file)
        const pos = contextEventsPos[file] || 0
        if (st.size < pos) {
          contextEventsPos[file] = 0
          contextEventsRemain[file] = ''
          continue
        }
        if (st.size === pos) continue
        const fd = openSync(file, 'r')
        const buf = Buffer.alloc(st.size - pos)
        readSync(fd, buf, 0, buf.length, pos)
        closeSync(fd)
        contextEventsPos[file] = st.size
        text = buf.toString('utf8')
      } catch {
        continue
      }
      parseEventsChunk(role, file, text)
    }
  }

  try {
    if (existsSync(progressFile)) watch(progressFile, () => broadcast())
  } catch {
    /* 平台不支持则靠轮询 */
  }
  const pollTimer = setInterval(broadcast, 1500)
  const tailTimer = setInterval(() => {
    tailEvents()
    tailContext()
  }, 400)

  /**
   * @param {string} pathname
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {{ basePath?: string, backLink?: string }} [opts]
   * @returns {boolean} 是否已处理
   */
  function handleRequest(pathname, req, res, opts = {}) {
    const basePath = normalizeBasePath(opts.basePath)
    const pagePath = joinPath(basePath, '/')
    const eventsPath = joinPath(basePath, '/events')
    const path = (pathname || '/').split('?')[0]

    if (path === pagePath || path === basePath) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(
        renderProgressHtml({
          basePath,
          backLink: opts.backLink || '',
          progressFile,
        }),
      )
      return true
    }

    if (path === eventsPath) {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      res.write('retry: 2000\n\n')
      const evs = loadEvents(progressFile)
      registerContextFiles(evs)
      sentCount = evs.length
      if (evs.length) res.write(evs.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''))
      writeEventsReplay(res)
      writeContextReplay(res)
      clients.add(res)
      const keep = setInterval(() => {
        try {
          res.write(': keepalive\n\n')
        } catch {
          clearInterval(keep)
        }
      }, 15000)
      req.on('close', () => {
        clearInterval(keep)
        clients.delete(res)
      })
      return true
    }

    return false
  }

  function close() {
    clearInterval(pollTimer)
    clearInterval(tailTimer)
    for (const res of clients) {
      try {
        res.end()
      } catch {
        /* ignore */
      }
    }
    clients.clear()
  }

  return { handleRequest, close, progressFile }
}
