/**
 * tapd-loop 看板。两种用法：
 *
 *   - 只读：把 ~/.tapd-loop/runs 里每个 run 摊开（原样保留，深链和弹窗都在）
 *   - 操作：顶上的控制面板能选仓库、按一下接单开跑、按一下停、开定时接单
 *
 * 出网（`--host 0.0.0.0`，默认）时 `/api/*` 一律要密钥：这个页面能让人替你在共享
 * 分支上提交代码，不能跟只读看板一个待遇。密钥在 `~/.tapd-loop/board-key`，只从
 * 打出来的那个带 `?k=` 的链接进来一次，之后存在浏览器里。
 *
 * 绑回 loopback（`--host 127.0.0.1`）就不需要密钥，本机自己用。
 */

import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir, networkInterfaces } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readAsset, sharedAsset } from '../../../lib/web-ui/assets.mjs'
import { createControl, ensureKey, isLoopbackHost, sameKey } from './control.mjs'
import { listRuns, readArm, readCard, readFileInfo } from './read-run.mjs'
import { pageHtml } from './page.mjs'

const args = process.argv.slice(2)
const HERE = dirname(fileURLToPath(import.meta.url))
const HOME = argValue('--home') || join(homedir(), '.tapd-loop')
const ROOT = argValue('--root') || join(HOME, 'runs')
const HOST = argValue('--host') || process.env.TAPD_LOOP_BOARD_HOST || '0.0.0.0'
const PORT = Number(argValue('--port') || 7317)
const AUTH_REQUIRED = !isLoopbackHost(HOST) && !args.includes('--no-auth')
const KEY = ensureKey(HOME)
const LOOP = argValue('--loop-script') || join(HERE, 'loop.mjs')
const control = createControl({ home: HOME, runsRoot: ROOT, loopScript: LOOP })

/**
 * 局域网地址排序：虚拟网卡（WSL/Hyper-V/Tailscale/隧道）不能拿去发给别人。
 * 跟 agent runs 看板同一套打分：192.168 > 10 > 172.16-31，虚拟名和链路本地扣到底。
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

function lanCandidates() {
  const found = []
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family !== 'IPv4' || entry.internal) continue
      found.push({ name, address: entry.address, score: scoreInterface(name, entry.address) })
    }
  }
  return found.sort((a, b) => b.score - a.score)
}

const wildcard = HOST === '0.0.0.0' || HOST === '::'
const lan = wildcard ? lanCandidates()[0]?.address || '' : ''
const LOCAL_URL = `http://127.0.0.1:${PORT}/`
const SHARE_URL = lan ? `http://${lan}:${PORT}/` : ''
const KEY_QUERY = AUTH_REQUIRED ? `?k=${encodeURIComponent(KEY)}` : ''
/** 给人用的主链接：出网就给局域网地址，本机就给 loopback。 */
const PRIMARY_URL = `${SHARE_URL || LOCAL_URL}${KEY_QUERY}`

const server = createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1')
  handle(req, res, url).catch((err) => {
    sendJson(res, 500, { ok: false, error: String(err?.message || err) })
  })
})

async function handle(req, res, url) {
  const path = url.pathname
  // 页面和静态资源不设防（里面没有数据）；数据与操作一律过钥匙。
  if (path === '/healthz') {
    // 不带密钥：start-board / 扩展只靠它探活。回的只有「我是谁、在哪、要不要密钥」。
    sendJson(res, 200, {
      ok: true, app: 'tapd-loop', pid: process.pid, port: PORT,
      host: HOST, local: LOCAL_URL, share: SHARE_URL, authRequired: AUTH_REQUIRED,
    })
    return
  }
  if (path === '/favicon.ico') {
    res.writeHead(204)
    res.end()
    return
  }
  if (path === '/' || path === '/index.html') return send(res, 200, pageHtml(), 'text/html; charset=utf-8')

  const asset = path.startsWith('/assets/') ? sharedAsset(path.slice('/assets/'.length)) : null
  if (asset) return sendAsset(res, asset)
  // 页面模块的名字和对外的路由名不一样（app.js 就是 page-app.js），所以这里查表。
  const own = { '/app.js': 'page-app.js', '/control.js': 'control.js', '/auth.js': 'auth.js', '/fileview.js': 'fileview.js' }[path]
  if (own) return sendAsset(res, readAsset(join(HERE, own)))

  if (!path.startsWith('/api/')) return send(res, 404, 'not found')
  if (!authorized(req, url)) {
    sendJson(res, 401, { ok: false, error: '需要访问密钥：用看板打印出来的带 ?k= 的链接打开，或设 x-tapd-loop-key 头' })
    return
  }

  if (path === '/api/state') {
    return sendJson(res, 200, { ok: true, runs: listRuns(ROOT) })
  }
  if (path === '/api/card') {
    const card = readCard(ROOT, url.searchParams.get('run') || '', url.searchParams.get('id') || '')
    return sendJson(res, card ? 200 : 404, card || { ok: false, error: 'card not found' })
  }
  if (path === '/api/file') {
    // 日志弹窗用：一份文件的信息 + 尾部内容。路径白名单在 readFileInfo 里定。
    const info = readFileInfo(HOME, url.searchParams.get('path') || '')
    return sendJson(res, info.ok ? 200 : 404, info)
  }
  if (path === '/api/arm') {
    const data = readArm(ROOT, url.searchParams.get('run') || '', url.searchParams.get('id') || '', url.searchParams.get('arm') || '')
    return sendJson(res, data ? 200 : 404, data || { ok: false, error: 'arm not found' })
  }
  if (path === '/api/control') {
    if (req.method === 'GET') return sendJson(res, 200, { ok: true, ...boardStatus() })
    if (req.method === 'POST') {
      const body = await readJsonBody(req)
      control.write(body)
      return sendJson(res, 200, { ok: true, ...boardStatus() })
    }
    return sendJson(res, 405, { ok: false, error: 'GET/POST only' })
  }
  if (path === '/api/queue') {
    const config = control.read()
    if (!config.workdir) return sendJson(res, 400, { ok: false, error: '先选工作目录' })
    const refresh = url.searchParams.get('refresh') === '1'
    const queue = await control.queueFor(config.workdir, { refresh })
    return sendJson(res, 200, { ok: true, queue: publicQueue(queue) })
  }
  if (path === '/api/card-link') {
    // 贴链接先看清楚：认的是哪张卡、状态对不对、有没有机器标签。只读，不占卡。
    const ref = url.searchParams.get('ref') || ''
    const peeked = await control.peek({ workdir: url.searchParams.get('workdir') || '', ref })
    return sendJson(res, peeked.ok ? 200 : 400, { ...peeked, ...boardStatus() })
  }
  if (path === '/api/run') {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' })
    const body = await readJsonBody(req)
    // 带 ref 就先把链接翻译成 id，并确认这张卡现在真的能接；不然只会在批次里跳过一张。
    if (body.ref != null && String(body.ref).trim()) {
      const peeked = await control.peek({ workdir: body.workdir || '', ref: body.ref })
      if (!peeked.ok) return sendJson(res, 400, { ok: false, error: peeked.error, ...boardStatus() })
      const blocked = peeked.card?.blockedReason
      if (blocked) return sendJson(res, 409, { ok: false, error: blocked, card: peeked.card, ...boardStatus() })
      body.card = peeked.id
    }
    const result = control.start(body)
    return sendJson(res, result.ok ? 200 : 409, { ...result, ...boardStatus() })
  }
  if (path === '/api/stop') {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' })
    const body = await readJsonBody(req)
    const result = control.stop(body)
    // 只有「带 error 的拒绝」才算 400；补回写这种「部分提交找不到卡片」是结果，不是失败。
    return sendJson(res, result.error ? 400 : 200, { ...result, ...boardStatus() })
  }
  if (path === '/api/stations') {
    if (req.method === 'GET') return sendJson(res, 200, { ok: true, ...boardStatus() })
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'GET/POST only' })
    const body = await readJsonBody(req)
    const action = String(body.action || '').trim()
    // probeUnity 是 async：统一 await 一下，不然回给页面的是个 Promise。
    const result = await Promise.resolve(action === 'create' ? control.createStation(body)
      : action === 'remove' ? control.removeStation(body)
        : action === 'register' ? control.registerStation(body)
          : action === 'forget' ? control.forgetStation(body)
            : action === 'clean' ? control.cleanStation(body)
              : action === 'merge' ? control.mergeStation(body)
                : action === 'resolve' ? control.resolveMerge(body)
                  : action === 'mainpush' ? control.pushMain(body)
                    : action === 'mainverify' ? control.verifyMain(body)
                      : action === 'mainunity' ? control.openMainUnity(body)
                        : action === 'mainprobe' ? control.probeUnity({ path: body.path || '', name: body.name || '' })
                          : action === 'mainbackfill' ? control.backfillMain(body)
                            : action === 'mainclean' ? control.cleanMain(body)
                          : { ok: false, error: `未知动作：${action || '(空)'}（create / remove / register / forget / clean / merge / resolve / mainpush / mainverify / mainunity / mainprobe / mainbackfill / mainclean）` })
    return sendJson(res, result.ok ? 200 : 400, { ...result, ...boardStatus() })
  }
  if (path === '/api/dispatch') {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' })
    const body = await readJsonBody(req)
    if (body.enabled != null) {
      const current = control.read()
      control.write({ ...current, watch: { ...current.watch, enabled: Boolean(body.enabled) } })
    }
    // force：手动派一次不进节流（定时器自己调的时候不传）。
    const tick = await control.tick({ force: true })
    return sendJson(res, 200, { ok: true, tick, ...boardStatus() })
  }
  if (path === '/api/unity') {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' })
    const body = await readJsonBody(req)
    const result = String(body.action || '') === 'probe'
      ? await control.probeUnity(body)
      : control.openUnity(body)
    return sendJson(res, result.ok ? 200 : 400, { ...result, ...boardStatus() })
  }
  if (path.startsWith('/img/')) return sendImage(res, url)
  return send(res, 404, 'not found')
}

function boardStatus() {
  return {
    ...control.status(),
    board: {
      host: HOST,
      port: PORT,
      local: LOCAL_URL,
      share: SHARE_URL,
      shareWithKey: AUTH_REQUIRED ? `${SHARE_URL || LOCAL_URL}${KEY_QUERY}` : SHARE_URL || LOCAL_URL,
      shareCandidates: wildcard ? lanCandidates().map((entry) => `http://${entry.address}:${PORT}/`) : [],
      authRequired: AUTH_REQUIRED,
      lan: Boolean(SHARE_URL),
    },
  }
}

function publicQueue(queue) {
  return {
    ok: Boolean(queue.ok),
    error: queue.error || '',
    workdir: queue.workdir,
    at: queue.at,
    allowedStatuses: queue.allowedStatuses || [],
    ready: (queue.ready || []).map((card) => ({
      id: card.id, title: card.title, statusLabel: card.statusLabel, priorityLabel: card.priorityLabel, labels: card.labels || [],
    })),
    rejected: (queue.rejected || []).map((card) => ({
      id: card.id, title: card.title, statusLabel: card.statusLabel, reason: card.reason || '',
    })),
  }
}

function authorized(req, url) {
  if (!AUTH_REQUIRED) return true
  const header = req.headers['x-tapd-loop-key']
  const supplied = Array.isArray(header) ? header[0] : header || url.searchParams.get('k') || ''
  return sameKey(String(supplied || ''), KEY)
}

function sendImage(res, url) {
  const parts = url.pathname.split('/').filter(Boolean).slice(1).map(safeName)
  if (parts.length !== 3) return send(res, 400, 'bad path')
  const file = join(ROOT, parts[0], parts[1], 'images', parts[2])
  if (!existsSync(file)) return send(res, 404, 'not found')
  res.writeHead(200, { 'content-type': mime(parts[2]), 'cache-control': 'max-age=3600' })
  res.end(readFileSync(file))
}

function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((done, fail) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        fail(new Error('请求体太大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (!text) return done({})
      try {
        const parsed = JSON.parse(text)
        done(parsed && typeof parsed === 'object' ? parsed : {})
      } catch {
        fail(new Error('请求体不是 JSON'))
      }
    })
    req.on('error', fail)
  })
}

server.on('error', (err) => {
  console.error(JSON.stringify({ error: err.code || err.message, port: PORT, host: HOST }))
  process.exit(err.code === 'EADDRINUSE' ? 2 : 1)
})

server.listen(PORT, HOST, () => {
  console.log(JSON.stringify({
    url: LOCAL_URL,
    local: LOCAL_URL,
    share: SHARE_URL || '',
    primary: PRIMARY_URL,
    key: AUTH_REQUIRED ? KEY : '',
    authRequired: AUTH_REQUIRED,
    host: HOST,
    port: PORT,
    root: ROOT,
    home: HOME,
    runs: listRuns(ROOT).length,
  }))
  if (args.includes('--open')) open(PRIMARY_URL)
})

// 定时接单的心跳。看板活着才有定时器：不想让它跑就把开关关掉。
const TICK_MS = 5000
const timer = setInterval(() => {
  control.tick().catch(() => {
    // 一次 tick 出错不能让定时器死掉：下一轮还会试
  })
  // 主树自动验证并推送：开关关着时它只读一次配置就返回，代价可以忽略。
  try { control.autoPushTick() } catch { /* 下一轮再试 */ }
  // 主树自动合入工位提交（默认关）。它内部自己把探测频率收到 autoMerge.pollSec。
  try { control.autoMergeTick() } catch { /* 下一轮再试 */ }
}, TICK_MS)
timer.unref?.()
control.tick().catch(() => {})
try { control.autoPushTick() } catch { /* 下一轮再试 */ }
try { control.autoMergeTick() } catch { /* 下一轮再试 */ }

function send(res, code, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' })
  res.end(body)
}

function sendJson(res, code, body) {
  send(res, code, `${JSON.stringify(body)}\n`, 'application/json; charset=utf-8')
}

function sendAsset(res, asset) {
  res.writeHead(200, { 'content-type': asset.type, 'cache-control': 'no-store' })
  res.end(asset.body)
}

function mime(name) {
  const ext = String(name).split('.').pop().toLowerCase()
  return { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' }[ext] || 'application/octet-stream'
}

function safeName(value) {
  return String(value || '').replace(/[^a-zA-Z0-9._-]/g, '')
}

function argValue(name) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : ''
}

function open(url) {
  if (process.platform === 'win32') execFile('cmd', ['/c', 'start', '', url])
  else execFile('open', [url])
}
