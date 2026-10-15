import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const bin = fileURLToPath(new URL('../../bin/agent-tools.mjs', import.meta.url))
test('dispatcher treats inherited object keys as unknown commands', () => {
  for (const args of [['constructor'], ['toString'], ['questionnaire', 'constructor']]) {
    const result = spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', windowsHide: true })
    assert.equal(result.status, 2, result.stderr)
    assert.equal(result.stdout, '')
    assert.ok(!result.stderr.includes('TypeError'))
  }
})

test('importing the CLI does not dispatch using its importing host arguments', () => {
  const script = `await import(${JSON.stringify(new URL('../../bin/agent-tools.mjs', import.meta.url).href)}); console.log('imported');`
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, '--', '--help'], { encoding: 'utf8', windowsHide: true })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), 'imported')
})
