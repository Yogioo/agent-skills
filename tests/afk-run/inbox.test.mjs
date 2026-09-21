/**
 * 收件箱单元测试（投信 / 读信 / 状态迁移 / 撞名 / 容错）。
 *
 *   node --test tests/afk-run/inbox.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  INBOX_STATES,
  ackInboxItem,
  inboxCounts,
  listInboxItems,
  updateInboxItem,
  writeInboxItem,
} from '../../skills/afk-run/scripts/inbox.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

/** 每个测试一个干净的 AFK home。模块都收 `home` 参数，所以不必改环境变量。 */
async function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'afk-inbox-'))
  try {
    return await fn(home)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

test('投一条事件，能原样读回来，项目 key 自动推出来', async () => {
  await withHome((home) => {
    const item = writeInboxItem(
      {
        kind: 'run-end',
        requirementId: 'req-1',
        workdir: 'C:/projects/Demo',
        workItems: [{ taskSource: 'tapd', id: '1111' }],
        title: '一批干完：1 完成 / 0 失败',
        detail: { done: 1 },
        nextStep: '读报告',
      },
      { home },
    )

    assert.equal(item.state, 'unread')
    assert.equal(item.requirementId, 'req-1')
    assert.ok(item.projectKey, 'workdir 给了，projectKey 应当自动推出来')
    assert.deepEqual(item.workItems, [{ taskSource: 'tapd', id: '1111' }])

    const [read] = listInboxItems({ home })
    assert.equal(read.id, item.id)
    assert.equal(read.title, '一批干完：1 完成 / 0 失败')
    assert.deepEqual(read.detail, { done: 1 })
    assert.ok(existsSync(item.file))
  })
})

test('没给 requirementId 的事件是无主，不是错', async () => {
  await withHome((home) => {
    const item = writeInboxItem({ kind: 'watch-stop', workdir: 'C:/projects/Demo' }, { home })
    assert.equal(item.requirementId, null)

    const unrouted = listInboxItems({ home, unroutedOnly: true })
    assert.equal(unrouted.length, 1)
    assert.equal(unrouted[0].id, item.id)
  })
})

test('状态只由显式 ack 推动：unread → seen → done', async () => {
  await withHome((home) => {
    const item = writeInboxItem({ kind: 'run-end', workdir: 'C:/projects/Demo' }, { home })

    // 读一眼不改状态
    listInboxItems({ home, states: ['unread'] })
    assert.equal(listInboxItems({ home, states: ['unread'] }).length, 1)

    ackInboxItem(item.id, { home, state: 'seen', note: '已叫醒' })
    assert.equal(listInboxItems({ home, states: ['unread'] }).length, 0)
    assert.equal(listInboxItems({ home, states: ['seen'] }).length, 1)

    const done = ackInboxItem(item.id, { home, state: 'done', note: '清单已出' })
    assert.equal(done.state, 'done')
    assert.equal(done.note, '清单已出')
    assert.deepEqual(inboxCounts({ home }), { unread: 0, seen: 0, done: 1 })
  })
})

test('ack 未知状态与不存在的 id 都报错', async () => {
  await withHome((home) => {
    writeInboxItem({ kind: 'run-end', workdir: 'C:/projects/Demo' }, { home })
    assert.throws(() => ackInboxItem('不存在的-id', { home }), /不存在/)
    const item = writeInboxItem({ kind: 'run-end', workdir: 'C:/projects/Demo' }, { home })
    assert.throws(() => ackInboxItem(item.id, { home, state: '别乱来' }), /未知收件箱状态/)
  })
  assert.deepEqual(INBOX_STATES, ['unread', 'seen', 'done'])
})

test('id 只校验不加工，所以长 id 也找得到自己的文件', async () => {
  await withHome((home) => {
    // questionnaire-submitted 这种长 kind 会造出 >40 字符的 id：
    // 早先版本把文件名净化函数套在 id 上（它会截断），于是自己写的条目找不到。
    const item = writeInboxItem(
      { kind: 'questionnaire-submitted', requirementId: 'req-260921-1055-abcd', workdir: 'C:/projects/Demo' },
      { home },
    )
    assert.ok(item.id.length > 40, `id 应当够长以复现截断问题，实际 ${item.id.length}`)
    assert.ok(readdirSync(join(home, 'inbox')).includes(`${item.id}.json`))
    assert.equal(ackInboxItem(item.id, { home, state: 'done' }).state, 'done')
  })
})

test('ack 拒绝路径穿越与含斜杠的 id', async () => {
  await withHome((home) => {
    assert.throws(() => ackInboxItem('../evil', { home }), /id 非法/)
    assert.throws(() => ackInboxItem('a/b', { home }), /id 非法/)
  })
})

test('同一秒里连投的事件互不覆盖', async () => {
  await withHome((home) => {
    const count = 300
    const ids = new Set()
    for (let i = 0; i < count; i += 1) {
      const item = writeInboxItem({ kind: 'run-end', workdir: 'C:/projects/Demo', title: `第 ${i} 条` }, { home })
      ids.add(item.id)
    }
    assert.equal(ids.size, count, '同一秒内 id 撞了就会覆盖别人的事件')
    const stored = listInboxItems({ home })
    assert.equal(stored.length, count)
    assert.equal(new Set(stored.map((item) => item.title)).size, count, '内容也不能丢')
    // 原子写不该留下半截文件
    assert.deepEqual(readdirSync(join(home, 'inbox')).filter((f) => !f.endsWith('.json')), [])
  })
})

test('updateInboxItem 不许改 id / kind / createdAt', async () => {
  await withHome((home) => {
    const item = writeInboxItem({ kind: 'run-end', workdir: 'C:/projects/Demo' }, { home })
    const next = updateInboxItem(item.id, { id: '换掉', kind: '换掉', createdAt: 1, wakeAttempts: 2 }, { home })
    assert.equal(next.id, item.id)
    assert.equal(next.kind, 'run-end')
    assert.equal(next.createdAt, item.createdAt)
    assert.equal(next.wakeAttempts, 2)
  })
})

test('坏文件与半截 .tmp 不影响读，也不影响写', async () => {
  await withHome((home) => {
    writeInboxItem({ kind: 'run-end', workdir: 'C:/projects/Demo' }, { home })
    writeFileSync(join(home, 'inbox', 'broken.json'), '{ 半截', 'utf8')
    writeFileSync(join(home, 'inbox', 'leftover.json.tmp'), '{}', 'utf8')

    assert.equal(listInboxItems({ home }).length, 1)
    const added = writeInboxItem({ kind: 'run-end', workdir: 'C:/projects/Demo' }, { home })
    assert.equal(listInboxItems({ home }).length, 2)
    assert.ok(added.id)
  })
})

test('按状态、需求与项目过滤', async () => {
  await withHome((home) => {
    const a = writeInboxItem({ kind: 'run-end', requirementId: 'req-a', workdir: 'C:/projects/Demo' }, { home })
    writeInboxItem({ kind: 'run-end', requirementId: 'req-b', workdir: 'C:/projects/Demo' }, { home })
    ackInboxItem(a.id, { home, state: 'done' })

    assert.equal(listInboxItems({ home, states: ['unread'] }).length, 1)
    assert.equal(listInboxItems({ home, requirementId: 'req-a' }).length, 1)
    assert.equal(listInboxItems({ home, requirementId: 'req-a', states: ['unread'] }).length, 0)
    assert.equal(listInboxItems({ home, projectKey: '查不到的项目' }).length, 0)
  })
})

test('列表按创建时间升序', async () => {
  await withHome((home) => {
    const first = writeInboxItem({ kind: 'run-end', workdir: 'C:/projects/Demo' }, { home })
    const second = writeInboxItem({ kind: 'watch-stop', workdir: 'C:/projects/Demo' }, { home })
    const ids = listInboxItems({ home }).map((item) => item.id)
    assert.deepEqual(ids, [first.id, second.id])
  })
})
