import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { run } from '../../skills/work-items/scripts/cli.mjs'
import { createBeadsSource } from '../../skills/work-items/scripts/beads.mjs'
import { createGhSource } from '../../skills/work-items/scripts/gh.mjs'

test('GitHub capabilities require neither a repository nor an external command', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'work-items-capability-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const source = createGhSource({ cwd: dir, run: () => { throw new Error('unexpected external command') } })
  assert.equal(source.capabilities().source, 'gh')
})

test('GitHub includeBlocked is honored and unsupported CLI options fail visibly', async () => {
  const rows = [{ number: 1, body: '- [ ] #2', state: 'open' }, { number: 2, body: '', state: 'open' }]
  const source = createGhSource({ repo: 'example/tasks', run: () => JSON.stringify(rows) })
  assert.equal(source.selectReady().length, 1)
  assert.equal(source.selectReady({ includeBlocked: true }).length, 2)
  for (const args of [
    ['list', '--source', 'beads', '--state', 'closed'],
    ['list', '--source', 'gh', '--exclude-machine-labels'],
    ['list', '--source', 'tapd', '--include-blocked'],
  ]) {
    let stderr = ''
    assert.equal(await run(args, { stdout: () => assert.fail('unexpected output'), stderr: (s) => { stderr += s } }), 2)
    assert.equal(JSON.parse(stderr).status, 'error')
  }
})

test('malformed rows cannot silently turn a task list into an empty queue', () => {
  for (const rows of [[null], [{}], [{ title: 'missing id' }]]) {
    const raw = JSON.stringify(rows)
    assert.throws(() => createBeadsSource({ run: () => raw }).list(), /valid id/)
    assert.throws(() => createGhSource({ repo: 'example/tasks', run: () => raw }).list(), /valid id/)
  }
})

test('a failed claim is a failing CLI operation, with its source capability retained', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'work-items-error-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const fake = join(dir, 'failed.mjs')
  writeFileSync(fake, "process.stderr.write('backend unavailable');process.exit(7)")
  const config = join(dir, 'config.json')
  writeFileSync(config, JSON.stringify({ workdir: dir, command: process.execPath, commandPrefix: [fake] }))
  let out = '', err = ''
  const code = await run(['claim', '--source', 'beads', '--id', 'example-1', '--config', config], {
    stdout: (value) => { out += value }, stderr: (value) => { err += value },
  })
  assert.equal(code, 1)
  assert.equal(out, '')
  assert.equal(JSON.parse(err).status, 'error')
  assert.equal(JSON.parse(err).claimMode, 'atomic')
})
