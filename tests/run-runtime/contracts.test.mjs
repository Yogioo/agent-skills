import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { appendEvent, readEvents } from '../../skills/run-runtime/scripts/progress.mjs'
import { redactSecrets } from '../../skills/run-runtime/scripts/config.mjs'

const cli = fileURLToPath(new URL('../../skills/run-runtime/scripts/cli.mjs', import.meta.url))
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'runtime-contract-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
function run(args) { return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', windowsHide: true }) }

test('progress metadata cannot bypass validation through data fields', (t) => {
  const dir = fixture(t)
  const file = join(dir, 'events.jsonl')
  for (const data of [{ event: '' }, { t: -1 }, { level: -1 }, []]) {
    assert.throws(() => appendEvent(file, { event: 'valid', data }), /reserved/)
  }
  writeFileSync(file, JSON.stringify({ event: 'valid', t: -1, level: 0 }) + '\n')
  assert.equal(readEvents(file).events.length, 0)
  assert.equal(readEvents(file).malformed.length, 1)
})

test('secret-named containers are redacted as well as scalar secrets', () => {
  assert.deepEqual(redactSecrets({ tokens: ['one', 'two'], credentials: { value: 'secret' }, visible: 1 }), {
    tokens: '[redacted]', credentials: '[redacted]', visible: 1,
  })
})

test('lease refusal has a failing exit status and unknown flags cannot silently pass', (t) => {
  const dir = fixture(t)
  const args = ['lease', 'acquire', '--registry-dir', join(dir, 'leases'), '--workdir', dir, '--pid', String(process.pid)]
  const first = run(args)
  assert.equal(first.status, 0, first.stderr)
  const second = run(args)
  assert.equal(second.status, 1)
  assert.equal(JSON.parse(second.stdout).reason, 'held')
  assert.equal(run([...args, '--unknown-option', 'ignored']).status, 2)
  assert.equal(run(['lease', 'release', '--registry-dir', join(dir, 'leases'), '--workdir', dir, '--force']).status, 2)
})
