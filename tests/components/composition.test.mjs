import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { assemblePrompt } from '../../lib/prompt-compose.mjs'
import { runAgentTurn } from '../../lib/agent-run/run-agent-turn.mjs'
import { captureWorkspace, diff } from '../../lib/workspace-diff.mjs'
import { writeEvent, listEvents, ackEvent } from '../../lib/event-inbox.mjs'
import { createRequirement, whereWorkItem } from '../../lib/requirement-store.mjs'
import { appendEvent, readEvents } from '../../lib/run-runtime/progress.mjs'
import { createGhSource } from '../../lib/work-items/gh.mjs'

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'component-composition-'))
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }))
  const workdir = join(dir, 'workspace')
  mkdirSync(workdir)
  return { dir, workdir }
}

test('compose prompt, invocation, change observation, records and progress without AFK', async (t) => {
  const { dir, workdir } = fixture(t)
  const requirements = join(dir, 'requirements')
  const inbox = join(dir, 'inbox')
  const record = createRequirement({ id: 'task-1', title: 'Produce a document', workdir }, { dir: requirements })
  const prompt = assemblePrompt({ base: { text: 'Write {{FILE}}.' }, variables: { FILE: 'result.txt' } })
  const promptFile = join(dir, 'prompt.md')
  writeFileSync(promptFile, prompt.text)
  const fake = join(dir, 'fake-agent.mjs')
  writeFileSync(fake, `import {writeFileSync} from 'node:fs';
writeFileSync('result.txt', 'document contents');
console.log(JSON.stringify({type:'result',subtype:'success',result:'Document written'}));`)
  const before = captureWorkspace(workdir, { mode: 'walk' })
  const outcome = await runAgentTurn({
    runner: 'agent', bin: fake, workdir, promptFile,
    outFile: join(dir, 'answer.txt'), eventsFile: join(dir, 'agent.jsonl'), logFile: join(dir, 'agent.log'),
  })
  const changes = diff(before.files, captureWorkspace(workdir, { mode: 'walk' }).files)
  assert.equal(outcome.exitCode, 0)
  assert.equal(readFileSync(join(workdir, 'result.txt'), 'utf8'), 'document contents')
  assert.deepEqual(changes, { changed: [], added: ['result.txt'], removed: [] })
  const event = writeEvent({
    kind: 'execution-finished', requirementId: record.id, workdir,
    detail: { exitCode: outcome.exitCode, changes, outputFile: outcome.outputFile },
  }, { dir: inbox })
  const queued = listEvents({ dir: inbox, requirementId: record.id, state: 'unread' })
  assert.equal(queued.items.length, 1)
  assert.deepEqual(queued.invalid, [])
  assert.equal(queued.items[0].detail.exitCode, 0)
  const progress = join(dir, 'progress.jsonl')
  appendEvent(progress, { event: 'execution_observed', data: { eventId: event.id, changes } })
  assert.deepEqual(readEvents(progress).events[0].changes, changes)
  assert.equal(ackEvent(event.id, { dir: inbox, state: 'done' }).state, 'done')
  assert.equal(listEvents({ dir: inbox, state: 'unread' }).items.length, 0)
  assert.equal(record.closedAt, null)
})

test('work-item facts can be selected and linked locally without remote mutations', (t) => {
  const { dir, workdir } = fixture(t)
  const calls = []
  const rows = [
    { number: 1, title: 'Selected', body: 'Write a report', state: 'OPEN', labels: [{ name: 'ready' }] },
    { number: 2, title: 'Unlabelled', body: '', state: 'OPEN', labels: [] },
  ]
  const source = createGhSource({ repo: 'example/tasks', run: (args) => {
    calls.push(args)
    assert.ok(args.includes('list'))
    return JSON.stringify(rows)
  } })
  assert.equal(source.list().length, 2)
  const selected = source.selectReady({ readyLabel: 'ready' })
  assert.equal(selected.length, 1)
  const store = join(dir, 'requirements')
  const record = createRequirement({
    id: 'request-1', title: selected[0].title, workdir,
    workItems: [{ taskSource: 'gh', id: selected[0].id }],
  }, { dir: store })
  const lookup = whereWorkItem({ dir: store, taskSource: 'gh', id: selected[0].id })
  assert.equal(lookup.ambiguous, false)
  assert.equal(lookup.matches[0].id, record.id)
  assert.equal(calls.length, 2)
})

test('store acquisition never deletes an existing stale writer lock', (t) => {
  const { dir } = fixture(t)
  for (const [name, action] of [
    ['inbox', (root) => writeEvent({ kind: 'test' }, { dir: root })],
    ['requirements', (root) => createRequirement({ id: 'test' }, { dir: root })],
  ]) {
    const root = join(dir, name)
    mkdirSync(root)
    const lockFile = join(root, '.write.lock')
    const lock = JSON.stringify({ pid: 2147483647, at: 1, token: 'stale-owner' })
    writeFileSync(lockFile, lock)
    assert.throws(() => action(root))
    assert.equal(readFileSync(lockFile, 'utf8'), lock)
  }
})
