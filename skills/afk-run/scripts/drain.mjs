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
 *   → 成功标 seen；失败记一次尝试次数
 *
 * 三件**故意不做**的事：
 * - 不替人验收：Two steps 的第二件只有人能点，所以叫醒词里明确禁止。
 * - 不静默丢：叫不醒的事件留在 unread，并在报告里点名（blocked 桶）。
 * - 不读 config.json：runner 设置走 CLI / env，避免把 token 带进日志。
 *
 * CLI：
 *   node drain.mjs [--requirement <id>] [--runner pi] [--dry-run] [--json] [--timeout <秒>]
 * 退出码：0 敲了至少一个 / 3 没得敲 / 2 出错。
 */

import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afkHomeRoot } from './afk-home.mjs'
import { ackInboxItem, listInboxItems, updateInboxItem } from './inbox.mjs'
import {
  DEFAULT_HEARTBEAT_MS,
  findRequirementById,
  isHeartbeatFresh,
  readRequirementRecord,
  requirementDir,
} from './requirement.mjs'
import { isProcessAlive } from '../../exec-review/scripts/workdir-session.mjs'
import { createRunner, runnerSessionMode } from '../../exec-review/scripts/runners/index.mjs'

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000
const DEFAULT_STALE_LOCK_MS = 30 * 60 * 1000
const DEFAULT_MAX_ATTEMPTS = 3
const INBOX_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'inbox.mjs')

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
 */
export function buildWakePrompt({ record, items }) {
  const title = record.title ? `「${record.title}」` : ''
  return [
    `[AFK] 需求 ${record.requirementId}${title} 收到 ${items.length} 条事件：`,
    ...items.map((item) => `- ${item.kind}: ${item.title || '(无标题)'}${item.nextStep ? `  → ${item.nextStep}` : ''}`),
    '',
    `先读原始记录（不要只凭这段摘要行动）：node "${INBOX_SCRIPT}" --list --state unread`,
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
      groups.set(key, { projectKey: item.projectKey, requirementId: item.requirementId, items: [] })
    }
    groups.get(key).items.push(item)
  }
  return { groups: [...groups.values()], unrouted }
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
    dryRun,
  }

  const items = listInboxItems({ home, states: ['unread'] })
  report.scanned = items.length
  if (items.length === 0) return report

  const { groups, unrouted } = groupByRequirement(items)
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

      // 敲通了才算看过。只把状态推到 seen——done 由被叫醒的那一轮自己决定。
      for (const item of pending) {
        ackInboxItem(item.id, { home, state: 'seen', note: `drain 已叫醒 ${runnerName}（${localStamp(now)}）` })
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
          { wakeAttempts: (item.wakeAttempts || 0) + 1, lastWakeError: message },
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
    else if (value === '--json') args.json = true
    else if (value === '--help' || value === '-h') args.help = true
  }
  return args
}

const USAGE = [
  'node drain.mjs [--requirement <id>] [--runner pi] [--dry-run] [--json] [--timeout <秒>]',
  '',
  '把收件箱抽干一次，跑完就退。写事件的一方负责踢它。',
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
