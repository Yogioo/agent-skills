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
const DETAIL_EVENTS = 60
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
      // 默认 7 天窗口：历史都在账上，页面只发这段；`days=0` 或 `all=1` 才是全部。
      // `alive=1` 只看在跑的。两个都是筛选，不会删任何东西。
      const daysParam = url.searchParams.get('days')
      const days = daysParam == null ? 7 : Number(daysParam)
      const since = Number.isFinite(days) && days > 0 ? Date.now() - days * 24 * 60 * 60 * 1000 : 0
      const onlyAlive = url.searchParams.get('alive') === '1' || url.searchParams.get('alive') === 'true'
      const listed = listRuns({ since, includeFinished: !onlyAlive })
      send(res, 200, {
        runs: listed.runs.map(summarizeRun),
        finished: listed.finished,
        crashed: listed.crashed,
        malformed: listed.malformed,
        window: { days, since, onlyAlive },
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
      // 已结束的 run 的用时是定值：不能拿 now 去减 startedAt，否则历史越看越长。
      const endAt = Number(record.endedAt) || Date.now()
      send(res, 200, {
        run: summarizeRun({
          ...record,
          alive,
          crashed: !alive && !record.endedAt,
          elapsedMs: Number.isFinite(Number(record.elapsedMs))
            ? Number(record.elapsedMs)
            : Math.max(0, endAt - Number(record.startedAt || endAt)),
        }),
        events: tailEvents(record, DETAIL_EVENTS),
      })
      return
    }
    send(res, 404, { error: 'not-found', path })
  } catch (err) {
    send(res, 500, { error: err && err.message ? err.message : String(err) })
  }
}

/** 一条 run 摘要：给页面与 agent 同一份数据。`phase` 给机器看，`lastEvent` 给人看。 */
export function summarizeRun(run) {
  const progress = tailEvents(run, 1)[0] || null
  return {
    runId: run.runId,
    workdir: run.workdir,
    outDir: run.outDir,
    labels: run.labels || [],
    runner: run.runner,
    // 给每个臂的提示词：页面的“输入”区块优先用它。progress 的尾巴里不一定还有
    // arm_start（长跑早期那条早掉出窗口了），所以记录里必须自带一份。
    inputs: Array.isArray(run.inputs) && run.inputs.length ? run.inputs : null,
    alive: run.alive !== false,
    // 历史行的三种结尾：正常收尾（endedAt+outcome）、崩了（crashed）、还在跑。
    endedAt: run.endedAt || null,
    outcome: run.outcome || null,
    crashed: run.crashed === true,
    elapsedMs: run.elapsedMs,
    startedAt: run.startedAt,
    phase: progress ? progress.event : 'starting',
    phaseDetail: progress ? compact(progress) : null,
    // 原始记录：页面据此写「正在读 xxx.cs」。不在这里拼成人话，因为人话要按工具族
    // 分颜色/动词，那是排版的事；API 保持可机读。
    lastEvent: progress,
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
body{background:#0b0e14;color:#e6edf3;font:13px/1.55 ui-monospace,Consolas,monospace;margin:0;padding:24px}
h1{font-size:15px;margin:0 0 4px;letter-spacing:.02em}#meta{color:#8b949e;margin-bottom:16px;font-size:12px}
#warn{background:#3d2b00;color:#f0c674;padding:8px 12px;border-radius:6px;margin-bottom:16px;display:none}
#filters{display:flex;align-items:center;gap:8px;margin:0 0 12px;font-size:12px;color:#8b949e}
#filters button{background:#11161f;color:#8b949e;border:1px solid #21262d;border-radius:6px;padding:3px 10px;font:inherit;cursor:pointer}
#filters button:hover{border-color:#30363d;color:#c9d1d9}
#filters button.on{background:#1f6feb22;border-color:#1f6feb;color:#c9d1d9}
#filters label{display:flex;align-items:center;gap:5px;cursor:pointer;margin-left:4px}
#filters input{accent-color:#388bfd}
table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:8px 10px;border-top:1px solid #21262d;vertical-align:top}
th{color:#8b949e;font-weight:500;font-size:11px;text-transform:uppercase;letter-spacing:.06em}
tr.run{cursor:pointer}tr.run:hover{background:#11161f}tr.sel{background:#161d29;box-shadow:inset 2px 0 0 #388bfd}
.what{max-width:620px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ok{color:#3fb950}.bad{color:#f85149}.dim{color:#6e7681}.say{color:#8fb8d8}
.stale{opacity:.55}
#detail{margin-top:22px;border-top:1px solid #21262d;padding-top:14px}
#detail h2{font-size:13px;margin:0 0 2px}
#detail .sub{color:#8b949e;font-size:12px;margin:4px 0 14px}
#detail details.prompt{margin:0 0 14px;border:1px solid #21262d;border-radius:6px;padding:8px 12px;background:#0d1117}
#detail details.prompt summary{color:#8b949e;font-size:12px;cursor:pointer;outline:none}
#detail details.prompt pre{margin:8px 0 0;white-space:pre-wrap;word-break:break-word;color:#c9d1d9;font:12px/1.55 ui-monospace,Consolas,monospace;max-height:320px;overflow:auto}
.tlhead,.tl{display:grid;grid-template-columns:66px 58px minmax(0,1fr) 62px;gap:12px;align-items:baseline}
.tlhead{color:#6e7681;font-size:11px;text-transform:uppercase;letter-spacing:.06em;padding-bottom:6px}
.tl{padding:4px 0;border-top:1px solid #161b22}
.tl>span:nth-child(3){white-space:pre-wrap;word-break:break-word}
.tl.tool>span:nth-child(3){color:#c9d1d9}
.tl.say>span:nth-child(3){color:#8fb8d8;font-style:italic;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.tl.think>span:nth-child(3){color:#7d8590;font-style:italic;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.tl>span:last-child{text-align:right;color:#6e7681}
</style></head><body>
<h1>agent runs</h1><div id="meta">连接中…</div>
<div id="warn"></div>
<div id="filters">
  <button data-days="1">近 1 天</button>
  <button data-days="7" class="on">近 7 天</button>
  <button data-days="30">近 30 天</button>
  <button data-days="0">全部</button>
  <label><input type="checkbox" id="onlyAlive">只看运行中</label>
</div>
<table><thead><tr><th>项目</th><th>臂</th><th>正在做什么</th><th>用时</th><th>状态</th></tr></thead>
<tbody id="rows"></tbody></table>
<div id="detail"></div>
<script>
(function(){
  var rowsEl=document.getElementById('rows'),meta=document.getElementById('meta'),
      detail=document.getElementById('detail'),warn=document.getElementById('warn');
  var selected=null;
  // 筛选只决定“发哪些记录”，不决定“留哪些”：窗口外的历史仍在账上，切一下就回来。
  var view={days:7,onlyAlive:false};
  try{var saved=JSON.parse(localStorage.getItem('agent-runs-view')||'null');
    if(saved&&typeof saved.days==='number')view={days:saved.days,onlyAlive:!!saved.onlyAlive};}catch(e){}
  function saveView(){try{localStorage.setItem('agent-runs-view',JSON.stringify(view));}catch(e){}}
  function query(){var q='days='+view.days;if(view.onlyAlive)q+='&alive=1';return q;}

  // 输入块的展开状态：详情每 2 秒整体重建一次，<details> 会跟着被打回默认值，
  // 于是“刚点开的 brief 过一会儿自己收回去”。按 runId|臂 记住，刷新页面也还在。
  var openInputs={};
  try{openInputs=JSON.parse(localStorage.getItem('agent-runs-inputs')||'{}')||{};}catch(e){openInputs={};}
  function saveOpenInputs(){try{localStorage.setItem('agent-runs-inputs',JSON.stringify(openInputs));}catch(e){}}
  var lastDetailSig=null,lastDetailRun=null;

  function esc(t){var d=document.createElement('div');d.textContent=t==null?'':String(t);return d.innerHTML;}
  function dur(ms){var s=Math.max(0,Math.round((ms||0)/1000));var h=Math.floor(s/3600),m=Math.floor(s%3600/60);
    return h>0?h+'h'+m+'m':(m>0?m+'m'+(s%60)+'s':s+'s');}
  function clock(t){var d=new Date(t);function p(n){return (n<10?'0':'')+n;}
    return p(d.getHours())+':'+p(d.getMinutes())+':'+p(d.getSeconds());}
  function rel(t){if(!t)return'';var s=Math.round((Date.now()-t)/1000);
    return s<2?'刚刚':(s<60?s+' 秒前':dur(s*1000)+'前');}
  // 21.4 秒的构建别写成 21400ms。
  function msText(ms){return ms<1000?ms+'ms':(Math.round(ms/100)/10)+'s';}
  // 路径分隔符两种都要认，且不把反斜杠写进模板字符串（转义过了就成半个正则）。
  var BS=String.fromCharCode(92);
  function project(p){var s=String(p||''),parts=[],cur='';
    for(var i=0;i<s.length;i++){var c=s.charAt(i);
      if(c==='/'||c===BS){if(cur){parts.push(cur);cur='';}}else{cur+=c;}}
    if(cur)parts.push(cur);return parts.length?parts[parts.length-1]:s;}

  // 工具名 → 图标与动词。detail 已在记录端拼好，页面只管好看。
  var VERBS={read:['📖','读'],write:['📝','写'],edit:['✏️','改'],bash:['⚡','命令'],shell:['⚡','命令'],run:['⚡','命令'],
    grep:['🔍','搜'],glob:['🔍','搜'],search:['🔍','搜'],find:['🔍','找'],list:['📁','列目录'],ls:['📁','列目录'],
    web_search:['🌐','搜网'],web_fetch:['🌐','取网页'],fetch_content:['🌐','取网页'],todo:['☑','待办'],
    task:['🤖','子代理'],agent:['🤖','子代理'],ask_user:['❓','问人']};
  function verb(name){var key=String(name||'tool'),hit=VERBS[key.toLowerCase()];
    if(hit)return hit;
    if(key.indexOf('mcp__')===0)return ['🔌',key.slice(5).replace(/__/g,'：')];
    var pre=key.split('_')[0].toLowerCase();
    return VERBS[pre]||['⚙',key];}

  // 一条进度记录说成人话：工具调用写成「读 …/Foo.cs」，助手消息直接当旁白。
  function describe(e){
    if(!e)return {icon:'·',text:'等第一个事件',cls:'dim'};
    if(e.event==='tool'){var v=verb(e.name),rest=String(e.detail||'');
      return {icon:v[0],text:v[1]+(rest?' '+rest:''),ms:e.ms,cls:'tool'};}
    if(e.event==='say')return {icon:'💬',text:String(e.text||''),cls:'say'};
    if(e.event==='think')return {icon:'🧠',text:String(e.text||''),cls:'think'};
    if(e.event==='arm_start'){var bits=[e.runner,e.model,e.thinking].filter(Boolean).join(' · ');
      return {icon:'▶',text:'开跑'+(bits?'　'+bits:''),cls:'dim'};}
    if(e.event==='arm_end'){var text=e.status==='ok'?'完成':('结束（'+String(e.status||'?')+'）');
      if(e.reason)text+='：'+String(e.reason);
      if(e.tokens)text+='　'+e.tokens+' tok';
      return {icon:'■',text:text,cls:e.status==='ok'?'ok':'bad'};}
    return {icon:'·',text:String(e.event||''),cls:'dim'};}

  // pi 把 --prompt-file 展开成 file name 包装标签；文件名已在标题里，正文不必再看一遍。
  function promptText(inp){
    var t=String(inp.prompt||'');
    var m=t.match(/^<file name="[^"]*">\s*/);
    return m?t.slice(m[0].length):t;
  }

  function statusOf(r){
    if(r.alive)return '<span class="ok">运行中</span>';
    if(r.crashed)return '<span class="bad">中断</span>';
    if(r.outcome==='ok')return '<span class="ok">完成</span>';
    if(r.outcome==='failed'||r.outcome==='error')return '<span class="bad">失败</span>';
    return '<span class="dim">已结束</span>';
  }

  function row(r){
    var tr=document.createElement('tr');
    tr.className='run'+(r.alive?'':' stale')+(r.runId===selected?' sel':'');
    r._at=Date.now();
    var d=describe(r.lastEvent),label=r.labels&&r.labels.length?r.labels.join(','):'—';
    tr.innerHTML='<td>'+esc(project(r.workdir))+'</td><td>'+esc(label)+'</td>'+
      '<td><div class="what" title="'+esc(d.text)+'">'+d.icon+' '+esc(d.text)+
        (typeof d.ms==='number'?' <span class="dim">'+esc(msText(d.ms))+'</span>':'')+'</div>'+
        '<div class="dim" style="font-size:11px">'+esc(rel(r.lastEvent&&r.lastEvent.t||r.startedAt))+'</div></td>'+
      '<td class="el"></td>'+
      '<td>'+statusOf(r)+'</td>';
    tr.onclick=function(){open(r.runId);};
    tr._run=r;
    return tr;
  }

  // 用时每秒自走一格，不等下一次 poll。
  function paintElapsed(){
    var list=rowsEl.querySelectorAll('tr.run');
    for(var i=0;i<list.length;i++){var tr=list[i],r=tr._run,cell=tr.querySelector('td.el');
      if(!r||!cell)continue;
      cell.textContent=dur(r.elapsedMs+(r.alive?Date.now()-r._at:0));}
    if(lastDetailRun)setElapsedText(lastDetailRun);
  }

  function setElapsedText(run){
    var el=document.getElementById('d-elapsed');
    if(!el)return;
    el.textContent=(run.alive?'已跑 ':'用时 ')+dur(run.elapsedMs+(run.alive?Date.now()-run._at:0));
  }

  // 展开/折叠状态写回 localStorage：内联的状态一变就没了。
  function wirePromptToggles(){
    var list=detail.querySelectorAll('details.prompt');
    for(var i=0;i<list.length;i++){(function(el){
      el.addEventListener('toggle',function(){
        openInputs[el.getAttribute('data-key')]=el.open;
        saveOpenInputs();
      });
    })(list[i]);}
  }

  function open(id){selected=id;lastDetailSig=null;detail.textContent='读取中…';loadDetail();poll();}

  function loadDetail(){
    if(!selected)return;
    fetch('api/runs/'+encodeURIComponent(selected)).then(function(r){return r.json();}).then(function(d){
      if(d.error){detail.innerHTML='<h2>'+esc(selected)+'</h2><div class="bad">读不到：'+esc(d.error)+'</div>';return;}
      var run=d.run,evs=d.events||[],start=null,i;
      run._at=Date.now();
      lastDetailRun=run;
      for(i=0;i<evs.length;i++){if(evs[i].event==='arm_start'){start=evs[i];break;}}
      // 签名只看“结构”：有新事件/状态变了才重建 DOM。否则每 2 秒重建不仅会
      // 把 <details> 打回收起的默认值，也会把时间线里的滚动位置清掉。
      var sig=[run.runId,run.alive,run.endedAt||'',run.outcome||'',evs.length,
        evs.length?evs[evs.length-1].t:'',JSON.stringify(run.inputs||null)].join('|');
      if(sig===lastDetailSig){setElapsedText(run);return;}
      lastDetailSig=sig;
      var bits=[project(run.workdir)];
      if(start){if(start.runner)bits.push(start.runner);if(start.model)bits.push(start.model);
        if(start.thinking)bits.push('thinking '+start.thinking);}
      var html=['<h2>'+esc(run.labels&&run.labels.length?run.labels.join(','):run.runId)+'</h2>',
        '<div class="sub">'+esc(bits.join('  ·  '))+' · <span id="d-elapsed"></span></div>',
        '<div class="sub dim">'+esc(run.outDir)+'</div>'];
      // 输入：记录里带的优先（历史 run 也有，且不受 progress 尾巴窗口影响）；
      // 旧记录退回 arm_start。每个臂一块，多臂时标上臂名。
      var inputs=(run.inputs&&run.inputs.length)?run.inputs.slice():[];
      if(!inputs.length){
        for(i=0;i<evs.length;i++){var s0=evs[i];
          if(s0.event==='arm_start'&&(s0.prompt||s0.promptFile)){
            inputs.push({label:s0.arm,prompt:s0.prompt,promptChars:s0.promptChars,promptFile:s0.promptFile});}}
      }
      for(i=0;i<inputs.length;i++){var inp=inputs[i]||{};
        var parts=['输入'];
        if(inp.label&&inputs.length>1)parts.unshift(inp.label);
        if(inp.promptChars)parts.push(inp.promptChars+' 字');
        if(inp.promptFile)parts.push(project(inp.promptFile));
        // 展开状态按 runId|臂 记着；没记过时短文本默认展开、长 brief 默认收起。
        var key=run.runId+'|'+(inp.label||'input');
        var known=Object.prototype.hasOwnProperty.call(openInputs,key);
        var shouldOpen=known?!!openInputs[key]:!!(inp.promptChars&&inp.promptChars<=320);
        html.push('<details class="prompt" data-key="'+esc(key)+'"'+(shouldOpen?' open':'')+'>'+
          '<summary>'+esc(parts.join('  ·  '))+'</summary>'+
          '<pre>'+esc(promptText(inp)||'（没读到输入正文）')+'</pre></details>');
      }
      html.push('<div class="tlhead"><span>时间</span><span>起点+</span><span>动作</span><span>耗时</span></div>');
      for(i=0;i<evs.length;i++){var e=evs[i],x=describe(e);
        var base0=start&&start.at?start.at:run.startedAt;
        var off=base0?Math.max(0,e.t-base0):null;
        // title 里放全文：行内放不下时鼠标一悬就能看完整命令/路径。
        html.push('<div class="tl '+x.cls+'" title="'+esc(x.text)+'"><span class="dim">'+clock(e.t)+'</span>'+
          '<span class="dim">'+(off==null?'':(off<1000?off+'ms':dur(off)))+'</span>'+
          '<span>'+x.icon+' '+esc(x.text)+'</span>'+
          '<span>'+(typeof x.ms==='number'?esc(msText(x.ms)):'')+'</span></div>');}
      if(!evs.length)html.push('<div class="tl dim"><span></span><span></span><span>还没有进度记录</span><span></span></div>');
      detail.innerHTML=html.join('');
      wirePromptToggles();
      setElapsedText(run);
    }).catch(function(){detail.innerHTML='<div class="bad">读取失败，重试中…</div>';});
  }
  function poll(){
    fetch('api/runs?'+query()).then(function(r){return r.json();}).then(function(d){
      var runs=d.runs||[],i,aliveCount=0;
      rowsEl.innerHTML='';
      if(!runs.length){
        var empty=document.createElement('tr');
        empty.innerHTML='<td colspan="5" class="dim" style="padding:18px 10px">这个窗口里没有 run。'+
          (view.days>0?'试试「全部」或把筛选放宽。':(view.onlyAlive?'取消「只看运行中」。':''))+'</td>';
        rowsEl.appendChild(empty);
      }
      for(i=0;i<runs.length;i++){rowsEl.appendChild(row(runs[i]));if(runs[i].alive)aliveCount++;}
      var stillThere=selected&&runs.some(function(r){return r.runId===selected;});
      if(!stillThere)selected=runs.length?runs[0].runId:null;
      paintElapsed();
      var scope=view.days>0?('近 '+view.days+' 天'):'全部历史';
      meta.textContent=scope+' · '+runs.length+' 个 run'+(aliveCount?('（'+aliveCount+' 个运行中）'):'')+
        (d.malformed?(' · '+d.malformed+' 个记录损坏'):'')+' · 切筛选不删记录 · 每 2 秒刷新';
      if(d.board&&d.board.share){warn.style.display='block';
        warn.textContent='对外监听中（无鉴权，局域网内任何人可读）：'+d.board.share;}
      if(selected)loadDetail();else{detail.innerHTML='';lastDetailSig=null;lastDetailRun=null;}
    }).catch(function(){meta.textContent='连接断开，重试中…';});
  }

  function syncFilters(){
    var btns=document.querySelectorAll('#filters button');
    for(var i=0;i<btns.length;i++){
      btns[i].className=Number(btns[i].getAttribute('data-days'))===view.days?'on':'';}
  }
  (function wireFilters(){
    var btns=document.querySelectorAll('#filters button'),i;
    for(i=0;i<btns.length;i++){(function(btn){btn.onclick=function(){
      view.days=Number(btn.getAttribute('data-days'));saveView();syncFilters();selected=null;poll();};})(btns[i]);}
    var cb=document.getElementById('onlyAlive');
    cb.checked=view.onlyAlive;
    cb.onchange=function(){view.onlyAlive=cb.checked;saveView();selected=null;poll();};
    syncFilters();
  })();

  poll();setInterval(poll,2000);setInterval(paintElapsed,1000);
})();
</script></body></html>`
