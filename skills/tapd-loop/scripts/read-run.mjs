/**
 * 读 tapd-loop 的 run 目录，聚合成看板要的数据。
 * 只读，不碰 TAPD，不碰工作区。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

const ALIVE_WINDOW_MS = 10 * 60 * 1000

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
      events: armEvents.filter((event) => toArmEvent(event)).length,
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
    const entry = toArmEvent(event)
    if (entry) out.push(entry)
  }
  return out
}

function toArmEvent(event) {
  const base = { t: event.t || 0, arm: event.arm || '' }
  if (event.event === 'say') return { ...base, kind: 'say', text: event.text || '' }
  if (event.event === 'think') return { ...base, kind: 'think', text: event.text || '' }
  if (event.event === 'tool') return { ...base, kind: 'tool', name: event.name || 'tool', detail: event.detail || '', ms: event.ms }
  if (event.event === 'arm_start') return { ...base, kind: 'arm_start', text: [event.runner, event.model, event.thinking].filter(Boolean).join(' · ') }
  if (event.event === 'arm_end') return { ...base, kind: 'arm_end', text: event.status || '', status: event.status }
  return null
}

function summarizeRun(dir) {
  const runId = basename(dir)
  const progress = readProgress(join(dir, 'progress.jsonl'))
  const cards = aggregate(progress, dir)
  const start = progress.find((event) => event.event === 'loop_start')
  const end = [...progress].reverse().find((event) => event.event === 'loop_end')
  const last = progress[progress.length - 1]
  const startedAt = start?.t || birthtime(dir) || 0
  const endedAt = end?.t || 0
  const alive = !endedAt && Boolean(last) && Date.now() - last.t < ALIVE_WINDOW_MS
  return {
    runId,
    dir,
    workdir: start?.workdir || '',
    assignee: start?.assignee || '',
    startedAt,
    endedAt,
    alive,
    reason: end?.reason || '',
    cards,
    counts: countCards(cards),
    events: progress.length,
  }
}

function aggregate(progress, dir) {
  const cards = new Map()
  for (const event of progress) {
    if (event.event === 'queue') {
      for (const item of event.rejected || []) queueCard(cards, item.id, 'blocked', `状态 ${item.status}`, item.title)
      continue
    }
    const id = event.id
    if (!id) continue
    let card = cards.get(id)
    if (!card) {
      card = { id, title: '', status: 'queued', phase: '', startedAt: 0, endedAt: 0, note: '', commit: '', durations: [] }
      cards.set(id, card)
    }
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
      card.model = event.model
    }
    if (event.event === 'turn_end') {
      card.lastTurnMs = event.durationMs
      if (event.timedOut) card.phase = 'timeout'
    }
    if (event.event === 'card_done' || event.event === 'card_failed' || event.event === 'card_skipped') {
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
  const counts = { total: cards.length, running: 0, done: 0, failed: 0, blocked: 0, queued: 0, preview: 0, skipped: 0 }
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
    const entry = toTimeline(event, lastT ? lastT + seq++ : 0)
    if (entry) out.push(entry)
  }
  return out.slice(-400)
}

function toTimeline(event, t = 0) {
  if (event.type === 'message_end' && event.message?.role === 'assistant') {
    const text = contentText(event.message.content)
    if (!text.trim()) return null
    return { t, kind: 'say', text }
  }
  if (event.type === 'tool_execution_start') {
    return { t, kind: 'tool', name: event.toolName || 'tool', detail: argsDetail(event.args) }
  }
  if (event.type === 'tool_execution_end') {
    return { t, kind: 'tool_end', name: event.toolName || 'tool', ms: event.durationMs, error: Boolean(event.isError) }
  }
  if (event.type === 'agent_settled') {
    return { t, kind: 'settled', text: event.aborted ? '被中断' : '正常结束' }
  }
  return null
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

function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter((part) => part?.type === 'text').map((part) => part.text).join('\n')
}

function argsDetail(args) {
  if (!args || typeof args !== 'object') return ''
  const pick = args.command || args.path || args.file_path || args.pattern || args.query || args.url
  if (pick) return String(pick).slice(0, 220)
  return JSON.stringify(args).slice(0, 220)
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
