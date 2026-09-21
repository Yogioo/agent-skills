/**
 * GitHub Issues adapter tests with a fake gh executable.
 *
 * Run:
 *   node --test tests/afk-run/github.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import {
  createGhSource,
  parseRepoRemote,
  parseTaskList,
  priorityFromLabels,
} from '../../skills/afk-run/scripts/task-sources/gh.mjs'
import { createSource } from '../../skills/afk-run/scripts/task-sources/index.mjs'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'afk-gh-'))
}

function installFakeGh(dir, state) {
  const stateFile = join(dir, 'state.json')
  writeFileSync(stateFile, JSON.stringify({ ...state, calls: [] }), 'utf8')
  writeFileSync(
    join(dir, 'fake-gh.mjs'),
    `import { readFileSync, writeFileSync } from 'node:fs'
const stateFile = process.env.AFK_FAKE_GH_STATE
const state = JSON.parse(readFileSync(stateFile, 'utf8'))
const args = process.argv.slice(2)
state.calls.push(args)
if (args[0] === 'issue' && args[1] === 'edit') {
  const id = args[2]
  const issue = (state.issues || []).find((item) => String(item.number) === String(id))
  for (let i = 3; i < args.length; i++) {
    if (args[i] !== '--add-label' && args[i] !== '--remove-label') continue
    const name = args[i + 1]
    if (!issue || !name) continue
    const labels = Array.isArray(issue.labels) ? issue.labels : []
    if (args[i] === '--add-label') {
      if (!labels.some((label) => label && label.name === name)) issue.labels = [...labels, { name }]
    } else {
      issue.labels = labels.filter((label) => !label || label.name !== name)
    }
  }
}
if (state.failures > 0) {
  state.failures -= 1
  writeFileSync(stateFile, JSON.stringify(state), 'utf8')
  process.stderr.write(state.failureText || 'temporary network error')
  process.exit(1)
}
if (args[0] === 'issue' && args[1] === 'list') {
  process.stdout.write(JSON.stringify(state.issues))
} else {
  writeFileSync(stateFile, JSON.stringify(state), 'utf8')
}
writeFileSync(stateFile, JSON.stringify(state), 'utf8')
`,
    'utf8',
  )
  return stateFile
}

function withFakeGh(state, fn) {
  const dir = tempDir()
  const stateFile = installFakeGh(dir, state)
  const oldPath = process.env.PATH
  const oldState = process.env.AFK_FAKE_GH_STATE
  process.env.PATH = `${dir}${delimiter}${oldPath || ''}`
  process.env.AFK_FAKE_GH_STATE = stateFile
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      process.env.PATH = oldPath
      if (oldState === undefined) delete process.env.AFK_FAKE_GH_STATE
      else process.env.AFK_FAKE_GH_STATE = oldState
      rmSync(dir, { recursive: true, force: true })
    })
}

function issue(number, title, body = '', labels = []) {
  return { number, title, body, labels: labels.map((name) => ({ name })) }
}

test('priority and task-list parsing follow the GitHub source contract', () => {
  assert.equal(priorityFromLabels([{ name: 'P0' }]), 0)
  assert.equal(priorityFromLabels([{ name: 'P4' }, { name: 'P1' }]), 1)
  assert.equal(priorityFromLabels([{ name: 'bug' }]), 2)
  assert.deepEqual(parseTaskList('- [ ] #12\n- [x] #13\n- [X] #14\n- [ ] owner/repo#15'), [
    { number: 12, checked: false },
    { number: 13, checked: true },
    { number: 14, checked: true },
  ])
})

test('repo inference accepts GitHub HTTPS, SSH, and enterprise remotes', () => {
  assert.equal(parseRepoRemote('https://github.com/owner/repo.git'), 'owner/repo')
  assert.equal(parseRepoRemote('ssh://git@github.com/owner/repo.git'), 'owner/repo')
  assert.equal(parseRepoRemote('git@github.example.com:owner/repo.git'), 'github.example.com/owner/repo')
})

test('gh source lists ready issues, reuses detail, and writes lifecycle commands', async () => {
  await withFakeGh(
    {
      issues: [
        issue(1, 'default priority', '', ['ready-for-agent']),
        issue(2, 'critical', '', ['P0', 'ready-for-agent']),
        issue(3, 'blocked', '- [ ] #4', ['P1', 'ready-for-agent']),
        issue(4, 'dependency', '', ['P3', 'ready-for-agent']),
        issue(5, 'unlocked', '- [x] #4', ['P1', 'ready-for-agent']),
        issue(6, 'failed', '', ['afk-failed']),
        issue(7, 'claimed', '', ['in-progress', 'ready-for-agent']),
      ],
    },
    async () => {
      const source = createSource('gh', {
        cwd: process.cwd(),
        repo: 'owner/repo',
        command: process.execPath,
        commandPrefix: [join(dirname(process.env.AFK_FAKE_GH_STATE), 'fake-gh.mjs')],
      })
      assert.deepEqual(await source.listReady(), [
        { id: '2', title: 'critical', priority: 0 },
        { id: '5', title: 'unlocked', priority: 1 },
        { id: '1', title: 'default priority', priority: 2 },
        { id: '4', title: 'dependency', priority: 3 },
      ])
      assert.deepEqual(await source.getDetail('5'), {
        id: '5',
        title: 'unlocked',
        body: '- [x] #4',
        requirements: '',
      })
      assert.deepEqual(await source.describeBlocked(), {
        ready: [
          { id: '2', title: 'critical', priority: 0 },
          { id: '5', title: 'unlocked', priority: 1 },
          { id: '1', title: 'default priority', priority: 2 },
          { id: '4', title: 'dependency', priority: 3 },
        ],
        blocked: [{ id: '3', title: 'blocked', priority: 1, blockedBy: [] }],
        inProgress: [{ id: '7', title: 'claimed', priority: 2 }],
      })

      await source.markInProgress('2')
      assert.deepEqual(
        (await source.describeBlocked()).inProgress.map((task) => task.id).sort(),
        ['2', '7'],
      )
      await source.markDone('2', { status: 'approved', summary: 'implemented' })
      await source.markFailed('3', 'review rejected')
      assert.deepEqual(await source.describeBlocked(), {
        ready: [
          { id: '5', title: 'unlocked', priority: 1 },
          { id: '1', title: 'default priority', priority: 2 },
          { id: '4', title: 'dependency', priority: 3 },
        ],
        blocked: [],
        inProgress: [{ id: '7', title: 'claimed', priority: 2 }],
      })

      const state = JSON.parse(readFileSync(process.env.AFK_FAKE_GH_STATE, 'utf8'))
      assert.deepEqual(state.calls.slice(1), [
        ['issue', 'edit', '2', '--add-label', 'in-progress', '--repo', 'owner/repo'],
        ['issue', 'close', '2', '--comment', 'afk: approved — implemented', '--repo', 'owner/repo'],
        [
          'issue',
          'edit',
          '2',
          '--remove-label',
          'ready-for-agent',
          '--remove-label',
          'in-progress',
          '--repo',
          'owner/repo',
        ],
        ['issue', 'comment', '3', '--body', 'afk failed: review rejected', '--repo', 'owner/repo'],
        [
          'issue',
          'edit',
          '3',
          '--remove-label',
          'in-progress',
          '--add-label',
          'afk-failed',
          '--repo',
          'owner/repo',
        ],
      ])
    },
  )
})

test('markDone clears the queue and claim labels so a reopened story can be re-armed', async () => {
  await withFakeGh(
    {
      issues: [issue(8, 'shipped', '', ['bug', 'ready-for-agent', 'P1', 'in-progress'])],
    },
    async () => {
      const source = createGhSource({
        cwd: process.cwd(),
        repo: 'owner/repo',
        command: process.execPath,
        commandPrefix: [join(dirname(process.env.AFK_FAKE_GH_STATE), 'fake-gh.mjs')],
      })

      await source.markDone('8', { status: 'approved', summary: 'shipped' })
      const afterDone = JSON.parse(readFileSync(process.env.AFK_FAKE_GH_STATE, 'utf8'))
      const labels = afterDone.issues[0].labels.map((label) => label.name)
      assert.ok(!labels.includes('ready-for-agent'))
      assert.ok(!labels.includes('in-progress'))

      // 人把工单重新打开并放回队列：不再被残留的 in-progress 挡住。
      afterDone.issues[0].labels.push({ name: 'ready-for-agent' })
      writeFileSync(process.env.AFK_FAKE_GH_STATE, JSON.stringify(afterDone), 'utf8')
      assert.deepEqual(await source.listReady(), [{ id: '8', title: 'shipped', priority: 1 }])
    },
  )
})

test('markFailed releases the claim but keeps the story queued', async () => {
  await withFakeGh(
    {
      issues: [issue(9, 'retry me', '', ['ready-for-agent', 'in-progress'])],
    },
    async () => {
      const source = createGhSource({
        cwd: process.cwd(),
        repo: 'owner/repo',
        command: process.execPath,
        commandPrefix: [join(dirname(process.env.AFK_FAKE_GH_STATE), 'fake-gh.mjs')],
      })

      await source.markFailed('9', 'review rejected')
      const state = JSON.parse(readFileSync(process.env.AFK_FAKE_GH_STATE, 'utf8'))
      const labels = state.issues[0].labels.map((label) => label.name)
      assert.ok(!labels.includes('in-progress'))
      assert.ok(labels.includes('ready-for-agent'))
      assert.ok(labels.includes('afk-failed'))

      // 人清掉 afk-failed 即重新武装。
      state.issues[0].labels = state.issues[0].labels.filter((label) => label.name !== 'afk-failed')
      writeFileSync(process.env.AFK_FAKE_GH_STATE, JSON.stringify(state), 'utf8')
      assert.deepEqual(await source.listReady(), [{ id: '9', title: 'retry me', priority: 2 }])
    },
  )
})

test('gh source retries transient CLI failures and fetches more than 100 issues', async () => {
  await withFakeGh(
    {
      failures: 2,
      failureText: 'ECONNRESET',
      issues: Array.from({ length: 150 }, (_, i) => issue(i + 1, `issue-${i + 1}`, '', ['ready-for-agent'])),
    },
    async () => {
      const source = createGhSource({
        cwd: process.cwd(),
        repo: 'owner/repo',
        command: process.execPath,
        commandPrefix: [join(dirname(process.env.AFK_FAKE_GH_STATE), 'fake-gh.mjs')],
      })
      const ready = await source.listReady()
      assert.equal(ready.length, 150)
      assert.deepEqual(ready.slice(0, 3).map((task) => task.id), ['1', '2', '3'])
      const state = JSON.parse(readFileSync(process.env.AFK_FAKE_GH_STATE, 'utf8'))
      assert.equal(state.calls.filter((args) => args[0] === 'issue' && args[1] === 'list').length, 3)
      assert.ok(state.calls[2].includes('--limit'))
    },
  )
})

test('gh tryClaim is best-effort and reports an in-progress issue as already-claimed', async () => {
  await withFakeGh(
    {
      issues: [
        issue(2, 'critical', '', ['P0', 'ready-for-agent']),
        issue(7, 'claimed', '', ['in-progress', 'ready-for-agent']),
      ],
    },
    async () => {
      const source = createGhSource({
        cwd: process.cwd(),
        repo: 'owner/repo',
        command: process.execPath,
        commandPrefix: [join(dirname(process.env.AFK_FAKE_GH_STATE), 'fake-gh.mjs')],
      })
      assert.equal(source.claimMode, 'best-effort')
      assert.deepEqual(await source.tryClaim('2'), { status: 'claimed', claimMode: 'best-effort' })
      assert.deepEqual(await source.tryClaim('2'), { status: 'already-claimed', claimMode: 'best-effort' })
      assert.deepEqual(await source.tryClaim('7'), { status: 'already-claimed', claimMode: 'best-effort' })
      assert.equal((await source.tryClaim('999')).status, 'error')
    },
  )
})
