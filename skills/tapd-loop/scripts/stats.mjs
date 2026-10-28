/**
 * 看板的统计聚合：把 `~/.tapd-loop/index.jsonl` 的行算成面板要的数字。
 *
 * 纯函数、不碰文件——调用方读索引后丢进来，这样能用真实索引直接跑验证。
 *
 * 口径（很重要，写死在注释里免得后人改歪）：
 *   - **一次尝试（attempt）= 一条 `card_start`**。同一个工单（card）跑多个 run 就是多次尝试，
 *     也就是用户说的「重试」；`retries = attempts - 1`。
 *   - 一次尝试的结局 = 该 run 里紧随其后的 `card_done` / `card_failed` / `card_skipped` /
 *     `card_blocked`；`card_done` 且 note ∈ {done, preview, 空} 算成功。
 *   - **一次通过** = 该工单的第一次尝试就成功。`firstTryRate = 一次通过的工单 / 工单数`。
 *   - 时长只在成功的尝试上统计（失败的没意义）：`card_start` → 结束事件的毫秒差。
 *   - `done → done` 这种（第一次就成了又跑一遍）也算重试，但序列能看出来，不是失败。
 */

/** 成功判定：card_done 且不是被 special 状态顶掉的。 */
const OK_STATUS = new Set(['done', 'preview', ''])

/** 尝试的结局事件 → 状态名。 */
const END_KINDS = new Set(['card_done', 'card_failed', 'card_skipped', 'card_blocked'])

function endStatus(row) {
  if (row.kind === 'card_done') return String(row.note || 'done').trim() || 'done'
  return String(row.kind || '').replace(/^card_/, '')
}

function isOk(status) {
  return OK_STATUS.has(String(status || ''))
}

/** 本地时区的 YYYY-MM-DD。 */
export function dayKey(t) {
  const d = new Date(Number(t) || 0)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function percentile(values, p) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)))]
}

/** 失败原因聚类用：去掉数字和超长尾巴，把同类错误并成一条。 */
function normalizeNote(note) {
  return String(note || '')
    .replace(/\b[0-9a-f]{7,40}\b/gi, '<sha>')
    .replace(/\d{4,}/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 90)
}

/**
 * @param {Array<object>} rows index.jsonl 的行（已按时间排序）
 * @param {{from?: number, to?: number, days?: number}} [opts]
 */
export function computeStats(rows, opts = {}) {
  const now = Date.now()
  const days = Math.max(1, Math.min(120, Number(opts.days) || 14))
  const to = Number(opts.to) || now + 1
  const from = Number(opts.from) || (() => {
    const d = new Date(now)
    d.setHours(0, 0, 0, 0)
    return d.getTime() - (days - 1) * 86_400_000
  })()

  const inRange = rows.filter((r) => Number(r.t) >= from && Number(r.t) < to)

  // ---- 卡片维度：一张卡 = 一个工单，attempts 里放每次尝试 ----
  const cards = new Map()
  for (const row of inRange) {
    if (!row.card) continue
    const card = String(row.card)
    const slot = cards.get(card) || { card, title: '', attempts: [], merged: [], stations: new Set() }
    if (row.title && !slot.title) slot.title = String(row.title).slice(0, 80)
    if (row.station) slot.stations.add(String(row.station))
    if (row.kind === 'card_start') {
      slot.attempts.push({ runId: String(row.runId || ''), start: Number(row.t), end: 0, status: '', sha: '' })
    } else if (END_KINDS.has(row.kind)) {
      // 配对：同一 run 里最近一个还没有结局的尝试
      const open = [...slot.attempts].reverse().find((a) => !a.status && a.runId === String(row.runId || ''))
        || [...slot.attempts].reverse().find((a) => !a.status)
      const status = endStatus(row)
      if (open) {
        open.status = status
        open.end = Number(row.t)
        open.sha = String(row.sha || '')
      } else {
        // 没有 card_start 的结局（索引是中途开始记的，或卡被 blocked 在认领前）
        slot.attempts.push({ runId: String(row.runId || ''), start: Number(row.t), end: Number(row.t), status, sha: String(row.sha || '') })
      }
    } else if (row.kind === 'merged') {
      slot.merged.push({ t: Number(row.t), sha: String(row.sha || ''), note: String(row.note || '') })
    }
    cards.set(card, slot)
  }

  const cardList = [...cards.values()].map((slot) => {
    const attempts = slot.attempts.length
    const retries = Math.max(0, attempts - 1)
    const okAttempts = slot.attempts.filter((a) => isOk(a.status) && a.end > a.start)
    const minutes = okAttempts.map((a) => Math.round((a.end - a.start) / 60_000))
    const first = slot.attempts.length ? Math.min(...slot.attempts.map((a) => a.start)) : 0
    const last = slot.attempts.length ? Math.max(...slot.attempts.map((a) => a.end || a.start)) : 0
    const statuses = slot.attempts.map((a) => a.status || '未完成')
    return {
      card: slot.card,
      title: slot.title,
      attempts,
      retries,
      statuses,
      lastStatus: statuses[statuses.length - 1] || '',
      firstOk: isOk(statuses[0]),
      sha: [...slot.attempts].reverse().find((a) => a.sha)?.sha || '',
      merged: slot.merged.length ? slot.merged[slot.merged.length - 1].sha : '',
      stations: [...slot.stations],
      first,
      last,
      spanMinutes: Math.round((last - first) / 60_000),
      minutes: minutes.length ? Math.max(...minutes) : 0,
    }
  })

  const doneCards = cardList.filter((c) => isOk(c.lastStatus))
  const allOkMinutes = cardList.flatMap((c) => (c.minutes > 0 ? [c.minutes] : []))

  // ---- 天维度：吞吐趋势 ----
  const byDay = new Map()
  const daySlot = (key) => {
    const slot = byDay.get(key) || { date: key, runs: new Set(), attempts: 0, cards: new Set(), done: 0, failed: 0, merged: 0, jobFails: 0, minutes: [] }
    byDay.set(key, slot)
    return slot
  }
  for (const row of inRange) {
    const slot = daySlot(dayKey(row.t))
    if (row.runId) slot.runs.add(String(row.runId))
    if (row.card) slot.cards.add(String(row.card))
    if (row.kind === 'card_start') slot.attempts++
    if (END_KINDS.has(row.kind)) {
      if (isOk(endStatus(row))) slot.done++
      else slot.failed++
    }
    if (row.kind === 'merged') slot.merged++
    if (row.kind === 'job_failed') slot.jobFails++
  }
  // 当天成功尝试的时长（从 attempt 里取，按结束时间归日）
  for (const slot of cards.values()) {
    for (const a of slot.attempts) {
      if (!isOk(a.status) || a.end <= a.start) continue
      daySlot(dayKey(a.end)).minutes.push(Math.round((a.end - a.start) / 60_000))
    }
  }
  const dayList = [...byDay.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((slot) => ({
      date: slot.date,
      runs: slot.runs.size,
      attempts: slot.attempts,
      cards: slot.cards.size,
      done: slot.done,
      failed: slot.failed,
      merged: slot.merged,
      jobFails: slot.jobFails,
      p50: percentile(slot.minutes, 0.5),
    }))

  // ---- 失败原因 Top ----
  const failures = new Map()
  for (const row of inRange) {
    const kinds = new Set(['card_failed', 'card_skipped', 'card_blocked', 'card_after_sync_failed', 'job_failed', 'loop_blocked'])
    if (!kinds.has(String(row.kind || ''))) continue
    if (String(row.kind) === 'card_done') continue
    const note = normalizeNote(row.note) || '（没写原因）'
    const key = `${row.kind}|${note}`
    const slot = failures.get(key) || { kind: String(row.kind), note, count: 0, cards: new Set() }
    slot.count++
    if (row.card) slot.cards.add(String(row.card))
    failures.set(key, slot)
  }
  const failureList = [...failures.values()]
    .map((f) => ({ kind: f.kind, note: f.note, count: f.count, cards: f.cards.size }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 12)

  // ---- 工位维度 ----
  // 只看真正跑过卡的事件：job/merged 事件的 station 填的是工位展示名（如「b · 自动」），
  // 混进来会把排行榜画成一堆 0 次尝试的幽灵行。
  const stations = new Map()
  for (const row of inRange) {
    if (!row.station) continue
    if (row.kind !== 'card_start' && !END_KINDS.has(row.kind)) continue
    const slot = stations.get(String(row.station)) || { name: String(row.station), attempts: 0, done: 0, merged: 0, minutes: 0 }
    if (row.kind === 'card_start') slot.attempts++
    if (END_KINDS.has(row.kind) && isOk(endStatus(row))) slot.done++
    stations.set(String(row.station), slot)
  }
  for (const card of cardList) {
    const name = card.stations[0]
    if (name && stations.has(name)) stations.get(name).minutes += card.minutes
  }
  const stationList = [...stations.values()].filter((s) => s.attempts > 0).sort((a, b) => b.attempts - a.attempts)

  const attempts = cardList.reduce((n, c) => n + c.attempts, 0)
  // 索引实际覆盖到哪：面板上要写出来，否则「近 14 天」和「只有 5 天有数」会被当成统计坏了。
  // 注意 runs/ 里的历史卡片比索引多（索引从回填那天开始），两个数字本来就不该相等。
  const firstEvent = rows.length ? Math.min(...rows.map((r) => Number(r.t) || 0)) : 0
  const lastEvent = rows.length ? Math.max(...rows.map((r) => Number(r.t) || 0)) : 0

  return {
    range: { from, to, days, coverage: { first: firstEvent, last: lastEvent, rows: rows.length } },
    totals: {
      cards: cardList.length,
      attempts,
      retries: Math.max(0, attempts - cardList.length),
      retriedCards: cardList.filter((c) => c.retries > 0).length,
      firstTryOk: cardList.filter((c) => c.firstOk).length,
      firstTryRate: cardList.length ? Math.round((cardList.filter((c) => c.firstOk).length / cardList.length) * 100) : 0,
      done: doneCards.length,
      unresolved: cardList.length - doneCards.length,
      merged: cardList.filter((c) => c.merged).length,
      mergedEvents: inRange.filter((r) => r.kind === 'merged').length,
      p50Minutes: percentile(allOkMinutes, 0.5),
      p90Minutes: percentile(allOkMinutes, 0.9),
      rows: inRange.length,
    },
    days: dayList,
    retriedCards: cardList
      .filter((c) => c.retries > 0)
      .sort((a, b) => b.retries - a.retries || b.last - a.last)
      .slice(0, 20),
    failures: failureList,
    stations: stationList,
  }
}
