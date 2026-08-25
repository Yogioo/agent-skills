#!/usr/bin/env node
/**
 * AFK loop 的只读实时看板。
 *
 * 用 loop-progress.jsonl 记录任务队列生命周期，并按当前任务关联的
 * exec-review progress.jsonl 聚合执行/审查阶段和心跳。服务为独立进程，
 * 所以 loop 结束后报告和历史结果仍可查看。
 */

import { createServer } from 'node:http'
import { existsSync, readFileSync, watch } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadEvents } from '../../exec-review/scripts/progress.mjs'

const STAGE_NAMES = {
  preparing: '准备中',
  executing: '执行中',
  reviewing: '审查中',
  settled: '已结束',
}

/**
 * 将 append-only loop 事件及当前任务的 exec-review 事件投影为页面状态。
 * @param {object[]} loopEvents
 * @param {object[]} progressEvents
 */
export function projectLoopState(loopEvents = [], progressEvents = []) {
  const tasks = new Map()
  let config = {}
  let reason = ''
  let reportFile = ''
  let currentId = ''
  let currentStartedAt = 0
  let lastLoopEventAt = 0

  for (const event of loopEvents) {
    if (!event || !event.event) continue
    if (event.t) lastLoopEventAt = event.t
    if (event.event === 'loop_start') {
      config = { ...config, ...event }
      continue
    }
    if (event.event === 'queue_update') {
      const queuedTasks = Array.isArray(event.tasks) ? event.tasks : []
      const queuedIds = new Set(queuedTasks.map((task) => task.id))
      for (const [id, task] of tasks) {
        if (task.state === 'ready' && !queuedIds.has(id)) tasks.delete(id)
      }
      for (const queued of queuedTasks) {
        const old = tasks.get(queued.id)
        if (!old || old.state === 'ready') {
          tasks.set(queued.id, { ...old, ...queued, state: 'ready', updatedAt: event.t })
        }
      }
      continue
    }
    if (event.event === 'task_start') {
      const old = tasks.get(event.id) || {}
      tasks.set(event.id, { ...old, ...event, state: 'in_progress', updatedAt: event.t })
      currentId = event.id
      currentStartedAt = event.t || Date.now()
      continue
    }
    if (event.event === 'task_end') {
      const old = tasks.get(event.id) || {}
      tasks.set(event.id, {
        ...old,
        ...event,
        state: event.kind === 'done' ? 'done' : 'failed',
        updatedAt: event.t,
      })
      if (currentId === event.id) {
        currentId = ''
        currentStartedAt = 0
      }
      continue
    }
    if (event.event === 'loop_end') {
      reason = event.reason || ''
      reportFile = event.reportFile || ''
    }
  }

  const list = [...tasks.values()]
  const ready = list.filter((task) => task.state === 'ready')
  const active = list.filter((task) => task.state === 'in_progress')
  const done = list.filter((task) => task.state === 'done')
  const failed = list.filter((task) => task.state === 'failed')
  const currentTask = active.find((task) => task.id === currentId) || active.at(-1) || null

  let stage = 'preparing'
  let stageSince = currentStartedAt
  let heartbeats = 0
  let lastEventAt = currentStartedAt
  for (const event of progressEvents) {
    if (!event || !event.event) continue
    lastEventAt = event.t || lastEventAt
    if (event.event === 'executor_start') {
      stage = 'executing'
      stageSince = event.t
    } else if (event.event === 'reviewer_start') {
      stage = 'reviewing'
      stageSince = event.t
    } else if (event.event === 'settle') {
      stage = 'settled'
      stageSince = event.t
    } else if (event.event === 'heartbeat') {
      heartbeats++
      if (event.stage) stage = event.stage
      if (typeof event.sinceMs === 'number' && event.t) stageSince = event.t - event.sinceMs
    }
  }

  const current = currentTask
    ? {
        ...currentTask,
        stage,
        stageLabel: STAGE_NAMES[stage] || stage,
        stageSince,
        heartbeats,
        lastEventAt,
      }
    : null

  return {
    events: loopEvents,
    config,
    ready,
    active,
    done,
    failed,
    current,
    reason,
    reportFile,
    stopFile: config.stopFile || '',
    runDir: config.runDir || '',
    startedAt: config.t || 0,
    lastEventAt: lastLoopEventAt,
  }
}

const HTML = `
<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>afk-run · 实时看板</title>
<style>
  :root { --bg:#0c1016; --panel:#151b24; --line:#2a3442; --text:#e8edf3; --muted:#95a2b2; --dim:#687587; --blue:#5ca7f7; --green:#4bc47b; --amber:#d8a23a; --red:#e06767; --mono:ui-monospace,SFMono-Regular,Consolas,monospace; }
  * { box-sizing:border-box; margin:0; }
  body { background:var(--bg); color:var(--text); font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif; padding:28px clamp(16px,4vw,64px) 60px; }
  .grip { color:var(--dim); font:11px var(--mono); letter-spacing:.12em; text-transform:uppercase; margin-bottom:12px; }
  h1 { font-size:25px; font-weight:650; }
  .sub { color:var(--muted); margin-top:5px; overflow-wrap:anywhere; }
  .badge { display:inline-block; margin-top:13px; border:1px solid var(--line); background:var(--panel); color:var(--blue); padding:5px 10px; border-radius:5px; font-weight:600; }
  .badge.done { color:var(--green); } .badge.stale { color:var(--amber); }
  .summary { display:flex; flex-wrap:wrap; gap:10px 22px; margin-top:18px; color:var(--muted); font-size:12px; }
  .summary span b { color:var(--text); font-family:var(--mono); font-weight:600; }
  section { margin-top:20px; }
  h2 { color:var(--dim); font-size:12px; letter-spacing:.08em; text-transform:uppercase; margin-bottom:10px; }
  .queues { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:12px; }
  .queue { min-height:138px; border:1px solid var(--line); background:var(--panel); padding:13px; border-radius:6px; }
  .queue h3 { color:var(--muted); font-size:12px; font-weight:600; margin-bottom:10px; }
  .count { font-family:var(--mono); color:var(--dim); float:right; }
  .task { border-top:1px solid var(--line); padding:9px 0; }
  .task:first-of-type { border-top:0; padding-top:0; }
  .taskid { color:var(--blue); font:12px var(--mono); }
  .tasktitle { overflow-wrap:anywhere; margin-top:2px; }
  .taskmeta { color:var(--muted); font-size:12px; margin-top:3px; overflow-wrap:anywhere; }
  .failed .taskid { color:var(--red); } .finished .taskid { color:var(--green); }
  .empty { color:var(--dim); font-size:13px; }
  .current { border:1px solid var(--line); background:var(--panel); padding:18px; border-radius:6px; display:grid; grid-template-columns:minmax(220px,1fr) 210px; gap:24px; }
  .stage { display:flex; align-items:center; gap:9px; font-size:19px; font-weight:650; }
  .dot { width:10px; height:10px; border-radius:50%; background:var(--green); box-shadow:0 0 0 4px #4bc47b20; flex:none; }
  .dot.stale { background:var(--amber); box-shadow:0 0 0 4px #d8a23a20; }
  .bartrack { height:8px; background:#0d1219; border:1px solid var(--line); margin-top:17px; overflow:hidden; border-radius:4px; }
  .bar { height:100%; width:0%; background:var(--blue); transition:width .3s; }
  .stagehint { color:var(--muted); font-size:12px; margin-top:6px; }
  .stats { display:grid; gap:8px; align-content:center; }
  .stat { display:flex; justify-content:space-between; border-bottom:1px solid var(--line); padding:5px 0; color:var(--muted); font-size:12px; }
  .stat b { color:var(--text); font:600 13px var(--mono); }
  .footer { border-top:1px solid var(--line); color:var(--muted); margin-top:22px; padding-top:14px; font-size:12px; overflow-wrap:anywhere; }
  .footer a { color:var(--blue); }
  @media (max-width:900px) { .queues { grid-template-columns:repeat(2,minmax(0,1fr)); } .current { grid-template-columns:1fr; } }
  @media (max-width:560px) { .queues { grid-template-columns:1fr; } body { padding-top:18px; } }
</style>
</head>
<body>
  <div class="grip">afk-run · 实时聚合进度</div>
  <h1 id="title">AFK 运行看板</h1>
  <div class="sub" id="meta">等待 loop 开始...</div>
  <div class="badge" id="status">连接中</div>
  <div class="summary">
    <span>启动 <b id="started">-</b></span>
    <span>来源 <b id="source">-</b></span>
    <span>停止文件 <b id="stopsummary">-</b></span>
    <span>runDir <b id="rundir">-</b></span>
    <span>上次事件 <b id="lastupdate">-</b></span>
  </div>

  <section>
    <h2>任务队列</h2>
    <div class="queues">
      <div class="queue"><h3>就绪 <span class="count" id="readycount">0</span></h3><div id="ready"></div></div>
      <div class="queue"><h3>进行中 <span class="count" id="activecount">0</span></h3><div id="active"></div></div>
      <div class="queue finished"><h3>完成 <span class="count" id="finishedcount">0</span></h3><div id="finished"></div></div>
      <div class="queue failed"><h3>失败 <span class="count" id="failedcount">0</span></h3><div id="failed"></div></div>
    </div>
  </section>

  <section>
    <h2>当前任务</h2>
    <div class="current">
      <div>
        <div class="stage"><span class="dot" id="dot"></span><span id="stage">等待任务...</span></div>
        <div class="stagehint" id="taskname">执行和审查阶段会显示在这里。</div>
        <div class="bartrack"><div class="bar" id="bar"></div></div>
        <div class="stagehint" id="stagehint">-</div>
      </div>
      <div class="stats">
        <div class="stat"><span>本阶段耗时</span><b id="stagedur">-</b></div>
        <div class="stat"><span>心跳</span><b id="heartbeat">0</b></div>
        <div class="stat"><span>尝试</span><b id="attempt">-</b></div>
      </div>
    </div>
  </section>

  <div class="footer">
    停止：在 <span id="stopfile">-</span> 放置 <code>afk-stop</code> 文件。<br />
    报告：<span id="report">运行结束后可查看 report.md。</span>
  </div>

<script>
(function () {
  const $ = (id) => document.getElementById(id);
  let state = null;
  function esc(value) { return String(value || '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function ts(value) { if (!value) return '-'; const d = new Date(value); return String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0')+':'+String(d.getSeconds()).padStart(2,'0'); }
  function dur(value) { const seconds = Math.max(0, Math.round(value / 1000)); if (seconds < 60) return seconds+'s'; const minutes = Math.floor(seconds / 60); return minutes+'m '+(seconds % 60)+'s'; }
  function task(task) { return '<div class="task"><div class="taskid">'+esc(task.id)+'</div><div class="tasktitle">'+esc(task.title || task.id)+'</div><div class="taskmeta">P'+esc(task.priority == null ? '-' : task.priority)+' · 第 '+esc(task.attempts || task.attempt || 1)+' 次'+(task.reason ? '<br>'+esc(task.reason) : '')+'</div></div>'; }
  function queue(id, count, tasks) { $(id+'count').textContent = tasks.length; $(id).innerHTML = tasks.length ? tasks.map(task).join('') : '<div class="empty">-</div>'; }
  function render() {
    if (!state) return;
    const cfg = state.config || {};
    $('meta').textContent = cfg.workdir || state.runDir || '等待运行...';
    $('source').textContent = cfg.source || '-';
    $('started').textContent = ts(state.startedAt);
    $('stopfile').textContent = state.stopFile || '-';
    $('stopsummary').textContent = state.stopFile || '-';
    $('rundir').textContent = state.runDir || '-';
    queue('ready', state.ready || []); queue('active', state.active || []); queue('finished', state.done || []); queue('failed', state.failed || []);
    const current = state.current;
    const last = current ? current.lastEventAt : state.lastEventAt;
    const age = last ? Date.now() - last : 0;
    $('lastupdate').textContent = last ? (age > 25000 ? dur(age)+' 前' : '刚刚') : '-';
    const badge = $('status');
    if (state.reason) { badge.textContent = '已结束 · '+state.reason; badge.className = 'badge done'; }
    else if (age > 25000) { badge.textContent = '无新事件'; badge.className = 'badge stale'; }
    else { badge.textContent = current ? '运行中' : '等待任务'; badge.className = 'badge'; }
    const dot = $('dot');
    dot.className = 'dot'+(current && age > 25000 ? ' stale' : '');
    if (!current) { $('stage').textContent = state.reason ? '本轮已结束' : '等待任务...'; $('taskname').textContent = '-'; $('stagehint').textContent = '-'; $('bar').style.width = '0%'; $('heartbeat').textContent = '0'; $('stagedur').textContent = '-'; $('attempt').textContent = '-'; }
    else {
      $('stage').textContent = current.stageLabel || current.stage || '准备中';
      $('taskname').textContent = (current.id || '-')+' · '+(current.title || current.id || '');
      $('stagehint').textContent = current.stage === 'reviewing' ? '执行已完成，正在审查' : current.stage === 'executing' ? '执行端正在工作' : '正在准备执行';
      $('bar').style.width = current.stage === 'reviewing' ? '65%' : current.stage === 'settled' ? '100%' : current.stage === 'executing' ? '30%' : '8%';
      $('heartbeat').textContent = current.heartbeats || 0;
      $('stagedur').textContent = current.stageSince ? dur(Date.now() - current.stageSince) : '-';
      $('attempt').textContent = current.attempt || 1;
    }
    $('report').innerHTML = state.reportFile ? '<a href="/report">'+esc(state.reportFile)+'</a>' : '运行结束后可查看 report.md。';
  }
  const stream = new EventSource('/events');
  stream.onmessage = (message) => { try { const payload = JSON.parse(message.data); if (payload.type === 'state') { state = payload.state; render(); } } catch (_) {} };
  stream.onerror = () => { const badge = $('status'); if (!state) { badge.textContent = '连接中断'; badge.className = 'badge stale'; } };
  setInterval(render, 1000);
})();
</script>
</body>
</html>
`.replace(/^\s+/gm, '')

function clientState(state) {
  const { events, ...rest } = state
  return rest
}

function main() {
  const runDir = resolve(process.argv[2] || process.cwd())
  const port = Number(process.argv[3]) || 8700
  const loopProgressFile = `${runDir}/loop-progress.jsonl`
  const clients = new Set()
  let previous = ''

  function readState() {
    const loopEvents = loadEvents(loopProgressFile)
    const initial = projectLoopState(loopEvents)
    const progressEvents = initial.current?.progressFile ? loadEvents(initial.current.progressFile) : []
    return projectLoopState(loopEvents, progressEvents)
  }

  function broadcast(force = false) {
    const payload = JSON.stringify({ type: 'state', state: clientState(readState()) })
    if (!force && payload === previous) return
    previous = payload
    for (const response of clients) {
      try { response.write(`data: ${payload}\n\n`) } catch { /* disconnected client */ }
    }
  }

  try {
    if (existsSync(runDir)) watch(runDir, { recursive: false }, () => broadcast())
  } catch {
    // 轮询保证 Windows 与网络目录也能刷新。
  }
  setInterval(() => broadcast(), 1000)

  const server = createServer((request, response) => {
    if (request.url === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(HTML)
      return
    }
    if (request.url === '/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' })
      response.write('retry: 2000\n\n')
      clients.add(response)
      broadcast(true)
      const keepalive = setInterval(() => {
        try { response.write(': keepalive\n\n') } catch { clearInterval(keepalive) }
      }, 15000)
      request.on('close', () => { clearInterval(keepalive); clients.delete(response) })
      return
    }
    if (request.url === '/report') {
      const reportFile = readState().reportFile
      if (reportFile && existsSync(reportFile)) {
        response.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' })
        response.end(readFileSync(reportFile, 'utf8'))
        return
      }
    }
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('not found')
  })
  server.listen(port, '127.0.0.1', () => console.error(`afk-run 实时看板: http://127.0.0.1:${port}/`))
  process.on('SIGINT', () => server.close(() => process.exit(0)))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
