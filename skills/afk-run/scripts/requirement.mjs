#!/usr/bin/env node
/**
 * 需求本子：一个需求一个文件（见 CONTEXT.md「Requirement record」）。
 *
 * 位置：<AFK home>/<projectKey>/requirements/<requirementId>.json
 * 里面记：workdir、runner、session reference、它生出来的 work item、
 *        以及需求助理的心跳。**session 只是需求的一个视图，本子才是本体。**
 *
 * 三个消费者共用这一个文件：
 * - 收件箱（路由）：拿 workItems 反查「这条事件属于哪个需求」
 * - 叫醒：拿 runner + sessionRef 决定去敲哪个 session
 * - 人：拿 title 和心跳判断需求现在什么情况
 *
 * 本模块**不读 config.json**（那里有 token），也**不解释 sessionRef**
 * ——它对所有人不透明，只有 runner 懂。
 *
 * CLI：
 *   node requirement.mjs --create --workdir <目录> [--requirement <id>] [--title <标题>] [--runner pi]
 *   node requirement.mjs --list [--project <key>] [--json]
 *   node requirement.mjs --get --requirement <id>
 *   node requirement.mjs --where --source <taskSource> --item <workItemId>
 *   node requirement.mjs --set-session --requirement <id> --runner pi [--ref <sessionRef>]
 *   node requirement.mjs --link --requirement <id> --source <taskSource> --item <workItemId>
 *   node requirement.mjs --heartbeat --requirement <id>
 *   node requirement.mjs --close --requirement <id>
 * 退出码：0 有内容 / 3 没找到 / 2 出错。
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
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afkHomeRoot, resolveProjectConfigDir } from './afk-home.mjs'

/** 心跳多久算新鲜。新鲜的 session 说明有人正在用，别去撞它。 */
export const DEFAULT_HEARTBEAT_MS = 2 * 60 * 1000

export function requirementDir(home, projectKey) {
  return join(home, projectKey, 'requirements')
}

export function requirementFile(home, projectKey, requirementId) {
  return join(requirementDir(home, projectKey), `${assertRequirementId(requirementId)}.json`)
}

/** 需求 id 进文件名：只校验，不加工（加工会算出另一个文件名）。 */
export function assertRequirementId(id) {
  const value = String(id || '')
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(value) || value.includes('..')) {
    throw new Error(`需求 id 非法: ${JSON.stringify(id)}（只允许字母数字与 _ . -，最长 64）`)
  }
  return value
}

export function newRequirementId(now = Date.now()) {
  const d = new Date(now)
  const pad = (n) => String(n).padStart(2, '0')
  const stamp =
    String(d.getFullYear()).slice(2) + pad(d.getMonth() + 1) + pad(d.getDate()) +
    '-' + pad(d.getHours()) + pad(d.getMinutes())
  // 后缀补齐到 4 位：toString(36) 偶尔只给 1-2 位，id 形状会不固定
  const suffix = Math.random().toString(36).slice(2, 6).padEnd(4, '0')
  return `req-${stamp}-${suffix}`
}

/**
 * 自动生成 id 时，同一分钟内可能撞。撞了就换一个重抽——
 * 报「已存在」而把人顶回去比多试几次差。
 */
function allocateRequirementId(home, projectKey, attempts = 8) {
  for (let i = 0; i < attempts; i += 1) {
    const candidate = newRequirementId()
    if (!existsSync(requirementFile(home, projectKey, candidate))) return candidate
  }
  throw new Error(`需求 id 连续 ${attempts} 次冲突，未创建`)
}

/** work item reference 的键：二元组，因为两个 task source 可能用同一个 id。 */
export function workItemKey(taskSource, id) {
  return `${String(taskSource || '').toLowerCase()}:${String(id)}`
}

function writeAtomic(file, record) {
  const tmp = `${file}.tmp`
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
}

function normalizeWorkItems(workItems) {
  if (!Array.isArray(workItems)) return []
  return workItems
    .filter((item) => item && item.taskSource && item.id !== undefined && item.id !== null)
    .map((item) => ({ taskSource: String(item.taskSource).toLowerCase(), id: String(item.id) }))
}

/**
 * 建或覆盖一个需求本子。已存在则报错——覆盖会丢掉 sessionRef 和 workItems。
 * @param {object} record
 * @param {string} record.workdir
 * @param {string} [record.requirementId]  不给就生成
 * @param {string} [record.title]
 * @param {string} [record.runner]
 * @param {string} [record.sessionRef]
 * @param {Array<{taskSource: string, id: string}>} [record.workItems]
 * @param {object} [opts]
 * @param {string} [opts.home]
 * @param {string} [opts.projectKey]       不给就从 workdir 解析
 */
export function createRequirementRecord(record = {}, { home = afkHomeRoot(), projectKey = '' } = {}) {
  const workdir = record.workdir || ''
  if (!workdir) throw new Error('createRequirementRecord 需要 workdir')

  const key = projectKey || resolveProjectConfigDir(workdir).projectKey
  if (!key) throw new Error(`无法从 workdir 解析项目 key: ${workdir}`)

  // 显式给的 id 撞了就报错（调用方自己选的名字，不该被偷偷改）；
  // 自动生成的则换一个重抽。
  const requirementId = record.requirementId
    ? assertRequirementId(record.requirementId)
    : allocateRequirementId(home, key)
  const file = requirementFile(home, key, requirementId)
  if (existsSync(file)) throw new Error(`需求已存在: ${requirementId}（先删或换一个 id）`)

  const now = Date.now()
  const next = {
    requirementId,
    projectKey: key,
    workdir,
    title: record.title || '',
    runner: record.runner || '',
    sessionRef: record.sessionRef || '',
    workItems: normalizeWorkItems(record.workItems),
    createdAt: now,
    // 建档也算一次写：与 updateRequirementRecord 共用同一条递增线，
    // 否则同毫秒内建的档会和刚改过的档比不出先后。
    updatedAt: nextUpdatedAt(),
    heartbeatAt: now,
    closedAt: null,
  }
  mkdirSync(requirementDir(home, key), { recursive: true })
  writeAtomic(file, next)
  return { ...next, file }
}

export function readRequirementRecord({ home = afkHomeRoot(), projectKey, requirementId } = {}) {
  if (!projectKey) throw new Error('readRequirementRecord 需要 projectKey')
  const file = requirementFile(home, projectKey, requirementId)
  if (!existsSync(file)) return null
  try {
    return { ...JSON.parse(readFileSync(file, 'utf8')), file }
  } catch {
    return null
  }
}

/**
 * 下一次写入的时间戳，**进程内严格递增**。
 *
 * 毫秒太粗：建两条需求、再改一条，可能全在同一毫秒里完成。逐条 `max(now, 自己+1)` 不够
 * ——两条各自加一之后还是会打平（同毫秒内被改的两条都等于 T+1），而「同一 session 认哪个需求」
 * 正好比的就是这个先后。所以计数器放在模块级：后写的必定大于先写的。
 * 跨进程仍可能撞上（不同步的时钟），那就交给调用方的 id 平局决胜。
 */
let lastStamp = 0

function nextUpdatedAt() {
  const now = Date.now()
  lastStamp = now > lastStamp ? now : lastStamp + 1
  return lastStamp
}

/**
 * 改一个需求本子。requirementId / projectKey / createdAt 不允许被 patch 改。
 * @returns {object|null} 改完的记录；需求不存在时 null
 */
export function updateRequirementRecord(
  { home = afkHomeRoot(), projectKey, requirementId } = {},
  patch = {},
) {
  const current = readRequirementRecord({ home, projectKey, requirementId })
  if (!current) return null

  const next = { ...current, ...patch, requirementId: current.requirementId, projectKey: current.projectKey, createdAt: current.createdAt }
  if (patch.workItems) next.workItems = normalizeWorkItems(patch.workItems)
  next.updatedAt = nextUpdatedAt()
  delete next.file
  writeAtomic(current.file, next)
  return { ...next, file: current.file }
}

/** 心跳：需求助理每轮盖一次。表示「刚有人动过这个 session」。 */
export function stampHeartbeat({ home, projectKey, requirementId } = {}, now = Date.now()) {
  return updateRequirementRecord({ home, projectKey, requirementId }, { heartbeatAt: now })
}

/** 记下这个需求生出来的 work item。重复的会去重。 */
export function linkWorkItems({ home, projectKey, requirementId } = {}, workItems = []) {
  const current = readRequirementRecord({ home, projectKey, requirementId })
  if (!current) return null
  const merged = [...current.workItems]
  const seen = new Set(merged.map((item) => workItemKey(item.taskSource, item.id)))
  for (const item of normalizeWorkItems(workItems)) {
    const key = workItemKey(item.taskSource, item.id)
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(item)
  }
  return updateRequirementRecord({ home, projectKey, requirementId }, { workItems: merged })
}

export function closeRequirement({ home, projectKey, requirementId } = {}, now = Date.now()) {
  return updateRequirementRecord({ home, projectKey, requirementId }, { closedAt: now })
}

export function isHeartbeatFresh(
  record,
  { now = Date.now(), windowMs = DEFAULT_HEARTBEAT_MS } = {},
) {
  if (!record || !record.heartbeatAt) return false
  return now - record.heartbeatAt < windowMs
}

/** 扫所有项目的需求本子。坏文件跳过，不让页面或 drain 崩掉。 */
export function listRequirementRecords({ home = afkHomeRoot(), projectKey } = {}) {
  const keys = []
  if (projectKey) {
    keys.push(projectKey)
  } else if (existsSync(home)) {
    for (const entry of readdirSync(home, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== 'inbox') keys.push(entry.name)
    }
  }

  const records = []
  for (const key of keys) {
    const dir = requirementDir(home, key)
    if (!existsSync(dir)) continue
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue
      try {
        const record = JSON.parse(readFileSync(join(dir, name), 'utf8'))
        if (record && record.requirementId) records.push({ ...record, file: join(dir, name) })
      } catch {
        // 半截文件：跳过
      }
    }
  }
  return records.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
}

/**
 * 建倒排表：work item reference → 需求本子。drain 和总览页靠它路由。
 * 关闭的需求仍然在里面——旧事件还得找得到主人。
 */
export function buildWorkItemIndex({ home = afkHomeRoot() } = {}) {
  const index = new Map()
  for (const record of listRequirementRecords({ home })) {
    for (const item of normalizeWorkItems(record.workItems)) {
      index.set(workItemKey(item.taskSource, item.id), record)
    }
  }
  return index
}

/** 反查一条 work item 属于哪个需求。查不到返回 null（调用方自己决定要不要报无主）。 */
export function resolveRequirementForWorkItem({ home = afkHomeRoot(), taskSource, id } = {}) {
  if (!taskSource || id === undefined || id === null) return null
  return buildWorkItemIndex({ home }).get(workItemKey(taskSource, id)) || null
}

/** 按 id 扫所有项目找需求。生产者给不出 projectKey 时（比如只从环境变量拿到 id）用它。 */
export function findRequirementById({ home = afkHomeRoot(), requirementId } = {}) {
  if (!requirementId) return null
  return listRequirementRecords({ home }).find((r) => r.requirementId === requirementId) || null
}

/**
 * 按 session reference 反查需求。**这就是需求助理的无状态入口**：
 * 它拿自己的 session 环境变量就能知道「我是哪个需求」，不靠记忆。
 */
export function findRequirementBySession({ home = afkHomeRoot(), sessionRef, runner = '' } = {}) {
  const ref = String(sessionRef || '')
  if (!ref) return null
  const matches = listRequirementRecords({ home }).filter(
    (record) =>
      String(record.sessionRef || '') === ref && (!runner || !record.runner || record.runner === runner),
  )
  if (!matches.length) return null
  // 同一 session 被两个需求登记过：拿最新的，并在报告里留下痕迹（由调用方决定说不说）。
  // updatedAt 由 monotonicUpdatedAt 推进，所以「最新」是真的可比；这里只用 id 兜
  // 那些手工改过的、或老版本写下的记录：平局时退回 id 降序，至少结果是确定的
  // （读目录的顺序由文件系统决定，不能当 tie-break，否则只在部分机器上复现）。
  return matches.sort((a, b) => {
    const byTime = (b.updatedAt || 0) - (a.updatedAt || 0)
    if (byTime !== 0) return byTime
    return String(b.requirementId || '').localeCompare(String(a.requirementId || ''))
  })[0]
}

/**
 * 定一条事件属于哪个需求。三层，后者依次兜底：
 *   1. 显式给的（助理起链路时用 --requirement 传下去）
 *   2. 环境变量 `AFK_REQUIREMENT_ID`
 *   3. 按 work item 反查（需求本子里的 workItems）
 * **查不到就返回 null，不猜**——无主事件要被看得见，不能被随便归给某个需求。
 */
export function resolveEventRequirement({ home = afkHomeRoot(), explicit = '', env = process.env, workItems = [] } = {}) {
  const direct = explicit || env.AFK_REQUIREMENT_ID || ''
  if (direct) return { requirementId: direct, via: explicit ? 'flag' : 'env' }

  for (const item of workItems) {
    const found = resolveRequirementForWorkItem({ home, taskSource: item.taskSource, id: item.id })
    if (found) return { requirementId: found.requirementId, via: 'work-item' }
  }
  return null
}

// ---------------------------------------------------------------- CLI

function parseArgs(argv) {
  const args = { json: false, itemIds: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i]
    if (value === '--create') args.mode = 'create'
    else if (value === '--list') args.mode = 'list'
    else if (value === '--get') args.mode = 'get'
    else if (value === '--where') args.mode = 'where'
    else if (value === '--set-session') args.mode = 'set-session'
    else if (value === '--link') args.mode = 'link'
    else if (value === '--heartbeat') args.mode = 'heartbeat'
    else if (value === '--close') args.mode = 'close'
    else if (value === '--requirement') args.requirementId = argv[++i] || ''
    else if (value === '--project') args.projectKey = argv[++i] || ''
    else if (value === '--workdir') args.workdir = argv[++i] || ''
    else if (value === '--title') args.title = argv[++i] || ''
    else if (value === '--runner') args.runner = argv[++i] || ''
    else if (value === '--ref') args.sessionRef = argv[++i] || ''
    else if (value === '--source') args.taskSource = argv[++i] || ''
    else if (value === '--item') args.itemIds.push(argv[++i] || '')
    else if (value === '--json') args.json = true
    else if (value === '--help' || value === '-h') args.help = true
  }
  // --source 与 --item 的先后顺序不该影响结果，所以在解析完之后才配对
  args.workItems = args.itemIds.map((id) => ({ taskSource: args.taskSource, id }))
  return args
}

const USAGE = [
  'node requirement.mjs --create --workdir <目录> [--requirement <id>] [--title <标题>] [--runner pi]',
  'node requirement.mjs --list [--project <key>] [--json]',
  'node requirement.mjs --get --requirement <id>',
  'node requirement.mjs --where --source <taskSource> --item <workItemId>',
  'node requirement.mjs --set-session --requirement <id> --runner pi [--ref <sessionRef>]',
  'node requirement.mjs --link --requirement <id> --source <taskSource> --item <workItemId>',
  'node requirement.mjs --heartbeat --requirement <id>',
  'node requirement.mjs --close --requirement <id>',
  '',
  '退出码: 0 有内容 / 3 没找到 / 2 出错',
].join('\n')

function oneLine(record) {
  const beat = record.heartbeatAt ? new Date(record.heartbeatAt).toISOString().slice(11, 19) : '-'
  const state = record.closedAt ? '已结束' : '进行中'
  const items = record.workItems.map((item) => workItemKey(item.taskSource, item.id)).join(', ') || '-'
  return [
    `${record.requirementId}  [${state}]  ${record.title}`,
    `  项目: ${record.projectKey}  runner: ${record.runner || '-'}  心跳: ${beat}`,
    `  工单: ${items}`,
    `  目录: ${record.workdir}`,
  ].join('\n')
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || !args.mode) {
    process.stdout.write(`${USAGE}\n`)
    process.exit(args.help ? 0 : 2)
  }

  try {
    if (args.mode === 'create') {
      const record = createRequirementRecord(
        {
          workdir: args.workdir,
          requirementId: args.requirementId,
          title: args.title,
          runner: args.runner,
          sessionRef: args.sessionRef,
          workItems: args.workItems,
        },
        { projectKey: args.projectKey },
      )
      process.stdout.write(`${JSON.stringify({ requirementId: record.requirementId, projectKey: record.projectKey, file: record.file })}\n`)
      process.exit(0)
    }

    if (args.mode === 'list') {
      const records = listRequirementRecords({ projectKey: args.projectKey })
      if (args.json) {
        process.stdout.write(`${JSON.stringify(records, null, 2)}\n`)
      } else if (records.length === 0) {
        process.stdout.write('没有需求\n')
      } else {
        process.stdout.write(`${records.length} 个需求\n\n${records.map(oneLine).join('\n\n')}\n`)
      }
      process.exit(records.length === 0 ? 3 : 0)
    }

    if (args.mode === 'where') {
      const record = resolveRequirementForWorkItem({ taskSource: args.taskSource, id: args.itemIds[0] })
      if (!record) {
        process.stdout.write(`没有需求认领这个 work item：${workItemKey(args.taskSource, args.itemIds[0])}\n`)
        process.exit(3)
      }
      process.stdout.write(`${args.json ? JSON.stringify(record, null, 2) : oneLine(record)}\n`)
      process.exit(0)
    }

    // 其余模式都需要先找到需求
    const project = args.projectKey || resolveProjectConfigDir(args.workdir || process.cwd()).projectKey
    const lookup = { projectKey: project, requirementId: args.requirementId }
    const current = readRequirementRecord(lookup)
    if (!current) {
      process.stdout.write(`没找到需求: ${args.requirementId}（项目 ${project}）\n`)
      process.exit(3)
    }

    if (args.mode === 'get') {
      process.stdout.write(`${args.json ? JSON.stringify(current, null, 2) : oneLine(current)}\n`)
      process.exit(0)
    }
    if (args.mode === 'set-session') {
      const next = updateRequirementRecord(lookup, { runner: args.runner, sessionRef: args.sessionRef, heartbeatAt: Date.now() })
      process.stdout.write(`${JSON.stringify({ requirementId: next.requirementId, runner: next.runner, sessionRef: next.sessionRef })}\n`)
      process.exit(0)
    }
    if (args.mode === 'link') {
      const next = linkWorkItems(lookup, args.workItems)
      process.stdout.write(`${JSON.stringify({ requirementId: next.requirementId, workItems: next.workItems })}\n`)
      process.exit(0)
    }
    if (args.mode === 'heartbeat') {
      const next = stampHeartbeat(lookup)
      process.stdout.write(`${JSON.stringify({ requirementId: next.requirementId, heartbeatAt: next.heartbeatAt })}\n`)
      process.exit(0)
    }
    if (args.mode === 'close') {
      const next = closeRequirement(lookup)
      process.stdout.write(`${JSON.stringify({ requirementId: next.requirementId, closedAt: next.closedAt })}\n`)
      process.exit(0)
    }
    process.exit(2)
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
