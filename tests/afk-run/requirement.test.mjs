/**
 * 需求本子单元测试（建 / 改 / 反查 / 心跳 / id 与路径）。
 *
 *   node --test tests/afk-run/requirement.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_HEARTBEAT_MS,
  buildWorkItemIndex,
  closeRequirement,
  createRequirementRecord,
  findRequirementById,
  findRequirementBySession,
  isHeartbeatFresh,
  linkWorkItems,
  listRequirementRecords,
  newRequirementId,
  readRequirementRecord,
  requirementDir,
  requirementNotFoundMessage,
  resolveEventRequirement,
  resolveLookupProjectKey,
  resolveRequirementForWorkItem,
  stampHeartbeat,
  updateRequirementRecord,
  workItemKey,
} from '../../skills/afk-run/scripts/requirement.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CLI = join(__dirname, '..', '..', 'skills', 'afk-run', 'scripts', 'requirement.mjs')

/** 跑 CLI：cwd 可以故意和需求目录不一样，AFK_HOME 指进临时 home。 */
function runCli(args, { home, cwd }) {
  const env = { ...process.env, AFK_HOME: home }
  try {
    return {
      code: 0,
      out: execFileSync(process.execPath, [CLI, ...args], {
        encoding: 'utf8',
        env,
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim(),
    }
  } catch (err) {
    return { code: err.status, out: ((err.stdout || '') + (err.stderr || '')).trim() }
  }
}

/** 每个测试一个干净的 AFK home 加一个 workdir。 */
async function withEnv(fn) {
  const home = mkdtempSync(join(tmpdir(), 'afk-req-home-'))
  const workdir = mkdtempSync(join(tmpdir(), 'afk-req-wd-'))
  try {
    return await fn({ home, workdir })
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(workdir, { recursive: true, force: true })
  }
}

test('建需求：自动 id、项目 key 从 workdir 推、默认值齐', async () => {
  await withEnv(({ home, workdir }) => {
    const record = createRequirementRecord({ workdir, title: '评估波次' }, { home })

    assert.match(record.requirementId, /^req-\d{6}-\d{4}-[a-z0-9]{4}$/)
    assert.ok(record.projectKey, 'projectKey 应当从 workdir 推出来')
    assert.equal(record.workdir, workdir)
    assert.equal(record.title, '评估波次')
    assert.equal(record.sessionRef, '')
    assert.equal(record.closedAt, null)
    assert.deepEqual(record.workItems, [])
    assert.ok(record.heartbeatAt > 0)

    const read = readRequirementRecord({ home, projectKey: record.projectKey, requirementId: record.requirementId })
    assert.equal(read.title, '评估波次')
  })
})

test('重复的需求 id 报错，不覆盖（覆盖会丢掉 sessionRef 和工单）', async () => {
  await withEnv(({ home, workdir }) => {
    const record = createRequirementRecord({ workdir, requirementId: 'req-fixed-1' }, { home })
    linkWorkItems({ home, projectKey: record.projectKey, requirementId: 'req-fixed-1' }, [
      { taskSource: 'tapd', id: '1' },
    ])
    assert.throws(
      () => createRequirementRecord({ workdir, requirementId: 'req-fixed-1' }, { home }),
      /需求已存在/,
    )
    const kept = readRequirementRecord({ home, projectKey: record.projectKey, requirementId: 'req-fixed-1' })
    assert.equal(kept.workItems.length, 1, '已存在的需求不该被清空')
  })
})

test('非法需求 id 被拒（含路径穿越）', async () => {
  await withEnv(({ home, workdir }) => {
    for (const bad of ['../evil', 'a/b', '带空格 的', 'req..x']) {
      assert.throws(() => createRequirementRecord({ workdir, requirementId: bad }, { home }), /id 非法/, bad)
    }
    // 中文 id 也拒：id 要进文件名，只收 ASCII 才跨平台安全
    assert.throws(() => createRequirementRecord({ workdir, requirementId: 'req-中文' }, { home }), /id 非法/)
  })
})

test('同一分钟内连建的需求 id 不撞', async () => {
  await withEnv(({ home, workdir }) => {
    const ids = new Set()
    for (let i = 0; i < 300; i += 1) ids.add(createRequirementRecord({ workdir }, { home }).requirementId)
    assert.equal(ids.size, 300)
    assert.equal(listRequirementRecords({ home }).length, 300)
  })
})

test('auto id 形状固定（后缀补零）', () => {
  for (let i = 0; i < 500; i += 1) {
    assert.match(newRequirementId(), /^req-\d{6}-\d{4}-[a-z0-9]{4}$/)
  }
})

test('挂工单去重', async () => {
  await withEnv(({ home, workdir }) => {
    const record = createRequirementRecord({ workdir }, { home })
    const key = { home, projectKey: record.projectKey, requirementId: record.requirementId }
    linkWorkItems(key, [{ taskSource: 'tapd', id: '1111' }, { taskSource: 'tapd', id: '2222' }])
    const after = linkWorkItems(key, [{ taskSource: 'TAPD', id: '1111' }, { taskSource: 'tapd', id: '3333' }])

    assert.equal(after.workItems.length, 3, '大小写不同的同一个工单只算一次')
    assert.deepEqual(after.workItems[0], { taskSource: 'tapd', id: '1111' })
  })
})

test('反查：两个 task source 用同一个 id 也分得开', async () => {
  await withEnv(({ home, workdir }) => {
    const gh = createRequirementRecord({ workdir, title: 'GH 的' }, { home })
    const tapd = createRequirementRecord({ workdir, title: 'TAPD 的' }, { home })
    linkWorkItems({ home, projectKey: gh.projectKey, requirementId: gh.requirementId }, [
      { taskSource: 'gh', id: '42' },
    ])
    linkWorkItems({ home, projectKey: tapd.projectKey, requirementId: tapd.requirementId }, [
      { taskSource: 'tapd', id: '42' },
    ])

    assert.equal(resolveRequirementForWorkItem({ home, taskSource: 'gh', id: '42' }).requirementId, gh.requirementId)
    assert.equal(
      resolveRequirementForWorkItem({ home, taskSource: 'tapd', id: '42' }).requirementId,
      tapd.requirementId,
    )
    assert.equal(resolveRequirementForWorkItem({ home, taskSource: 'gh', id: '999' }), null)
    assert.equal(buildWorkItemIndex({ home }).size, 2)
    assert.equal(workItemKey('TAPD', 42), 'tapd:42', '键要归一化大小写并把 id 转字符串')
  })
})

test('路由三层：显式 > 环境变量 > 按工单反查', async () => {
  await withEnv(({ home, workdir }) => {
    const record = createRequirementRecord({ workdir }, { home })
    linkWorkItems({ home, projectKey: record.projectKey, requirementId: record.requirementId }, [
      { taskSource: 'tapd', id: '1111' },
    ])
    const workItems = [{ taskSource: 'tapd', id: '1111' }]

    assert.deepEqual(
      resolveEventRequirement({ home, explicit: 'req-flag', env: { AFK_REQUIREMENT_ID: 'req-env' }, workItems }),
      { requirementId: 'req-flag', via: 'flag' },
    )
    assert.deepEqual(resolveEventRequirement({ home, env: { AFK_REQUIREMENT_ID: 'req-env' }, workItems }), {
      requirementId: 'req-env',
      via: 'env',
    })
    assert.deepEqual(resolveEventRequirement({ home, env: {}, workItems }), {
      requirementId: record.requirementId,
      via: 'work-item',
    })
    assert.equal(
      resolveEventRequirement({ home, env: {}, workItems: [{ taskSource: 'tapd', id: '没登记' }] }),
      null,
      '查不到就是 null，不能猜',
    )
  })
})

test('按 session reference 认需求（助理的无状态入口）', async () => {
  await withEnv(({ home, workdir }) => {
    const record = createRequirementRecord({ workdir, runner: 'pi', sessionRef: 'sess-abc' }, { home })
    assert.equal(findRequirementBySession({ home, sessionRef: 'sess-abc' }).requirementId, record.requirementId)
    assert.equal(findRequirementBySession({ home, sessionRef: 'sess-abc', runner: 'pi' }).requirementId, record.requirementId)
    assert.equal(findRequirementBySession({ home, sessionRef: 'sess-别的' }), null)
    assert.equal(findRequirementBySession({ home, sessionRef: '' }), null)
    assert.equal(findRequirementById({ home, requirementId: record.requirementId }).requirementId, record.requirementId)
    assert.equal(findRequirementById({ home, requirementId: 'req-missing' }), null)
  })
})

test('同一 session 两个需求且时间戳打平时，认谁必须是确定的', async () => {
  await withEnv(({ home, workdir }) => {
    // id 显式指定：读目录的顺序由文件系统决定（NTFS 是字母序），不能当平局决胜。
    // 这里让文件名顺序（aaaa → zzzz）与想要的答案（zzzz）相反，就能真的抳住这个 bug。
    const names = ['req-260101-0000-aaaa', 'req-260101-0000-zzzz']
    const [smaller, bigger] = names.map((requirementId) =>
      createRequirementRecord(
        { requirementId, workdir, runner: 'pi', sessionRef: 'sess-shared' },
        { home },
      ),
    )

    // 强制打平：同一毫秒内建两条就是这个样子（真实产出里很常见）
    const pinned = 1_700_000_000_000
    for (const r of [smaller, bigger]) {
      const key = { home, projectKey: r.projectKey, requirementId: r.requirementId }
      const raw = readRequirementRecord(key)
      const file = join(requirementDir(home, r.projectKey), `${r.requirementId}.json`)
      writeFileSync(file, `${JSON.stringify({ ...raw, updatedAt: pinned })}\n`, 'utf8')
    }

    // 平局用 id 降序兜底（id 以时间戳开头，降序 ≈ 新的在前），且每次都得同一个
    const picked = [...Array(5)].map(
      () => findRequirementBySession({ home, sessionRef: 'sess-shared' }).requirementId,
    )
    assert.equal(new Set(picked).size, 1, '每次都得同一个：否则 checkin 会认到另一个需求')
    assert.equal(picked[0], bigger.requirementId)
  })
})

test('心跳窗口：边界内新鲜，超出即旧', async () => {
  const record = { heartbeatAt: 1_000 }
  assert.equal(isHeartbeatFresh(record, { now: 1_000 + DEFAULT_HEARTBEAT_MS - 1 }), true)
  assert.equal(isHeartbeatFresh(record, { now: 1_000 + DEFAULT_HEARTBEAT_MS + 1 }), false)
  assert.equal(isHeartbeatFresh(record, { now: 2_000, windowMs: 500 }), false)
  assert.equal(isHeartbeatFresh(null), false)
  assert.equal(isHeartbeatFresh({}), false)
})

test('盖心跳只动 heartbeatAt，并把 updatedAt 推进', async () => {
  await withEnv(({ home, workdir }) => {
    const record = createRequirementRecord({ workdir }, { home })
    const before = readRequirementRecord({ home, projectKey: record.projectKey, requirementId: record.requirementId })
    const next = stampHeartbeat(
      { home, projectKey: record.projectKey, requirementId: record.requirementId },
      1_700_000_000_000,
    )
    assert.equal(next.heartbeatAt, 1_700_000_000_000)
    assert.equal(next.title, before.title)
    assert.ok(next.updatedAt >= before.updatedAt)
  })
})

test('update 不许改 requirementId / projectKey / createdAt', async () => {
  await withEnv(({ home, workdir }) => {
    const record = createRequirementRecord({ workdir }, { home })
    const next = updateRequirementRecord(
      { home, projectKey: record.projectKey, requirementId: record.requirementId },
      { requirementId: '换掉', projectKey: '换掉', createdAt: 1, title: '新标题' },
    )
    assert.equal(next.requirementId, record.requirementId)
    assert.equal(next.projectKey, record.projectKey)
    assert.equal(next.createdAt, record.createdAt)
    assert.equal(next.title, '新标题')
  })
})

test('update 不存在的需求返回 null，不建新文件', async () => {
  await withEnv(({ home }) => {
    assert.equal(updateRequirementRecord({ home, projectKey: 'proj_x_1', requirementId: 'req-missing' }, { title: 'x' }), null)
    assert.equal(readRequirementRecord({ home, projectKey: 'proj_x_1', requirementId: 'req-missing' }), null)
  })
})

test('关闭需求：closedAt 有值，但倒排表里仍找得到（旧事件还得找到主人）', async () => {
  await withEnv(({ home, workdir }) => {
    const record = createRequirementRecord({ workdir }, { home })
    linkWorkItems({ home, projectKey: record.projectKey, requirementId: record.requirementId }, [
      { taskSource: 'tapd', id: '1111' },
    ])
    const closed = closeRequirement({ home, projectKey: record.projectKey, requirementId: record.requirementId })
    assert.ok(closed.closedAt > 0)
    assert.equal(resolveRequirementForWorkItem({ home, taskSource: 'tapd', id: '1111' }).requirementId, record.requirementId)
  })
})

test('坏文件与 inbox 目录都不影响扫需求', async () => {
  await withEnv(({ home, workdir }) => {
    const record = createRequirementRecord({ workdir }, { home })
    writeFileSync(join(home, record.projectKey, 'requirements', 'broken.json'), '{ 半截', 'utf8')
    mkdirSync(join(home, 'inbox'), { recursive: true })

    const records = listRequirementRecords({ home })
    assert.equal(records.length, 1)
    assert.equal(records[0].requirementId, record.requirementId)
  })
})

test('resolveLookupProjectKey：显式 project > workdir > cwd', async () => {
  await withEnv(({ home, workdir }) => {
    const record = createRequirementRecord({ workdir }, { home })
    assert.equal(resolveLookupProjectKey({ projectKey: 'explicit_key' }), 'explicit_key')
    assert.equal(resolveLookupProjectKey({ workdir }), record.projectKey)
    assert.equal(resolveLookupProjectKey({ cwd: workdir }), record.projectKey)
  })
})

test('没找到需求的提示：说清它属于哪个项目、加什么参数', () => {
  const base = { requirementId: 'req-x', projectKey: 'here_00000000' }
  assert.equal(requirementNotFoundMessage(base), '没找到需求: req-x（项目 here_00000000）')

  const hint = requirementNotFoundMessage({
    ...base,
    elsewhere: { projectKey: 'there_11111111', workdir: 'C:/projects/there' },
  })
  assert.match(hint, /没找到需求: req-x（项目 here_00000000）/)
  assert.match(hint, /属于项目 there_11111111/)
  assert.match(hint, /--project there_11111111/)
  assert.match(hint, /C:\/projects\/there/)

  // 就是本项目缺文件时不该凭空多一句「它在别处」
  assert.equal(
    requirementNotFoundMessage({ ...base, elsewhere: { projectKey: 'here_00000000' } }),
    '没找到需求: req-x（项目 here_00000000）',
  )
})

test('CLI：从别的 cwd 用 --project / --workdir 定位需求', async () => {
  await withEnv(async ({ home, workdir }) => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'afk-req-other-'))
    try {
      const record = createRequirementRecord({ workdir, title: '跨目录' }, { home })

      // 不带定位：按 cwd 推，找不到，但提示要指出真正的项目
      const miss = runCli(['--get', '--requirement', record.requirementId], { home, cwd: elsewhere })
      assert.equal(miss.code, 3)
      assert.match(miss.out, new RegExp(record.projectKey))
      assert.match(miss.out, /--project/)

      // --project 从任意 cwd 找到它
      const byProject = runCli(['--get', '--requirement', record.requirementId, '--project', record.projectKey, '--json'], {
        home,
        cwd: elsewhere,
      })
      assert.equal(byProject.code, 0)
      assert.equal(JSON.parse(byProject.out).requirementId, record.requirementId)

      // --workdir 同理（与 --create 的定位方式一致）
      const byWorkdir = runCli(['--get', '--requirement', record.requirementId, '--workdir', workdir], {
        home,
        cwd: elsewhere,
      })
      assert.equal(byWorkdir.code, 0)
      assert.match(byWorkdir.out, new RegExp(record.requirementId))

      // 反向：在需求自己的 workdir 里不传定位，行为与以前一致
      const inWorkdir = runCli(['--get', '--requirement', record.requirementId], { home, cwd: workdir })
      assert.equal(inWorkdir.code, 0)
    } finally {
      rmSync(elsewhere, { recursive: true, force: true })
    }
  })
})

test('CLI：从别的 cwd 用 --project 挂工单、关单', async () => {
  await withEnv(async ({ home, workdir }) => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'afk-req-other-'))
    try {
      const record = createRequirementRecord({ workdir }, { home })
      const locate = ['--requirement', record.requirementId, '--project', record.projectKey]

      const linked = runCli(['--link', ...locate, '--source', 'beads', '--item', 'e2e-wik'], { home, cwd: elsewhere })
      assert.equal(linked.code, 0)
      assert.deepEqual(JSON.parse(linked.out).workItems, [{ taskSource: 'beads', id: 'e2e-wik' }])

      const closed = runCli(['--close', ...locate], { home, cwd: elsewhere })
      assert.equal(closed.code, 0)
      assert.ok(JSON.parse(closed.out).closedAt > 0)

      const after = readRequirementRecord({ home, projectKey: record.projectKey, requirementId: record.requirementId })
      assert.equal(after.workItems.length, 1)
      assert.ok(after.closedAt > 0)
    } finally {
      rmSync(elsewhere, { recursive: true, force: true })
    }
  })
})
