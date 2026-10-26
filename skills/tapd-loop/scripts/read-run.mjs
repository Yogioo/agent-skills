/**
 * 读 tapd-loop 的 run 目录，聚合成看板要的数据。
 * 只读，不碰 TAPD，不碰工作区。
 */

import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'
import { fromPiEvent, fromProgressEvent } from '../../../lib/web-ui/events.mjs'

const ALIVE_WINDOW_MS = 10 * 60 * 1000
// 心跳超过这么久没动就算卡死。窗口要大于 afterSync 的默认超时（1800s）：
// 同步/验证/afterSync 走 execFileSync，会整个卡住事件循环，那段时间是不会有心跳的。
const STALL_MS = 31 * 60 * 1000

export function listRuns(root) {
  if (!existsSync(root)) return []
  return readdirSync(root)
    .filter((name) => name.startsWith('run-'))
    .map((name) => join(root, name))
    .filter((dir) => isDir(dir))
    .filter((dir) => existsSync(join(dir, 'progress.jsonl')) || hasCard(dir))
    .map((dir) => summarizeRun(dir))
    .sort((a, b) => b.startedAt - a.startedAt)
}

export function readRun(root, runId) {
  const dir = join(root, safeName(runId))
  if (!existsSync(dir)) return null
  return summarizeRun(dir)
}

/**
 * 看板上的「文件」按钮读这里：给一份日志的信息 + 尾部内容，不用人再去资源管理器里找。
 *
 * 只读 <home> 下这三棵目录（runs / cards / board-batches）。看板默认绑 0.0.0.0，
 * 哪怕带了密钥也不该变成一个任意读盘的接口 —— 路径不在白名单里就直接拒。
 */
export function readFileInfo(home, wanted, { bytes = 64 * 1024 } = {}) {
  const abs = resolve(String(wanted || ''))
  const roots = ['runs', 'cards', 'board-batches'].map((name) => resolve(home, name))
  if (!roots.some((root) => abs === root || abs.startsWith(root + sep))) {
    return { ok: false, path: abs, error: `只给看 ${home} 下的日志（runs / cards / board-batches）` }
  }
  if (!existsSync(abs)) return { ok: false, path: abs, error: '文件还不存在（可能还没写出来）' }
  const stat = statSync(abs)
  if (stat.isDirectory()) return { ok: false, path: abs, error: '这是个目录，不给看' }

  const fd = openSync(abs, 'r')
  let text = ''
  try {
    const start = Math.max(0, stat.size - bytes)
    const buf = Buffer.alloc(stat.size - start)
    readSync(fd, buf, 0, buf.length, start)
    // 日志里有 GBK（cmd/powershell 的中文）时 utf8 会出 ，但不影响看结构。
    text = buf.toString('utf8')
  } finally {
    closeSync(fd)
  }
  return {
    ok: true,
    path: abs,
    name: basename(abs),
    size: stat.size,
    mtime: stat.mtimeMs,
    truncated: stat.size > bytes,
    tail: text,
  }
}

export function readCard(root, runId, cardId) {
  const dir = join(root, safeName(runId), safeName(cardId))
  if (!existsSync(dir)) return null
  const cardFile = join(dir, 'card.json')
  const card = existsSync(cardFile) ? readJson(cardFile) : null
  return {
    card: card?.card || null,
    detail: card?.detail || null,
    brief: readText(join(dir, 'brief.md')),
    cardMd: readText(join(dir, 'card.md')),
    events: timeline(join(dir, 'events.jsonl')),
    diff: readText(join(dir, 'diff.txt')),
    verify: readText(join(dir, 'verify.log')),
    logTail: tail(readText(join(dir, 'pi.log')), 4000),
    arms: listArms(dir),
  }
}

export function readArm(root, runId, cardId, armName) {
  const dir = join(root, safeName(runId), safeName(cardId), safeName(armName))
  if (!existsSync(dir)) return null
  return { name: armName, reports: readJsonLines(join(dir, 'report.jsonl')), events: armTimeline(join(dir, 'progress.jsonl')) }
}

/** 主 Agent 通过 agent-tools 起的每个 arm，都落在卡片目录的 arm-N/ 下。 */
function listArms(cardDir) {
  let names = []
  try {
    names = readdirSync(cardDir).filter((name) => /^arm-\d+$/.test(name))
  } catch {
    return []
  }
  return names.map((name) => {
    const dir = join(cardDir, name)
    const reports = readJsonLines(join(dir, 'report.jsonl'))
    const armEvents = readProgress(join(dir, 'progress.jsonl'))
    const ends = armEvents.filter((event) => event.event === 'arm_end')
    return {
      name,
      reports,
      labels: reports.map((row) => row.label).filter(Boolean),
      status: reports.every((row) => row.status === 'ok') ? 'ok' : 'error',
      elapsedMs: ends.reduce((sum, event) => sum + (event.elapsedMs || 0), 0),
      tokens: reports.reduce((sum, row) => sum + (row.tokens || 0), 0),
      events: armTimeline(join(dir, 'progress.jsonl')).length,
    }
  })
}

function armTimeline(file) {
  if (!existsSync(file)) return []
  const out = []
  for (const line of readText(file).split('\n')) {
    if (!line.trim()) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    const entry = fromProgressEvent(event)
    // 臂进度只认识 say/think/tool/arm_start/arm_end；其余记录旧版直接丢掉，
    // 共享归一化会把它们变成 note，这里继续丢掉以保持计数和行数不变。
    if (entry && entry.kind !== 'note') out.push(entry)
  }
  return out
}

function summarizeRun(dir) {
  const runId = basename(dir)
  const progress = readProgress(join(dir, 'progress.jsonl'))
  const start = progress.find((event) => event.event === 'loop_start')
  const end = [...progress].reverse().find((event) => event.event === 'loop_end')
  const beats = progress.filter((event) => event.event === 'heartbeat')
  const startedAt = start?.t || birthtime(dir) || 0
  const endedAt = end?.t || 0
  const liveness = judgeLiveness({
    endedAt,
    pid: Number(start?.pid) || 0,
    lastBeat: beats[beats.length - 1]?.t || 0,
    last: progress[progress.length - 1],
  })
  const cards = settleInterrupted(aggregate(progress, dir), liveness, progress[progress.length - 1]?.t || 0)
  return {
    runId,
    dir,
    workdir: start?.workdir || '',
    assignee: start?.assignee || '',
    // 这一批用的 CLI / 模型 / 思考等级。卡片自己的 turn_start 没带时（旧事件、被中断的卡）
    // 看板拿它兜底，不然弹窗里只剩一个空。
    runtime: start?.runtime || null,
    startedAt,
    endedAt,
    alive: liveness.alive,
    reason: end?.reason || liveness.reason,
    cards,
    counts: countCards(cards),
    events: progress.length,
  }
}

/**
 * 进程被强杀（taskkill /F、断电、终端被关）不会留下 loop_end，只读事件流就会永远显示「运行中」。
 * 所以按进程判生死：
 *   pid 明确定义了不在 → 立刻中断；
 *   pid 还在 → 信它，只看心跳会把「同步中卡住事件循环」误判成死；
 *   pid 不知道（老 run 没写、EPERM、跨机）→ 退回「最后事件多久以前」。
 */
function judgeLiveness({ endedAt, pid, lastBeat, last }) {
  if (endedAt) return { alive: false, why: 'ended', reason: '' }
  const running = processAlive(pid)
  if (running === false) return { alive: false, why: 'gone', reason: '进程已退出，没有 loop_end' }
  if (running === true) {
    if (lastBeat && Date.now() - lastBeat > STALL_MS) return { alive: false, why: 'stalled', reason: '进程在，但长时间没有心跳' }
    return { alive: true, why: 'process', reason: '' }
  }
  if (!last) return { alive: false, why: 'empty', reason: '' }
  return Date.now() - last.t < ALIVE_WINDOW_MS
    ? { alive: true, why: 'silence', reason: '' }
    : { alive: false, why: 'silence', reason: '长时间没有事件' }
}

/** pid 在不在。null 表示判不了（没给 pid / 权限不够）。 */
function processAlive(pid) {
  if (!pid) return null
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM' ? true : false
  }
}

/** run 不在了，还挂着 running 的卡按中断收尾：时钟停住，并说清楚原因。 */
function settleInterrupted(cards, liveness, lastSeen) {
  if (liveness.alive) return cards
  const note = liveness.why === 'stalled' ? '进程还在，但长时间没有心跳' : '进程已中断（没有写 loop_end）'
  for (const card of cards) {
    if (card.status !== 'running') continue
    card.status = 'interrupted'
    card.phase = ''
    // 心跳不带卡片 id，所以用「整个 run 最后一条事件的时刻」兜底，否则长任务的中断时刻会回溯到 card_start。
    card.endedAt = Math.max(card.startedAt || 0, card.lastEventAt || 0, lastSeen || 0)
    card.note = note
  }
  return cards
}

function aggregate(progress, dir) {
  const cards = new Map()
  for (const event of progress) {
    if (event.event === 'queue') {
      for (const item of event.rejected || []) queueCard(cards, item.id, 'blocked', item.reason || `状态 ${item.status}`, item.title)
      continue
    }
    const id = event.id
    if (!id) continue
    let card = cards.get(id)
    if (!card) {
      card = { id, title: '', status: 'queued', phase: '', startedAt: 0, endedAt: 0, lastEventAt: 0, note: '', commit: '', durations: [] }
      cards.set(id, card)
    }
    if (event.t) card.lastEventAt = event.t
    if (event.event === 'card_start') {
      card.title = event.title || card.title
      card.status = 'running'
      card.startedAt = event.t
      card.priorityLabel = event.priorityLabel || ''
      card.statusLabel = event.statusLabel || ''
    }
    if (event.event === 'card_phase') card.phase = event.phase
    if (event.event === 'turn_start') {
      card.phase = 'running'
      card.cli = event.cli || ''
      card.provider = event.provider || ''
      card.model = event.model || ''
      card.thinking = event.thinking || ''
    }
    if (event.event === 'turn_end') {
      card.lastTurnMs = event.durationMs
      if (event.timedOut) card.phase = 'timeout'
    }
    if (event.event === 'card_done' || event.event === 'card_failed' || event.event === 'card_skipped' || event.event === 'card_interrupted') {
      card.status = event.event.slice(5)
      card.endedAt = event.t
      card.note = event.reason || ''
      card.commit = event.commit || ''
      card.phase = ''
    }
  }

  for (const card of cards.values()) {
    if (!card.title) {
      const meta = readJson(join(dir, card.id, 'card.json'))
      card.title = meta?.card?.title || meta?.detail?.title || ''
    }
  }
  return [...cards.values()].sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0))
}

function queueCard(cards, id, status, note, title = '') {
  if (cards.has(id)) return
  cards.set(id, { id, title, status, phase: '', startedAt: 0, endedAt: 0, note, commit: '', durations: [] })
}

function countCards(cards) {
  const counts = { total: cards.length, running: 0, done: 0, failed: 0, interrupted: 0, blocked: 0, queued: 0, preview: 0, skipped: 0 }
  for (const card of cards) {
    const key = card.status === 'done' ? 'done' : card.status === 'failed' ? 'failed' : card.status
    if (key in counts) counts[key] += 1
  }
  return counts
}

function readProgress(file) {
  if (!existsSync(file)) return []
  const out = []
  for (const line of readText(file).split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      // 写到一半的行跳过
    }
  }
  return out
}

function timeline(file) {
  if (!existsSync(file)) return []
  const out = []
  let lastT = 0
  let seq = 0
  for (const line of readText(file).split('\n')) {
    if (!line.trim()) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    // 工具事件本身没有时间戳，挂在最近一条消息的时间上，再用序号保持先后。
    const own = eventTime(event.timestamp) || eventTime(event.message?.timestamp)
    if (own) {
      lastT = own
      seq = 0
    }
    const entry = fromPiEvent(event, lastT ? lastT + seq++ : 0)
    if (entry) out.push(entry)
  }
  return out.slice(-400)
}

/** pi 的事件用毫秒数字，只有 session header 用 ISO 字符串。两种都要认。 */
function eventTime(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value)
    if (Number.isFinite(n) && n > 1e12) return n
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function readJsonLines(file) {
  if (!existsSync(file)) return []
  return readText(file)
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

function readText(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

function tail(text, limit) {
  return text.length > limit ? text.slice(-limit) : text
}

function hasCard(dir) {
  try {
    return readdirSync(dir).some((name) => existsSync(join(dir, name, 'card.json')))
  } catch {
    return false
  }
}

function isDir(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function birthtime(dir) {
  try {
    return statSync(dir).birthtimeMs
  } catch {
    return 0
  }
}

function safeName(value) {
  return String(value || '').replace(/[^a-zA-Z0-9._-]/g, '')
}
