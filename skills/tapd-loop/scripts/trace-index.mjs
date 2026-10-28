/**
 * 全链路追溯索引：`~/.tapd-loop/index.jsonl`（append-only）。
 *
 * 为什么要有它：一张卡的链路散在四处，而且互相没有关联键——
 *   - `runs/<runId>/<cardId>/`（事件、brief、diff、verify/after-sync 日志）
 *   - `runs/<runId>/progress.jsonl`（批次时间线，但每批一份，得先知道 runId）
 *   - `board-control.json` 的 `jobs[]`（合入/推送，只有工位名，没有卡片）
 *   - `board-batches/*.log`（合入明细）
 * 想回答「这张卡从头到尾发生了什么」「今天都干了什么」只能遍历 41 个 run 目录去 grep，
 * 而单卡 `events.jsonl` 就有 31MB。
 *
 * 所以每个关键节点往这一个文件追加一行，`trace.mjs` 只读它（毫秒级）。写失败绝不影响干活。
 * 索引是「旁路」：删掉它照样能跑，`trace.mjs --rebuild` 可以从 runs/ + board-control.json 重建。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

export const INDEX_NAME = 'index.jsonl'

/** 索引文件位置。 */
export function indexPath(home) {
  return join(home, INDEX_NAME)
}

/**
 * 追加一条事件。字段尽量少，但要能把这些串起来：时间、批次、卡片、提交、工位。
 *   t        毫秒时间戳
 *   kind     阶段名（loop_start / card_start / card_phase / card_done / merged / job_done …）
 *   runId    批次（run-YYYYMMDDHHMMSS）；合入/推送类事件来自看板进程，没有 runId
 *   card     工单 id
 *   sha      提交号（10 位）；merged 是主树提交
 *   note     一句话（阶段名 / 失败原因 / 分支流转）
 *   station  工位目录名（DigitDoor-wt-a）
 *   title    卡片标题（截断）
 *   job/log/exit  job 类事件用
 */
export function appendTrace(home, entry) {
  try {
    mkdirSync(home, { recursive: true })
    appendFileSync(indexPath(home), `${JSON.stringify(entry)}\n`, 'utf8')
  } catch {
    // 索引只是追溯旁路：写不进去绝不能挡住干活
  }
}

/** 读回全部事件，按时间排序。坏行/半行跳过，不让一行脏数据废掉整个索引。 */
export function readTrace(home) {
  const file = indexPath(home)
  if (!existsSync(file)) return []
  const out = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const text = line.trim()
    if (!text) continue
    try {
      out.push(JSON.parse(text))
    } catch {
      // 写到一半的行（进程被杀）直接跳过
    }
  }
  return out.sort((a, b) => Number(a.t || 0) - Number(b.t || 0) || 0)
}

/**
 * progress.jsonl 的一条事件 → 索引行。
 *
 * loop.mjs 实时写和 trace.mjs --rebuild 回填**都走这个函数**：两条路产出的必须是同一个对象，
 * 回填才能按「整行 JSON 相同」去重，不会把同一件事记两遍。
 */
export function progressToTrace(event, ctx) {
  const data = event || {}
  return {
    t: Number(data.t || Date.now()),
    kind: String(data.event || data.kind || 'event'),
    runId: String(ctx.runId || ''),
    card: String(data.id || ctx.card || ''),
    sha: String(data.commit || data.to || '').slice(0, 10),
    note: String(data.phase || data.reason || data.status || (data.code != null ? `exit ${data.code}` : '')).slice(0, 120),
    station: String(ctx.workdir ? basename(String(ctx.workdir).replace(/[\\/]+$/, '')) : ''),
    title: String(data.title || '').slice(0, 60),
  }
}

/** 心跳太吵（一张卡几十条），进索引没意义。 */
export function isNoise(event) {
  return String(event?.event || event?.kind || '') === 'heartbeat'
}

/** `2026-10-28` / `20261028` / `2026/10/28` → 当地时区的 [起, 止) 毫秒区间。 */
export function dayRange(input) {
  const text = String(input || '').replace(/[^\d]/g, '')
  if (text.length !== 8) return null
  const [y, m, d] = [text.slice(0, 4), text.slice(4, 6), text.slice(6, 8)].map(Number)
  const from = new Date(y, m - 1, d, 0, 0, 0, 0).getTime()
  const to = new Date(y, m - 1, d + 1, 0, 0, 0, 0).getTime()
  if (!Number.isFinite(from) || from <= 0) return null
  return { from, to, label: `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` }
}

/** 毫秒 → `2026-10-28 12:30:28`（本地时区）。 */
export function fmtTime(t) {
  const d = new Date(Number(t) || 0)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
