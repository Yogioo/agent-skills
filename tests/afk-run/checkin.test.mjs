/**
 * checkin 单元测试（认自己 / 盖心跳 / 只列自己的 / 退出码）。
 *
 *   node --test tests/afk-run/checkin.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { checkin, detectSession } from '../../skills/afk-run/scripts/checkin.mjs'
import { listInboxItems, writeInboxItem } from '../../skills/afk-run/scripts/inbox.mjs'
import {
  createRequirementRecord,
  readRequirementRecord,
  updateRequirementRecord,
} from '../../skills/afk-run/scripts/requirement.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CLI = join(__dirname, '..', '..', 'skills', 'afk-run', 'scripts', 'checkin.mjs')
const STALE_HEARTBEAT = Date.now() - 10 * 60 * 1000

async function withEnv(fn) {
  const home = mkdtempSync(join(tmpdir(), 'afk-checkin-home-'))
  const workdir = mkdtempSync(join(tmpdir(), 'afk-checkin-wd-'))
  try {
    return await fn({ home, workdir })
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(workdir, { recursive: true, force: true })
  }
}

function runCli(args, env) {
  try {
    return { code: 0, out: execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim() }
  } catch (err) {
    return { code: err.status, out: ((err.stdout || '') + (err.stderr || '')).trim() }
  }
}

test('detectSession：认得各 runner 的 session 环境变量', () => {
  assert.deepEqual(detectSession({ PI_SESSION_ID: 'p1' }), { runner: 'pi', sessionRef: 'p1', via: 'PI_SESSION_ID' })
  assert.deepEqual(detectSession({ CODEX_THREAD_ID: 'c1' }), {
    runner: 'codex',
    sessionRef: 'c1',
    via: 'CODEX_THREAD_ID',
  })
  assert.deepEqual(detectSession({ AGENT_SESSION_ID: 'a1' }), {
    runner: 'agent',
    sessionRef: 'a1',
    via: 'AGENT_SESSION_ID',
  })
  assert.deepEqual(detectSession({}), { runner: '', sessionRef: '', via: '' })
})

test('没登记过的 session：给原因和登记指引，不猜', async () => {
  await withEnv(({ home }) => {
    const result = checkin({ home, env: { PI_SESSION_ID: 'sess-没登记' } })
    assert.equal(result.ok, false)
    assert.match(result.reason, /还没有登记过/)
    assert.match(result.reason, /sess-没登记/)
  })
})

test('既没给 --requirement 也没有 session 环境变量：说清认不出', async () => {
  await withEnv(({ home }) => {
    const result = checkin({ home, env: {} })
    assert.equal(result.ok, false)
    assert.match(result.reason, /认不出这个 session/)
  })
})

test('靠 session reference 认自己，并把心跳推到当前时间', async () => {
  await withEnv(({ home, workdir }) => {
    const record = createRequirementRecord({ workdir, title: '评估波次', runner: 'pi', sessionRef: 'sess-me' }, { home })
    const key = { home, projectKey: record.projectKey, requirementId: record.requirementId }
    updateRequirementRecord(key, { heartbeatAt: STALE_HEARTBEAT })

    const now = Date.now()
    const result = checkin({ home, env: { PI_SESSION_ID: 'sess-me' }, now })

    assert.equal(result.ok, true)
    assert.equal(result.record.requirementId, record.requirementId)
    assert.equal(result.heartbeatAt, now)
    assert.equal(readRequirementRecord(key).heartbeatAt, now)
    assert.equal(result.sessionVia, 'PI_SESSION_ID')
  })
})

test('--no-beat 只读不写心跳', async () => {
  await withEnv(({ home, workdir }) => {
    const record = createRequirementRecord({ workdir, runner: 'pi', sessionRef: 'sess-me' }, { home })
    const key = { home, projectKey: record.projectKey, requirementId: record.requirementId }
    updateRequirementRecord(key, { heartbeatAt: STALE_HEARTBEAT })

    const result = checkin({ home, env: { PI_SESSION_ID: 'sess-me' }, beat: false })
    assert.equal(result.ok, true)
    assert.equal(readRequirementRecord(key).heartbeatAt, STALE_HEARTBEAT, '心跳不该被推动')
  })
})

test('只列属于我这个需求的未读', async () => {
  await withEnv(({ home, workdir }) => {
    const mine = createRequirementRecord({ workdir, runner: 'pi', sessionRef: 'sess-mine' }, { home })
    const other = createRequirementRecord({ workdir, runner: 'pi', sessionRef: 'sess-other' }, { home })

    const a = writeInboxItem({ kind: 'run-end', requirementId: mine.requirementId, workdir, title: '我的 A' }, { home })
    writeInboxItem({ kind: 'run-end', requirementId: mine.requirementId, workdir, title: '我的 B' }, { home })
    writeInboxItem({ kind: 'run-end', requirementId: other.requirementId, workdir, title: '别人的' }, { home })
    writeInboxItem({ kind: 'watch-stop', workdir, title: '无主的' }, { home })

    const result = checkin({ home, env: { PI_SESSION_ID: 'sess-mine' } })
    assert.equal(result.ok, true)
    assert.equal(result.items.length, 2)
    assert.deepEqual(result.items.map((item) => item.title), ['我的 A', '我的 B'])
    assert.ok(result.items.some((item) => item.id === a.id))

    // 别人的和无主的都还在等
    assert.equal(listInboxItems({ home, states: ['unread'] }).length, 4)
  })
})

test('显式 --requirement 优先于 session 反查', async () => {
  await withEnv(({ home, workdir }) => {
    const one = createRequirementRecord({ workdir, runner: 'pi', sessionRef: 'sess-shared' }, { home })
    const two = createRequirementRecord({ workdir, runner: 'pi', sessionRef: 'sess-shared' }, { home })

    const result = checkin({ home, requirementId: one.requirementId, env: { PI_SESSION_ID: 'sess-shared' } })
    assert.equal(result.record.requirementId, one.requirementId)

    // 同一 session 登记了两个需求时，按 session 认会挑最近更新的那个
    updateRequirementRecord(
      { home, projectKey: two.projectKey, requirementId: two.requirementId },
      { title: '刚刚更新过' },
    )
    const bySession = checkin({ home, env: { PI_SESSION_ID: 'sess-shared' } })
    assert.equal(bySession.record.requirementId, two.requirementId)
  })
})

test('登记时忘了写 session reference，第一次带 --requirement 报到会补上', async () => {
  await withEnv(({ home, workdir }) => {
    const record = createRequirementRecord({ workdir, runner: 'pi' }, { home })
    const key = { home, projectKey: record.projectKey, requirementId: record.requirementId }
    assert.equal(readRequirementRecord(key).sessionRef, '')

    const first = checkin({ home, requirementId: record.requirementId, env: { PI_SESSION_ID: 'sess-late' } })
    assert.equal(first.ok, true)
    assert.equal(readRequirementRecord(key).sessionRef, 'sess-late')

    // 补上之后，不带参数也能认出来
    const second = checkin({ home, env: { PI_SESSION_ID: 'sess-late' } })
    assert.equal(second.ok, true)
    assert.equal(second.record.requirementId, record.requirementId)
  })
})

test('需求已结束也照常报到，只是提示一句', async () => {
  await withEnv(({ home, workdir }) => {
    const record = createRequirementRecord({ workdir, runner: 'pi', sessionRef: 'sess-closed' }, { home })
    updateRequirementRecord(
      { home, projectKey: record.projectKey, requirementId: record.requirementId },
      { closedAt: Date.now() },
    )

    const result = checkin({ home, env: { PI_SESSION_ID: 'sess-closed' } })
    assert.equal(result.ok, true)
    assert.ok(result.record.closedAt > 0)
  })
})

test('CLI 退出码：有未读 0 / 没我的事 3', async () => {
  await withEnv(({ home, workdir }) => {
    const record = createRequirementRecord({ workdir, runner: 'pi', sessionRef: 'sess-cli' }, { home })
    const env = { ...process.env, AFK_HOME: home, PI_SESSION_ID: 'sess-cli', AFK_NO_DRAIN: '1' }

    let result = runCli([], env)
    assert.equal(result.code, 3, '没我的事应当是 3')
    assert.match(result.out, new RegExp(record.requirementId))

    writeInboxItem({ kind: 'run-end', requirementId: record.requirementId, workdir, title: 'A' }, { home })
    result = runCli([], env)
    assert.equal(result.code, 0, '有未读应当是 0')
    assert.match(result.out, /run-end/)

    result = runCli(['--json'], env)
    const payload = JSON.parse(result.out)
    assert.equal(payload.ok, true)
    assert.equal(payload.items.length, 1)
  })
})

test('CLI 认不出 session 时退出码是 3 且给出登记命令', async () => {
  await withEnv(({ home }) => {
    const result = runCli([], { ...process.env, AFK_HOME: home, PI_SESSION_ID: 'sess-unknown', AFK_NO_DRAIN: '1' })
    assert.equal(result.code, 3)
    assert.match(result.out, /requirement\.mjs --create/)
  })
})
