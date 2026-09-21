#!/usr/bin/env node
/**
 * drain：把收件箱抽干一次，跑完就退。**不是常驻进程。**
 *
 * 谁踢它：写事件的那个进程（afk-run / afk-watch / 问卷服务）写完信顺手 detached 踢一脚。
 * 它不持状态：杀掉它、晚点再跑，信还在收件箱里，一条不丢。
 *
 * 一轮：
 *   读 unread → 按需求分组 → 反查需求本子 → 看心跳 → 抢锁
 *   → 给那个 session 追一轮（runner 层负责翻译成各 CLI 的命令）
 *   → 成功把 unread 推到 seen（不碰轮内已经自己 ack 的条目）；失败记一次尝试次数
 *
 * 三件**故意不做**的事：
 * - 不替人验收：Two steps 的第二件只有人能点，所以叫醒词里明确禁止。
 * - 不静默丢：叫不醒的事件留在 unread，并在报告里点名（blocked 桶）。
 * - 不读 config.json：runner 设置走 CLI / env，避免把 token 带进日志。
 * - 每轮顺手把结论追加进 <AFK home>/wake-log.jsonl：踢它的人用 stdio:'ignore' 起进程，
 *   不留一份就等于没发生（--no-log 可关）。
 *
 * CLI：
 *   node drain.mjs [--requirement <id>] [--runner pi] [--dry-run] [--json] [--timeout <秒>]
 * 退出码：0 敲了至少一个 / 3 没得敲 / 2 出错。
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afkHomeRoot } from './afk-home.mjs'
import { DEFAULT_STUCK_SEEN_MS, isStuckSeen, listInboxItems, readInboxItem, updateInboxItem } from './inbox.mjs'
import {
  DEFAULT_HEARTBEAT_MS,
  findRequirementById,
  isHeartbeatFresh,
  readRequirementRecord,
  requirementDir,
  resolveEventRequirement,
} from './requirement.mjs'
import { isProcessAlive } from '../../exec-review/scripts/workdir-session.mjs'
import { createRunner, runnerSessionMode } from '../../exec-review/scripts/runners/index.mjs'

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000
const DEFAULT_STALE_LOCK_MS = 30 * 60 * 1000
const DEFAULT_MAX_ATTEMPTS = 3
const INBOX_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'inbox.mjs')
const CHECKIN_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'checkin.mjs')

function localStamp(ts) {
  const d = new Date(ts)
  const pad = (n) => String(n).padStart(2, '0')
  return (
    String(d.getFullYear()) + pad(d.getMonth() + 1) + pad(d.getDate()) +
    '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds())
  )
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

// ------------------------------------------------------- 每个需求一把锁

function lockFileFor(home, projectKey, requirementId) {
  return join(requirementDir(home, projectKey), `${requirementId}.lock`)
}

/**
 * 抢锁。用 `wx` 打开是原子的——两个 drain 同时跑只有一个能抢到。
 * 持有者进程死了、或者锁太旧，就当陈旧抢过来。
 */
function acquireLock(file, { now, staleMs }) {
  const tryCreate = () => {
    const fd = openSync(file, 'wx')
    writeSync(fd, `${JSON.stringify({ pid: process.pid, startedAt: now })}\n`)
    closeSync(fd)
  }

  try {
    tryCreate()
    return { ok: true }
  } catch (err) {
    if (err.code !== 'EEXIST') throw err
  }

  const held = readJson(file)
  const alive = held?.pid ? isProcessAlive(held.pid) : false
  const fresh = held?.startedAt ? now - held.startedAt < staleMs : false
  if (alive && fresh) return { ok: false, holder: held }

  // 陈旧：删掉重抢。删和抢之间可能被别人插队，那就下一轮再来。
  try {
    unlinkSync(file)
  } catch {
    /* 已被别人清掉 */
  }
  try {
    tryCreate()
    return { ok: true, stole: held }
  } catch (err) {
    if (err.code === 'EEXIST') return { ok: false, holder: readJson(file) }
    throw err
  }
}

function releaseLock(file) {
  const held = readJson(file)
  if (held?.pid !== process.pid) return false
  try {
    unlinkSync(file)
    return true
  } catch {
    return false
  }
}

// ------------------------------------------------------- 叫醒词

/**
 * 叫醒词只给指针，不给正文——正文在收件箱和报告文件里，让它自己去读。
 * 明确禁止替人验收，因为那是 Two steps 里唯一属于人的第二步。
 * 第一句是报到：SKILL 的「每轮先报到」也管唤醒轮，而唤醒轮没有人机对话在替它续心跳。
 */
export function buildWakePrompt({ record, items }) {
  const title = record.title ? `「${record.title}」` : ''
  // 唤醒轮没有 runner 的 session 环境变量可用时，靠这里注入的 reference 把需求认回来。
  const checkinArgs = [`--requirement ${record.requirementId}`]
  if (record.sessionRef) checkinArgs.push(`--session "${record.sessionRef}"`)
  if (record.runner) checkinArgs.push(`--runner ${record.runner}`)
  return [
    `[AFK] 需求 ${record.requirementId}${title} 收到 ${items.length} 条事件：`,
    ...items.map((item) => `- ${item.kind}: ${item.title || '(无标题)'}${item.nextStep ? `  → ${item.nextStep}` : ''}`),
    '',
    `先报到（盖心跳 + 取收件箱）：node "${CHECKIN_SCRIPT}" ${checkinArgs.join(' ')}`,
    '',
    `再读原始记录（不要只凭这段摘要行动）：node "${INBOX_SCRIPT}" --list --state unread`,
    '',
    '规则：',
    '- 能自己做完的做完；命中 Stop-and-ask 清单的才要人决定。',
    '- 验收是人点的那一下：准备到「只差他点」为止。',
    `- 处理完把条目标掉：node "${INBOX_SCRIPT}" --ack <id> --done`,
  ].join('\n')
}

// ------------------------------------------------------- 主流程

function groupByRequirement(items) {
  const groups = new Map()
  const unrouted = []
  for (const item of items) {
    if (!item.requirementId) {
      unrouted.push(item)
      continue
    }
    const key = `${item.projectKey}\u0000${item.requirementId}`
    if (!groups.has(key)) {
      groups.set(key, {
        projectKey: item.projectKey,
        requirementId: item.requirementId,
        items: [],
        routedByInbox: false,
      })
    }
    const group = groups.get(key)
    group.items.push(item)
    if (item.routedBy === 'inbox') group.routedByInbox = true
  }
  return { groups: [...groups.values()], unrouted }
}

/**
 * 事件可能带着工单却没带需求号（生产者算不出，或者干脆没算）。
 * 队列这一侧再试一次反查——这是三层路由的第三层。
 * 只用 workItems，不看环境变量：环境变量那一层生产者已经用过了，
 * 这里再看一遍只会把 drain 自己的环境误用到别人的事件上。
 */
function routeItem(item, { home }) {
  if (item.requirementId) return item
  const found = resolveEventRequirement({ home, explicit: '', env: {}, workItems: item.workItems || [] })
  return found ? { ...item, requirementId: found.requirementId, routedBy: 'inbox' } : item
}

/**
 * 抽干一次。纯函数式地返回报告，退出码由 CLI 决定。
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun] 只做判断，不真的跑 turn
 * @param {Function} [opts.createRunnerFn] 注入 runner 工厂（测试用）；默认用真的 createRunner
 */
export async function drainInbox({
  home = afkHomeRoot(),
  runnerOverride = '',
  model = '',
  provider = '',
  thinking = '',
  onlyRequirement = '',
  cacheRoot = join(tmpdir(), 'afk-wake'),
  timeoutMs = Number(process.env.AFK_WAKE_TIMEOUT_MS || 0) || DEFAULT_TIMEOUT_MS,
  staleLockMs = DEFAULT_STALE_LOCK_MS,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  heartbeatWindowMs = DEFAULT_HEARTBEAT_MS,
  stuckSeenMs = DEFAULT_STUCK_SEEN_MS,
  dryRun = false,
  now = Date.now(),
  createRunnerFn = createRunner,
} = {}) {
  const report = {
    at: now,
    scanned: 0,
    woke: [],
    waiting: [],
    blocked: [],
    unrouted: [],
    failed: [],
    stuck: [],
    dryRun,
  }

  const items = listInboxItems({ home, states: ['unread'] })
  report.scanned = items.length

  // 「叫醒了但一直没处理完」：这些条目已经不在 unread 里，所以既不叫醒、也不出声。
  // 每轮顺手点一次名，让页面和 wake-log 看得见。**不改它们**——已经敲过了，
  // 再敲一次是重复劳动（可能重复干活），升级成人看才是对的。
  report.stuck = listInboxItems({ home, states: ['seen'] })
    .filter((item) => isStuckSeen(item, { now, windowMs: stuckSeenMs }))
    .map((item) => ({
      id: item.id,
      kind: item.kind,
      requirementId: item.requirementId || '',
      title: item.title || '',
      seenAt: item.seenAt || item.updatedAt || 0,
    }))

  if (items.length === 0) return report

  const { groups, unrouted } = groupByRequirement(items.map((item) => routeItem(item, { home })))
  report.unrouted = unrouted.map((item) => ({ id: item.id, kind: item.kind, projectKey: item.projectKey }))

  for (const group of groups) {
    const { projectKey, requirementId } = group
    if (onlyRequirement && requirementId !== onlyRequirement) continue

    const push = (bucket, reason, extra = {}) =>
      report[bucket].push({ requirementId, projectKey, items: group.items.map((i) => i.id), reason, ...extra })

    // 先用事件自带的 projectKey 查；查不到就扫所有项目——生产者不一定知道需求住在哪个项目
    const record =
      readRequirementRecord({ home, projectKey, requirementId }) ||
      findRequirementById({ home, requirementId })
    if (!record) {
      push('blocked', '需求本子不存在（事件认领了一个查不到的需求）')
      continue
    }
    if (record.closedAt) {
      push('blocked', `需求已结束（${new Date(record.closedAt).toISOString()}），新事件需要人看一眼`)
      continue
    }

    const runnerName = runnerOverride || record.runner
    if (!runnerName) {
      push('blocked', '需求本子没记 runner，不知道用哪个 CLI 叫醒')
      continue
    }
    if (!record.sessionRef) {
      push('blocked', '需求本子没有 session reference，没法接着聊')
      continue
    }
    if (!record.workdir) {
      push('blocked', '需求本子没有 workdir')
      continue
    }

    const sessionMode = runnerSessionMode(runnerName)
    if (sessionMode === 'none') {
      push('blocked', `runner ${runnerName} 不支持续会话，只能人工接手（或换 runner）`)
      continue
    }

    const pending = group.items.filter((item) => (item.wakeAttempts || 0) < maxAttempts)
    const exhausted = group.items.filter((item) => (item.wakeAttempts || 0) >= maxAttempts)
    if (exhausted.length) {
      push('blocked', `已叫醒 ${maxAttempts} 次仍失败，停止重试`, {
        items: exhausted.map((i) => i.id),
        lastError: exhausted[0].lastWakeError || '',
      })
    }
    if (pending.length === 0) continue

    if (isHeartbeatFresh(record, { now, windowMs: heartbeatWindowMs })) {
      push('waiting', `心跳还新鲜（${Math.round((now - record.heartbeatAt) / 1000)}s 前有人动过），这轮不敲`, {
        items: pending.map((i) => i.id),
      })
      continue
    }

    const lockFile = lockFileFor(home, record.projectKey || projectKey, requirementId)
    const lock = acquireLock(lockFile, { now, staleMs: staleLockMs })
    if (!lock.ok) {
      push('waiting', '锁被另一轮占用', { holderPid: lock.holder?.pid || 0, items: pending.map((i) => i.id) })
      continue
    }

    const runDir = join(cacheRoot, `wake-${localStamp(now)}-${requirementId}`)
    // 如果需求号是队列这一侧反查出来的，落盘时一并记上，免得下轮再查一遍、页面上也好看
    const routePatch = group.routedByInbox ? { requirementId } : {}
    try {
      const prompt = buildWakePrompt({ record, items: pending })
      if (!dryRun) mkdirSync(runDir, { recursive: true })

      if (dryRun) {
        report.woke.push({
          requirementId, projectKey, items: pending.map((i) => i.id),
          runner: runnerName, sessionMode, runDir, prompt, dryRun: true,
        })
        continue
      }

      const controller = new AbortController()
      const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null
      let runResult
      try {
        const runner = createRunnerFn(runnerName, { model, provider, thinking })
        runResult = await runner.runTurn({
          role: 'executor',
          workdir: record.workdir,
          prompt,
          session: record.sessionRef,
          outFile: join(runDir, 'out.md'),
          logFile: join(runDir, 'run.log'),
          eventsFile: join(runDir, 'events.jsonl'),
          model, provider, thinking,
          signal: controller.signal,
        })
      } finally {
        if (timer) clearTimeout(timer)
      }

      if (runResult.code !== 0) {
        throw new Error(`runner 退出码 ${runResult.code}${runResult.aborted ? '（超时中止）' : ''}`)
      }

      // 敲通了才算看过。只把 **unread** 推到 seen——done 由被叫醒的那一轮自己决定：
      // 它可能在轮内已经 ack --done，这里是收尾，不是裁判，不能把它的结论回退成 seen。
      for (const item of pending) {
        const fresh = readInboxItem(item.id, { home })
        if (!fresh) continue // 轮内被人删了：没什么可记的，不该弄崩整轮
        if (fresh.state === 'unread') {
          updateInboxItem(
            item.id,
            { state: 'seen', note: `drain 已叫醒 ${runnerName}（${localStamp(now)}）`, ...routePatch },
            { home },
          )
        } else if (Object.keys(routePatch).length) {
          // 轮内已经走过一步（seen / done）：只补路由，不动状态，也不盖掉处理人的备注
          updateInboxItem(item.id, { ...routePatch }, { home })
        }
      }
      report.woke.push({
        requirementId, projectKey, items: pending.map((i) => i.id),
        runner: runnerName, sessionMode, runDir,
      })
    } catch (err) {
      const message = err?.message || String(err)
      for (const item of pending) {
        updateInboxItem(
          item.id,
          { wakeAttempts: (item.wakeAttempts || 0) + 1, lastWakeError: message, ...routePatch },
          { home },
        )
      }
      report.failed.push({ requirementId, projectKey, items: pending.map((i) => i.id), error: message, runDir })
    } finally {
      releaseLock(lockFile)
    }
  }

  return report
}

// ------------------------------------------------------- 叫醒记录（持久）

/**
 * 叫醒记录落一份磁盘副本。
 *
 * `kickDrain` 用 detached + stdio:'ignore' 起进程——drain 的标准输出**没人接**，
 * 五个桶（敲醒 / 等下一轮 / 叫不醒 / 无主 / 叫了但失败）看完就没了。
 * 不留一份，事后就只能猜「唤醒环到底干过什么」。
 */
export function wakeLogPath(home = afkHomeRoot()) {
  return join(home, 'wake-log.jsonl')
}

/** 超过这个体积就只留最后几条：它是流水，不是账本。 */
const WAKE_LOG_MAX_BYTES = 256 * 1024
const WAKE_LOG_KEEP_LINES = 200

/** 把一轮报告压成日志条目——只留指针与计数，不放大段正文。 */
export function wakeLogEntry(report) {
  const ids = (list) => list.flatMap((entry) => entry.items || [])
  return {
    at: report.at,
    scanned: report.scanned,
    dryRun: Boolean(report.dryRun),
    woke: (report.woke || []).map((entry) => ({
      requirementId: entry.requirementId,
      runner: entry.runner || '',
      items: entry.items || [],
      runDir: entry.runDir || '',
    })),
    waiting: (report.waiting || []).map((entry) => ({
      requirementId: entry.requirementId,
      reason: entry.reason || '',
      items: entry.items || [],
    })),
    blocked: (report.blocked || []).map((entry) => ({
      requirementId: entry.requirementId,
      reason: entry.reason || '',
      items: entry.items || [],
    })),
    unrouted: (report.unrouted || []).map((entry) => ({
      id: entry.id,
      kind: entry.kind || '',
      projectKey: entry.projectKey || '',
    })),
    failed: (report.failed || []).map((entry) => ({
      requirementId: entry.requirementId,
      error: entry.error || '',
      items: entry.items || [],
    })),
    stuck: report.stuck || [],
    itemCount: ids(report.woke || []).length + ids(report.waiting || []).length +
      ids(report.blocked || []).length + ids(report.failed || []).length +
      (report.unrouted || []).length,
  }
}

/** 这一轮值不值得记：什么都没碰到就别长大长。 */
export function isNoteworthy(report) {
  return report.scanned > 0 || (report.stuck || []).length > 0
}

/**
 * 追加一轮记录。**不抛**：写不成日志不能弄挂唤醒环，只能少一份痕迹。
 * @returns {string} 写入的路径；没写时为空串
 */
export function appendWakeLog(report, { home = afkHomeRoot(), log = () => {} } = {}) {
  if (!isNoteworthy(report)) return ''
  const file = wakeLogPath(home)
  try {
    mkdirSync(dirname(file), { recursive: true })
    // 太大先压：留尾部若干行。原子写，读者不会撞到半截文件。
    try {
      if (statSync(file).size > WAKE_LOG_MAX_BYTES) {
        const kept = readWakeLog({ home, limit: WAKE_LOG_KEEP_LINES, raw: true })
        writeFileSync(`${file}.tmp`, kept.map((line) => `${line}\n`).join(''), 'utf8')
        renameSync(`${file}.tmp`, file)
      }
    } catch {
      /* 文件不存在或读不动：继续追加 */
    }
    appendFileSync(file, `${JSON.stringify(wakeLogEntry(report))}\n`, 'utf8')
    return file
  } catch (err) {
    log(`[afk] 写唤醒记录失败（忽略）: ${err.message}`)
    return ''
  }
}

/**
 * 读尾部若干条，新的在前。坏行跳过。
 * @param {object} [opts]
 * @param {boolean} [opts.raw] 原样返回行（供压缩时回写）
 */
export function readWakeLog({ home = afkHomeRoot(), limit = 10, raw = false } = {}) {
  const file = wakeLogPath(home)
  if (!existsSync(file)) return []
  let lines = []
  try {
    lines = readFileSync(file, 'utf8').split('\n').filter((line) => line.trim())
  } catch {
    return []
  }
  const tail = lines.slice(Math.max(0, lines.length - limit))
  if (raw) return tail
  const entries = []
  for (const line of tail) {
    try {
      const parsed = JSON.parse(line)
      if (parsed && typeof parsed === 'object') entries.push(parsed)
    } catch {
      /* 半截行：跳过 */
    }
  }
  return entries.reverse()
}

// ------------------------------------------------------- CLI

function parseArgs(argv) {
  const args = { json: false, dryRun: false }
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i]
    if (value === '--requirement') args.requirement = argv[++i] || ''
    else if (value === '--runner') args.runner = argv[++i] || ''
    else if (value === '--model') args.model = argv[++i] || ''
    else if (value === '--provider') args.provider = argv[++i] || ''
    else if (value === '--thinking') args.thinking = argv[++i] || ''
    else if (value === '--timeout') args.timeout = Number(argv[++i] || 0)
    else if (value === '--max-attempts') args.maxAttempts = Number(argv[++i] || 0)
    else if (value === '--cache-dir') args.cacheDir = argv[++i] || ''
    else if (value === '--dry-run') args.dryRun = true
    else if (value === '--no-log') args.noLog = true
    else if (value === '--json') args.json = true
    else if (value === '--help' || value === '-h') args.help = true
  }
  return args
}

const USAGE = [
  'node drain.mjs [--requirement <id>] [--runner pi] [--dry-run] [--json] [--timeout <秒>] [--no-log]',
  '',
  '把收件箱抽干一次，跑完就退。写事件的一方负责踢它。',
  '每轮顺手把结论追加到 <AFK home>/wake-log.jsonl（--no-log 可关）。',
  '退出码: 0 敲了至少一个 / 3 没得敲 / 2 出错',
].join('\n')

function printReport(report) {
  const lines = [`收件箱 ${report.scanned} 条未读${report.dryRun ? '（dry-run）' : ''}`]
  const show = (label, list, fmt) => {
    if (!list.length) return
    lines.push(`${label} ${list.length}`)
    for (const entry of list) lines.push(`  ${fmt(entry)}`)
  }
  show('敲醒', report.woke, (e) => `${e.requirementId} → ${e.runner} (${e.items.length} 条)  ${e.runDir || ''}`)
  show('等下一轮', report.waiting, (e) => `${e.requirementId}: ${e.reason}`)
  show('叫不醒，要人', report.blocked, (e) => `${e.requirementId}: ${e.reason}${e.lastError ? ` — ${e.lastError}` : ''}`)
  show('无主', report.unrouted, (e) => `${e.id} (${e.kind}, 项目 ${e.projectKey || '未知'}) — 没有需求认领它`)
  show('叫了但失败', report.failed, (e) => `${e.requirementId}: ${e.error}`)
  show(
    '叫醒了但一直没处理',
    report.stuck || [],
    (e) => `${e.requirementId || '无主'}: ${e.title || e.kind}（${e.id}）`,
  )
  return lines.join('\n')
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }

  const report = await drainInbox({
    runnerOverride: args.runner || '',
    model: args.model || '',
    provider: args.provider || '',
    thinking: args.thinking || '',
    onlyRequirement: args.requirement || '',
    cacheRoot: args.cacheDir || undefined,
    timeoutMs: args.timeout ? args.timeout * 1000 : undefined,
    maxAttempts: args.maxAttempts || undefined,
    dryRun: args.dryRun,
  })

  // 默认落一份持久记录：踢我们的人把 stdout 丢了，不写就等于没发生。
  if (!args.noLog && !args.dryRun) {
    const logged = appendWakeLog(report, { log: (line) => console.error(line) })
    report.logFile = logged
  }

  process.stdout.write(`${args.json ? JSON.stringify(report, null, 2) : printReport(report)}\n`)
  if (report.failed.length > 0) return 2
  if (report.woke.length > 0) return 0
  return 3
}

const isMain =
  process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
if (isMain) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err?.stack || err?.message || String(err))
      process.exit(2)
    })
}
