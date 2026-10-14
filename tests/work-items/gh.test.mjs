/**
 * GitHub Issues work-item tests with a fake gh executable.
 *
 * Run: node --test tests/work-items/gh.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGhSource, parseRepoRemote, parseTaskList, priorityFromLabels } from '../../skills/work-items/scripts/gh.mjs'

const FAKE_GH = `import { readFileSync, writeFileSync } from 'node:fs'
const stateFile = process.env.WORK_ITEMS_FAKE_GH_STATE
const state = JSON.parse(readFileSync(stateFile, 'utf8'))
const args = process.argv.slice(2)
state.calls.push(args)
const save = () => writeFileSync(stateFile, JSON.stringify(state), 'utf8')
const out = (value) => process.stdout.write(JSON.stringify(value))
const issueOf = (id) => state.issues.find((issue) => String(issue.number) === String(id))
const readLabels = (issue) => (issue.labels || []).map((label) => (typeof label === 'string' ? label : label.name))
if (state.failures > 0) {
  state.failures -= 1
  save()
  process.stderr.write(state.failureText || 'ECONNRESET')
  process.exit(1)
}
if (args[0] === 'issue' && args[1] === 'list') {
  const stateIndex = args.indexOf('--state')
  const wanted = stateIndex >= 0 ? args[stateIndex + 1] : 'open'
  const rows = wanted === 'all' ? state.issues : state.issues.filter((issue) => (issue.state || 'open') === wanted)
  save(); out(rows)
} else if (args[0] === 'issue' && args[1] === 'view') {
  const issue = issueOf(args[2])
  if (!issue) { process.stderr.write('not found'); process.exit(1) }
  save(); out(issue)
} else if (args[0] === 'issue' && args[1] === 'edit') {
  const issue = issueOf(args[2])
  const nameOf = (label) => (typeof label === 'string' ? label : label.name)
  for (let i = 3; i < args.length; i++) {
    if (args[i] !== '--add-label' && args[i] !== '--remove-label') continue
    const name = args[i + 1]
    if (args[i] === '--add-label') {
      if (!(issue.labels || []).some((label) => nameOf(label) === name)) issue.labels = [...(issue.labels || []), { name }]
    } else {
      issue.labels = (issue.labels || []).filter((label) => nameOf(label) !== name)
    }
  }
  save(); process.stdout.write('')
} else if (args[0] === 'issue' && args[1] === 'comment') {
  const issue = issueOf(args[2])
  const bodyIndex = args.indexOf('--body')
  issue.comments = [...(issue.comments || []), { id: 'c' + ((issue.comments || []).length + 1), author: { login: 'me' }, body: args[bodyIndex + 1], createdAt: '2026-01-01T00:00:00Z' }]
  save(); process.stdout.write('')
} else if (args[0] === 'issue' && args[1] === 'close') {
  const issue = issueOf(args[2])
  issue.state = 'closed'
  const commentIndex = args.indexOf('--comment')
  if (commentIndex >= 0) issue.comments = [...(issue.comments || []), { id: 'close', author: { login: 'me' }, body: args[commentIndex + 1], createdAt: '2026-01-02T00:00:00Z' }]
  save(); process.stdout.write('')
} else {
  process.stderr.write('unexpected gh command: ' + args.join(' ')); process.exit(1)
}
`

function issue(number, title, body = '', labels = []) {
  return { number, title, body, labels: labels.map((name) => ({ name })), state: 'open', comments: [] }
}

function fixture(t, issues, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'work-items-gh-'))
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }))
  const stateFile = join(dir, 'state.json')
  const cli = join(dir, 'fake-gh.mjs')
  writeFileSync(stateFile, JSON.stringify({ issues, calls: [], ...extra }), 'utf8')
  writeFileSync(cli, FAKE_GH, 'utf8')
  process.env.WORK_ITEMS_FAKE_GH_STATE = stateFile
  const opts = { cwd: dir, repo: 'owner/repo', command: process.execPath, commandPrefix: [cli], retries: 0 }
  return {
    opts,
    state: () => JSON.parse(readFileSync(stateFile, 'utf8')),
    source: (over = {}) => createGhSource({ ...opts, ...over }),
  }
}

test('gh: priority, task-list and remote parsing follow the source contract', () => {
  assert.equal(priorityFromLabels([{ name: 'P0' }]), 0)
  assert.equal(priorityFromLabels([{ name: 'P4' }, { name: 'P1' }]), 1)
  assert.equal(priorityFromLabels([{ name: 'bug' }]), 2)
  assert.deepEqual(parseTaskList('- [ ] #12\n- [x] #13\n- [X] #14\n- [ ] owner/repo#15'), [
    { number: 12, checked: false },
    { number: 13, checked: true },
    { number: 14, checked: true },
  ])
  assert.equal(parseRepoRemote('https://github.com/owner/repo.git'), 'owner/repo')
  assert.equal(parseRepoRemote('git@github.example.com:owner/repo.git'), 'github.example.com/owner/repo')
})

test('gh: list is unfiltered and selectReady applies explicit options', (t) => {
  const fx = fixture(t, [
    issue(1, 'plain', '', ['ready-for-agent']),
    issue(2, 'critical', '', ['P0', 'ready-for-agent']),
    issue(3, 'blocked', '- [ ] #4', ['P1', 'ready-for-agent']),
    issue(4, 'dependency', '', ['P3', 'ready-for-agent']),
    issue(5, 'failed', '', ['afk-failed']),
  ])
  const source = fx.source()
  assert.deepEqual(source.list().map((row) => row.id).sort(), ['1', '2', '3', '4', '5'])
  const selected = source.selectReady({ readyLabel: 'ready-for-agent', excludeLabels: ['afk-failed'] })
  assert.deepEqual(selected.map((row) => row.id), ['2', '1', '4'])
  assert.deepEqual(selected.find((row) => row.id === '2').priority, 0)
  const withBlocked = source.selectReady({ readyLabel: 'ready-for-agent', requireDependencies: false })
  assert.deepEqual(withBlocked.find((row) => row.id === '3').blockedBy, ['4'])
})

test('gh: get returns title, body and comments', (t) => {
  const fx = fixture(t, [
    { ...issue(7, 'has comments', 'body text', ['ready-for-agent']), comments: [{ id: 'c1', author: { login: 'alice' }, body: 'first', createdAt: '2026-01-01T00:00:00Z' }] },
  ])
  const detail = fx.source().get('7')
  assert.equal(detail.title, 'has comments')
  assert.equal(detail.body, 'body text')
  assert.deepEqual(detail.comments, [{ id: 'c1', author: 'alice', body: 'first', createdAt: '2026-01-01T00:00:00Z' }])
  assert.throws(() => fx.source().get('999'), /不存在/)
})

test('gh: claim is best-effort and never claims exclusivity', (t) => {
  const fx = fixture(t, [issue(2, 'critical', '', ['P0', 'ready-for-agent']), issue(7, 'claimed', '', ['in-progress'])])
  const source = fx.source()
  assert.equal(source.claimMode, 'best-effort')
  assert.deepEqual(source.claim('2'), { id: '2', status: 'claimed', claimMode: 'best-effort' })
  assert.deepEqual(source.claim('2'), { id: '2', status: 'already-claimed', claimMode: 'best-effort' })
  assert.deepEqual(source.claim('7'), { id: '7', status: 'already-claimed', claimMode: 'best-effort' })
  assert.equal(source.claim('999').status, 'error')
  assert.equal(source.claim('2', { claimLabel: 'triage' }).status, 'claimed')
})

test('gh: mutations are explicit; label replacement and deliver are unsupported', (t) => {
  const fx = fixture(t, [issue(1, 'one', '', ['ready-for-agent'])])
  const source = fx.source()
  source.comment('1', 'a note')
  source.addLabels('1', ['triaged'])
  source.removeLabels('1', ['ready-for-agent'])
  source.close('1', { comment: 'shipped' })
  const stored = fx.state().issues[0]
  assert.deepEqual(stored.labels.map((label) => label.name), ['triaged'])
  assert.deepEqual(stored.comments.map((comment) => comment.body), ['a note', 'shipped'])
  assert.equal(stored.state, 'closed')
  assert.throws(() => source.setLabels('1', ['x']), /addLabels/)
  assert.throws(() => source.deliver('1', {}), /close/)
})

test('gh: malformed payloads are invalid records and transient failures retry', (t) => {
  const bad = fixture(t, [])
  const cli = bad.opts.commandPrefix[0]
  writeFileSync(cli, 'process.stdout.write("not json")', 'utf8')
  const error = (() => {
    try {
      bad.source().list()
    } catch (err) {
      return err
    }
    throw new Error('expected the malformed payload to throw')
  })()
  assert.equal(error.exitCode, 2)

  const fx = fixture(t, [issue(1, 'one', '', ['ready-for-agent'])], { failures: 2, failureText: 'ECONNRESET' })
  const source = fx.source({ retries: 3, retryDelayMs: 0 })
  assert.deepEqual(source.list().map((row) => row.id), ['1'])
  assert.equal(fx.state().calls.filter((args) => args[0] === 'issue' && args[1] === 'list').length, 3)
})
