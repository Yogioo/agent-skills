#!/usr/bin/env node
/**
 * 实时进度查看器（独立进程）。
 * 读取单条 progress.jsonl，经 SSE 推送给浏览器渲染成实时 HTML。
 * 与 run-task 解耦：无论 loop 由谁启动，用户都能单独打开 URL 观察进度。
 *
 * 视图为单次「执行 → 审查」两阶段：执行端实现提交后，审查端直接改进提交。
 *
 * 用法：
 *   node scripts/serve.mjs <runDir> [port]
 */

import { createServer } from 'node:http'
import { watch, existsSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { resolve } from 'node:path'
import { loadEvents } from './progress.mjs'

const runDir = resolve(process.argv[2] || process.cwd())
const port = Number(process.argv[3]) || 8642
const progressFile = `${runDir}/progress.jsonl`

const HMTL = `
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
  .context-console .ctx-sep { color:var(--dim); }

  footer { margin-top:18px; color:var(--dim); font-size:12px; font-family:var(--mono); word-break:break-all; }
  .empty { color:var(--dim); font-size:13px; }
</style>
</head>
<body>
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
      <h2>Agent 上下文 · 实时滚动</h2>
      <div class="context-console console"><pre id="context"></pre></div>
    </div>
  </section>

  <footer id="footer"></footer>

<script>
(function () {
  const $ = (id) => document.getElementById(id);
  const events = [];
  const contextLines = []; let ctxDirty = false;
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

  function ts(t){ const d=new Date(t); return String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0')+':'+String(d.getSeconds()).padStart(2,'0'); }
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
    if (e.event==='run_start'){ meta.title=e.title; meta.workdir=e.workdir; meta.runner=e.runner; meta.id=e.id; }
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
    // status badge
    const sb=$('status');
    if (meta.settled){
      sb.textContent = meta.status==='approved' ? '✓ 已通过' : meta.status;
      sb.className='status-badge '+ (meta.status==='approved'?'approve':'error');
    } else {
      sb.textContent = STAGE_LABEL[stage] || stage;
      sb.className='status-badge '+(stage==='executing'||stage==='preparing'?'run':'run');
    }
    // title/meta
    if (meta.title){ $('title').textContent=meta.title; $('meta').textContent=(meta.id?('id '+meta.id+' · '):'')+(meta.workdir||''); }
    // stage
    $('stage').textContent = meta.settled ? (STAGE_LABEL['settle_'+ (meta.status==='approved'?'approved':'other')]) : (STAGE_LABEL[stage]||stage);
    $('stage').style.color = stColor;
    // dot
    const dot=$('dot');
    if (meta.settled) dot.className='dot done';
    else {
      const gap=Date.now()-meta.lastT;
      const stall = gap > 25000;
      dot.className='dot '+(stall?'stall':'alive');
      dot.style.color = stall?'var(--amber)':'var(--green)';
    }
    // bar
    const phasesDone = Object.keys(meta.phases).length;
    const pct = meta.settled ? 100 : Math.min(100, Math.round((phasesDone/MAX_PHASES)*100));
    $('bar').style.width=pct+'%';
    $('barCaption').textContent = meta.settled
      ? ('完成 · '+phasesDone+'/'+MAX_PHASES+' 阶段')
      : (phasesDone+' / '+MAX_PHASES+' 阶段');
    // stats
    $('phaseCount').textContent=phasesDone;
    $('elapsed').textContent = dur((meta.settled?meta.lastT:Date.now())-meta.started);
    $('stageDur').textContent = dur(Date.now() - (meta.stageStart||meta.started));
    $('heartbeatCount').textContent = meta.heartbeats;
    const lastAgo = Math.max(0, Math.round((Date.now()-meta.lastT)/1000));
    const le=$('lastEvent');
    le.textContent = meta.settled ? '已结束' : (lastAgo+'s 前');
    le.style.color = meta.settled?'var(--green)':(lastAgo>25?'var(--amber)':'var(--green)');
    // phases timeline
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
    // log
    const lines = events.map(logLine).filter(Boolean);
    const logEl=$('log');
    logEl.innerHTML = lines.map(l=>'<span>'+l+'</span>').join(String.fromCharCode(10));
    logEl.parentElement.scrollTop = logEl.parentElement.scrollHeight;
    // footer
    $('footer').textContent = 'runDir: '+(meta.runDir||'—');
  }

  function esc(s){ return String(s||'').replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

  function renderContext(){
    const pre=$('context');
    pre.innerHTML = contextLines.map(l=>{
      if(l.sep) return '<span class="ctx-sep">'+esc(l.line)+'</span>';
      return '<span class="stamp">'+ts(l.t)+'</span> <span class="'+(l.role==='reviewer'?'role-review':'role-exec')+'">['+(l.role==='reviewer'?'审查':'执行')+']</span> '+esc(l.line);
    }).join(String.fromCharCode(10));
    pre.parentElement.scrollTop = pre.parentElement.scrollHeight;
  }
  setInterval(()=>{ if(ctxDirty){ renderContext(); ctxDirty=false; } }, 150);

  // SSE
  const es = new EventSource('/events');
  es.onmessage = (m)=>{ try{ const e=JSON.parse(m.data); if(e.type==='context'){ contextLines.push({role:e.role,line:e.line||'',t:e.t||Date.now()}); if(contextLines.length>600) contextLines.splice(0,contextLines.length-600); ctxDirty=true; return; } handleEvent(e); render(); }catch(err){} };
  es.onerror = ()=>{ const le=$('lastEvent'); if(le) le.textContent='连接中断'; };

  setInterval(()=>{ if(!meta.settled){ render(); } }, 1000);
})();
</script>
</body>
</html>
`.replace(/^\s+/gm, '')

// ---------- server ----------

const clients = new Set()
let sentCount = 0
const contextFiles = {} // role -> 实时日志文件
const contextPos = {} // file -> 已读字节
const contextRemain = {} // file -> 未完成的行尾
const registeredFiles = new Set() // 已注册的上下文文件（去重）
const contextBuffer = [] // 已发射的上下文行缓冲（供新连接回放）

// 全量扫描 progress 事件，注册新出现的 context_start 文件（与 sentCount 解耦）
function registerContextFiles(evs) {
  for (const e of evs) {
    if (e.event === 'context_start' && e.role && e.file && !registeredFiles.has(e.file)) {
      registeredFiles.add(e.file)
      contextFiles[e.role] = e.file
      contextPos[e.file] = 0
      contextRemain[e.file] = ''
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
  contextBuffer.push({ role, line })
  if (contextBuffer.length > 800) contextBuffer.splice(0, contextBuffer.length - 800)
  const payload = `data: ${JSON.stringify({ type: 'context', role, line })}\n\n`
  for (const res of clients) {
    try {
      res.write(payload)
    } catch {
      /* ignore */
    }
  }
}

function tailContext() {
  for (const role of Object.keys(contextFiles)) {
    const file = contextFiles[role]
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

// fs.watch（尽力）+ 轮询兜底
try {
  watch(progressFile, () => broadcast())
} catch {
  /* 平台不支持则靠轮询 */
}
setInterval(broadcast, 1500)
setInterval(tailContext, 400)

const server = createServer((req, res) => {
  const url = req.url || '/'
  if (url === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(HMTL)
    return
  }
  if (url === '/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    res.write('retry: 2000\n\n')
    // 先发全量历史
    const evs = loadEvents(progressFile)
    sentCount = evs.length
    if (evs.length) res.write(evs.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''))
    if (contextBuffer.length) res.write(contextBuffer.map((x) => `data: ${JSON.stringify({ type: 'context', role: x.role, line: x.line })}\n\n`).join(''))
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
    return
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('not found')
})

server.listen(port, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${port}/`
  console.error(`exec-review 实时进度: ${url}`)
  console.error(`  读取: ${progressFile}`)
})

process.on('SIGINT', () => {
  server.close()
  process.exit(0)
})
