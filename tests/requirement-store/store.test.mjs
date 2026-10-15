/**
 * requirement-store tests: lifecycle, linkage ownership, heartbeat, corruption,
 * CLI, cross-process persistence, standalone copy, and a Windows directory
 * junction entry.
 *
 * Run: node --test tests/requirement-store/store.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_HEARTBEAT_MS,
  RequirementStoreError,
  closeRequirement,
  createRequirement,
  findRequirementBySession,
  findRequirementsBySession,
  findRequirementsByWorkItem,
  getRequirement,
  heartbeat,
  isHeartbeatFresh,
  linkWorkItems,
  listRequirements,
  setSession,
  whereWorkItem,
  workItemKey,
} from '../../lib/requirement-store.mjs'
import { createRuntimeCopy } from '../support/runtime-package.mjs'

const cli = fileURLToPath(new URL('../../tools/requirement-store/cli.mjs', import.meta.url))

function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }))
  return dir
}

function invoke(args, { executable = cli, cwd, env = {}, input } = {}) {
  const result = spawnSync(process.execPath, [executable, ...args], {
    cwd,
    input,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
    env: { ...process.env, ...env },
  })
  assert.ifError(result.error)
  assert.equal(result.signal, null)
  return result
}

function success(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.equal(result.stderr, '')
  return JSON.parse(result.stdout)
}

function failure(result, code) {
  assert.equal(result.status, code, result.stderr || result.stdout)
  assert.equal(result.stdout, '')
}

function runConcurrent(invocations) {
  return Promise.all(
    invocations.map(
      (args) =>
        new Promise((resolve) => {
          const child = spawn(process.execPath, args, { windowsHide: true })
          let stdout = ''
          let stderr = ''
          child.stdout.on('data', (chunk) => {
            stdout += chunk
          })
          child.stderr.on('data', (chunk) => {
            stderr += chunk
          })
          child.on('close', (status, signal) => resolve({ status, signal, stdout, stderr }))
        }),
    ),
  )
}

test('create keeps explicit project metadata and fills defaults', (t) => {
  const dir = tempDir(t, 'requirement-store-create-')
  const record = createRequirement({ projectKey: 'p1', title: '评估波次', workdir: 'C:/work dir' }, { dir })

  assert.match(record.id, /^req-\d{8}-\d{4}-[a-f0-9]{8}$/)
  assert.equal(record.projectKey, 'p1')
  assert.equal(record.title, '评估波次')
  assert.equal(record.workdir, 'C:/work dir')
  assert.equal(record.runner, '')
  assert.equal(record.sessionRef, '')
  assert.deepEqual(record.workItems, [])
  assert.equal(record.closedAt, null)
  assert.ok(record.heartbeatAt > 0)
  assert.equal(getRequirement(record.id, { dir }).title, '评估波次')
})

test('an explicit duplicate id is an error and never overwrites', (t) => {
  const dir = tempDir(t, 'requirement-store-dupe-')
  const first = createRequirement({ id: 'req-fixed', projectKey: 'p1' }, { dir })
  linkWorkItems(first.id, [{ taskSource: 'tapd', id: '1' }], { dir })
  assert.throws(() => createRequirement({ id: 'req-fixed', projectKey: 'p1' }, { dir }), /需求已存在/)
  assert.equal(getRequirement('req-fixed', { dir }).workItems.length, 1, 'existing work items must survive')
})

test('invalid ids and path traversal are rejected', (t) => {
  const dir = tempDir(t, 'requirement-store-ids-')
  for (const bad of ['../evil', 'a/b', '带空格 的', 'req..x', 'req-中文']) {
    assert.throws(() => createRequirement({ id: bad, projectKey: 'p1' }, { dir }), RequirementStoreError, bad)
    assert.throws(() => getRequirement(bad, { dir }), /id 非法/, bad)
  }
})

test('link dedupes, rejects silent ownership, and reports ambiguity on demand', (t) => {
  const dir = tempDir(t, 'requirement-store-link-')
  const a = createRequirement({ projectKey: 'p1' }, { dir })
  const b = createRequirement({ projectKey: 'p1' }, { dir })

  const linked = linkWorkItems(a.id, [{ taskSource: 'TAPD', id: 1111 }, { taskSource: 'tapd', id: '1111' }], { dir })
  assert.deepEqual(linked.workItems, [{ taskSource: 'tapd', id: '1111' }], 'same key dedupes and normalizes case')

  assert.throws(
    () => linkWorkItems(b.id, [{ taskSource: 'tapd', id: '1111' }], { dir }),
    /已被其他需求认领/,
  )
  assert.equal(findRequirementsByWorkItem({ dir, taskSource: 'tapd', id: '1111' }).length, 1)

  linkWorkItems(b.id, [{ taskSource: 'tapd', id: '1111' }], { dir, allowShared: true })
  const where = whereWorkItem({ dir, taskSource: 'tapd', id: '1111' })
  assert.equal(where.ambiguous, true)
  assert.equal(where.matches.length, 2)
  assert.equal(where.none, false)

  const missing = whereWorkItem({ dir, taskSource: 'gh', id: '999' })
  assert.equal(missing.none, true)
  assert.equal(missing.ambiguous, false)
  assert.equal(workItemKey('TAPD', 42), 'tapd:42')
})

test('session lookup and heartbeats are explicit and newest-first', (t) => {
  const dir = tempDir(t, 'requirement-store-session-')
  const older = createRequirement({ projectKey: 'p1', runner: 'pi', sessionRef: 'sess-me' }, { dir })
  const newer = createRequirement({ projectKey: 'p1', runner: 'pi', sessionRef: 'sess-me' }, { dir })

  const found = findRequirementsBySession({ dir, sessionRef: 'sess-me' })
  assert.equal(found.length, 2)
  assert.equal(newer.updatedAt, found[0].updatedAt)
  assert.ok(found[0].updatedAt >= found[1].updatedAt)
  assert.equal(findRequirementBySession({ dir, sessionRef: 'sess-me' }).id, found[0].id)
  assert.equal(findRequirementBySession({ dir, sessionRef: 'nope' }), null)

  setSession(older.id, { dir, runner: 'codex', sessionRef: 'sess-other' })
  assert.equal(getRequirement(older.id, { dir }).sessionRef, 'sess-other')

  const before = getRequirement(older.id, { dir })
  const beaten = heartbeat(older.id, { dir, at: 1_700_000_000_000 })
  assert.equal(beaten.heartbeatAt, 1_700_000_000_000)
  assert.equal(beaten.title, before.title)
  assert.equal(isHeartbeatFresh({ heartbeatAt: 1_000 }, { now: 1_000 + DEFAULT_HEARTBEAT_MS - 1 }), true)
  assert.equal(isHeartbeatFresh({ heartbeatAt: 1_000 }, { now: 1_000 + DEFAULT_HEARTBEAT_MS + 1 }), false)
  assert.equal(isHeartbeatFresh(null), false)
})

test('close only marks the local record and is idempotent', (t) => {
  const dir = tempDir(t, 'requirement-store-close-')
  const record = createRequirement({ projectKey: 'p1' }, { dir })
  linkWorkItems(record.id, [{ taskSource: 'tapd', id: '1' }], { dir })

  const closed = closeRequirement(record.id, { dir, at: 111 })
  assert.equal(closed.closedAt, 111)
  assert.equal(closeRequirement(record.id, { dir, at: 999 }).closedAt, 111)
  assert.equal(findRequirementsByWorkItem({ dir, taskSource: 'tapd', id: '1' })[0].id, record.id)
  assert.equal(getRequirement(record.id, { dir }).workItems.length, 1)
})

test('list filters by project and open/closed, and surfaces corruption', (t) => {
  const dir = tempDir(t, 'requirement-store-list-')
  const a = createRequirement({ projectKey: 'p1' }, { dir })
  createRequirement({ projectKey: 'p2' }, { dir })
  closeRequirement(a.id, { dir })
  writeFileSync(join(dir, 'req-broken.json'), '{ 半截', 'utf8')

  const listed = listRequirements({ dir })
  assert.equal(listed.items.length, 2)
  assert.equal(listed.invalid.length, 1)
  assert.match(listed.invalid[0].error, /损坏/)
  assert.deepEqual(listRequirements({ dir, projectKey: 'p1', state: 'closed' }).items.map((r) => r.id), [a.id])
  assert.equal(listRequirements({ dir, state: 'open' }).items.length, 1)
  assert.throws(() => getRequirement('req-broken', { dir }), /损坏/)
})

test('help exits 0 and invalid arguments exit 2', (t) => {
  const dir = tempDir(t, 'requirement-store-cli-bad-')
  for (const args of [['--help'], []]) {
    const help = invoke(args)
    assert.equal(help.status, 0)
    assert.match(help.stdout, /create/)
  }
  failure(invoke(['bogus']), 2)
  failure(invoke(['get', '--dir', dir]), 2)
  failure(invoke(['link', '--dir', dir, '--id', 'req-x', '--item', '1']), 2)
  failure(invoke(['list', '--dir', dir, '--state', 'bogus']), 2)
  failure(invoke(['where', '--dir', dir, '--source', 'gh', '--item', '5']), 1)
})

test('CLI lifecycle works across separate processes', (t) => {
  const dir = join(tempDir(t, 'requirement-store-cli-'), 'store dir')
  const created = success(invoke(['create', '--dir', dir, '--project', 'p1', '--title', '跨进程', '--workdir', 'C:/work dir']))
  assert.equal(created.projectKey, 'p1')

  const listed = success(invoke(['list', '--dir', dir, '--project', 'p1']))
  assert.deepEqual(listed.items.map((r) => r.id), [created.id])

  const linked = success(invoke(['link', '--dir', dir, '--id', created.id, '--source', 'beads', '--item', 'e2e-wik']))
  assert.deepEqual(linked.workItems, [{ taskSource: 'beads', id: 'e2e-wik' }])

  const where = success(invoke(['where', '--dir', dir, '--source', 'beads', '--item', 'e2e-wik']))
  assert.equal(where.ambiguous, false)
  assert.equal(where.matches[0].id, created.id)

  const closed = success(invoke(['close', '--dir', dir, '--id', created.id]))
  assert.ok(closed.closedAt > 0)
  const relinked = success(invoke(['link', '--dir', dir, '--id', created.id, '--source', 'beads', '--item', 'e2e-wik']))
  assert.equal(relinked.workItems.length, 1, 'relinking the same item is idempotent')
  failure(invoke(['get', '--dir', dir, '--id', 'req-missing']), 1)
})

test('CLI set-session, heartbeat and ambiguous where are explicit', (t) => {
  const dir = join(tempDir(t, 'requirement-store-cli2-'), 'store dir')
  const a = success(invoke(['create', '--dir', dir, '--project', 'p1']))
  const b = success(invoke(['create', '--dir', dir, '--project', 'p1']))
  success(invoke(['link', '--dir', dir, '--id', a.id, '--source', 'gh', '--item', '42']))
  success(invoke(['link', '--dir', dir, '--id', b.id, '--source', 'gh', '--item', '42', '--allow-shared']))

  const where = success(invoke(['where', '--dir', dir, '--source', 'gh', '--item', '42']))
  assert.equal(where.ambiguous, true)
  assert.equal(where.matches.length, 2)

  const session = success(invoke(['set-session', '--dir', dir, '--id', a.id, '--runner', 'pi', '--ref', 'sess-1']))
  assert.equal(session.runner, 'pi')
  assert.equal(session.sessionRef, 'sess-1')

  const beaten = success(invoke(['heartbeat', '--dir', dir, '--id', a.id]))
  assert.ok(beaten.heartbeatAt > 0)
  failure(invoke(['heartbeat', '--dir', dir, '--id', 'req-missing']), 1)
})

test('copied runtime runs alone with no legacy skills', (t) => {
  const home = tempDir(t, 'requirement-store-copy-')
  const rt = createRuntimeCopy('requirement-store-runtime-')
  t.after(() => rmSync(rt.root, { recursive: true, force: true, maxRetries: 3 }))
  assert.equal(existsSync(join(rt.root, 'skills')), false)
  const executable = rt.cli('requirement-store')
  const store = join(home, 'store')
  const created = success(invoke(['create', '--dir', store, '--project', 'p1'], { executable, cwd: home }))
  assert.equal(success(invoke(['get', '--dir', store, '--id', created.id], { executable, cwd: home })).id, created.id)
})

test('installed runtime directory junction executes help and create', function (t) {
  if (process.platform !== 'win32') t.skip('Windows junction test')
  const home = tempDir(t, 'requirement-store-junction-')
  const rt = createRuntimeCopy('requirement-store-junction-')
  t.after(() => rmSync(rt.root, { recursive: true, force: true, maxRetries: 3 }))
  const installed = join(home, 'installed-runtime')
  symlinkSync(rt.root, installed, 'junction')
  const executable = join(installed, 'tools', 'requirement-store', 'cli.mjs')
  const help = invoke(['--help'], { executable, cwd: home })
  assert.equal(help.status, 0, help.stderr)
  assert.match(help.stdout, /create/)
  const store = join(home, 'store')
  assert.ok(success(invoke(['create', '--dir', store, '--project', 'p1'], { executable, cwd: home })).id)
})

test('create with initial work items enforces the same ownership policy', (t) => {
  const dir = tempDir(t, 'requirement-store-create-link-')
  const a = createRequirement(
    { projectKey: 'p1', workItems: [{ taskSource: 'TAPD', id: 7 }, { taskSource: 'tapd', id: '7' }] },
    { dir },
  )
  assert.deepEqual(a.workItems, [{ taskSource: 'tapd', id: '7' }], 'initial items dedupe and normalize')
  assert.throws(
    () => createRequirement({ projectKey: 'p1', workItems: [{ taskSource: 'tapd', id: '7' }] }, { dir }),
    /已被其他需求认领/,
  )
  const shared = createRequirement(
    { projectKey: 'p1', workItems: [{ taskSource: 'tapd', id: '7' }] },
    { dir, allowShared: true },
  )
  assert.deepEqual(shared.workItems, [{ taskSource: 'tapd', id: '7' }])
  assert.equal(whereWorkItem({ dir, taskSource: 'tapd', id: '7' }).ambiguous, true)
})

test('corrupt records block ownership checks instead of claiming false uniqueness', (t) => {
  const dir = tempDir(t, 'requirement-store-corrupt-own-')
  const a = createRequirement({ projectKey: 'p1' }, { dir })
  createRequirement({ projectKey: 'p1' }, { dir })
  writeFileSync(
    join(dir, 'req-corrupt.json'),
    JSON.stringify({ id: 'req-corrupt', createdAt: 1, workItems: [{ taskSource: 'tapd', id: '1' }] }),
    'utf8',
  )
  assert.throws(() => linkWorkItems(a.id, [{ taskSource: 'tapd', id: '1' }], { dir }), /损坏/)
  assert.throws(() => findRequirementsByWorkItem({ dir, taskSource: 'tapd', id: '1' }), /损坏/)
  assert.throws(() => whereWorkItem({ dir, taskSource: 'tapd', id: '1' }), /损坏/)
  assert.equal(listRequirements({ dir }).invalid.length, 1, 'list must still surface the corrupt record')
})

test('malformed requirement fields are invalid and strict get throws', (t) => {
  const dir = tempDir(t, 'requirement-store-malformed-')
  writeFileSync(
    join(dir, 'req-badtime.json'),
    JSON.stringify({ id: 'req-badtime', createdAt: 1, updatedAt: 'x', workItems: [] }),
    'utf8',
  )
  writeFileSync(
    join(dir, 'req-baditems.json'),
    JSON.stringify({ id: 'req-baditems', createdAt: 1, updatedAt: 2, workItems: 'nope' }),
    'utf8',
  )
  const listed = listRequirements({ dir })
  assert.equal(listed.items.length, 0)
  assert.equal(listed.invalid.length, 2)
  assert.throws(() => getRequirement('req-badtime', { dir }), /损坏/)
  assert.throws(() => getRequirement('req-baditems', { dir }), /损坏/)
})

test('mutations respect the persisted updatedAt even when the clock goes back', (t) => {
  const dir = tempDir(t, 'requirement-store-monotonic-')
  const future = Date.now() + 10_000_000
  const record = createRequirement({ projectKey: 'p1' }, { dir, now: future })
  const beaten = heartbeat(record.id, { dir })
  assert.ok(beaten.updatedAt >= record.updatedAt + 1, 'updatedAt must never move backwards')
  const session = setSession(record.id, { dir, sessionRef: 'sess-later' })
  assert.ok(session.updatedAt >= beaten.updatedAt + 1)
})

test('invalid caller timestamps are rejected', (t) => {
  const dir = tempDir(t, 'requirement-store-time-')
  assert.throws(() => createRequirement({ projectKey: 'p1' }, { dir, now: NaN }), /时间戳/)
  const record = createRequirement({ projectKey: 'p1' }, { dir })
  assert.throws(() => heartbeat(record.id, { dir, at: -5 }), /时间戳/)
  assert.throws(() => closeRequirement(record.id, { dir, at: Infinity }), /时间戳/)
})

test('duplicate explicit id across separate processes creates exactly one record', async (t) => {
  const dir = tempDir(t, 'requirement-store-dupe-proc-')
  const results = await runConcurrent([
    [cli, 'create', '--dir', dir, '--id', 'req-race', '--project', 'p1'],
    [cli, 'create', '--dir', dir, '--id', 'req-race', '--project', 'p1'],
  ])
  for (const result of results) assert.equal(result.signal, null)
  const winners = results.filter((result) => result.status === 0)
  assert.equal(
    winners.length,
    1,
    `expected exactly one winner: ${JSON.stringify(results.map((r) => [r.status, r.stderr]))}`,
  )
  assert.equal(JSON.parse(winners[0].stdout).id, 'req-race')
  const stored = getRequirement('req-race', { dir })
  assert.equal(stored.projectKey, 'p1')
  assert.equal(listRequirements({ dir }).items.length, 1)
  assert.equal(existsSync(join(dir, '.write.lock')), false, 'no writer lock may be left behind')
})

test('linking one work item to different requirements conflicts across processes', async (t) => {
  const dir = tempDir(t, 'requirement-store-link-proc-')
  const a = success(invoke(['create', '--dir', dir, '--project', 'p1']))
  const b = success(invoke(['create', '--dir', dir, '--project', 'p1']))
  assert.equal(
    success(invoke(['link', '--dir', dir, '--id', a.id, '--source', 'gh', '--item', '42'])).workItems.length,
    1,
  )
  const second = invoke(['link', '--dir', dir, '--id', b.id, '--source', 'gh', '--item', '42'])
  assert.equal(second.status, 2)
  assert.equal(second.stdout, '')
  assert.match(second.stderr, /已被其他需求认领/)
  assert.equal(getRequirement(b.id, { dir }).workItems.length, 0, 'the losing record is untouched')
})

test('concurrent cross-process links never give one work item two owners', async (t) => {
  const dir = tempDir(t, 'requirement-store-link-race-')
  const a = success(invoke(['create', '--dir', dir, '--project', 'p1']))
  const b = success(invoke(['create', '--dir', dir, '--project', 'p1']))
  const results = await runConcurrent([
    [cli, 'link', '--dir', dir, '--id', a.id, '--source', 'gh', '--item', '99'],
    [cli, 'link', '--dir', dir, '--id', b.id, '--source', 'gh', '--item', '99'],
  ])
  for (const result of results) assert.equal(result.signal, null)
  const owners = [a, b].filter((record) =>
    getRequirement(record.id, { dir }).workItems.some((item) => item.id === '99'),
  )
  assert.ok(owners.length <= 1, 'a shared work item must never have two silent owners')
  assert.equal(existsSync(join(dir, '.write.lock')), false, 'no writer lock may be left behind')
  assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith('.tmp')), [], 'no temp files may remain')
})
