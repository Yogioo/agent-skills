/**
 * drain 单元测试（路由 / 心跳 / 锁 / 重试上限 / 无主）。
 *
 *   node --test tests/afk-run/drain.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { drainInbox } from '../../skills/afk-run/scripts/drain.mjs'
import { listInboxItems, writeInboxItem } from '../../skills/afk-run/scripts/inbox.mjs'
import {
  createRequirementRecord,
  linkWorkItems,
  readRequirementRecord,
  requirementDir,
  updateRequirementRecord,
} from '../../skills/afk-run/scripts/requirement.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

const STALE_HEARTBEAT = Date.now() - 10 * 60 * 1000

/** 每个测试一套隔离的 AFK home / workdir / cache。 */
async function withEnv(fn) {
  const home = mkdtempSync(join(tmpdir(), 'afk-drain-home-'))
  const workdir = mkdtempSync(join(tmpdir(), 'afk-drain-wd-'))
  const cacheRoot = mkdtempSync(join(tmpdir(), 'afk-drain-cache-'))
  try {
    return await fn({ home, workdir, cacheRoot })
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(workdir, { recursive: true, force: true })
    rmSync(cacheRoot, { recursive: true, force: true })
  }
}

/** 建一个可被叫醒的需求：runner + sessionRef + 旧心跳（人已经走开）。 */
function makeAwakeRequirement({ home, workdir, workItems = [] }, extra = {}) {
  const record = createRequirementRecord(
    { workdir, title: '评估波次', runner: 'pi', sessionRef: 'sess-1' },
    { home },
  )
  if (workItems.length) {
    linkWorkItems({ home, projectKey: record.projectKey, requirementId: record.requirementId }, workItems)
  }
  const key = { home, projectKey: record.projectKey, requirementId: record.requirementId }
  updateRequirementRecord(key, { heartbeatAt: STALE_HEARTBEAT, ...extra })
  return { record, key }
}

/** 注入用的 runner 工厂：记录收到的 turn，按剧本返回。 */
function recordingRunner(turns, script = () => ({ code: 0 })) {
  return (name, opts) => ({
    name,
    sessionMode: 'create-or-resume',
    async runTurn(turn) {
      turns.push({ name, opts, turn })
      return script(turn, turns.length)
    },
  })
}

test('收件箱是空的就什么都不做', async () => {
  await withEnv(async ({ home, cacheRoot }) => {
    const report = await drainInbox({ home, cacheRoot })
    assert.equal(report.scanned, 0)
    assert.deepEqual(report.woke, [])
  })
})

test('同一需求的多条事件合并成一次敲醒，turn 带上 session 与 workdir', async () => {
  await withEnv(async ({ home, workdir, cacheRoot }) => {
    const { record } = makeAwakeRequirement({ home, workdir }, { workItems: [{ taskSource: 'tapd', id: '1111' }] })
    const a = writeInboxItem(
      { kind: 'run-end', requirementId: record.requirementId, workdir, title: 'A' },
      { home },
    )
    const b = writeInboxItem(
      { kind: 'questionnaire-submitted', requirementId: record.requirementId, workdir, title: 'B' },
      { home },
    )

    const turns = []
    const report = await drainInbox({ home, cacheRoot, createRunnerFn: recordingRunner(turns) })

    assert.equal(report.woke.length, 1)
    assert.equal(report.woke[0].items.length, 2)
    assert.equal(turns.length, 1, '两条事件只该敲一次')
    assert.equal(turns[0].turn.session, 'sess-1')
    assert.equal(turns[0].turn.workdir, workdir)
    assert.equal(turns[0].name, 'pi')
    assert.ok(turns[0].turn.signal, '要能超时中止')
    assert.match(turns[0].turn.prompt, new RegExp(record.requirementId))
    assert.match(turns[0].turn.prompt, /验收是人点的那一下/, '叫醒词要说清验收归人，且用正面表述')

    // 敲通了才标 seen；不代劳 done
    for (const item of [a, b]) {
      const [stored] = listInboxItems({ home, requirementId: record.requirementId }).filter((i) => i.id === item.id)
      assert.equal(stored.state, 'seen')
      assert.ok(stored.note, '要留叫醒痕迹')
    }
  })
})

test('router：不传 requirement 时靠工单反查', async () => {
  await withEnv(async ({ home, workdir, cacheRoot }) => {
    const { record } = makeAwakeRequirement({ home, workdir }, { workItems: [{ taskSource: 'tapd', id: '1111' }] })
    const item = writeInboxItem(
      { kind: 'run-end', workdir, workItems: [{ taskSource: 'tapd', id: '1111' }], title: 'A' },
      { home },
    )
    assert.equal(item.requirementId, null, '写的时候还没路由')

    const turns = []
    const report = await drainInbox({ home, cacheRoot, createRunnerFn: recordingRunner(turns) })
    assert.equal(report.woke.length, 1)
    assert.equal(report.woke[0].requirementId, record.requirementId, 'drain 要按工单把它归给需求')
  })
})

test('心跳新鲜时不敲（别撞正在用的 session），旧了才敲', async () => {
  await withEnv(async ({ home, workdir, cacheRoot }) => {
    const { record, key } = makeAwakeRequirement({ home, workdir })
    writeInboxItem({ kind: 'run-end', requirementId: record.requirementId, workdir, title: 'A' }, { home })

    updateRequirementRecord(key, { heartbeatAt: Date.now() })
    let turns = []
    let report = await drainInbox({ home, cacheRoot, createRunnerFn: recordingRunner(turns) })
    assert.equal(report.woke.length, 0)
    assert.equal(report.waiting.length, 1)
    assert.match(report.waiting[0].reason, /心跳还新鲜/)
    assert.equal(turns.length, 0)
    assert.equal(listInboxItems({ home, states: ['unread'] }).length, 1, '不敲就不能动状态')

    updateRequirementRecord(key, { heartbeatAt: STALE_HEARTBEAT })
    turns = []
    report = await drainInbox({ home, cacheRoot, createRunnerFn: recordingRunner(turns) })
    assert.equal(report.woke.length, 1)
  })
})

test('叫不醒的各种原因都点名，不静默丢', async () => {
  await withEnv(async ({ home, workdir, cacheRoot }) => {
    const cases = [
      ['没有 session reference', { sessionRef: '' }],
      ['没记 runner', { sessionRef: 's', runner: '' }],
      ['runner 不支持续会话', { sessionRef: 's', runner: 'agent' }],
      ['没有 workdir', { sessionRef: 's', workdir: '' }],
    ]
    for (const [label, patch] of cases) {
      const { record } = makeAwakeRequirement({ home, workdir })
      const key = { home, projectKey: record.projectKey, requirementId: record.requirementId }
      updateRequirementRecord(key, { heartbeatAt: STALE_HEARTBEAT, ...patch })
      writeInboxItem({ kind: 'run-end', requirementId: record.requirementId, workdir, title: label }, { home })

      const report = await drainInbox({ home, cacheRoot, createRunnerFn: recordingRunner([]) })
      assert.equal(report.woke.length, 0, label)
      assert.equal(report.blocked.length, 1, label)
      assert.ok(report.blocked[0].reason, `${label} 要给原因`)
      assert.equal(listInboxItems({ home, states: ['unread'] }).length, 1, `${label}：事件要留在 unread`)
      // 清掉收件箱，给下一个 case 一个干净起点
      rmSync(join(home, 'inbox'), { recursive: true, force: true })
    }
  })
})

test('需求本子不存在 / 需求已结束：进 blocked，事件仍留着', async () => {
  await withEnv(async ({ home, workdir, cacheRoot }) => {
    // 认领了一个查不到的需求
    writeInboxItem({ kind: 'run-end', requirementId: 'req-ghost', workdir, title: 'A' }, { home })
    let report = await drainInbox({ home, cacheRoot, createRunnerFn: recordingRunner([]) })
    assert.equal(report.blocked.length, 1)
    assert.match(report.blocked[0].reason, /需求本子不存在/)

    rmSync(join(home, 'inbox'), { recursive: true, force: true })
    const { record, key } = makeAwakeRequirement({ home, workdir })
    updateRequirementRecord(key, { closedAt: Date.now() })
    writeInboxItem({ kind: 'run-end', requirementId: record.requirementId, workdir, title: 'B' }, { home })
    report = await drainInbox({ home, cacheRoot, createRunnerFn: recordingRunner([]) })
    assert.equal(report.blocked.length, 1)
    assert.match(report.blocked[0].reason, /需求已结束/)
    assert.equal(listInboxItems({ home, states: ['unread'] }).length, 1)
  })
})

test('无主事件点名但不改状态', async () => {
  await withEnv(async ({ home, workdir, cacheRoot }) => {
    const item = writeInboxItem({ kind: 'watch-stop', workdir, title: '没人看活了' }, { home })
    const report = await drainInbox({ home, cacheRoot, createRunnerFn: recordingRunner([]) })

    assert.equal(report.unrouted.length, 1)
    assert.equal(report.unrouted[0].id, item.id)
    assert.equal(report.woke.length, 0)
    assert.equal(listInboxItems({ home })[0].state, 'unread')
  })
})

test('敲失败：留在 unread、记尝试次数与错误、报告里带错误', async () => {
  await withEnv(async ({ home, workdir, cacheRoot }) => {
    const { record } = makeAwakeRequirement({ home, workdir })
    writeInboxItem({ kind: 'run-end', requirementId: record.requirementId, workdir, title: 'A' }, { home })

    const failing = recordingRunner([], () => {
      throw new Error('runner 退出码 1')
    })
    const report = await drainInbox({ home, cacheRoot, createRunnerFn: failing })

    assert.equal(report.failed.length, 1)
    assert.match(report.failed[0].error, /退出码 1/)
    assert.ok(existsSync(report.failed[0].runDir), '失败也要留下 runDir 供排障')
    const [stored] = listInboxItems({ home })
    assert.equal(stored.state, 'unread')
    assert.equal(stored.wakeAttempts, 1)
    assert.match(stored.lastWakeError, /退出码 1/)
  })
})

test('到重试上限后停止重试，升级给人', async () => {
  await withEnv(async ({ home, workdir, cacheRoot }) => {
    const { record } = makeAwakeRequirement({ home, workdir })
    writeInboxItem({ kind: 'run-end', requirementId: record.requirementId, workdir, title: 'A' }, { home })

    const failing = recordingRunner([], () => {
      throw new Error('总是失败')
    })
    for (let i = 0; i < 3; i += 1) await drainInbox({ home, cacheRoot, maxAttempts: 3, createRunnerFn: failing })

    const turns = []
    const report = await drainInbox({ home, cacheRoot, maxAttempts: 3, createRunnerFn: recordingRunner(turns) })
    assert.equal(turns.length, 0, '到上限就不该再敲')
    assert.equal(report.failed.length, 0)
    assert.equal(report.blocked.length, 1)
    assert.match(report.blocked[0].reason, /停止重试/)
  })
})

test('已经 seen 的不重复敲', async () => {
  await withEnv(async ({ home, workdir, cacheRoot }) => {
    const { record } = makeAwakeRequirement({ home, workdir })
    writeInboxItem({ kind: 'run-end', requirementId: record.requirementId, workdir, title: 'A' }, { home })

    const turns = []
    const runner = recordingRunner(turns)
    await drainInbox({ home, cacheRoot, createRunnerFn: runner })
    assert.equal(turns.length, 1)

    const second = await drainInbox({ home, cacheRoot, createRunnerFn: runner })
    assert.equal(turns.length, 1, 'seen 的不该再敲')
    assert.equal(second.scanned, 0)
  })
})

test('并发两个 drain：一个需求只敲一次（锁生效）', async () => {
  await withEnv(async ({ home, workdir, cacheRoot }) => {
    const { record } = makeAwakeRequirement({ home, workdir })
    writeInboxItem({ kind: 'run-end', requirementId: record.requirementId, workdir, title: 'A' }, { home })

    let concurrent = 0
    let peak = 0
    const slow = (name) => ({
      name,
      sessionMode: 'create-or-resume',
      async runTurn() {
        concurrent += 1
        peak = Math.max(peak, concurrent)
        await new Promise((resolve) => setTimeout(resolve, 200))
        concurrent -= 1
        return { code: 0 }
      },
    })
    const [a, b] = await Promise.all([
      drainInbox({ home, cacheRoot, createRunnerFn: slow }),
      drainInbox({ home, cacheRoot, createRunnerFn: slow }),
    ])

    assert.equal(a.woke.length + b.woke.length, 1, '合计只该敲一次')
    assert.equal(peak, 1, '同一个 session 不能同时跑两个 turn')
    const blocked = [...a.waiting, ...b.waiting]
    assert.equal(blocked.length, 1)
    assert.match(blocked[0].reason, /锁/)
    // 锁要释放干净
    const leftovers = listLockFiles(home, record.projectKey)
    assert.deepEqual(leftovers, [])
  })
})

test('陈旧锁（持有者进程已死）能被抢过来', async () => {
  await withEnv(async ({ home, workdir, cacheRoot }) => {
    const { record } = makeAwakeRequirement({ home, workdir })
    writeInboxItem({ kind: 'run-end', requirementId: record.requirementId, workdir, title: 'A' }, { home })
    writeFileSync(
      join(requirementDir(home, record.projectKey), `${record.requirementId}.lock`),
      `${JSON.stringify({ pid: 999999, startedAt: Date.now() })}\n`,
      'utf8',
    )

    const turns = []
    const report = await drainInbox({ home, cacheRoot, createRunnerFn: recordingRunner(turns) })
    assert.equal(turns.length, 1, '持有者已死就该抢过来')
    assert.equal(report.woke.length, 1)
    assert.deepEqual(listLockFiles(home, record.projectKey), [])
  })
})

test('dry-run 只做判断：不跑 turn、不改状态，但报告里带叫醒词', async () => {
  await withEnv(async ({ home, workdir, cacheRoot }) => {
    const { record } = makeAwakeRequirement({ home, workdir })
    writeInboxItem({ kind: 'run-end', requirementId: record.requirementId, workdir, title: 'A' }, { home })

    const turns = []
    const report = await drainInbox({ home, cacheRoot, dryRun: true, createRunnerFn: recordingRunner(turns) })

    assert.equal(turns.length, 0)
    assert.equal(report.woke.length, 1)
    assert.ok(report.woke[0].prompt.includes('inbox.mjs'), '报告里要能看到叫醒词给出的命令')
    assert.equal(listInboxItems({ home })[0].state, 'unread')
  })
})

test('--requirement 只看指定需求', async () => {
  await withEnv(async ({ home, workdir, cacheRoot }) => {
    const one = makeAwakeRequirement({ home, workdir })
    const two = makeAwakeRequirement({ home, workdir })
    writeInboxItem({ kind: 'run-end', requirementId: one.record.requirementId, workdir, title: 'A' }, { home })
    writeInboxItem({ kind: 'run-end', requirementId: two.record.requirementId, workdir, title: 'B' }, { home })

    const turns = []
    const report = await drainInbox({
      home,
      cacheRoot,
      onlyRequirement: two.record.requirementId,
      createRunnerFn: recordingRunner(turns),
    })
    assert.equal(report.woke.length, 1)
    assert.equal(report.woke[0].requirementId, two.record.requirementId)
    assert.equal(turns.length, 1)
  })
})

test('需求本子里的 runner 决定用哪个 CLI，注入的 override 优先', async () => {
  await withEnv(async ({ home, workdir, cacheRoot }) => {
    const { record, key } = makeAwakeRequirement({ home, workdir })
    updateRequirementRecord(key, { runner: 'codex' })
    writeInboxItem({ kind: 'run-end', requirementId: record.requirementId, workdir, title: 'A' }, { home })

    const turns = []
    await drainInbox({ home, cacheRoot, createRunnerFn: recordingRunner(turns) })
    assert.equal(turns[0].name, 'codex', '默认用本子里记的 runner')

    // 上一条已经被标成 seen，要再写一条才有得敲
    updateRequirementRecord(key, { heartbeatAt: STALE_HEARTBEAT })
    writeInboxItem({ kind: 'run-end', requirementId: record.requirementId, workdir, title: 'B' }, { home })
    turns.length = 0
    await drainInbox({ home, cacheRoot, runnerOverride: 'pi', createRunnerFn: recordingRunner(turns) })
    assert.equal(turns[0].name, 'pi', '显式 --runner 覆盖本子')
  })
})

test('本子里没有 sessionRef 时不会拿空串去敲', async () => {
  await withEnv(async ({ home, workdir, cacheRoot }) => {
    const { record, key } = makeAwakeRequirement({ home, workdir })
    updateRequirementRecord(key, { sessionRef: '' })
    writeInboxItem({ kind: 'run-end', requirementId: record.requirementId, workdir, title: 'A' }, { home })

    const turns = []
    const report = await drainInbox({ home, cacheRoot, createRunnerFn: recordingRunner(turns) })
    assert.equal(turns.length, 0)
    assert.match(report.blocked[0].reason, /session reference/)
    assert.equal(readRequirementRecord(key).sessionRef, '')
  })
})

function listLockFiles(home, projectKey) {
  const dir = requirementDir(home, projectKey)
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((name) => name.endsWith('.lock'))
}
