#!/usr/bin/env node
/**
 * 全链路追溯。读 `~/.tapd-loop/index.jsonl`，回答两个问题：
 *
 *   node scripts/trace.mjs --card 1152360842001005156     这张卡从头到尾发生了什么
 *   node scripts/trace.mjs --day 2026-10-28               这一天都跑了什么、合入了什么
 *
 * 另外两个：
 *   --sha <sha>   某个提交号出现在哪张卡/哪次合入
 *   --rebuild     从现有 runs/ + board-control.json 回填索引（历史数据一次性补齐）
 *   --stats       索引现状：多少行、覆盖哪些天、每天几批几张卡
 *
 * 索引是 append-only 的旁路：loop.mjs（卡片流程）和 control.mjs（合入/推送 job）各写一行，
 * 这个脚本只读。写失败不影响干活；索引丢了也能用 --rebuild 重建。
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import {
  appendTrace, dayRange, fmtTime, indexPath, isNoise, progressToTrace, readTrace,
} from './trace-index.mjs'

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : ''
}
const HOME = String(flag('home') || join(homedir(), '.tapd-loop'))
const RUNS = String(flag('runs') || join(HOME, 'runs'))
const asJson = Boolean(flag('json'))
const wantEvents = Boolean(flag('events'))

const USAGE = `用法：
  trace.mjs --card <工单id>           一张卡的完整链路
  trace.mjs --day 2026-10-28          这一天的工作链路（默认按卡聚合，--events 展开每条）
  trace.mjs --sha <提交号>            某提交号出现在哪张卡/哪次合入
  trace.mjs --rebuild                 从 runs/ 与 board-control.json 回填索引
  trace.mjs --stats                   索引现状
  通用：--home <dir> --runs <dir> --json --events`

function pad(text, width) {
  const s = String(text ?? '')
  // 中文字符占两列，按显示宽度补空格，否则列会歪
  const shown = [...s].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0)
  return s + ' '.repeat(Math.max(0, width - shown))
}

/** run-20261028041253 → 20261028041253（表格里省 4 列）。 */
const runTag = (runId) => String(runId || '').replace(/^run-/, '')

/** 把一条事件画成一行。 */
function line(e) {
  const cols = [
    fmtTime(e.t),
    pad(e.kind, 22),
    pad(runTag(e.runId), 15),
    pad(e.station, 16),
    pad(e.sha, 11),
    String(e.title || e.note || '').slice(0, 80),
  ]
  return cols.join(' ').replace(/\s+$/, '')
}

/** 这张卡（这个批次）在本机还留着哪些产物。 */
function artifacts(runId, cardId) {
  const dir = join(RUNS, String(runId || ''), String(cardId || ''))
  if (!runId || !cardId || !existsSync(dir)) return { dir: '', files: [] }
  try {
    const files = readdirSync(dir)
      .filter((name) => {
        try { return statSync(join(dir, name)).isFile() } catch { return false }
      })
      .sort()
    return { dir, files }
  } catch {
    return { dir: '', files: [] }
  }
}

function printCard(entries, cardId) {
  const rows = entries.filter((e) => String(e.card) === String(cardId))
  if (!rows.length) {
    console.log(`索引里没有卡片 ${cardId}。`)
    console.log('（历史批次用 --rebuild 回填；本轮之后新跑的卡会自动进索引）')
    return
  }
  const title = rows.find((e) => e.title)?.title || ''
  console.log(`卡片 ${cardId}${title ? ` · ${title}` : ''} · ${rows.length} 个事件`)
  console.log('')
  for (const e of rows) console.log(line(e))
  const runs = [...new Set(rows.map((e) => e.runId).filter(Boolean))]
  console.log('')
  console.log('本机产物：')
  for (const runId of runs) {
    const { dir, files } = artifacts(runId, cardId)
    if (!dir) {
      console.log(`  ${runId}：目录已不在（缓存目录可能被清过）`)
      continue
    }
    console.log(`  ${dir}`)
    console.log(`    ${files.join('  ')}`)
  }
}

function groupByCard(rows) {
  const map = new Map()
  for (const e of rows) {
    if (!e.card) continue
    const key = String(e.card)
    const slot = map.get(key) || { card: key, title: e.title || '', first: e.t, last: e.t, kinds: [], runIds: new Set(), sha: '' }
    slot.first = Math.min(slot.first, e.t)
    slot.last = Math.max(slot.last, e.t)
    if (e.title) slot.title = e.title
    if (e.runId) slot.runIds.add(e.runId)
    if (e.kind) slot.kinds.push(e.kind)
    if (e.sha) slot.sha = e.sha
    map.set(key, slot)
  }
  return [...map.values()].sort((a, b) => a.first - b.first)
}

function printDay(entries, range) {
  const rows = entries.filter((e) => Number(e.t) >= range.from && Number(e.t) < range.to)
  if (!rows.length) {
    console.log(`${range.label} 索引里没有任何事件。`)
    return
  }
  const runs = new Set(rows.map((e) => e.runId).filter(Boolean))
  const cards = groupByCard(rows)
  const jobs = rows.filter((e) => String(e.kind || '').startsWith('job_'))
  const merged = rows.filter((e) => e.kind === 'merged')
  console.log(`${range.label} · ${rows.length} 个事件 / ${runs.size} 个批次 / ${cards.length} 张卡 / ${merged.length} 次合入或推送 / ${jobs.length} 条 job 事件`)
  console.log('')
  console.log('按卡片：')
  for (const slot of cards) {
    const dur = Math.max(0, slot.last - slot.first)
    const mins = dur >= 60_000 ? `${Math.round(dur / 60_000)}m` : `${Math.round(dur / 1000)}s`
    console.log(`  ${slot.card}  ${pad(slot.title || '（无标题）', 28)} ${fmtTime(slot.first).slice(11)} → ${fmtTime(slot.last).slice(11)} (${mins})  ${pad(slot.sha, 11)} ${[...slot.runIds].map(runTag).join(',')}`)
  }
  if (merged.length) {
    console.log('')
    console.log('合入 / 推送：')
    for (const e of merged) console.log(`  ${fmtTime(e.t).slice(11)}  ${pad(e.card, 20)} ${pad(e.sha, 11)} ${e.note || ''}`)
  }
  if (jobs.length) {
    console.log('')
    console.log('看板 job：')
    for (const e of jobs) console.log(`  ${fmtTime(e.t).slice(11)}  ${pad(e.kind, 12)} ${pad(e.station, 16)} ${e.exit != null ? `exit ${e.exit}` : ''} ${String(e.note || '').slice(0, 70)}`)
  }
  if (wantEvents) {
    console.log('')
    console.log('全部事件：')
    for (const e of rows) console.log(`  ${line(e)}`)
  }
}

function printSha(entries, sha) {
  const needle = String(sha).toLowerCase()
  const rows = entries.filter((e) => String(e.sha || '').toLowerCase().startsWith(needle))
  if (!rows.length) {
    console.log(`索引里没有 ${sha}。（工位原始提交不会进索引的话本里，也可能它还没被合入）`)
    return
  }
  for (const e of rows) console.log(line(e))
  const card = rows.find((e) => e.card)?.card
  if (card) {
    console.log('')
    console.log(`卡片 ${card} 的完整链路：trace.mjs --card ${card}`)
  }
}

/** 从 runs/ 与 board-control.json 回填：与已有索引按键去重，已有的（信息更全）优先。 */
function rebuild() {
  const key = (e) => [e.kind, e.runId || '', e.card || '', e.sha || '', e.station || '', e.job || '', e.note || ''].join('|')
  const existing = readTrace(HOME)
  const seen = new Set(existing.map(key))
  const added = []

  const push = (entry) => {
    const k = key(entry)
    if (seen.has(k)) return
    seen.add(k)
    added.push(entry)
  }

  let runDirs = []
  try {
    runDirs = readdirSync(RUNS).filter((name) => {
      try { return statSync(join(RUNS, name)).isDirectory() } catch { return false }
    })
  } catch {
    // 没有 runs 目录：只回填看板 job
  }

  let scannedRuns = 0
  let scannedEvents = 0
  for (const runId of runDirs.sort()) {
    const file = join(RUNS, runId, 'progress.jsonl')
    if (!existsSync(file)) continue
    scannedRuns++
    let workdir = ''
    for (const text of readFileSync(file, 'utf8').split('\n')) {
      const raw = text.trim()
      if (!raw) continue
      let event
      try { event = JSON.parse(raw) } catch { continue }
      if (event.workdir) workdir = event.workdir
      if (isNoise(event)) continue
      scannedEvents++
      push(progressToTrace(event, { runId, workdir }))
    }
    // 批次结束的卡片汇总（report.md 里的状态）不单独记：card_done 事件已经带着 status/commit。
  }

  // 看板侧的合入/推送 job（这些不在 runs/ 里，只能从 board-control.json 捞）
  const controlFile = join(HOME, 'board-control.json')
  let scannedJobs = 0
  if (existsSync(controlFile)) {
    try {
      const control = JSON.parse(readFileSync(controlFile, 'utf8'))
      for (const job of Array.isArray(control.jobs) ? control.jobs : []) {
        if (!job || !job.kind) continue
        scannedJobs++
        push({
          t: Number(job.startedAt) || Date.now(),
          kind: 'job_start',
          station: String(job.name || ''),
          note: String(job.kind || ''),
          job: String(job.id || ''),
          log: job.log || '',
        })
        if (job.endedAt) {
          push({
            t: Number(job.endedAt) || Number(job.startedAt) || Date.now(),
            kind: job.status === 'done' ? 'job_done' : 'job_failed',
            station: String(job.name || ''),
            note: String(job.summary || job.kind || '').slice(0, 120),
            job: String(job.id || ''),
            exit: job.code == null ? undefined : Number(job.code),
            log: job.log || '',
          })
        }
      }
    } catch {
      // board-control.json 坏了就只回填 runs
    }
  }

  const all = [...existing, ...added].sort((a, b) => Number(a.t || 0) - Number(b.t || 0))
  try {
    writeFileSync(indexPath(HOME), all.map((e) => JSON.stringify(e)).join('\n') + (all.length ? '\n' : ''), 'utf8')
  } catch (err) {
    console.error(`写索引失败：${err.message}`)
    process.exitCode = 1
    return
  }
  console.log(JSON.stringify({
    ok: true,
    index: indexPath(HOME),
    total: all.length,
    added: added.length,
    scannedRuns,
    scannedEvents,
    scannedJobs,
  }, null, 2))
}

function printStats(entries) {
  if (!entries.length) {
    console.log('索引是空的。历史数据用 --rebuild 回填。')
    return
  }
  const days = new Map()
  for (const e of entries) {
    const d = new Date(Number(e.t) || 0)
    const label = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const slot = days.get(label) || { events: 0, runs: new Set(), cards: new Set(), merged: 0 }
    slot.events++
    if (e.runId) slot.runs.add(e.runId)
    if (e.card) slot.cards.add(e.card)
    if (e.kind === 'merged') slot.merged++
    days.set(label, slot)
  }
  const first = entries[0]
  const last = entries[entries.length - 1]
  console.log(`索引：${indexPath(HOME)}`)
  console.log(`${entries.length} 行 · ${fmtTime(first.t)} → ${fmtTime(last.t)} · 覆盖 ${days.size} 天`)
  console.log('')
  for (const label of [...days.keys()].sort()) {
    const slot = days.get(label)
    console.log(`  ${label}  ${String(slot.events).padStart(5)} 事件  ${String(slot.runs.size).padStart(2)} 批  ${String(slot.cards.size).padStart(2)} 卡  ${String(slot.merged).padStart(2)} 合入`)
  }
}

function main() {
  if (flag('help') || args.includes('-h')) {
    console.log(USAGE)
    return
  }
  if (flag('rebuild')) return rebuild()

  const entries = readTrace(HOME)
  if (asJson) {
    const card = flag('card')
    const day = flag('day')
    const sha = flag('sha')
    let rows = entries
    if (card) rows = rows.filter((e) => String(e.card) === String(card))
    if (day) {
      const range = dayRange(day)
      rows = range ? rows.filter((e) => Number(e.t) >= range.from && Number(e.t) < range.to) : []
    }
    if (sha) rows = rows.filter((e) => String(e.sha || '').toLowerCase().startsWith(String(sha).toLowerCase()))
    console.log(JSON.stringify(rows, null, 2))
    return
  }

  if (flag('stats')) return printStats(entries)
  const card = flag('card')
  if (card) return printCard(entries, card)
  const day = flag('day')
  if (day) {
    const range = dayRange(day)
    if (!range) {
      console.error(`--day 需要 YYYY-MM-DD（收到 ${day}）`)
      process.exitCode = 2
      return
    }
    return printDay(entries, range)
  }
  const sha = flag('sha')
  if (sha) return printSha(entries, sha)

  console.log(USAGE)
  if (!entries.length) console.log('\n索引是空的：先跑一批卡，或对历史数据执行 --rebuild。')
}

main()
