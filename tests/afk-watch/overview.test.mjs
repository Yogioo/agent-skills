/**
 * 总览页单元测试（投影 / 待人工处理 / 陈旧标记 / 渲染转义）。
 *
 *   node --test tests/afk-watch/overview.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { EXHAUSTED_WAKE_ATTEMPTS, projectOverview, renderPage, wakeableOf } from '../../skills/afk-watch/scripts/overview.mjs'
import { updateInboxItem, writeInboxItem } from '../../skills/afk-run/scripts/inbox.mjs'
import { appendWakeLog } from '../../skills/afk-run/scripts/drain.mjs'
import { createRequirementRecord, closeRequirement } from '../../skills/afk-run/scripts/requirement.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

/** 隔离的 AFK home + 两个缓存根。isAlive 默认由测试自己控制。 */
async function withEnv(fn) {
  const home = mkdtempSync(join(tmpdir(), 'afk-ov-home-'))
  const workdir = mkdtempSync(join(tmpdir(), 'afk-ov-wd-'))
  const watchCacheRoot = mkdtempSync(join(tmpdir(), 'afk-ov-watch-'))
  const runCacheRoot = mkdtempSync(join(tmpdir(), 'afk-ov-run-'))
  try {
    return await fn({ home, workdir, watchCacheRoot, runCacheRoot })
  } finally {
    for (const dir of [home, workdir, watchCacheRoot, runCacheRoot]) {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

function writeWatcherRegistry(watchCacheRoot, workdir, record) {
  writeFileSync(join(watchCacheRoot, 'watch-1.json'), `${JSON.stringify({ workdir, ...record })}\n`, 'utf8')
}

function writeLoopRegistry(runCacheRoot, workdir, record) {
  writeFileSync(join(runCacheRoot, 'loop-1.json'), `${JSON.stringify({ workdir, ...record })}\n`, 'utf8')
}

test('空机器：没有需求、没有环境、没有要人动的事', async () => {
  await withEnv(({ home, watchCacheRoot, runCacheRoot }) => {
    const model = projectOverview({ home, watchCacheRoot, runCacheRoot, isAlive: () => false })
    assert.equal(model.counts.requirements, 0)
    assert.equal(model.counts.environments, 0)
    assert.equal(model.counts.needsHuman, 0)
    assert.deepEqual(model.needsHuman, { unrouted: [], exhausted: [], stuckSeen: [], unwakeable: [] })
    assert.match(renderPage(model), /没有要你动的事/)
  })
})

test('需求带上它自己的事件与计数', async () => {
  await withEnv(({ home, workdir, watchCacheRoot, runCacheRoot }) => {
    const mine = createRequirementRecord({ workdir, title: '评估波次', runner: 'pi', sessionRef: 's' }, { home })
    const other = createRequirementRecord({ workdir, title: '别的需求', runner: 'pi', sessionRef: 's2' }, { home })
    writeInboxItem({ kind: 'run-end', requirementId: mine.requirementId, workdir, title: 'A' }, { home })
    writeInboxItem({ kind: 'run-error', requirementId: mine.requirementId, workdir, title: 'B' }, { home })
    writeInboxItem({ kind: 'run-end', requirementId: other.requirementId, workdir, title: 'C' }, { home })

    const model = projectOverview({ home, watchCacheRoot, runCacheRoot, isAlive: () => false })
    const found = model.requirements.find((r) => r.requirementId === mine.requirementId)
    assert.equal(found.items.length, 2, '只算自己的事件')
    assert.equal(found.counts.unread, 2)
    assert.equal(model.requirements.find((r) => r.requirementId === other.requirementId).items.length, 1)
    assert.equal(model.counts.inbox.unread, 3)
  })
})

test('无主事件进「待人工处理」并说清原因', async () => {
  await withEnv(({ home, workdir, watchCacheRoot, runCacheRoot }) => {
    const item = writeInboxItem({ kind: 'watch-stop', workdir, title: '没人看活了' }, { home })
    const model = projectOverview({ home, watchCacheRoot, runCacheRoot, isAlive: () => false })

    assert.equal(model.counts.needsHuman, 1)
    assert.equal(model.needsHuman.unrouted[0].id, item.id)
    assert.match(model.needsHuman.unrouted[0].why, /没有被任何需求认领/)
    assert.match(renderPage(model), /没有被任何需求认领/)
  })
})

test('叫醒到上限的事件进「待人工处理」，没到上限的不进', async () => {
  await withEnv(({ home, workdir, watchCacheRoot, runCacheRoot }) => {
    const record = createRequirementRecord({ workdir, runner: 'pi', sessionRef: 's' }, { home })
    const fresh = writeInboxItem({ kind: 'run-end', requirementId: record.requirementId, workdir, title: '刚写的' }, { home })
    const stuck = writeInboxItem({ kind: 'run-end', requirementId: record.requirementId, workdir, title: '一直失败' }, { home })

    // 直接改文件模拟 drain 重试过（drain 就在那两个字段上记重试）
    const path = join(home, 'inbox', `${stuck.id}.json`)
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    raw.wakeAttempts = EXHAUSTED_WAKE_ATTEMPTS
    raw.lastWakeError = 'runner 退出码 1'
    writeFileSync(path, `${JSON.stringify(raw)}\n`, 'utf8')

    const model = projectOverview({ home, watchCacheRoot, runCacheRoot, isAlive: () => false })
    assert.equal(model.needsHuman.exhausted.length, 1)
    assert.equal(model.needsHuman.exhausted[0].id, stuck.id)
    assert.match(model.needsHuman.exhausted[0].why, /已叫醒 3 次仍失败/)
    assert.equal(model.needsHuman.exhausted[0].nextStep !== undefined, true, 'nextStep 要带上，人靠它知道该干什么')
    assert.ok(!model.needsHuman.unrouted.some((i) => i.id === fresh.id), '没到上限的不算要人动')
    assert.match(renderPage(model), /唤醒环已经放弃/)
    // 事件时间要渲染出来，不能是 '-'（漏 createdAt 就是这个样子）
    assert.equal((renderPage(model).match(/<span class="mono">-<\/span>/g) || []).length, 0)
  })
})

test('wakeableOf：四种叫不醒的原因各自说清', () => {
  assert.deepEqual(wakeableOf({ runner: 'pi', sessionRef: 's' }), { ok: true, why: '' })
  assert.match(wakeableOf({ runner: '', sessionRef: 's' }).why, /没记 runner/)
  assert.match(wakeableOf({ runner: 'agent', sessionRef: 's' }).why, /agent 不支持续会话/)
  assert.match(wakeableOf({ runner: '并不存在', sessionRef: 's' }).why, /不认识/)
  assert.match(wakeableOf({ runner: 'pi', sessionRef: '' }).why, /没有 session reference/)
})

test('叫不醒的需求进「待人工处理」，已结束的不进', async () => {
  await withEnv(({ home, workdir, watchCacheRoot, runCacheRoot }) => {
    // 真实踩过：runner 记成了项目执行链用的 agent，而助理 session 是 pi
    const bad = createRequirementRecord({ workdir, title: '叫不醒的', runner: 'agent', sessionRef: 's' }, { home })
    createRequirementRecord({ workdir, title: '好的', runner: 'pi', sessionRef: 's' }, { home })

    const model = projectOverview({ home, watchCacheRoot, runCacheRoot, isAlive: () => false })
    assert.equal(model.needsHuman.unwakeable.length, 1)
    assert.equal(model.needsHuman.unwakeable[0].requirementId, bad.requirementId)
    assert.equal(model.counts.needsHuman, 1)

    const html = renderPage(model)
    assert.match(html, /叫不醒的需求/)
    assert.match(html, /叫不醒的/)
    assert.match(html, /唤醒环叫不醒它/)
    // 只有那一个需求带红标，好的那个不该带
    assert.equal((html.match(/<span class="pill bad">叫不醒<\/span>/g) || []).length, 1)
  })
})

test('已结束且叫不醒的需求不算「要人动」', async () => {
  await withEnv(({ home, workdir, watchCacheRoot, runCacheRoot }) => {
    const record = createRequirementRecord({ workdir, runner: 'agent', sessionRef: 's' }, { home })
    closeRequirement({ home, projectKey: record.projectKey, requirementId: record.requirementId })

    const model = projectOverview({ home, watchCacheRoot, runCacheRoot, isAlive: () => false })
    assert.equal(model.needsHuman.unwakeable.length, 0)
    assert.equal(model.requirements[0].closed, true)
  })
})

test('执行环境：watcher 的 pool 计数来自它 runDir 里的 pool.json', async () => {
  await withEnv(({ home, workdir, watchCacheRoot, runCacheRoot }) => {
    const runDir = join(watchCacheRoot, 'watch-run-1')
    mkdirSync(runDir, { recursive: true })
    writeFileSync(
      join(runDir, 'pool.json'),
      `${JSON.stringify({ updatedAt: 123, ready: [{ id: 'a' }], blocked: [], inProgress: [{ id: 'b' }, { id: 'c' }] })}\n`,
      'utf8',
    )
    writeWatcherRegistry(watchCacheRoot, workdir, {
      pid: 111,
      state: 'running',
      runDir,
      claimMode: 'best-effort',
      lastPollAt: 456,
    })

    const model = projectOverview({ home, watchCacheRoot, runCacheRoot, isAlive: () => true })
    const env = model.environments[0]
    assert.equal(env.watcher.state, 'running')
    assert.equal(env.watcher.alive, true)
    assert.deepEqual(env.watcher.pool, { ready: 1, blocked: 0, inProgress: 2, updatedAt: 123 })
    assert.equal(env.stale, false)
    assert.match(renderPage(model), /ready 1 \/ 进行中 2 \/ 阻塞 0/)
  })
})

test('陈旧：注册表还在但进程已死，页面必须标出来，不能说在跑', async () => {
  await withEnv(({ home, workdir, watchCacheRoot, runCacheRoot }) => {
    writeWatcherRegistry(watchCacheRoot, workdir, { pid: 111, state: 'running', runDir: '' })
    writeLoopRegistry(runCacheRoot, workdir, { pid: 222, runDir: '/tmp/run-x' })

    const model = projectOverview({ home, watchCacheRoot, runCacheRoot, isAlive: () => false })
    const env = model.environments[0]
    assert.equal(env.stale, true)
    assert.equal(env.watcher.alive, false)
    assert.equal(env.run.alive, false)

    const html = renderPage(model)
    assert.match(html, /陈旧：注册表还在、进程已死/)
    assert.match(html, /（进程没了）/)
    assert.match(html, /run 已结束/)
  })
})

test('坏注册表文件与缺失的 pool 都不炸', async () => {
  await withEnv(({ home, workdir, watchCacheRoot, runCacheRoot }) => {
    writeFileSync(join(watchCacheRoot, 'watch-broken.json'), '{ 半截', 'utf8')
    writeWatcherRegistry(watchCacheRoot, workdir, { pid: 111, state: 'polling', runDir: '/tmp/不存在' })
    const model = projectOverview({ home, watchCacheRoot, runCacheRoot, isAlive: () => true })
    assert.equal(model.environments.length, 1)
    assert.equal(model.environments[0].watcher.pool, null)
  })
})

test('需求所在的 workdir 即使没有 watcher 也出现在环境列表里', async () => {
  await withEnv(({ home, workdir, watchCacheRoot, runCacheRoot }) => {
    const record = createRequirementRecord({ workdir, runner: 'pi', sessionRef: 's' }, { home })
    const model = projectOverview({ home, watchCacheRoot, runCacheRoot, isAlive: () => false })
    const env = model.environments[0]
    assert.equal(env.workdir, workdir)
    assert.equal(env.watcher, null)
    assert.deepEqual(env.requirements, [record.requirementId])
    assert.match(renderPage(model), /没有 watcher/)
  })
})

test('渲染：所有插值都转义（事件标题里就是 CLI 报错原文）', async () => {
  await withEnv(({ home, workdir, watchCacheRoot, runCacheRoot }) => {
    const record = createRequirementRecord(
      { workdir, title: '<img src=x onerror=alert(1)>', runner: 'pi', sessionRef: 's' },
      { home },
    )
    writeInboxItem(
      {
        kind: 'run-error',
        requirementId: record.requirementId,
        workdir,
        title: '报错 <script>alert(1)</script> & "quoted"',
        nextStep: '<b>下一步</b>',
      },
      { home },
    )
    writeInboxItem({ kind: 'watch-stop', workdir, title: '<i>无主</i>' }, { home })

    const html = renderPage(projectOverview({ home, watchCacheRoot, runCacheRoot, isAlive: () => false }))
    assert.ok(!html.includes('<img src=x'), '标题里的标签不能裸奔')
    assert.ok(!html.includes('<script>alert'), '事件标题里的脚本不能裸奔')
    assert.ok(!html.includes('<i>无主</i>'), '无主事件标题里的标签不能裸奔')
    assert.ok(!html.includes('<b>下一步</b>'), 'nextStep 也要转义')
    assert.match(html, /&lt;img src=x/)
    assert.match(html, /&amp; &quot;quoted&quot;/)
    assert.match(html, /下一步：&lt;b&gt;下一步&lt;\/b&gt;/)
  })
})

test('渲染：默认自动刷新，?static=1 关掉并可切回', async () => {
  await withEnv(({ home, watchCacheRoot, runCacheRoot }) => {
    const model = projectOverview({ home, watchCacheRoot, runCacheRoot, isAlive: () => false })
    const live = renderPage(model)
    const frozen = renderPage(model, { staticMode: true })

    assert.match(live, /http-equiv="refresh"/)
    assert.match(live, /停止自动刷新/)
    assert.ok(!frozen.includes('http-equiv="refresh"'))
    assert.match(frozen, /开启自动刷新/)
  })
})

test('页面明确声明不读 config.json', async () => {
  await withEnv(({ home, watchCacheRoot, runCacheRoot }) => {
    const html = renderPage(projectOverview({ home, watchCacheRoot, runCacheRoot, isAlive: () => false }))
    assert.match(html, /不读 <span class="mono">config\.json<\/span>/)
  })
})

// ---------------------------------------------------------------- 叫醒了但没处理完

test('seen 停了太久进「待人工处理」：这件事不给它留位置就永远不会被发现', async () => {
  await withEnv(({ home, workdir, watchCacheRoot, runCacheRoot }) => {
    const record = createRequirementRecord({ workdir, runner: 'pi', sessionRef: 's' }, { home })
    const item = writeInboxItem({ kind: 'run-end', requirementId: record.requirementId, workdir, title: '敲过没回音' }, { home })
    updateInboxItem(item.id, { state: 'seen' }, { home })

    // 窗口给 0：刚标 seen 也算停太久
    const stuck = projectOverview({ home, watchCacheRoot, runCacheRoot, isAlive: () => false, stuckSeenMs: 0 })
    assert.equal(stuck.needsHuman.stuckSeen.length, 1)
    assert.equal(stuck.needsHuman.stuckSeen[0].id, item.id)
    assert.match(stuck.needsHuman.stuckSeen[0].why, /没标成已处理/)
    assert.match(renderPage(stuck), /叫醒了但一直没处理完/)

    // 默认窗口下它不算卡住：刚敲完不该立刻要人动手
    const fresh = projectOverview({ home, watchCacheRoot, runCacheRoot, isAlive: () => false })
    assert.equal(fresh.needsHuman.stuckSeen.length, 0)

    // 处理掉的（done）永远不算
    updateInboxItem(item.id, { state: 'done' }, { home })
    const acked = projectOverview({ home, watchCacheRoot, runCacheRoot, isAlive: () => false, stuckSeenMs: 0 })
    assert.equal(acked.needsHuman.stuckSeen.length, 0)
  })
})

test('unread 的条目不会被当成「叫醒了没处理」', async () => {
  await withEnv(({ home, workdir, watchCacheRoot, runCacheRoot }) => {
    writeInboxItem({ kind: 'run-end', workdir, title: '还没敲过' }, { home })
    const model = projectOverview({ home, watchCacheRoot, runCacheRoot, isAlive: () => false, stuckSeenMs: 0 })
    assert.equal(model.needsHuman.stuckSeen.length, 0, '没敲过的走 unrouted，不走 stuckSeen')
    assert.equal(model.needsHuman.unrouted.length, 1)
  })
})

// ---------------------------------------------------------------- 最近唤醒

test('最近唤醒：drain 的结论留在页面上，事后看得出敲了什么、为什么没敲', async () => {
  await withEnv(({ home, watchCacheRoot, runCacheRoot }) => {
    appendWakeLog(
      {
        at: 1_700_000_000_000,
        scanned: 3,
        woke: [{ requirementId: 'req-a', runner: 'pi', items: ['i1'], runDir: 'C:/tmp/wake-1' }],
        waiting: [{ requirementId: 'req-b', reason: '心跳还新鲜（12s 前有人动过）', items: ['i2'] }],
        blocked: [],
        unrouted: [],
        failed: [],
        stuck: [],
      },
      { home },
    )

    const model = projectOverview({ home, watchCacheRoot, runCacheRoot, isAlive: () => false })
    assert.equal(model.wakeLog.length, 1)
    assert.equal(model.wakeLog[0].scanned, 3)

    const html = renderPage(model)
    assert.match(html, /最近唤醒/)
    assert.match(html, /敲醒 1/)
    assert.match(html, /等下一轮 1/)
    assert.match(html, /心跳还新鲜/)
    assert.match(html, /C:\/tmp\/wake-1/, '唤醒那一轮的报告目录要指出来，否则没人找得到')
  })
})

test('没有唤醒记录时不渲染空区块', async () => {
  await withEnv(({ home, watchCacheRoot, runCacheRoot }) => {
    const model = projectOverview({ home, watchCacheRoot, runCacheRoot, isAlive: () => false })
    assert.deepEqual(model.wakeLog, [])
    assert.ok(!renderPage(model).includes('最近唤醒'))
  })
})

test('唤醒记录损坏不炸页面，只当没有这一段', async () => {
  await withEnv(({ home, watchCacheRoot, runCacheRoot }) => {
    writeFileSync(join(home, 'wake-log.jsonl'), '{半截\n\n', 'utf8')
    const model = projectOverview({ home, watchCacheRoot, runCacheRoot, isAlive: () => false })
    assert.deepEqual(model.wakeLog, [])
    assert.match(renderPage(model), /AFK 总览/)
  })
})
