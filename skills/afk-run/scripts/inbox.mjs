#!/usr/bin/env node
/**
 * 收件箱：AFK 事件的唯一写入口与读入口（见 CONTEXT.md「Inbox item」）。
 *
 * 约定：
 * - 一条事件一个文件，放在 <AFK home>/inbox/。
 * - 写者不知道读者：只写文件，不发消息、不开端口、不查配置。
 * - 状态住在文件里：unread → seen → done。只有显式 ack 才改状态。
 * - 原子落盘：先写 .tmp 再 rename，读者永远看不到半个文件。
 *
 * 本模块**不读 config.json**——那里有 token，页面和日志不该碰到它。
 * 本模块也**不做路由**：调用方自己决定 requirementId，反查是 requirement.mjs 的事。
 *
 * CLI（单行 JSON 或人类可读表格）：
 *   node inbox.mjs --list [--state unread] [--project <key>] [--json]
 *   node inbox.mjs --ack <id> [--done | --seen] [--note <文字>]
 * 退出码：0 有内容 / 3 列表为空 / 2 出错。
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afkHomeRoot, resolveProjectConfigDir } from './afk-home.mjs'

const DRAIN_PATH = join(dirname(fileURLToPath(import.meta.url)), 'drain.mjs')

export const INBOX_STATES = ['unread', 'seen', 'done']

/** 未被需求认领的事件：requirementId 为 null。 */
export const UNROUTED = null

/**
 * 叫醒之后多久还没被标成 done，就算「叫醒了但没处理完」。
 * 这类事件不在 unread 里，所以既不叫醒也不出声——除了这个窗口，没有别的信号能发现它。
 */
export const DEFAULT_STUCK_SEEN_MS = 15 * 60 * 1000

/**
 * 一条 seen 事件是不是卡住了。老条目没有 `seenAt`，退回 `updatedAt`
 * ——那正是 drain 标 seen 时写的时间，之后没人再动它。
 */
export function isStuckSeen(item, { now = Date.now(), windowMs = DEFAULT_STUCK_SEEN_MS } = {}) {
  if (!item || item.state !== 'seen') return false
  const since = item.seenAt || item.updatedAt || item.createdAt || 0
  if (!since) return false
  return now - since >= windowMs
}

export function inboxDir(home = afkHomeRoot()) {
  return join(home, 'inbox')
}

/**
 * 文件名片段净化：只用于拼接文件名，**不要用在 id 上**。
 * 它会截断，套在 id 上会算出另一个文件名，导致自己写的条目找不到。
 */
function safePart(value) {
  return String(value || '')
    .replace(/[^A-Za-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
}

/** ack 的 id 由本模块生成：只校验，不加工。 */
function assertInboxId(id) {
  const value = String(id || '')
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value) || value.includes('..')) {
    throw new Error(`收件箱条目 id 非法: ${JSON.stringify(id)}`)
  }
  return value
}

function localStamp(ts) {
  const d = new Date(ts)
  const pad = (n) => String(n).padStart(2, '0')
  return (
    String(d.getFullYear()) +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    '-' +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  )
}

/** 随机后缀补齐到 4 位，id 形状才固定。 */
function salt4() {
  return Math.random().toString(36).slice(2, 6).padEnd(4, '0')
}

/**
 * 同一秒内两条事件可能抽到同一个后缀。撞了就换一个重新抽。
 * 静默覆盖是这条链路最不能接受的失败：宁可多试几次，也不能 rename 掉别人的信。
 */
function allocateInboxId(dir, makeId, attempts = 8) {
  for (let i = 0; i < attempts; i += 1) {
    const id = makeId()
    if (!existsSync(join(dir, `${id}.json`))) return id
  }
  throw new Error(`收件箱文件名连续 ${attempts} 次冲突，未写入: ${dir}`)
}

/** 原子写：tmp + rename。ack 重写同一个文件时也走这里。 */
function writeAtomic(file, record) {
  const tmp = `${file}.tmp`
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
}

/**
 * 写一条事件。调用方负责算好 requirementId（可为 null）与 workItems。
 * @param {object} item
 * @param {string} item.kind            例如 run-end / watch-stop / questionnaire-submitted
 * @param {string} [item.projectKey]    AFK home 的项目目录名
 * @param {string} [item.workdir]
 * @param {string|null} [item.requirementId]
 * @param {Array<{taskSource: string, id: string}>} [item.workItems]
 * @param {string} [item.title]         一行摘要，给人看
 * @param {object} [item.detail]        指针与计数，不放大段正文
 * @param {string} [item.nextStep]      拿到这条事件之后该做什么
 * @param {object} [opts]
 * @param {string} [opts.home]
 * @returns {object} 落盘的记录（含 id 与 file）
 */
export function writeInboxItem(item = {}, { home = afkHomeRoot() } = {}) {
  const kind = safePart(item.kind) || 'event'
  const dir = inboxDir(home)
  mkdirSync(dir, { recursive: true })

  // 生产者只要说「在哪个目录发生」就行，项目 key 由这里推——三个生产者不用各自解析一遍。
  const workdir = item.workdir || process.cwd()
  let projectKey = item.projectKey || ''
  if (!projectKey) {
    try {
      projectKey = resolveProjectConfigDir(workdir).projectKey || ''
    } catch {
      projectKey = ''
    }
  }

  const now = Date.now()
  const scope = safePart(item.requirementId || projectKey || 'unscoped')
  const id = allocateInboxId(dir, () => `${localStamp(now)}-${kind}-${scope}-${salt4()}`)

  const record = {
    id,
    kind,
    state: 'unread',
    createdAt: now,
    updatedAt: now,
    projectKey,
    workdir,
    requirementId: item.requirementId ?? UNROUTED,
    workItems: Array.isArray(item.workItems) ? item.workItems : [],
    title: item.title || '',
    detail: item.detail && typeof item.detail === 'object' ? item.detail : {},
    nextStep: item.nextStep || '',
  }

  const file = join(dir, `${id}.json`)
  writeAtomic(file, record)
  return { ...record, file }
}

/**
 * 读收件箱。按创建时间升序返回。
 * @param {object} [opts]
 * @param {string} [opts.home]
 * @param {string[]} [opts.states]        只要这些状态
 * @param {string} [opts.projectKey]
 * @param {string} [opts.requirementId]
 * @param {boolean} [opts.unroutedOnly]   只要没被需求认领的
 */
export function listInboxItems({
  home = afkHomeRoot(),
  states,
  projectKey,
  requirementId,
  unroutedOnly = false,
} = {}) {
  const dir = inboxDir(home)
  if (!existsSync(dir)) return []

  const items = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue // 跳过 .tmp 与别的文件
    try {
      const record = JSON.parse(readFileSync(join(dir, name), 'utf8'))
      if (record && record.id) items.push(record)
    } catch {
      // 半截文件或不是本模块写的：跳过，不让读者的循环崩掉
    }
  }

  return items
    .filter((item) => !states || states.includes(item.state))
    .filter((item) => !projectKey || item.projectKey === projectKey)
    .filter((item) => !requirementId || item.requirementId === requirementId)
    .filter((item) => !unroutedOnly || item.requirementId === UNROUTED)
    .sort((a, b) => a.createdAt - b.createdAt)
}

/** 状态计数，供页面和 --list 用。 */
export function inboxCounts(opts = {}) {
  const counts = { unread: 0, seen: 0, done: 0 }
  for (const item of listInboxItems(opts)) {
    if (counts[item.state] === undefined) counts[item.state] = 0
    counts[item.state] += 1
  }
  return counts
}

/**
 * 踢一脚 drain（detached，跑完就退）。
 * 收件箱是队列，这一脚只是门铃：踢空了不丢东西，下一封信会把它捡起来。
 * 设 `AFK_NO_DRAIN=1` 可关闭（测试用）。
 */
export function kickDrain({ env = process.env, log = () => {} } = {}) {
  if (String(env.AFK_NO_DRAIN || '') === '1') return false
  try {
    const child = spawn(process.execPath, [DRAIN_PATH], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env,
    })
    child.unref()
    return true
  } catch (err) {
    log(`[afk] 踢 drain 失败（忽略，不影响主流程）: ${err.message}`)
    return false
  }
}

/**
 * 生产者用这一个函数就够了：写一条事件，再踢一脚。
 * **永不抛**——写不成收件箱不能弄挂生产者，只能留一行日志。
 * @returns {object|null} 落盘的记录；失败时 null
 */
export function emitInboxEvent(item, { home = afkHomeRoot(), kick = true, log = () => {} } = {}) {
  let saved = null
  try {
    saved = writeInboxItem(item, { home })
  } catch (err) {
    log(`[afk] 写收件箱失败（忽略，不影响主流程）: ${err.message}`)
    return null
  }
  if (kick) kickDrain({ log })
  return saved
}

/**
 * 改一条事件的字段。id / kind / createdAt 不允许被 patch 改。
 * drain 用它记尝试次数，不靠只改 state 的 ack。
 * @returns {object} 改完的记录
 */
export function updateInboxItem(id, patch = {}, { home = afkHomeRoot() } = {}) {
  if (patch.state && !INBOX_STATES.includes(patch.state)) {
    throw new Error(`未知收件箱状态: ${patch.state}（支持: ${INBOX_STATES.join(', ')}）`)
  }
  const file = join(inboxDir(home), `${assertInboxId(id)}.json`)
  if (!existsSync(file)) throw new Error(`收件箱条目不存在: ${id}`)

  const record = JSON.parse(readFileSync(file, 'utf8'))
  const now = Date.now()
  const next = {
    ...record,
    ...patch,
    id: record.id,
    kind: record.kind,
    createdAt: record.createdAt,
    updatedAt: now,
  }
  // 状态迁移盖时间戳：谁走到哪一步、在那里停了多久，是「叫醒了但没人处理」唯一的证据。
  // 只在真的跨过那一步时盖——重复 ack 不会把时间往后推，否则永远算不出停多久。
  if (next.state !== record.state) {
    if (next.state === 'seen') next.seenAt = now
    if (next.state === 'done') next.doneAt = now
  }
  writeAtomic(file, next)
  return next
}

/**
 * 改状态。只有这里能把条目推到 done——读一眼不算处理完。
 * @param {string} id
 * @param {object} [opts]
 * @param {string} [opts.state]  seen | done
 * @param {string} [opts.note]
 */
export function ackInboxItem(id, { home = afkHomeRoot(), state = 'done', note = '' } = {}) {
  const patch = { state }
  if (note) patch.note = note
  return updateInboxItem(id, patch, { home })
}

// ---------------------------------------------------------------- CLI

function parseArgs(argv) {
  const args = { list: false, ack: '', state: '', project: '', json: false, note: '' }
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i]
    if (value === '--list') args.list = true
    else if (value === '--ack') args.ack = argv[++i] || ''
    else if (value === '--state') args.state = argv[++i] || ''
    else if (value === '--project') args.project = argv[++i] || ''
    else if (value === '--note') args.note = argv[++i] || ''
    else if (value === '--json') args.json = true
    else if (value === '--seen') args.ackState = 'seen'
    else if (value === '--done') args.ackState = 'done'
    else if (value === '--help' || value === '-h') args.help = true
  }
  return args
}

function formatLine(item) {
  const when = localStamp(item.createdAt)
  const route = item.requirementId ? item.requirementId : '无主'
  const head = `[${item.state}] ${when}  ${item.kind}  ${route}  ${item.title}`
  const lines = [head]
  if (item.nextStep) lines.push(`         下一步: ${item.nextStep}`)
  lines.push(`         id: ${item.id}`)
  return lines.join('\n')
}

function usage() {
  return [
    'node inbox.mjs --list [--state unread] [--project <key>] [--json]',
    'node inbox.mjs --ack <id> [--done | --seen] [--note <文字>]',
    '',
    '退出码: 0 有内容 / 3 列表为空 / 2 出错',
  ].join('\n')
}

function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(err.message)
    process.exit(2)
  }
  if (args.help || (!args.list && !args.ack)) {
    process.stdout.write(`${usage()}\n`)
    process.exit(args.help ? 0 : 2)
  }

  try {
    if (args.ack) {
      const state = args.ackState || 'done'
      const next = ackInboxItem(args.ack, { state, note: args.note })
      process.stdout.write(`${JSON.stringify({ id: next.id, state: next.state })}\n`)
      process.exit(0)
    }

    const states = args.state ? args.state.split(',').map((s) => s.trim()).filter(Boolean) : undefined
    const items = listInboxItems({ states, projectKey: args.project })
    if (args.json) {
      process.stdout.write(`${JSON.stringify(items, null, 2)}\n`)
    } else if (items.length === 0) {
      process.stdout.write('收件箱为空\n')
    } else {
      const counts = items.reduce((acc, item) => {
        acc[item.state] = (acc[item.state] || 0) + 1
        return acc
      }, {})
      const summary = Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(' / ')
      process.stdout.write(`${items.length} 条（${summary}）\n\n${items.map(formatLine).join('\n\n')}\n`)
    }
    process.exit(items.length === 0 ? 3 : 0)
  } catch (err) {
    console.error(err.message)
    process.exit(2)
  }
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  main()
}
