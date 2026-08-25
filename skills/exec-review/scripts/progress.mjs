/**
 * 单条 append-only 进度事件流（全技能唯一事实来源）。
 *
 * 所有观测者（人的实时 HTML、Agent 的极简契约）都订阅同一根流，
 * 差异只在订阅深度（level）与渲染方式。
 *
 * level 语义（渐进式披露，越低越关键）：
 *   0  settle / heartbeat —— 终态与存活信号
 *   1  run_start / round_start / revise / settle —— 轮次里程碑
 *   2  executor_start/end / reviewer_start/end —— 单步转换
 *   3  全量细节（提示词/diff 指针等，本期未发射）
 *
 * 每条记录：{ t, level, event, ...data }
 */

import { createWriteStream, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** event -> 最小披露深度（未列出默认取 data.level） */
export const EVENT_LEVEL = {
  heartbeat: 0,
  settle: 0,
  run_start: 1,
  executor_start: 2,
  executor_end: 2,
  reviewer_start: 2,
  reviewer_end: 2,
}

export class ProgressWriter {
  /**
   * @param {string} runDir
   * @param {{ heartbeatMs?: number, progressFile?: string }} [opts]
   */
  constructor(runDir, opts = {}) {
    this.path = join(runDir, 'progress.jsonl')
    this.heartbeatMs = opts.heartbeatMs || 10000
    this.stream = createWriteStream(this.path, { flags: 'a' })
    this.mirrorStream = null
    if (opts.progressFile && resolve(opts.progressFile) !== resolve(this.path)) {
      mkdirSync(dirname(opts.progressFile), { recursive: true })
      this.mirrorStream = createWriteStream(opts.progressFile, { flags: 'a' })
    }
    this.all = []
    this.stage = 'idle'
    this.stageSince = Date.now()
    this.started = Date.now()
    this.heartbeatTimer = null
    this.closed = false
  }

  setStage(stage) {
    this.stage = stage
    this.stageSince = Date.now()
  }

  /** @param {string} event @param {object} [data] @param {number} [level] */
  write(event, data = {}, level) {
    if (this.closed) return null
    const rec = {
      t: Date.now(),
      level: level ?? EVENT_LEVEL[event] ?? 1,
      event,
      ...data,
    }
    this.all.push(rec)
    this.stream.write(JSON.stringify(rec) + '\n')
    if (this.mirrorStream) this.mirrorStream.write(JSON.stringify(rec) + '\n')
    return rec
  }

  /** level 0 */
  heartbeat(data = {}) {
    return this.write(
      'heartbeat',
      { stage: this.stage, sinceMs: Date.now() - this.stageSince, elapsedMs: Date.now() - this.started, ...data },
      0,
    )
  }

  startHeartbeat() {
    if (this.heartbeatTimer) return
    this.heartbeatTimer = setInterval(() => this.heartbeat(), this.heartbeatMs)
    if (this.heartbeatTimer.unref) this.heartbeatTimer.unref()
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  end() {
    if (this.closed) return Promise.resolve()
    this.stopHeartbeat()
    this.closed = true
    const streams = [this.stream, this.mirrorStream].filter(Boolean)
    return Promise.all(streams.map((stream) => new Promise((resolvePromise) => stream.end(resolvePromise))))
  }
}

/**
 * 读取 progress.jsonl 全部事件（serve 端初始加载用）。
 * @param {string} file
 * @returns {Array<object>}
 */
export function loadEvents(file) {
  if (!existsSync(file)) return []
  let txt
  try {
    txt = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const events = []
  for (const line of txt.split('\n')) {
    const s = line.trim()
    if (!s) continue
    try {
      events.push(JSON.parse(s))
    } catch {
      /* 跳过坏行 */
    }
  }
  return events
}

