#!/usr/bin/env node
/**
 * checkin：需求助理每轮开头跑一次的东西。
 *
 * 一条命令做完两件事，而不是让助理记两条规则：
 *   1. 盖心跳——告诉 drain「有人正在用这个 session，别撞」
 *   2. 读收件箱——有没有属于我这个需求的事件
 *
 * 它靠 session reference 认自己（默认读 runner 的环境变量），所以
 * **助理不需要记住自己是哪个需求**：session 被压缩、人重开终端之后，
 * 只要还在同一个 session 里，这一条命令就能把它认回来。
 *
 * CLI：
 *   node checkin.mjs [--requirement <id>] [--session <ref>] [--runner pi] [--json]
 * 退出码：0 有未读要处理 / 3 没我的事 / 2 出错。
 */

import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { afkHomeRoot } from './afk-home.mjs'
import { listInboxItems } from './inbox.mjs'
import {
  findRequirementById,
  findRequirementBySession,
  stampHeartbeat,
  updateRequirementRecord,
} from './requirement.mjs'

/** runner 专属的 session 环境变量。只在这里出现，别处靠 --session 传。 */
const SESSION_ENV = [
  { runner: 'pi', names: ['PI_SESSION_ID'] },
  { runner: 'codex', names: ['CODEX_SESSION_ID', 'CODEX_THREAD_ID'] },
  { runner: 'agent', names: ['CURSOR_SESSION_ID', 'AGENT_SESSION_ID'] },
]

export function detectSession(env = process.env) {
  for (const entry of SESSION_ENV) {
    for (const name of entry.names) {
      const value = String(env[name] || '')
      if (value) return { runner: entry.runner, sessionRef: value, via: name }
    }
  }
  return { runner: '', sessionRef: '', via: '' }
}

/**
 * 报到一次。
 * @returns {{ok: boolean, reason?: string, record?: object, items?: object[], heartbeatAt?: number}}
 */
export function checkin({ home = afkHomeRoot(), requirementId = '', sessionRef = '', runner = '', env = process.env, beat = true, now = Date.now() } = {}) {
  const detected = detectSession(env)
  const ref = sessionRef || detected.sessionRef
  const runnerName = runner || detected.runner

  let record = null
  if (requirementId) {
    record = findRequirementById({ home, requirementId })
    if (!record) return { ok: false, reason: `没有这个需求: ${requirementId}` }
  } else if (ref) {
    record = findRequirementBySession({ home, sessionRef: ref, runner: runnerName })
    if (!record) {
      return { ok: false, reason: `这个 session 还没有登记过（${detected.via || '--session'} = ${ref}）` }
    }
  } else {
    return { ok: false, reason: '认不出这个 session：没给 --requirement，也没找到 runner 的 session 环境变量' }
  }

  // 显式给了 --requirement 时才有意义：助理刚建完需求、还没写 ref，这一轮把它补上。
  // 按 session 查的那条路上永远走不到这里——要按 session 找到记录，记录里就得先有 session。
  // 所以登记时必须带 ref（见 SKILL.md）；这里只是兼底。
  if (beat && requirementId && !record.sessionRef && ref) {
    record =
      updateRequirementRecord(
        { home, projectKey: record.projectKey, requirementId: record.requirementId },
        { sessionRef: ref, ...(runnerName ? { runner: runnerName } : {}) },
      ) || record
  }
  const final = beat
    ? stampHeartbeat({ home, projectKey: record.projectKey, requirementId: record.requirementId }, now) || record
    : record

  const items = listInboxItems({ home, states: ['unread'], requirementId: final.requirementId })
  return { ok: true, record: final, items, heartbeatAt: final.heartbeatAt, sessionVia: detected.via }
}

// ---------------------------------------------------------------- CLI

function parseArgs(argv) {
  const args = { json: false, beat: true }
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i]
    if (value === '--requirement') args.requirement = argv[++i] || ''
    else if (value === '--session') args.session = argv[++i] || ''
    else if (value === '--runner') args.runner = argv[++i] || ''
    else if (value === '--no-beat') args.beat = false
    else if (value === '--json') args.json = true
    else if (value === '--help' || value === '-h') args.help = true
  }
  return args
}

const USAGE = [
  'node checkin.mjs [--requirement <id>] [--session <ref>] [--runner pi] [--json] [--no-beat]',
  '',
  '需求助理每轮开头跑一次：盖心跳 + 读属于我这个需求的收件箱。',
  '退出码: 0 有未读要处理 / 3 没我的事 / 2 出错',
].join('\n')

function printCheckin(result) {
  const lines = []
  if (!result.ok) {
    lines.push(`认不出我负责哪个需求：${result.reason}`)
    lines.push('还没登记过就先登记：node requirement.mjs --create --workdir <目录> --title <标题> --runner <runner>')
    return lines.join('\n')
  }
  const r = result.record
  lines.push(`需求 ${r.requirementId}${r.title ? `「${r.title}」` : ''}`)
  lines.push(`  项目: ${r.projectKey}   runner: ${r.runner || '-'}   心跳已盖`)
  if (r.workItems?.length) {
    lines.push(`  工单: ${r.workItems.map((i) => `${i.taskSource}:${i.id}`).join(', ')}`)
  }
  if (r.closedAt) lines.push('  （这个需求已结束）')
  if (!result.items.length) {
    lines.push('  收件箱：没有我的事')
    return lines.join('\n')
  }
  lines.push(`  收件箱 ${result.items.length} 条未读：`)
  for (const item of result.items) {
    lines.push(`  - ${item.kind}: ${item.title}`)
    if (item.nextStep) lines.push(`      下一步: ${item.nextStep}`)
    lines.push(`      id: ${item.id}`)
  }
  return lines.join('\n')
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  const result = checkin({
    requirementId: args.requirement || '',
    sessionRef: args.session || '',
    runner: args.runner || '',
    beat: args.beat,
  })
  process.stdout.write(`${args.json ? JSON.stringify(result, null, 2) : printCheckin(result)}\n`)
  if (!result.ok) return 3
  return result.items.length ? 0 : 3
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
