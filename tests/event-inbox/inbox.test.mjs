/**
 * event-inbox tests: API transitions, corruption visibility, CLI, cross-process
 * persistence, standalone copy, and a Windows directory junction entry.
 *
 * Run: node --test tests/event-inbox/inbox.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  EventInboxError,
  INBOX_STATES,
  ackEvent,
  getEvent,
  listEvents,
  writeEvent,
} from '../../lib/event-inbox.mjs'
import { createRuntimeCopy } from '../support/runtime-package.mjs'

const cli = fileURLToPath(new URL('../../tools/event-inbox/cli.mjs', import.meta.url))

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

test('writeEvent preserves explicit metadata and never infers a project', (t) => {
  const dir = tempDir(t, 'event-inbox-api-')
  const record = writeEvent(
    {
      kind: 'run-end',
      projectKey: 'explicit_key',
      requirementId: 'req-1',
      workItems: [{ taskSource: 'tapd', id: 1111 }],
      title: '一批干完',
      detail: { done: 1 },
      nextStep: '读报告',
    },
    { dir },
  )

  assert.equal(record.state, 'unread')
  assert.equal(record.projectKey, 'explicit_key')
  assert.equal(record.requirementId, 'req-1')
  assert.deepEqual(record.workItems, [{ taskSource: 'tapd', id: '1111' }])
  const [stored] = listEvents({ dir }).items
  assert.equal(stored.title, '一批干完')
  assert.deepEqual(stored.detail, { done: 1 })
  assert.ok(existsSync(record.file))
})

test('events with no requirement are unrouted, not an error', (t) => {
  const dir = tempDir(t, 'event-inbox-unrouted-')
  const record = writeEvent({ kind: 'watch-stop' }, { dir })
  assert.equal(record.requirementId, null)
  assert.equal(listEvents({ dir, unroutedOnly: true }).items.length, 1)
})

test('state is monotonic and repeated acks are idempotent', (t) => {
  const dir = tempDir(t, 'event-inbox-ack-')
  const record = writeEvent({ kind: 'run-end' }, { dir })
  assert.equal('seenAt' in record, false)

  const seen = ackEvent(record.id, { dir, state: 'seen' })
  assert.equal(typeof seen.seenAt, 'number')
  const again = ackEvent(record.id, { dir, state: 'seen', note: '再看一眼' })
  assert.equal(again.seenAt, seen.seenAt, 'repeated ack must not move seenAt')
  assert.equal(again.note, '再看一眼')

  const done = ackEvent(record.id, { dir, state: 'done' })
  assert.equal(typeof done.doneAt, 'number')
  assert.equal(done.seenAt, seen.seenAt)
  assert.throws(() => ackEvent(record.id, { dir, state: 'seen' }), /不能回退/)
  assert.throws(() => ackEvent(record.id, { dir, state: 'unread' }), /只接受 seen 或 done/)
  assert.throws(() => ackEvent(record.id, { dir, state: '别乱来' }), /未知收件箱状态/)
})

test('ids are collision-resistant and no temp files are left behind', (t) => {
  const dir = tempDir(t, 'event-inbox-collide-')
  const ids = new Set()
  for (let i = 0; i < 300; i += 1) {
    ids.add(writeEvent({ kind: 'run-end', title: `第 ${i} 条` }, { dir }).id)
  }
  assert.equal(ids.size, 300)
  assert.equal(listEvents({ dir }).items.length, 300)
  assert.deepEqual(readdirSync(dir).filter((f) => !f.endsWith('.json')), [])
})

test('invalid ids and malformed records are rejected or visible', (t) => {
  const dir = tempDir(t, 'event-inbox-bad-')
  for (const bad of ['../evil', 'a/b', '带空格 的', '']) {
    assert.throws(() => getEvent(bad, { dir }), /id 非法/, bad)
  }
  assert.throws(() => writeEvent({ kind: '' }, { dir }), /缺少 kind/)
  assert.throws(() => writeEvent({ kind: 'x', workItems: [{ id: '1' }] }, { dir }), /taskSource/)
  assert.throws(() => writeEvent({ kind: 'x', detail: [] }, { dir }), /detail/)

  writeFileSync(join(dir, 'broken.json'), '{ 半截', 'utf8')
  const listed = listEvents({ dir })
  assert.equal(listed.items.length, 0)
  assert.equal(listed.invalid.length, 1)
  assert.match(listed.invalid[0].error, /损坏/)
})

test('getEvent returns null for missing ids without throwing', (t) => {
  const dir = tempDir(t, 'event-inbox-missing-')
  assert.equal(getEvent('nope-123', { dir }), null)
  assert.throws(() => getEvent('../越界', { dir }), EventInboxError)
})

test('filters by state, project, requirement, kind and date order', (t) => {
  const dir = tempDir(t, 'event-inbox-filter-')
  const a = writeEvent({ kind: 'run-end', projectKey: 'p1', requirementId: 'req-a' }, { dir })
  const b = writeEvent({ kind: 'watch-stop', projectKey: 'p1', requirementId: 'req-b' }, { dir })
  ackEvent(a.id, { dir, state: 'done' })

  assert.deepEqual(listEvents({ dir, states: ['unread'] }).items.map((i) => i.kind), ['watch-stop'])
  assert.equal(listEvents({ dir, projectKey: 'p1' }).items.length, 2)
  assert.equal(listEvents({ dir, projectKey: 'other' }).items.length, 0)
  assert.equal(listEvents({ dir, requirementId: 'req-a' }).items.length, 1)
  assert.equal(listEvents({ dir, kind: 'run-end' }).items.length, 1)
  assert.deepEqual(listEvents({ dir }).items.map((i) => i.id), [a.id, b.id])
})

test('help exits 0 and unknown arguments exit 2', () => {
  for (const args of [['--help'], []]) {
    const help = invoke(args)
    assert.equal(help.status, 0)
    assert.match(help.stdout, /emit/)
  }
  failure(invoke(['bogus']), 2)
  failure(invoke(['ack', '--dir', 'd']), 2)
  failure(invoke(['ack', '--dir', 'd', '--id', 'x']), 2)
  failure(invoke(['list', '--dir']), 2)
})

test('CLI emit --stdin, list, get and ack round-trip with exit codes', (t) => {
  const dir = tempDir(t, 'event-inbox-cli-')
  const emit = invoke(['emit', '--dir', dir, '--stdin'], { input: JSON.stringify({ kind: 'questionnaire-submitted', projectKey: 'p1' }) })
  const record = success(emit)
  assert.equal(record.kind, 'questionnaire-submitted')

  const list = success(invoke(['list', '--dir', dir, '--state', 'unread']))
  assert.equal(list.items.length, 1)
  assert.deepEqual(list.invalid, [])

  assert.equal(success(invoke(['ack', '--dir', dir, '--id', record.id, '--state', 'seen'])).state, 'seen')
  assert.equal(success(invoke(['get', '--dir', dir, '--id', record.id])).state, 'seen')

  failure(invoke(['get', '--dir', dir, '--id', 'missing']), 1)
  failure(invoke(['list', '--dir', dir, '--state', 'bogus']), 2)
  failure(invoke(['emit', '--dir', dir, '--stdin'], { input: '{ not json' }), 2)
})

test('CLI emit --file accepts a path with spaces', (t) => {
  const dir = tempDir(t, 'event-inbox-file-')
  const input = join(dir, 'my event.json')
  writeFileSync(input, JSON.stringify({ kind: 'run-end', title: 'from file' }), 'utf8')
  const record = success(invoke(['emit', '--dir', dir, '--file', input]))
  assert.equal(record.title, 'from file')
})

test('records persist across separate processes', (t) => {
  const dir = tempDir(t, 'event-inbox-persist-')
  const emitted = success(invoke(['emit', '--dir', dir, '--stdin'], { input: JSON.stringify({ kind: 'run-end', requirementId: 'req-x' }) }))
  assert.ok(emitted.id)

  const listed = success(invoke(['list', '--dir', dir, '--requirement', 'req-x']))
  assert.equal(listed.items.length, 1)
  assert.equal(listed.items[0].id, emitted.id)
  assert.equal(success(invoke(['ack', '--dir', dir, '--id', emitted.id, '--state', 'done'])).state, 'done')
})

test('copied runtime runs alone with no legacy skills', (t) => {
  const home = tempDir(t, 'event-inbox-copy-')
  const rt = createRuntimeCopy('event-inbox-runtime-')
  t.after(() => rmSync(rt.root, { recursive: true, force: true, maxRetries: 3 }))
  assert.equal(existsSync(join(rt.root, 'skills')), false)
  const executable = rt.cli('event-inbox')
  const store = join(home, 'store')
  const record = success(invoke(['emit', '--dir', store, '--stdin'], { executable, cwd: home, input: JSON.stringify({ kind: 'run-end' }) }))
  assert.equal(record.kind, 'run-end')
  assert.equal(success(invoke(['list', '--dir', store], { executable, cwd: home })).items.length, 1)
})

test('installed runtime directory junction executes help and emit', function (t) {
  if (process.platform !== 'win32') t.skip('Windows junction test')
  const home = tempDir(t, 'event-inbox-junction-')
  const rt = createRuntimeCopy('event-inbox-junction-')
  t.after(() => rmSync(rt.root, { recursive: true, force: true, maxRetries: 3 }))
  const installed = join(home, 'installed-runtime')
  symlinkSync(rt.root, installed, 'junction')
  const executable = join(installed, 'tools', 'event-inbox', 'cli.mjs')
  const help = invoke(['--help'], { executable, cwd: home })
  assert.equal(help.status, 0, help.stderr)
  assert.match(help.stdout, /emit/)
  const store = join(home, 'store')
  const record = success(invoke(['emit', '--dir', store, '--stdin'], { executable, cwd: home, input: JSON.stringify({ kind: 'run-end' }) }))
  assert.equal(record.kind, 'run-end')
})

// Keep the imported constants honest without a separate assertion file.
test('state list is the documented order', () => {
  assert.deepEqual(INBOX_STATES, ['unread', 'seen', 'done'])
})

test('repeated identical ack does not move updatedAt', (t) => {
  const dir = tempDir(t, 'event-inbox-idempotent-')
  const record = writeEvent({ kind: 'run-end' }, { dir })
  const first = ackEvent(record.id, { dir, state: 'done' })
  const second = ackEvent(record.id, { dir, state: 'done' })
  assert.equal(second.updatedAt, first.updatedAt)
  assert.equal(second.doneAt, first.doneAt)
})

test('updatedAt advances by at least one across acks and clock ties', (t) => {
  const dir = tempDir(t, 'event-inbox-monotonic-')
  const record = writeEvent({ kind: 'run-end' }, { dir, now: 100 })
  const seen = ackEvent(record.id, { dir, state: 'seen', now: 100 })
  assert.ok(seen.updatedAt >= 101, `updatedAt ${seen.updatedAt} must exceed the create stamp`)
  const done = ackEvent(record.id, { dir, state: 'done', now: 0 })
  assert.ok(done.updatedAt >= seen.updatedAt + 1, 'a real mutation must advance updatedAt')
})

test('invalid caller timestamps are rejected', (t) => {
  const dir = tempDir(t, 'event-inbox-time-')
  assert.throws(() => writeEvent({ kind: 'x' }, { dir, now: NaN }), /时间戳/)
  const record = writeEvent({ kind: 'x' }, { dir })
  assert.throws(() => ackEvent(record.id, { dir, state: 'seen', now: -1 }), /时间戳/)
  assert.throws(() => ackEvent(record.id, { dir, state: 'seen', now: Infinity }), /时间戳/)
})

test('malformed record fields are visible and never silently dropped', (t) => {
  const dir = tempDir(t, 'event-inbox-malformed-')
  writeFileSync(
    join(dir, 'bad-state.json'),
    JSON.stringify({ id: 'bad-state', kind: 'x', state: 'bogus', createdAt: 1, updatedAt: 1, workItems: [] }),
    'utf8',
  )
  writeFileSync(
    join(dir, 'bad-time.json'),
    JSON.stringify({ id: 'bad-time', kind: 'x', state: 'unread', createdAt: 'no', updatedAt: 1, workItems: [] }),
    'utf8',
  )
  writeFileSync(
    join(dir, 'bad-items.json'),
    JSON.stringify({ id: 'bad-items', kind: 'x', state: 'unread', createdAt: 1, updatedAt: 1, workItems: [{ id: 1 }] }),
    'utf8',
  )
  const listed = listEvents({ dir })
  assert.equal(listed.items.length, 0)
  assert.equal(listed.invalid.length, 3)
  for (const bad of ['bad-state', 'bad-time', 'bad-items']) {
    assert.throws(() => getEvent(bad, { dir }), /损坏/, bad)
  }
})

test('concurrent acks from separate processes never lose data or regress state', async (t) => {
  const dir = tempDir(t, 'event-inbox-concurrent-')
  const before = writeEvent({ kind: 'run-end', title: '并发' }, { dir })
  const results = await runConcurrent(
    Array.from({ length: 6 }, () => [cli, 'ack', '--dir', dir, '--id', before.id, '--state', 'done']),
  )
  for (const result of results) {
    assert.equal(result.signal, null)
    assert.ok([0, 1].includes(result.status), `unexpected status ${result.status}: ${result.stderr}`)
    if (result.status === 0) assert.notEqual(result.stdout, '')
    else assert.equal(result.stdout, '')
  }
  assert.ok(
    results.some((result) => result.status === 0),
    `at least one ack must win: ${results.map((r) => r.status).join(',')}`,
  )
  const after = success(invoke(['get', '--dir', dir, '--id', before.id]))
  assert.equal(after.state, 'done')
  assert.equal(after.title, '并发')
  assert.ok(after.updatedAt > before.updatedAt, 'a real transition must advance updatedAt')
  assert.deepEqual(listEvents({ dir }).invalid, [])
  assert.equal(listEvents({ dir }).items.length, 1)
  assert.equal(existsSync(join(dir, '.write.lock')), false, 'no writer lock may be left behind')
  assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith('.tmp')), [], 'no temp files may remain')
})
