#!/usr/bin/env node
/**
 * 总览页：整台机器一张页面，回答「什么在等我」（见 ADR-0009）。
 *
 * 它是**只读的聚合**，不替代任何 per-workdir 看板（那些归 `loop-serve`，见 ADR-0005）。
 * 数据只来自四类文件：
 *   - Inbox item            <AFK home>/inbox/*.json
 *   - Requirement record     <AFK home>/<项目>/requirements/*.json
 *   - Watcher 注册表          <watch cache>/watch-<hash>.json（+ 它 runDir 里的 pool.json）
 *   - Loop 注册表              <run cache>/loop-<hash>.json
 *
 * **它不读 `config.json`。** 那里有 task source 的凭据，不该流进浏览器或日志。
 *
 * 进程没了的注册表一律标成陈旧：注册表是磁盘上的遗物，不是事实。
 *
 * CLI：
 *   node overview.mjs [--port <端口>] [--json] [--print-url]
 * 退出码：0 正常 / 2 出错。
 */

import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afkHomeRoot } from '../../afk-run/scripts/afk-home.mjs'
import { listInboxItems } from '../../afk-run/scripts/inbox.mjs'
import { DEFAULT_HEARTBEAT_MS, isHeartbeatFresh, listRequirementRecords } from '../../afk-run/scripts/requirement.mjs'
import { runnerSessionMode } from '../../exec-review/scripts/runners/index.mjs'
import { isPidAlive } from './watch-state.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

/** 重试到这个次数还没叫醒，drain 就不再敲了——那件事只有人能动。 */
export const EXHAUSTED_WAKE_ATTEMPTS = 3

export function defaultWatchCacheRoot() {
  return join(tmpdir(), 'afk-watch')
}

export function defaultRunCacheRoot() {
  return join(tmpdir(), 'afk-run')
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** 扫一个缓存目录里的注册表：`watch-*.json` / `loop-*.json`。坏文件跳过。 */
function readRegistries(root, prefix) {
  if (!existsSync(root)) return []
  const found = []
  for (const name of readdirSync(root)) {
    if (!name.startsWith(prefix) || !name.endsWith('.json')) continue
    const record = readJson(join(root, name))
    if (record && record.workdir) found.push({ ...record, file: join(root, name) })
  }
  return found
}

function readPool(runDir) {
  if (!runDir) return null
  return readJson(join(runDir, 'pool.json'))
}

function poolCounts(pool) {
  if (!pool) return null
  return {
    ready: (pool.ready || []).length,
    blocked: (pool.blocked || []).length,
    inProgress: (pool.inProgress || []).length,
    updatedAt: pool.updatedAt || 0,
  }
}

function countItems(items) {
  const counts = { unread: 0, seen: 0, done: 0 }
  for (const item of items) if (counts[item.state] !== undefined) counts[item.state] += 1
  return counts
}

/**
 * 这个需求能不能被唤醒环叫醒？答案直接决定「要不要人动」。
 * 真实踩过：需求本子里记的 runner 不支持续会话，于是事件永远叫不动人，而页面上只显示了一个普通 runner 名。
 */
export function wakeableOf(record) {
  if (!record.runner) return { ok: false, why: '需求本子没记 runner，唤醒环不知道用哪个 CLI' }
  try {
    if (runnerSessionMode(record.runner) === 'none') {
      return { ok: false, why: `runner ${record.runner} 不支持续会话，唤醒环叫不醒它` }
    }
  } catch {
    return { ok: false, why: `runner ${record.runner} 不认识` }
  }
  if (!record.sessionRef) return { ok: false, why: '没有 session reference，唤醒环找不到那个 session' }
  return { ok: true, why: '' }
}

/**
 * 把四类文件投影成页面模型。纯函数（除了注入的 isAlive），便于直接测。
 * @param {object} [opts]
 * @param {string} [opts.home]             AFK home
 * @param {string} [opts.watchCacheRoot]
 * @param {string} [opts.runCacheRoot]
 * @param {(pid: number) => boolean} [opts.isAlive]
 * @param {number} [opts.now]
 */
export function projectOverview({
  home = afkHomeRoot(),
  watchCacheRoot = defaultWatchCacheRoot(),
  runCacheRoot = defaultRunCacheRoot(),
  isAlive = isPidAlive,
  now = Date.now(),
} = {}) {
  const inbox = listInboxItems({ home })
  const requirements = listRequirementRecords({ home })
  const watchers = readRegistries(watchCacheRoot, 'watch-')
  const loops = readRegistries(runCacheRoot, 'loop-')

  // ---------------------------------------------------------------- 需求
  const requirementById = new Map()
  const requirementsOut = requirements.map((record) => {
    const items = inbox.filter((item) => item.requirementId === record.requirementId)
    const wakeable = wakeableOf(record)
    const view = {
      requirementId: record.requirementId,
      title: record.title,
      projectKey: record.projectKey,
      workdir: record.workdir,
      runner: record.runner,
      sessionRef: record.sessionRef ? '有' : '没有',
      wakeable,
      closed: Boolean(record.closedAt),
      heartbeatAt: record.heartbeatAt || 0,
      heartbeatFresh: isHeartbeatFresh(record, { now, windowMs: DEFAULT_HEARTBEAT_MS }),
      workItems: (record.workItems || []).map((item) => `${item.taskSource}:${item.id}`),
      items: items.map((item) => ({
        id: item.id,
        kind: item.kind,
        state: item.state,
        title: item.title,
        nextStep: item.nextStep,
        createdAt: item.createdAt,
        wakeAttempts: item.wakeAttempts || 0,
      })),
      counts: countItems(items),
    }
    requirementById.set(view.requirementId, view)
    return view
  })

  // ---------------------------------------------------------------- 待人工处理
  // 只有这两类是人必须动的手：没人认领的，和唤醒环已经放弃的。
  const unrouted = inbox
    .filter((item) => !item.requirementId)
    .map((item) => ({ ...item, why: '没有被任何需求认领：先登记需求、或把工单挂上' }))
  const exhausted = inbox
    .filter(
      (item) =>
        item.requirementId &&
        item.state === 'unread' &&
        (item.wakeAttempts || 0) >= EXHAUSTED_WAKE_ATTEMPTS,
    )
    .map((item) => ({ ...item, why: `已叫醒 ${item.wakeAttempts} 次仍失败：${item.lastWakeError || '原因未记'}` }))

  // 叫不醒的需求：登记本身有问题，与有没有事件无关。事件来了也只会堆在那里。
  const unwakeable = requirementsOut
    .filter((record) => !record.closed && !record.wakeable.ok)
    .map((record) => ({ ...record, why: record.wakeable.why }))

  // ---------------------------------------------------------------- 执行环境
  const workdirs = new Set([
    ...watchers.map((record) => record.workdir),
    ...loops.map((record) => record.workdir),
    ...requirementsOut.map((record) => record.workdir).filter(Boolean),
  ])

  const environments = [...workdirs].sort().map((workdir) => {
    const watcher = watchers.find((record) => record.workdir === workdir) || null
    const loop = loops.find((record) => record.workdir === workdir) || null
    const watcherAlive = Boolean(watcher && isAlive(watcher.pid))
    const loopAlive = Boolean(loop && isAlive(loop.pid))
    return {
      workdir,
      watcher: watcher
        ? {
            state: watcher.state || '',
            pid: watcher.pid,
            alive: watcherAlive,
            claimMode: watcher.claimMode || '',
            lastPollAt: watcher.lastPollAt || 0,
            phaseStartedAt: watcher.phaseStartedAt || 0,
            execRunDir: watcher.execRunDir || '',
            pool: poolCounts(readPool(watcher.runDir)),
          }
        : null,
      run: loop
        ? { pid: loop.pid, alive: loopAlive, runDir: loop.runDir || '', startedAt: loop.startedAt || 0 }
        : null,
      // 注册表还在、进程没了 = 崩溃或重启留下的遗物。宁可说陈旧，不能说在跑。
      stale: (Boolean(watcher) && !watcherAlive) || (Boolean(loop) && !loopAlive),
      requirements: requirementsOut
        .filter((record) => record.workdir === workdir)
        .map((record) => record.requirementId),
    }
  })

  return {
    generatedAt: now,
    counts: {
      requirements: requirementsOut.length,
      open: requirementsOut.filter((record) => !record.closed).length,
      environments: environments.length,
      inbox: countItems(inbox),
      needsHuman: unrouted.length + exhausted.length + unwakeable.length,
    },
    needsHuman: {
      unrouted: unrouted.map((item) => pickItem(item)),
      exhausted: exhausted.map((item) => pickItem(item)),
      unwakeable: unwakeable.map((record) => ({
        requirementId: record.requirementId,
        title: record.title,
        runner: record.runner,
        why: record.why,
      })),
    },
    requirements: requirementsOut,
    environments,
  }
}

function pickItem(item) {
  return {
    id: item.id,
    kind: item.kind,
    title: item.title,
    nextStep: item.nextStep || '',
    requirementId: item.requirementId || '',
    projectKey: item.projectKey || '',
    createdAt: item.createdAt,
    wakeAttempts: item.wakeAttempts || 0,
    why: item.why,
  }
}

// ---------------------------------------------------------------- 渲染

/** 插值前一律转义：事件标题里直接是 CLI 报错原文，带 < & 很正常。 */
function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function ago(ts, now) {
  if (!ts) return '-'
  const sec = Math.max(0, Math.round((now - ts) / 1000))
  if (sec < 60) return `${sec} 秒前`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min} 分钟前`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour} 小时前`
  return `${Math.floor(hour / 24)} 天前`
}

const CSS = `
:root{--bg:#f7f8fa;--card:#fff;--line:#dfe3e8;--text:#202124;--muted:#5f6368;--warn:#b06000;--bad:#c5221f;--ok:#137333}
*{box-sizing:border-box}
body{margin:0;padding:24px;background:var(--bg);color:var(--text);font:14px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1080px;margin:0 auto}h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 10px}
a{color:#1769e0}
.sub{color:var(--muted);font-size:13px}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:14px 16px;margin-bottom:10px}
.card.dim{opacity:.6}
.row{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}
.pill{font-size:12px;padding:1px 8px;border-radius:99px;border:1px solid var(--line);color:var(--muted);background:#fafbfc}
.pill.bad{border-color:#f0c0be;color:var(--bad);background:#fdecea}
.pill.warn{border-color:#f3d9a8;color:var(--warn);background:#fef7e0}
.pill.ok{border-color:#b7dfc4;color:var(--ok);background:#e6f4ea}
.mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;color:var(--muted)}
ul.events{margin:8px 0 0;padding:0;list-style:none}
ul.events li{border-top:1px solid #eef0f3;padding:6px 0}
.empty{background:var(--card);border:1px dashed var(--line);border-radius:8px;padding:18px;color:var(--muted);text-align:center}
.why{color:var(--bad);font-size:12px}
pre{white-space:pre-wrap;margin:0;font:inherit}
`

function countsLine(model) {
  const c = model.counts
  const parts = [
    `${c.requirements} 个需求（${c.open} 个进行中）`,
    `${c.environments} 个执行环境`,
    `收件箱 ${c.inbox.unread} 未读 / ${c.inbox.seen} 已读 / ${c.inbox.done} 已处理`,
  ]
  return parts.join('　·　')
}

function itemLine(item, now) {
  return `<li><div class="row"><span class="pill">${esc(item.kind)}</span>` +
    `<span>${esc(item.title) || '<span class="sub">（无标题）</span>'}</span>` +
    `<span class="mono">${ago(item.createdAt, now)}</span></div>` +
    (item.nextStep ? `<div class="sub">下一步：${esc(item.nextStep)}</div>` : '') +
    (item.why ? `<div class="why">${esc(item.why)}</div>` : '') +
    (item.wakeAttempts ? `<div class="mono">已叫醒 ${item.wakeAttempts} 次</div>` : '') +
    `<div class="mono">${esc(item.id)}</div></li>`
}

function renderNeedsHuman(model) {
  const now = model.generatedAt
  const rows = {
    unwakeable: model.needsHuman.unwakeable.map((r) => `
      <li><div class="row"><b>${esc(r.title) || '(无标题)'}</b>` +
      `<span class="pill">${esc(r.runner || '没记 runner')}</span></div>` +
      `<div class="why">${esc(r.why)}</div>` +
      `<div class="mono">${esc(r.requirementId)}</div></li>`),
    unrouted: model.needsHuman.unrouted.map((item) => itemLine(item, now)),
    exhausted: model.needsHuman.exhausted.map((item) => itemLine(item, now)),
  }
  const lists = [
    ['叫不醒的需求', rows.unwakeable],
    ['没有被任何需求认领', rows.unrouted],
    ['唤醒环已经放弃', rows.exhausted],
  ].filter(([, items]) => items.length)

  if (!lists.length) {
    return `<h2>待人工处理</h2><div class="empty">没有要你动的事</div>`
  }
  return (
    `<h2>待人工处理（${model.counts.needsHuman}）</h2>` +
    lists
      .map(
        ([label, items]) =>
          `<div class="card"><div class="row"><span class="pill bad">${esc(label)}</span>` +
          `<span class="sub">${items.length} 条</span></div>` +
          `<ul class="events">${items.join('')}</ul></div>`,
      )
      .join('')
  )
}

function renderRequirements(model) {
  if (!model.requirements.length) {
    return `<h2>需求</h2><div class="empty">还没有登记过需求</div>`
  }
  const now = model.generatedAt
  return (
    `<h2>需求（${model.requirements.length}）</h2>` +
    model.requirements
      .map((record) => {
        const pills = [
          record.closed ? '<span class="pill">已结束</span>' : '<span class="pill ok">进行中</span>',
          record.heartbeatFresh
            ? `<span class="pill ok">心跳 ${ago(record.heartbeatAt, now)}</span>`
            : `<span class="pill">心跳 ${ago(record.heartbeatAt, now)}</span>`,
          `<span class="pill">${esc(record.runner || '没记 runner')}</span>`,
          record.wakeable.ok ? '' : '<span class="pill bad">叫不醒</span>',
        ].join('')
        const events = record.items.length
          ? `<ul class="events">${record.items.map((item) => itemLine(item, now)).join('')}</ul>`
          : `<div class="sub" style="margin-top:6px">没有事件</div>`
        return (
          `<div class="card${record.closed ? ' dim' : ''}">` +
          `<div class="row"><b>${esc(record.title) || '(无标题)'}</b>${pills}</div>` +
          (record.wakeable.ok ? '' : `<div class="why">${esc(record.wakeable.why)}</div>`) +
          `<div class="mono">${esc(record.requirementId)}　${esc(record.projectKey)}</div>` +
          (record.workItems.length ? `<div class="mono">工单 ${esc(record.workItems.join(', '))}</div>` : '') +
          events +
          `</div>`
        )
      })
      .join('')
  )
}

function renderEnvironments(model) {
  if (!model.environments.length) {
    return `<h2>执行环境</h2><div class="empty">没有在跑的 Watch session</div>`
  }
  const now = model.generatedAt
  return (
    `<h2>执行环境（${model.environments.length}）</h2>` +
    model.environments
      .map((env) => {
        const bits = []
        if (env.watcher) {
          bits.push(
            `<span class="pill${env.watcher.alive ? ' ok' : ' bad'}">watcher ${esc(env.watcher.state)}${
              env.watcher.alive ? '' : '（进程没了）'
            }</span>`,
          )
          if (env.watcher.pool) {
            const p = env.watcher.pool
            bits.push(
              `<span class="pill">ready ${p.ready} / 进行中 ${p.inProgress} / 阻塞 ${p.blocked}</span>`,
            )
          }
          if (env.watcher.lastPollAt) bits.push(`<span class="mono">上次轮询 ${ago(env.watcher.lastPollAt, now)}</span>`)
        } else {
          bits.push('<span class="pill">没有 watcher</span>')
        }
        if (env.run) {
          bits.push(
            `<span class="pill${env.run.alive ? ' ok' : ''}">run ${env.run.alive ? '在跑' : '已结束'}</span>`,
          )
        }
        return (
          `<div class="card${env.stale ? ' dim' : ''}">` +
          `<div class="row"><b>${esc(env.workdir)}</b>` +
          (env.stale ? '<span class="pill bad">陈旧：注册表还在、进程已死</span>' : '') +
          `</div><div class="row">${bits.join('')}</div>` +
          (env.requirements.length
            ? `<div class="mono">需求 ${esc(env.requirements.join(', '))}</div>`
            : '') +
          `</div>`
        )
      })
      .join('')
  )
}

/** 服务端渲染。全部转义，无客户端依赖。 */
export function renderPage(model, { staticMode = false } = {}) {
  const refresh = staticMode ? '' : '<meta http-equiv="refresh" content="5">'
  const toggle = staticMode
    ? '<a href="/">开启自动刷新</a>'
    : '<a href="/?static=1">停止自动刷新</a>'
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">${refresh}
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AFK 总览</title><style>${CSS}</style></head><body><main>
<h1>AFK 总览</h1>
<div class="sub">${esc(new Date(model.generatedAt).toLocaleString())}　${toggle}</div>
<div class="sub">${countsLine(model)}</div>
${renderNeedsHuman(model)}
${renderRequirements(model)}
${renderEnvironments(model)}
<div class="sub" style="margin-top:28px">只读页面。数据来自收件箱 / 需求本子 / watcher 与 loop 注册表，不读 <span class="mono">config.json</span>。</div>
</main></body></html>`
}

/** 默认端口被占就往后找，和 loop-serve 一样。 */
function listenWithPortFallback(server, port, attempts = 20) {
  return new Promise((resolvePromise, reject) => {
    let candidate = port || 0
    let tried = 0
    const onError = (err) => {
      if (err.code === 'EADDRINUSE' && tried < attempts) {
        tried += 1
        candidate += 1
        server.listen(candidate, '127.0.0.1')
        return
      }
      server.removeListener('error', onError)
      reject(err)
    }
    server.on('error', onError)
    server.on('listening', () => {
      server.removeListener('error', onError)
      resolvePromise(server.address().port)
    })
    server.listen(candidate, '127.0.0.1')
  })
}

// ---------------------------------------------------------------- CLI

function parseArgs(argv) {
  const args = { port: 0, json: false }
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i]
    if (value === '--port') args.port = Number(argv[++i] || 0)
    else if (value === '--json') args.json = true
    else if (value === '--help' || value === '-h') args.help = true
  }
  return args
}

const USAGE = [
  'node overview.mjs [--port <端口>] [--json]',
  '',
  '整台机器一张只读总览页：待人工处理 / 需求 / 执行环境。',
  '--json 不启服务，只把投影结果打出来（调试与测试用）。',
].join('\n')

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  if (args.json) {
    process.stdout.write(`${JSON.stringify(projectOverview(), null, 2)}\n`)
    return 0
  }

  const server = createServer((request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1')
      if (url.pathname === '/' || url.pathname === '/index.html') {
        const model = projectOverview()
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        response.end(renderPage(model, { staticMode: url.searchParams.get('static') === '1' }))
        return
      }
      if (url.pathname === '/api/state') {
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        response.end(`${JSON.stringify(projectOverview())}\n`)
        return
      }
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('not found')
    } catch (err) {
      response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      response.end(err?.message || 'error')
    }
  })

  const port = await listenWithPortFallback(server, args.port)
  // 启动行按仓库惯例只打一行 JSON，调用方（启动器 / 助理）靠它拿地址
  process.stdout.write(
    `${JSON.stringify({ event: 'overview_started', pid: process.pid, port, url: `http://127.0.0.1:${port}/` })}\n`,
  )

  process.on('SIGINT', () => server.close(() => process.exit(0)))
  process.on('SIGTERM', () => server.close(() => process.exit(0)))
  return null // 不退出：服务一直挂到被停
}

const isMain =
  process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
if (isMain) {
  main()
    .then((code) => {
      if (code !== null) process.exit(code)
    })
    .catch((err) => {
      console.error(err?.stack || err?.message || String(err))
      process.exit(2)
    })
}
