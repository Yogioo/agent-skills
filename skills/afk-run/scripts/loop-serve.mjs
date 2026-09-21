#!/usr/bin/env node
/**
 * AFK loop 的只读实时看板。
 *
 * 用 loop-progress.jsonl 记录任务队列生命周期，并按当前任务关联的
 * exec-review progress.jsonl 聚合执行/审查阶段和心跳。服务为独立进程，
 * 所以 loop 结束后报告和历史结果仍可查看。
 */

import { createServer } from 'node:http'
import { existsSync, readFileSync, realpathSync, watch } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadEvents } from '../../exec-review/scripts/progress.mjs'
import { createProgressWatcher } from '../../exec-review/scripts/progress-http.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

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
  let pipeline = { ready: [], blocked: [], inProgress: [] }

  for (const event of loopEvents) {
    if (!event || !event.event) continue
    if (event.t) lastLoopEventAt = event.t
    if (event.event === 'loop_start') {
      config = { ...config, ...event }
      continue
    }
    if (event.event === 'pipeline_snapshot') {
      pipeline = {
        ready: Array.isArray(event.ready) ? event.ready : [],
        blocked: Array.isArray(event.blocked) ? event.blocked : [],
        inProgress: Array.isArray(event.inProgress) ? event.inProgress : [],
      }
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
        state: event.kind === 'done' ? 'done' : event.kind === 'noop' ? 'noop' : 'failed',
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
  const mergeById = (base = [], overlay = [], state) => {
    const merged = new Map()
    for (const item of base) {
      if (!item || !item.id) continue
      merged.set(item.id, { ...item, state })
    }
    for (const item of overlay) {
      if (!item || !item.id) continue
      merged.set(item.id, { ...merged.get(item.id), ...item, state })
    }
    return [...merged.values()].sort(
      (a, b) =>
        (a.priority ?? 2) - (b.priority ?? 2) || String(a.id).localeCompare(String(b.id)),
    )
  }
  /** 子 ticket 进行中时，隐藏 beads 里仍 claim 着的 parent 容器（如 2j9 vs 2j9.1） */
  const dropParentContainers = (tasks) => {
    const ids = new Set((tasks || []).map((task) => task.id))
    return (tasks || []).filter((task) => {
      for (const id of ids) {
        if (id !== task.id && String(id).startsWith(`${task.id}.`)) return false
      }
      return true
    })
  }
  const settledIds = new Set(
    list
      .filter((task) => task.state === 'done' || task.state === 'failed' || task.state === 'noop')
      .map((task) => task.id),
  )
  const inProgressIds = new Set(
    list.filter((task) => task.state === 'in_progress').map((task) => task.id),
  )
  const notSettled = (task) => task && !settledIds.has(task.id)
  const notClaimed = (task) => notSettled(task) && !inProgressIds.has(task.id)
  const ready = mergeById(pipeline.ready, list.filter((task) => task.state === 'ready'), 'ready')
    .filter(notClaimed)
    .map(withDetailUrl)
  const active = dropParentContainers(
    mergeById(
      pipeline.inProgress,
      list.filter((task) => task.state === 'in_progress'),
      'in_progress',
    ).filter(notSettled),
  ).map(withDetailUrl)
  const blocked = (pipeline.blocked || [])
    .filter(notClaimed)
    .map((task) => ({ ...task, state: 'blocked' }))
  const done = list.filter((task) => task.state === 'done').map(withDetailUrl)
  const noop = list.filter((task) => task.state === 'noop').map(withDetailUrl)
  const failed = list.filter((task) => task.state === 'failed').map(withDetailUrl)
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
    ? withDetailUrl({
        ...currentTask,
        stage,
        stageLabel: STAGE_NAMES[stage] || stage,
        stageSince,
        heartbeats,
        lastEventAt,
      })
    : null

  return {
    events: loopEvents,
    config,
    ready,
    active,
    blocked,
    done,
    noop,
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

export function taskDetailPath(taskId) {
  return `/task/${encodeURIComponent(String(taskId || ''))}`
}

function withDetailUrl(task) {
  if (!task || !task.id || !task.progressFile) return task
  return { ...task, detailUrl: taskDetailPath(task.id) }
}

export function findTaskRecord(state, taskId) {
  if (!state || !taskId) return null
  const buckets = [
    state.ready,
    state.active,
    state.done,
    state.noop,
    state.failed,
    state.current ? [state.current] : [],
  ]
  for (const bucket of buckets) {
    for (const task of bucket || []) {
      if (task && task.id === taskId && task.progressFile) return task
    }
  }
  return null
}

/** CLI：经典 `runDir [port]`，或 `--watch-registry` / `--watch-session` / `--port`。 */
export function parseServeArgs(argv = []) {
  const out = { runDir: '', port: 0, watchRegistry: '', watchSession: '' }
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--watch-registry') {
      out.watchRegistry = resolve(argv[++i] || '')
      continue
    }
    if (arg === '--watch-session') {
      out.watchSession = resolve(argv[++i] || '')
      continue
    }
    if (arg === '--port') {
      out.port = Number(argv[++i]) || 0
      continue
    }
    if (String(arg).startsWith('-')) continue
    positional.push(arg)
  }
  if (positional[0]) out.runDir = resolve(positional[0])
  if (positional[1] != null && !out.port) out.port = Number(positional[1]) || 0
  if (!out.port) out.port = out.watchRegistry ? 9700 : 8700
  if (!out.runDir && !out.watchRegistry) out.runDir = resolve(process.cwd())
  return out
}

function readJsonFile(path) {
  if (!path || !existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Watcher 侧 overlay：phase、pool、倒计时、最近事件。
 * 不查任务源；只读注册表 / pool.json / events.jsonl。
 */
export function projectWatchOverlay(registry, pool, events = [], now = Date.now()) {
  const phase = registry?.state || 'polling'
  const phaseStartedAt = registry?.phaseStartedAt || registry?.updatedAt || registry?.startedAt || 0
  const pollIntervalMs = Number(registry?.pollIntervalMs) > 0 ? Number(registry.pollIntervalMs) : 15000
  const lastPollAt = Number(pool?.updatedAt) || Number(registry?.lastPollAt) || 0
  const backoffWaitMs = Number(registry?.backoffWaitMs) || 0
  const nextPollAt =
    phase === 'backing-off'
      ? (phaseStartedAt || now) + backoffWaitMs
      : lastPollAt
        ? lastPollAt + pollIntervalMs
        : 0
  const recent = Array.isArray(events) ? events.slice(-40).reverse() : []
  return {
    phase,
    phaseStartedAt,
    phaseAgeMs: phaseStartedAt ? Math.max(0, now - phaseStartedAt) : 0,
    workdir: registry?.workdir || '',
    claimMode: registry?.claimMode || '',
    pid: registry?.pid || null,
    childPid: registry?.childPid || null,
    dashboardPid: registry?.dashboardPid || null,
    execRunDir: registry?.execRunDir || '',
    sessionDir: registry?.runDir || '',
    pollIntervalMs,
    lastPollAt,
    nextPollAt,
    backoffWaitMs,
    pool: {
      updatedAt: Number(pool?.updatedAt) || 0,
      ready: Array.isArray(pool?.ready) ? pool.ready : [],
      inProgress: Array.isArray(pool?.inProgress) ? pool.inProgress : [],
      blocked: Array.isArray(pool?.blocked) ? pool.blocked : [],
    },
    recentEvents: recent,
  }
}

function emptyLoopState() {
  return {
    events: [],
    config: {},
    ready: [],
    active: [],
    blocked: [],
    done: [],
    noop: [],
    failed: [],
    current: null,
    reason: '',
    reportFile: '',
    stopFile: '',
    runDir: '',
    startedAt: 0,
    lastEventAt: 0,
  }
}

function listenWithPortFallback(server, startPort, maxTries = 40) {
  let port = Math.max(1, Number(startPort) || 8700)
  const last = port + maxTries
  return new Promise((resolvePromise, reject) => {
    const tryListen = () => {
      const onError = (err) => {
        server.removeListener('listening', onListening)
        if (err?.code === 'EADDRINUSE' && port + 1 <= last) {
          port += 1
          try {
            server.close(() => setImmediate(tryListen))
          } catch {
            setImmediate(tryListen)
          }
          return
        }
        reject(err)
      }
      const onListening = () => {
        server.removeListener('error', onError)
        resolvePromise(port)
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, '127.0.0.1')
    }
    tryListen()
  })
}

const HTML = `
<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>afk · 实时看板</title>
<style>
  :root { --bg:#0c1016; --panel:#151b24; --line:#2a3442; --text:#e8edf3; --muted:#95a2b2; --dim:#687587; --blue:#5ca7f7; --green:#4bc47b; --amber:#d8a23a; --red:#e06767; --purple:#a78bfa; --mono:ui-monospace,SFMono-Regular,Consolas,monospace; }
  * { box-sizing:border-box; margin:0; }
  body { background:var(--bg); color:var(--text); font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif; padding:28px clamp(16px,4vw,64px) 60px; }
  .grip { color:var(--dim); font:11px var(--mono); letter-spacing:.12em; text-transform:uppercase; margin-bottom:12px; }
  h1 { font-size:25px; font-weight:650; }
  .sub { color:var(--muted); margin-top:5px; overflow-wrap:anywhere; }
  .badge { display:inline-block; margin-top:13px; border:1px solid var(--line); background:var(--panel); color:var(--blue); padding:5px 10px; border-radius:5px; font-weight:600; }
  .badge.done { color:var(--green); } .badge.stale { color:var(--amber); }
  .summary { display:flex; flex-wrap:wrap; gap:10px 22px; margin-top:18px; color:var(--muted); font-size:12px; }
  .summary span b { color:var(--text); font-family:var(--mono); font-weight:600; }
  .pipeline { display:flex; flex-wrap:wrap; gap:8px; margin-top:14px; }
  .pill { border:1px solid var(--line); background:var(--panel); border-radius:999px; padding:4px 12px; font-size:12px; color:var(--muted); }
  .pill b { font-family:var(--mono); color:var(--text); margin-left:4px; }
  .pill.active b { color:var(--blue); } .pill.ok b { color:var(--green); } .pill.bad b { color:var(--red); } .pill.warn b { color:var(--amber); }
  section { margin-top:20px; }
  h2 { color:var(--dim); font-size:12px; letter-spacing:.08em; text-transform:uppercase; margin-bottom:10px; }
  .watchgrid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:12px; }
  .watchcard { border:1px solid var(--line); background:var(--panel); padding:12px 14px; border-radius:6px; }
  .watchcard .label { color:var(--dim); font-size:11px; letter-spacing:.06em; text-transform:uppercase; }
  .watchcard .value { font:600 16px var(--mono); margin-top:6px; overflow-wrap:anywhere; }
  .watchcard .hint { color:var(--muted); font-size:12px; margin-top:4px; }
  .events { border:1px solid var(--line); background:var(--panel); border-radius:6px; padding:10px 14px; max-height:220px; overflow:auto; font:12px var(--mono); }
  .eventrow { border-top:1px solid var(--line); padding:6px 0; color:var(--muted); }
  .eventrow:first-child { border-top:0; padding-top:0; }
  .eventrow b { color:var(--text); }
  .hidden { display:none !important; }
  .queues { display:grid; grid-template-columns:repeat(6,minmax(0,1fr)); gap:12px; }
  .queue { min-height:138px; border:1px solid var(--line); background:var(--panel); padding:13px; border-radius:6px; }
  .queue h3 { color:var(--muted); font-size:12px; font-weight:600; margin-bottom:10px; }
  .count { font-family:var(--mono); color:var(--dim); float:right; }
  .task { border-top:1px solid var(--line); padding:9px 0; }
  .task:first-of-type { border-top:0; padding-top:0; }
  .taskid { color:var(--blue); font:12px var(--mono); }
  .tasktitle { overflow-wrap:anywhere; margin-top:2px; }
  .taskmeta { color:var(--muted); font-size:12px; margin-top:3px; overflow-wrap:anywhere; }
  .tasklink { display:block; color:inherit; text-decoration:none; border-radius:4px; padding:2px 4px; margin:0 -4px; }
  .tasklink:hover { background:#1a2230; }
  .tasklink .taskid { text-decoration:underline; text-underline-offset:2px; }
  .taskhint { color:var(--dim); font-size:11px; margin-top:2px; }
  .chip { display:inline-block; font-size:10px; font-weight:600; padding:1px 7px; border-radius:4px; margin-left:6px; vertical-align:middle; }
  .chip.run { color:var(--blue); background:#5ca7f722; }
  .chip.exec { color:var(--blue); background:#5ca7f722; }
  .chip.review { color:var(--purple); background:#a78bfa22; }
  .chip.ok { color:var(--green); background:#4bc47b22; }
  .chip.bad { color:var(--red); background:#e0676722; }
  .failed .taskid { color:var(--red); } .finished .taskid { color:var(--green); }
  .noopcol .taskid { color:var(--muted); }
  .blockedcol .taskid { color:var(--amber); }
  .empty { color:var(--dim); font-size:13px; }
  .current { border:1px solid var(--line); background:var(--panel); padding:18px; border-radius:6px; display:grid; grid-template-columns:minmax(220px,1fr) 210px; gap:24px; }
  .current.live { border-color:color-mix(in srgb,var(--blue) 45%,var(--line)); box-shadow:0 0 0 1px #5ca7f718; }
  .stage { display:flex; align-items:center; gap:9px; font-size:19px; font-weight:650; }
  .dot { width:10px; height:10px; border-radius:50%; background:var(--green); box-shadow:0 0 0 4px #4bc47b20; flex:none; }
  .dot.stale { background:var(--amber); box-shadow:0 0 0 4px #d8a23a20; }
  .dot.exec { background:var(--blue); box-shadow:0 0 0 4px #5ca7f720; }
  .dot.review { background:var(--purple); box-shadow:0 0 0 4px #a78bfa20; }
  .bartrack { height:8px; background:#0d1219; border:1px solid var(--line); margin-top:17px; overflow:hidden; border-radius:4px; }
  .bar { height:100%; width:0%; background:var(--blue); transition:width .3s; }
  .bar.review { background:var(--purple); }
  .stagehint { color:var(--muted); font-size:12px; margin-top:6px; }
  .stats { display:grid; gap:8px; align-content:center; }
  .stat { display:flex; justify-content:space-between; border-bottom:1px solid var(--line); padding:5px 0; color:var(--muted); font-size:12px; }
  .stat b { color:var(--text); font:600 13px var(--mono); }
  .footer { border-top:1px solid var(--line); color:var(--muted); margin-top:22px; padding-top:14px; font-size:12px; overflow-wrap:anywhere; }
  .footer a { color:var(--blue); }
  @media (max-width:1100px) { .queues { grid-template-columns:repeat(2,minmax(0,1fr)); } .current { grid-template-columns:1fr; } .watchgrid { grid-template-columns:repeat(2,minmax(0,1fr)); } }
  @media (max-width:560px) { .queues { grid-template-columns:1fr; } .watchgrid { grid-template-columns:1fr; } body { padding-top:18px; } }
</style>
</head>
<body>
  <div class="grip" id="grip">afk-run · 实时聚合进度</div>
  <h1 id="title">AFK 运行看板</h1>
  <div class="sub" id="meta">等待 loop 开始...</div>
  <div class="badge" id="status">连接中</div>
  <div class="pipeline" id="pipeline">
    <span class="pill">就绪<b id="pillready">0</b></span>
    <span class="pill active">进行中<b id="pillactive">0</b></span>
    <span class="pill warn">阻塞<b id="pillblocked">0</b></span>
    <span class="pill ok">完成<b id="pillfinished">0</b></span>
    <span class="pill warn">无需改动<b id="pillnoop">0</b></span>
    <span class="pill bad">失败<b id="pillfailed">0</b></span>
  </div>
  <div class="summary">
    <span>启动 <b id="started">-</b></span>
    <span>来源 <b id="source">-</b></span>
    <span>停止文件 <b id="stopsummary">-</b></span>
    <span>runDir <b id="rundir">-</b></span>
    <span>上次事件 <b id="lastupdate">-</b></span>
  </div>

  <section id="watchsection" class="hidden">
    <h2>Watcher</h2>
    <div class="watchgrid">
      <div class="watchcard"><div class="label">阶段</div><div class="value" id="watchphase">-</div><div class="hint" id="watchphaseage">-</div></div>
      <div class="watchcard"><div class="label">下次轮询</div><div class="value" id="watchnextpoll">-</div><div class="hint" id="watchlastpoll">-</div></div>
      <div class="watchcard"><div class="label">claim mode</div><div class="value" id="watchclaim">-</div><div class="hint" id="watchpids">-</div></div>
      <div class="watchcard"><div class="label">pool 快照</div><div class="value" id="watchpoolage">-</div><div class="hint" id="watchexec">-</div></div>
    </div>
    <div class="events" id="watchevents" style="margin-top:12px"></div>
  </section>

  <section>
    <h2 id="queueheading">任务队列</h2>
    <div class="queues">
      <div class="queue"><h3>就绪 <span class="count" id="readycount">0</span></h3><div id="ready"></div></div>
      <div class="queue"><h3>进行中 <span class="count" id="activecount">0</span></h3><div id="active"></div></div>
      <div class="queue blockedcol"><h3>阻塞 <span class="count" id="blockedcount">0</span></h3><div id="blocked"></div></div>
      <div class="queue finished"><h3>完成 <span class="count" id="finishedcount">0</span></h3><div id="finished"></div></div>
      <div class="queue noopcol"><h3>无需改动 <span class="count" id="noopcount">0</span></h3><div id="noop"></div></div>
      <div class="queue failed"><h3>失败 <span class="count" id="failedcount">0</span></h3><div id="failed"></div></div>
    </div>
  </section>

  <section>
    <h2>当前任务</h2>
    <div class="current" id="currentpanel">
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
        <div class="stat"><span>详情</span><b id="detailstat">-</b></div>
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
  function stageChip(task) {
    const stage = task && task.stage;
    if (stage === 'executing') return '<span class="chip exec">执行中</span>';
    if (stage === 'reviewing') return '<span class="chip review">审查中</span>';
    if (stage === 'settled') return '<span class="chip ok">已结束</span>';
    if (task && task.state === 'in_progress') return '<span class="chip run">进行中</span>';
    if (task && task.state === 'done') return '<span class="chip ok">'+(esc(task.status || 'done'))+'</span>';
    if (task && task.state === 'noop') return '<span class="chip exec">无需改动</span>';
    if (task && task.state === 'failed') return '<span class="chip bad">'+(esc(task.status || task.kind || 'failed'))+'</span>';
    return '';
  }
  function taskBody(task, extraMeta) {
    return '<div class="taskid">'+esc(task.id)+stageChip(task)+'</div><div class="tasktitle">'+esc(task.title || task.id)+'</div><div class="taskmeta">P'+esc(task.priority == null ? '-' : task.priority)+' · 第 '+esc(task.attempts || task.attempt || 1)+' 次'+(extraMeta || '')+(task.reason ? '<br>'+esc(task.reason) : '')+'</div>'+(task.detailUrl ? '<div class="taskhint">打开 exec-review 详情 →</div>' : '');
  }
  function task(taskItem) {
    const t = enrich(taskItem);
    const inner = taskBody(t);
    if (t.detailUrl) return '<a class="tasklink task" href="'+esc(t.detailUrl)+'" target="_blank" rel="noopener">'+inner+'</a>';
    return '<div class="task">'+inner+'</div>';
  }
  function enrich(task) {
    if (!task) return task;
    if (state && state.current && task.id === state.current.id) {
      return { ...task, stage: state.current.stage, stageLabel: state.current.stageLabel };
    }
    return task;
  }
  function blockedTask(task) {
    const t = enrich(task);
    const blockers = Array.isArray(t.blockedBy) && t.blockedBy.length
      ? '等待 '+t.blockedBy.map((id) => esc(id)).join(', ')
      : '等待依赖';
    return '<div class="task">'+taskBody(t, ' · '+blockers)+'</div>';
  }
  // 注意：只接收 (id, tasks)。曾误写成 (id, count, tasks) 却只传两参，导致 render 抛错、徽章一直停在「连接中」。
  function queue(id, tasks, renderTask) {
    const list = Array.isArray(tasks) ? tasks : [];
    const renderOne = renderTask || task;
    const countEl = $(id + 'count');
    const listEl = $(id);
    if (countEl) countEl.textContent = list.length;
    if (listEl) listEl.innerHTML = list.length ? list.map(renderOne).join('') : '<div class="empty">-</div>';
    const pill = $('pill' + id);
    if (pill) pill.textContent = list.length;
  }
  function render() {
    if (!state) return;
    const cfg = state.config || {};
    const watch = state.watch;
    if (watch) {
      $('grip').textContent = 'afk-watch · watcher 状态';
      $('title').textContent = 'AFK Watcher 看板';
      $('watchsection').classList.remove('hidden');
      $('watchphase').textContent = watch.phase || '-';
      $('watchphaseage').textContent = watch.phaseStartedAt ? ('已持续 '+dur(Date.now() - watch.phaseStartedAt)) : '-';
      const until = watch.nextPollAt ? Math.max(0, watch.nextPollAt - Date.now()) : 0;
      $('watchnextpoll').textContent = watch.phase === 'running' ? '批次进行中' : (watch.nextPollAt ? dur(until) : '-');
      $('watchlastpoll').textContent = watch.lastPollAt ? ('上次 '+ts(watch.lastPollAt)) : '尚无成功轮询';
      $('watchclaim').textContent = watch.claimMode || '-';
      $('watchpids').textContent = 'pid '+(watch.pid || '-')+' · child '+(watch.childPid || '-');
      $('watchpoolage').textContent = watch.pool && watch.pool.updatedAt ? ts(watch.pool.updatedAt) : '-';
      $('watchexec').textContent = watch.execRunDir ? ('exec '+String(watch.execRunDir).split(/[/\\\\]/).pop()) : '无执行批次';
      const events = Array.isArray(watch.recentEvents) ? watch.recentEvents : [];
      $('watchevents').innerHTML = events.length
        ? events.map((ev) => '<div class="eventrow"><b>'+esc(ev.event || '?')+'</b> · '+esc(ts(ev.t))+(ev.id ? ' · '+esc(ev.id) : '')+(ev.message ? ' · '+esc(ev.message) : '')+(ev.waitMs != null ? ' · '+esc(ev.waitMs)+'ms' : '')+(ev.code != null ? ' · code='+esc(ev.code) : '')+'</div>').join('')
        : '<div class="empty">暂无事件</div>';
      $('queueheading').textContent = (watch.phase === 'running' && state.runDir) ? '当前 Execution run 队列' : 'Work-item pool';
    } else {
      $('watchsection').classList.add('hidden');
    }
    $('meta').textContent = (watch && watch.workdir ? watch.workdir : (cfg.workdir || state.runDir || '等待运行...')) +
      (state.runDir ? ' · run ' + String(state.runDir).split(/[/\\\\]/).pop() : '');
    $('source').textContent = cfg.source || '-';
    $('started').textContent = ts(state.startedAt || (watch && watch.phaseStartedAt));
    $('stopfile').textContent = state.stopFile || '-';
    $('stopsummary').textContent = state.stopFile || '-';
    $('rundir').textContent = state.runDir || (watch && watch.execRunDir) || '-';
    queue('ready', state.ready || []); queue('active', state.active || []); queue('blocked', state.blocked || [], blockedTask); queue('finished', state.done || []); queue('noop', state.noop || []); queue('failed', state.failed || []);
    const current = state.current;
    const last = current ? current.lastEventAt : state.lastEventAt;
    const age = last ? Date.now() - last : 0;
    $('lastupdate').textContent = last ? (age > 25000 ? dur(age)+' 前' : '刚刚') : '-';
    const badge = $('status');
    if (watch && watch.phase) {
      badge.textContent = watch.phase;
      badge.className = 'badge'+(watch.phase === 'backing-off' || watch.phase === 'stopping' ? ' stale' : watch.phase === 'stopped' ? ' done' : '');
    } else if (state.reason) { badge.textContent = '已结束 · '+state.reason; badge.className = 'badge done'; }
    else if (age > 25000) { badge.textContent = '无新事件'; badge.className = 'badge stale'; }
    else { badge.textContent = current ? '运行中' : '等待任务'; badge.className = 'badge'; }
    const panel = $('currentpanel');
    panel.className = 'current'+(current && !state.reason ? ' live' : '');
    const dot = $('dot');
    const bar = $('bar');
    if (!current) {
      dot.className = 'dot'+(age > 25000 ? ' stale' : '');
      $('stage').textContent = state.reason ? '本轮已结束' : (watch && watch.phase !== 'running' ? '无执行批次' : '等待任务...');
      $('taskname').textContent = '-';
      $('stagehint').textContent = state.reason ? ('停止原因：'+state.reason) : '-';
      bar.style.width = '0%';
      bar.className = 'bar';
      $('heartbeat').textContent = '0';
      $('stagedur').textContent = '-';
      $('attempt').textContent = '-';
      $('detailstat').textContent = '-';
    } else {
      const stage = current.stage || '';
      dot.className = 'dot'+(age > 25000 ? ' stale' : stage === 'reviewing' ? ' review' : stage === 'executing' ? ' exec' : '');
      $('stage').textContent = current.stageLabel || current.stage || '准备中';
      const detail = current.detailUrl ? '<a href="'+esc(current.detailUrl)+'" target="_blank" rel="noopener">'+esc(current.id || '-')+'</a>' : esc(current.id || '-');
      $('taskname').innerHTML = detail+' · '+esc(current.title || current.id || '')+(current.detailUrl ? ' · <a href="'+esc(current.detailUrl)+'" target="_blank" rel="noopener">打开详情</a>' : '');
      $('stagehint').textContent = current.stage === 'reviewing' ? '执行已完成，正在审查' : current.stage === 'executing' ? '执行端正在工作' : current.stage === 'settled' ? '本任务已定案' : '正在准备执行';
      bar.style.width = current.stage === 'reviewing' ? '65%' : current.stage === 'settled' ? '100%' : current.stage === 'executing' ? '30%' : '8%';
      bar.className = 'bar'+(current.stage === 'reviewing' ? ' review' : '');
      $('heartbeat').textContent = current.heartbeats || 0;
      $('stagedur').textContent = current.stageSince ? dur(Date.now() - current.stageSince) : '-';
      $('attempt').textContent = current.attempt || 1;
      $('detailstat').innerHTML = current.detailUrl ? '<a href="'+esc(current.detailUrl)+'" target="_blank" rel="noopener">打开</a>' : '-';
    }
    $('report').innerHTML = state.reportFile ? '<a href="/report">'+esc(state.reportFile)+'</a>' : '运行结束后可查看 report.md。';
  }
  const stream = new EventSource('/events');
  stream.onmessage = (message) => { try { const payload = JSON.parse(message.data); if (payload.type === 'state') { state = payload.state; render(); } } catch (err) { console.error('afk-run render failed', err); } };
  stream.onerror = () => { const badge = $('status'); if (!state) { badge.textContent = '连接中断'; badge.className = 'badge stale'; } };
  setInterval(() => { try { render(); } catch (err) { console.error('afk-run render tick failed', err); } }, 1000);
})();
</script>
</body>
</html>
`.replace(/^\s+/gm, '')

function clientState(state) {
  const { events, ...rest } = state
  return rest
}

function parseTaskRoute(url) {
  const pathname = (url || '/').split('?')[0]
  const match = pathname.match(/^\/task\/([^/]+)(\/events)?\/?$/)
  if (!match) return null
  return {
    taskId: decodeURIComponent(match[1]),
    events: Boolean(match[2]),
  }
}

function main() {
  const args = parseServeArgs(process.argv.slice(2))
  const fixedRunDir = args.runDir || ''
  const watchRegistryPath = args.watchRegistry || ''
  const watchSessionDir = args.watchSession || ''
  const watchMode = Boolean(watchRegistryPath || watchSessionDir)
  const clients = new Set()
  let previous = ''
  let watchedExecDir = ''
  const progressWatchers = new Map()
  const dirWatchers = new Map()

  function getProgressWatcher(progressFile) {
    if (!progressWatchers.has(progressFile)) {
      progressWatchers.set(progressFile, createProgressWatcher(progressFile))
    }
    return progressWatchers.get(progressFile)
  }

  function ensureDirWatch(dir) {
    if (!dir || dirWatchers.has(dir) || !existsSync(dir)) return
    try {
      const handle = watch(dir, { recursive: false }, () => broadcast())
      dirWatchers.set(dir, handle)
    } catch {
      // 轮询兜底。
    }
  }

  function readLoopFrom(runDir) {
    if (!runDir) return emptyLoopState()
    const loopProgressFile = join(runDir, 'loop-progress.jsonl')
    if (!existsSync(loopProgressFile)) return { ...emptyLoopState(), runDir }
    const loopEvents = loadEvents(loopProgressFile)
    const initial = projectLoopState(loopEvents)
    const progressEvents = initial.current?.progressFile ? loadEvents(initial.current.progressFile) : []
    const state = projectLoopState(loopEvents, progressEvents)
    return { ...state, runDir: state.runDir || runDir }
  }

  function readState() {
    const now = Date.now()
    let watch = null
    if (watchMode) {
      const registry = readJsonFile(watchRegistryPath)
      const pool = readJsonFile(watchSessionDir ? join(watchSessionDir, 'pool.json') : '')
      const events = watchSessionDir ? loadEvents(join(watchSessionDir, 'events.jsonl')) : []
      watch = projectWatchOverlay(registry, pool, events, now)
      ensureDirWatch(watchSessionDir)
      if (watchRegistryPath) ensureDirWatch(dirname(watchRegistryPath))
    }

    const execRunDir = (watch && watch.execRunDir) || fixedRunDir || ''
    if (execRunDir && execRunDir !== watchedExecDir) {
      watchedExecDir = execRunDir
      ensureDirWatch(execRunDir)
    }

    let loop = readLoopFrom(execRunDir)
    const usePool =
      watch &&
      watch.phase !== 'running' &&
      Array.isArray(watch.pool?.ready)
    if (usePool) {
      loop = {
        ...loop,
        ready: (watch.pool.ready || []).map((task) => ({ ...task, state: 'ready' })),
        active: (watch.pool.inProgress || []).map((task) => ({ ...task, state: 'in_progress' })),
        blocked: (watch.pool.blocked || []).map((task) => ({ ...task, state: 'blocked' })),
        done: loop.done || [],
        noop: loop.noop || [],
        failed: loop.failed || [],
        current: null,
        reason: '',
      }
    }

    return { ...loop, watch }
  }

  function broadcast(force = false) {
    const payload = JSON.stringify({ type: 'state', state: clientState(readState()) })
    if (!force && payload === previous) return
    previous = payload
    for (const response of clients) {
      try { response.write(`data: ${payload}\n\n`) } catch { /* disconnected client */ }
    }
  }

  if (fixedRunDir) ensureDirWatch(fixedRunDir)
  if (watchSessionDir) ensureDirWatch(watchSessionDir)
  setInterval(() => broadcast(), 1000)

  const server = createServer((request, response) => {
    const route = parseTaskRoute(request.url)
    if (route) {
      const state = readState()
      const task = findTaskRecord(state, route.taskId)
      if (!task?.progressFile) {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        response.end('task progress not found')
        return
      }
      const basePath = taskDetailPath(route.taskId)
      const handled = getProgressWatcher(task.progressFile).handleRequest(
        (request.url || '/').split('?')[0],
        request,
        response,
        { basePath, backLink: '/' },
      )
      if (handled) return
    }
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

  listenWithPortFallback(server, args.port)
    .then((port) => {
      const label = watchMode ? 'afk-watch' : 'afk-run'
      console.error(`${label} 实时看板: http://127.0.0.1:${port}/`)
    })
    .catch((err) => {
      console.error(err.stack || err.message || String(err))
      process.exit(1)
    })

  process.on('SIGINT', () => {
    for (const watcher of progressWatchers.values()) watcher.close()
    for (const handle of dirWatchers.values()) {
      try { handle.close() } catch { /* ignore */ }
    }
    server.close(() => process.exit(0))
  })
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  main()
}
