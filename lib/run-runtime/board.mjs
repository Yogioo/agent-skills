/**
 * 只读看板：一台机器一个常驻进程，把 `<AFK home>/runs/` 里所有 run 摊开成一页。
 *
 * 为什么是「一个常驻页」而不是「每个 run 一个页面」：地址要能贴进 TAPD 评论、能被
 * 局域网里别人点开，所以它必须稳定、且不随 run 生灭。端口因此写进 state.json 并
 * 粘住；启动失败时顺延，但一旦定下来就复用，免得已经发出去的链接失效。
 *
 * 边界（与 afk-watch 总览页同一套规矩）：
 *   - 只读：没有任何能改变 run 的端点
 *   - 不读 config.json：凭据不会流进浏览器
 *   - 默认只听 loopback，`--host 0.0.0.0` 才出网，且页面顶部明示「无鉴权」
 *   - 拿不到的、坏掉的文件都降级成一条提示，不让整页 500
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { networkInterfaces } from 'node:os'
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afkHomeRoot, isRunAlive, listRuns, readRun } from './run-registry.mjs'
import { readEvents } from './progress.mjs'

/** 默认端口取一个不常撞的值；被占就顺延，实际值记在 state.json 里。 */
export const DEFAULT_BOARD_PORT = 7717
const PORT_TRIES = 10
const DETAIL_EVENTS = 40
const HEALTH_TIMEOUT_MS = 4000

export function boardDir() {
  return join(afkHomeRoot(), 'board')
}

export function boardStateFile() {
  return join(boardDir(), 'state.json')
}

/** 启动日志落在 board 目录里，起不来时 `--status` 会把尾巴带出来。 */
export function boardLogFile() {
  return join(boardDir(), 'board.log')
}

export function readBoardState() {
  const file = boardStateFile()
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function writeBoardState(state) {
  mkdirSync(boardDir(), { recursive: true })
  const file = boardStateFile()
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(state)}\n`, 'utf8')
  renameSync(tmp, file)
}

/**
 * 局域网地址排序：虚拟网卡（WSL/Hyper-V/Tailscale/隧道）不能拿去发给别人，
 * 实测本机会把 `172.19.0.1`（SmartRouteTun）排在真实网卡前面，所以按名字和
 * 网段打分：192.168 > 10 > 172.16-31 > 其他，169.254 链路本地和虚拟名扣到底。
 */
const VIRTUAL_NAME = /(vethernet|wsl|virtual|vmware|vbox|hyper-?v|tailscale|zerotier|docker|loopback|\btun\b|\btap\b)/i

function scoreInterface(name, address) {
  if (address.startsWith('169.254.')) return -100
  let score = 0
  if (VIRTUAL_NAME.test(String(name))) score -= 50
  if (address.startsWith('192.168.')) score += 30
  else if (address.startsWith('10.')) score += 20
  else if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) score += 5
  return score
}

/** 全部候选局域网地址，已排序；`share` 取第一个。 */
export function lanCandidates() {
  const found = []
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family !== 'IPv4' || entry.internal) continue
      found.push({ name, address: entry.address, score: scoreInterface(name, entry.address) })
    }
  }
  return found.sort((a, b) => b.score - a.score)
}

/** 局域网地址：真实网卡优先，取不到返回 null。 */
export function lanAddress() {
  return lanCandidates()[0]?.address || null
}

/** 给人用的地址：监听在通配地址时优先给局域网 IP，否则 loopback。 */
export function boardUrls(port, host = '127.0.0.1') {
  const wildcard = host === '0.0.0.0' || host === '::'
  const candidates = wildcard ? lanCandidates() : []
  const lan = candidates[0]?.address || null
  const share = lan ? `http://${lan}:${port}/` : null
  return {
    local: `http://127.0.0.1:${port}/`,
    share,
    shareCandidates: candidates.map((entry) => `http://${entry.address}:${port}/`),
    lanBound: wildcard && Boolean(lan),
  }
}

/**
 * 起服务（阻塞，直到 close）。端口按「上次用的 → 默认 → 顺延 → 随机」的顺序挑。
 * @param {{port?:number, host?:string, preferred?:number}} opts
 */
export async function startBoardServer(opts = {}) {
  const host = opts.host || '127.0.0.1'
  const preferred = Number(opts.preferred || opts.port || DEFAULT_BOARD_PORT)
  const candidates = [preferred]
  for (let i = 1; i < PORT_TRIES; i++) candidates.push(preferred + i)
  candidates.push(0)

  let lastError = null
  for (const port of candidates) {
    try {
      return await listenOn(port, host)
    } catch (err) {
      lastError = err
    }
  }
  throw lastError || new Error('board 无法监听任何端口')
}

function listenOn(port, host) {
  const server = createServer(handleRequest)
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      const actual = server.address()
      const urls = boardUrls(actual.port, host)
      const state = {
        pid: process.pid,
        port: actual.port,
        host,
        ...urls,
        startedAt: Date.now(),
      }
      try {
        writeBoardState(state)
      } catch {
        /* 状态文件写不了也要把页面跑起来 */
      }
      resolvePromise({
        ...state,
        server,
        close: () =>
          new Promise((done) => {
            server.close(() => done())
            server.closeAllConnections?.()
          }),
      })
    })
  })
}

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' })
  res.end(typeof body === 'string' ? body : JSON.stringify(body))
}

function handleRequest(req, res) {
  const url = new URL(req.url || '/', 'http://127.0.0.1')
  const path = url.pathname
  try {
    if (path === '/healthz') {
      send(res, 200, { ok: true, pid: process.pid, port: readBoardState()?.port })
      return
    }
    if (path === '/') {
      send(res, 200, PAGE, 'text/html; charset=utf-8')
      return
    }
    if (path === '/api/runs') {
      const state = readBoardState()
      const listed = listRuns()
      send(res, 200, {
        runs: listed.runs.map(summarizeRun),
        stale: listed.stale,
        malformed: listed.malformed,
        board: state ? { port: state.port, host: state.host, share: state.share, shareCandidates: state.shareCandidates } : null,
        now: Date.now(),
      })
      return
    }
    const detail = path.match(/^\/api\/runs\/([^/]+)$/)
    if (detail) {
      const runId = decodeURIComponent(detail[1])
      const { record, error } = readRun(runId)
      if (!record) {
        send(res, 404, { error: error || 'not-found', runId })
        return
      }
      // 活着的判定必须和列表同源，不能这里一律当真。
      const alive = isRunAlive(record)
      send(res, 200, {
        run: summarizeRun({ ...record, alive, elapsedMs: Math.max(0, Date.now() - Number(record.startedAt || Date.now())) }),
        events: tailEvents(record, DETAIL_EVENTS),
      })
      return
    }
    send(res, 404, { error: 'not-found', path })
  } catch (err) {
    send(res, 500, { error: err && err.message ? err.message : String(err) })
  }
}

/** 一条 run 摘要：只给能回答「跑到哪、多久、成没成」的字段。 */
export function summarizeRun(run) {
  const progress = tailEvents(run, 1)[0] || null
  return {
    runId: run.runId,
    workdir: run.workdir,
    outDir: run.outDir,
    labels: run.labels || [],
    runner: run.runner,
    alive: run.alive !== false,
    elapsedMs: run.elapsedMs,
    startedAt: run.startedAt,
    phase: progress ? progress.event : 'starting',
    phaseDetail: progress ? compact(progress) : null,
  }
}

/** 只取进度文件尾巴，且有上限 —— 一个臂能写几十万字节，整份读进来没意义。 */
function tailEvents(run, limit) {
  const file = run.progressFile
  if (!file || !existsSync(file)) return []
  try {
    const { events, malformed } = readEvents(file, {})
    const out = events.slice(-limit)
    if (malformed.length > 0) out.push({ t: Date.now(), level: 0, event: 'malformed_lines', count: malformed.length })
    return out
  } catch {
    return []
  }
}

function compact(record) {
  const { t, level, event, ...rest } = record
  const text = Object.entries(rest)
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(' ')
  return text.length > 160 ? `${text.slice(0, 160)}…` : text
}

/**
 * 确保 board 在跑：活着的直接复用，没有就 detached 起一个并等它健康。
 * **永不抛**：观察端不许拖垮执行，失败就返回 `{ok:false, error}`。
 * @param {{host?:string, now?:number}} [opts]
 */
export async function ensureBoard(opts = {}) {
  const host = opts.host || process.env.AGENT_TOOLS_BOARD_HOST || '0.0.0.0'
  const healthy = await currentBoard()
  if (healthy.ok) return healthled(healthy)

  const preferred = Number(readBoardState()?.port || DEFAULT_BOARD_PORT)
  const child = spawn(
    process.execPath,
    [join(dirname(fileURLToPath(import.meta.url)), 'board-daemon.mjs'), '--host', host, '--port', String(preferred)],
    {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
      env: { ...process.env, AFK_HOME: afkHomeRoot() },
    },
  )
  child.unref()

  const deadline = Date.now() + HEALTH_TIMEOUT_MS
  while (Date.now() < deadline) {
    await sleep(150)
    const check = await currentBoard()
    if (check.ok) return healthled(check)
  }
  return { ok: false, error: 'board 未在超时内就绪', url: null, local: null, share: null, host }
}

function healthled(state) {
  const urls = boardUrls(state.port, state.host)
  return { ok: true, pid: state.pid, port: state.port, host: state.host, url: urls.share || urls.local, ...urls }
}

/** 当前 board 是否健康；只读 state.json 并打一次 /healthz。 */
export async function currentBoard() {
  const state = readBoardState()
  if (!state || !state.port) return { ok: false, error: 'not-running' }
  try {
    const res = await fetch(`http://127.0.0.1:${state.port}/healthz`, { signal: AbortSignal.timeout(1200) })
    if (!res.ok) return { ok: false, error: `healthz ${res.status}`, ...state }
    return { ok: true, ...state }
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err), ...state }
  }
}

export function stopBoard() {
  const state = readBoardState()
  if (!state || !state.pid) return { stopped: false, reason: 'not-running' }
  try {
    process.kill(state.pid, 'SIGTERM')
  } catch { /* 已经没了 */ }
  try {
    writeFileSync(`${boardStateFile()}.stopped`, String(Date.now()), 'utf8')
  } catch { /* 无所谓 */ }
  return { stopped: true, pid: state.pid }
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms))
}

const PAGE = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>agent runs</title>
<style>
body{background:#0b0e14;color:#e6edf3;font:14px/1.5 ui-monospace,Consolas,monospace;margin:0;padding:24px}
h1{font-size:16px;margin:0 0 4px}#meta{color:#8b949e;margin-bottom:16px}
#warn{background:#3d2b00;color:#f0c674;padding:8px 12px;border-radius:6px;margin-bottom:16px;display:none}
table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:8px 10px;border-top:1px solid #21262d;vertical-align:top}
th{color:#8b949e;font-weight:500;font-size:12px;text-transform:uppercase}
tr.run{cursor:pointer}tr.run:hover{background:#11161f}
.ok{color:#3fb950}.bad{color:#f85149}.dim{color:#6e7681}
.stale{opacity:.55}
#detail{margin-top:20px;border-top:1px solid #21262d;padding-top:12px;white-space:pre-wrap}
#detail h2{font-size:14px;margin:0 0 8px}
</style></head><body>
<h1>agent runs</h1><div id="meta">连接中…</div>
<div id="warn"></div>
<table><thead><tr><th>项目</th><th>臂</th><th>阶段</th><th>用时</th><th>状态</th></tr></thead>
<tbody id="rows"></tbody></table>
<div id="detail"></div>
<script>
(function(){
  var rows=document.getElementById('rows'),meta=document.getElementById('meta'),
      detail=document.getElementById('detail'),warn=document.getElementById('warn');
  function dur(ms){var s=Math.floor(ms/1000);var m=Math.floor(s/60);
    return m>0?m+'m'+(s%60)+'s':s+'s';}
  function project(p){var parts=String(p||'').split(/[\\\\/]/);return parts[parts.length-1]||p;}
  function esc(t){var d=document.createElement('div');d.textContent=t==null?'':String(t);return d.innerHTML;}
  function row(r){
    var tr=document.createElement('tr');tr.className='run'+(r.alive?'':' stale');
    tr.innerHTML='<td>'+esc(project(r.workdir))+'</td>'+
      '<td>'+(r.labels.length?esc(r.labels.join(',')):'<span class=dim>—</span>')+'</td>'+
      '<td>'+esc(r.phase)+(r.phaseDetail?'<div class="dim">'+esc(r.phaseDetail)+'</div>':'')+'</td>'+
      '<td>'+esc(dur(r.elapsedMs||0))+'</td>'+
      '<td>'+(r.alive?'<span class=ok>running</span>':'<span class=bad>stale</span>')+'</td>';
    tr.onclick=function(){open(r.runId);};
    return tr;
  }
  function open(id){
    fetch('api/runs/'+encodeURIComponent(id)).then(function(r){return r.json();}).then(function(d){
      if(d.error){detail.textContent='读不到：'+d.error;return;}
      var lines=(d.events||[]).map(function(e){
        var rest=JSON.stringify(e).slice(0,240);
        return e.event+'  '+rest;});
      detail.innerHTML='<h2>'+esc(d.run.runId)+'</h2><div class="dim">'+esc(d.run.outDir)+'</div>'+
        '<div>'+esc(lines.join('\\n'))+'</div>';
    });
  }
  function poll(){
    fetch('api/runs').then(function(r){return r.json();}).then(function(d){
      rows.innerHTML='';
      (d.runs||[]).forEach(function(r){rows.appendChild(row(r));});
      meta.textContent=(d.runs||[]).length+' 个 run'+(d.stale?('，'+d.stale+' 个陈旧'):'')+
        (d.malformed?('，'+d.malformed+' 个记录损坏'):'')+' · 每 2 秒刷新';
      if(d.board&&d.board.share){warn.style.display='block';
        warn.textContent='对外监听中（无鉴权，局域网内任何人可读）：'+d.board.share;}
    }).catch(function(){meta.textContent='连接断开，重试中…';});
  }
  poll();setInterval(poll,2000);
})();
</script></body></html>`
