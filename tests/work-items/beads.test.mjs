/**
 * beads work-item tests using a fake bd executable (no real Dolt store).
 *
 * Run: node --test tests/work-items/beads.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBeadsSource } from '../../skills/work-items/scripts/beads.mjs'
import { createWorkSource } from '../../skills/work-items/scripts/index.mjs'

const FAKE_BD = `import { readFileSync, writeFileSync } from 'node:fs'
const stateFile = process.env.WORK_ITEMS_FAKE_BD_STATE
const state = JSON.parse(readFileSync(stateFile, 'utf8'))
let args = process.argv.slice(2)
let actor = ''
const actorIndex = args.indexOf('--actor')
if (actorIndex >= 0) { actor = args[actorIndex + 1]; args.splice(actorIndex, 2) }
state.calls.push({ actor, args })
const save = () => writeFileSync(stateFile, JSON.stringify(state), 'utf8')
const out = (value) => process.stdout.write(JSON.stringify(value))
if (state.error) { process.stderr.write(state.error); process.exit(1) }
const find = (id) => state.issues.find((issue) => String(issue.id) === String(id))
if (args[0] === 'list') {
  const idIndex = args.indexOf('--id')
  const rows = idIndex >= 0 ? state.issues.filter((issue) => String(issue.id) === String(args[idIndex + 1])) : state.issues
  save(); out(rows)
} else if (args[0] === 'update' && args.includes('--claim')) {
  const issue = find(args[1])
  if (!issue) { process.stderr.write('issue not found'); process.exit(1) }
  if (issue.status === 'in_progress' && issue.claimedBy && issue.claimedBy !== actor) {
    process.stderr.write('already claimed by ' + issue.claimedBy); process.exit(1)
  }
  issue.status = 'in_progress'; issue.claimedBy = actor
  save(); process.stdout.write('')
} else if (args[0] === 'label' && (args[1] === 'add' || args[1] === 'remove')) {
  const issue = find(args[2])
  const labels = Array.isArray(issue.labels) ? issue.labels : []
  if (args[1] === 'add') { if (!labels.includes(args[3])) issue.labels = [...labels, args[3]] }
  else { issue.labels = labels.filter((label) => label !== args[3]) }
  save(); process.stdout.write('')
} else if (args[0] === 'comment') {
  const issue = find(args[1])
  issue.comments = [...(issue.comments || []), args[2]]
  save(); process.stdout.write('')
} else if (args[0] === 'close') {
  const issue = find(args[1])
  issue.status = 'closed'
  const reasonIndex = args.indexOf('--reason')
  if (reasonIndex >= 0) issue.closeReason = args[reasonIndex + 1]
  save(); process.stdout.write('')
} else {
  process.stderr.write('unexpected bd command: ' + args.join(' ')); process.exit(1)
}
`

function fixture(t, issues, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'work-items-beads-'))
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }))
  const stateFile = join(dir, 'state.json')
  const cli = join(dir, 'fake-bd.mjs')
  writeFileSync(stateFile, JSON.stringify({ issues, calls: [], ...extra }), 'utf8')
  writeFileSync(cli, FAKE_BD, 'utf8')
  process.env.WORK_ITEMS_FAKE_BD_STATE = stateFile
  const opts = { cwd: dir, command: process.execPath, commandPrefix: [cli] }
  return {
    dir,
    opts,
    state: () => JSON.parse(readFileSync(stateFile, 'utf8')),
    source: () => createBeadsSource(opts),
  }
}

function issue(id, extra = {}) {
  return { id, title: `title-${id}`, description: `body-${id}`, status: 'open', priority: 2, labels: [], ...extra }
}

test('beads: list returns facts without label or readiness policy', (t) => {
  const fx = fixture(t, [
    issue('a', { labels: ['ready-for-agent'], priority: 0 }),
    issue('b', { labels: [] }),
    issue('c', { status: 'closed' }),
    issue('d', { labels: ['afk-failed'] }),
  ])
  const facts = fx.source().list()
  assert.deepEqual(facts.map((row) => row.id).sort(), ['a', 'b', 'c', 'd'])
  assert.deepEqual(facts[0].blockedBy, [])
  // No --ready-label means no implicit afk filtering.
  const ready = fx.source().selectReady()
  assert.deepEqual(ready.map((row) => row.id).sort(), ['a', 'b', 'd'])
})

test('beads: selectReady applies explicit labels, priorities and dependencies', (t) => {
  const fx = fixture(t, [
    issue('a', { labels: ['ready-for-agent'], priority: 0 }),
    issue('b', { labels: ['ready-for-agent'], priority: 1 }),
    issue('blocker', { labels: ['ready-for-agent'], status: 'open' }),
    issue('blocked', {
      labels: ['ready-for-agent'],
      priority: 1,
      dependencies: [{ type: 'blocks', depends_on_id: 'blocker' }],
    }),
    issue('parent', { labels: ['ready-for-agent'], priority: 0 }),
    issue('child', { labels: ['ready-for-agent'], parent: 'parent', priority: 0 }),
    issue('failed', { labels: ['ready-for-agent', 'afk-failed'] }),
  ])
  const source = fx.source()
  const selected = source.selectReady({ readyLabel: 'ready-for-agent', excludeLabels: ['afk-failed'] })
  assert.deepEqual(selected.map((row) => row.id), ['a', 'child', 'b', 'blocker'])
  const blocked = source.selectReady({ readyLabel: 'ready-for-agent', excludeLabels: ['afk-failed'], includeBlocked: true })
  assert.deepEqual(blocked.map((row) => row.id), ['a', 'child', 'b', 'blocked', 'blocker'])
  assert.deepEqual(blocked.find((row) => row.id === 'blocked').blockedBy, ['blocker'])
  // Parent with open child stays a container; the child is executable.
  assert.ok(!selected.some((row) => row.id === 'parent'))
  assert.ok(selected.some((row) => row.id === 'child'))
  const withContainers = source.selectReady({ readyLabel: 'ready-for-agent', excludeLabels: ['afk-failed'], excludeParentContainers: false })
  assert.ok(withContainers.some((row) => row.id === 'parent'))
  assert.deepEqual(source.selectReady({ readyLabel: 'ready-for-agent', priorityMax: 0 }).map((row) => row.id), ['a', 'child'])
})

test('beads: claim is atomic per actor and reports another actor', (t) => {
  const fx = fixture(t, [issue('a')])
  const sub = join(fx.dir, 'other-worktree')
  mkdirSync(sub)
  const alice = createBeadsSource({ cwd: fx.dir, command: process.execPath, commandPrefix: fx.opts.commandPrefix })
  const bob = createBeadsSource({ cwd: sub, command: process.execPath, commandPrefix: fx.opts.commandPrefix })
  assert.equal(alice.claimMode, 'atomic')
  assert.notEqual(alice.actor, bob.actor, 'different workdirs must not share an actor')
  assert.equal(alice.claim('a').status, 'claimed')
  assert.equal(alice.claim('a').status, 'claimed')
  assert.deepEqual(bob.claim('a'), { id: 'a', status: 'already-claimed', claimMode: 'atomic' })
  assert.equal(fx.state().issues[0].status, 'in_progress')
})

test('beads: mutations are explicit and label replacement is unsupported', (t) => {
  const fx = fixture(t, [issue('a')])
  const source = fx.source()
  source.comment('a', 'note')
  source.addLabels('a', ['triaged', 'triaged', 'P1'])
  source.removeLabels('a', ['P1'])
  source.close('a', { comment: 'done' })
  const stored = fx.state().issues[0]
  assert.deepEqual(stored.labels, ['triaged'])
  assert.deepEqual(stored.comments, ['note'])
  assert.equal(stored.status, 'closed')
  assert.equal(stored.closeReason, 'done')
  assert.throws(() => source.setLabels('a', ['x']), /addLabels|removeLabels/)
  assert.throws(() => source.comment('a', '  '), /非空/)
})

test('beads: reads return complete content and malformed payloads are invalid records', (t) => {
  const fx = fixture(t, [issue('a', { labels: ['ready-for-agent'] })])
  const detail = fx.source().get('a')
  assert.deepEqual(detail, {
    id: 'a', title: 'title-a', body: 'body-a', status: 'open', priority: 2,
    labels: ['ready-for-agent'], assignee: '', parent: '', blockedBy: [], requirements: '',
  })
  assert.throws(() => fx.source().get('missing'), /不存在/)

  const bad = fixture(t, [], { error: 'boom' })
  assert.throws(() => bad.source().list())
})

test('beads: createWorkSource names the source and unknown reads fail', (t) => {
  const fx = fixture(t, [issue('a')])
  const source = createWorkSource('beads', fx.opts)
  assert.equal(source.name, 'beads')
  assert.equal(source.capabilities().close, true)
  assert.equal(source.capabilities().claimMode, 'atomic')
  assert.throws(() => createWorkSource('nope'), /未知任务源/)
})
