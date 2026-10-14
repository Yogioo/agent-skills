/**
 * Standalone-skill test: copy only skills/agent-run to a temp dir (no old
 * siblings) and exercise the CLI through a real Node process, including a
 * Windows directory junction entry point for the direct-main guard.
 *
 *   node --test tests/agent-run/standalone.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SKILL = join(__dirname, '..', '..', 'skills', 'agent-run')
const FIXTURE = join(__dirname, 'fixtures', 'agent-stream.jsonl')

function runNode(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => (stdout += c))
    child.stderr.on('data', (c) => (stderr += c))
    child.once('error', reject)
    child.once('close', (code) => resolve({ code, stdout, stderr }))
  })
}

test('copied skill CLI runs without old siblings', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ar-standalone-'))
  const copy = join(tmp, 'agent-run')
  cpSync(SKILL, copy, { recursive: true })
  const cli = join(copy, 'scripts', 'cli.mjs')
  try {
    const help = await runNode([cli, '--help'], tmp)
    assert.equal(help.code, 0)
    assert.match(help.stdout, /agent-run/)

    const caps = await runNode([cli, 'capabilities'], tmp)
    assert.equal(caps.code, 0)
    const parsed = JSON.parse(caps.stdout.trim())
    assert.equal(parsed.runners.length, 3)

    const input = join(tmp, 'in.jsonl')
    const output = join(tmp, 'out.jsonl')
    writeFileSync(input, readFileSync(FIXTURE, 'utf8'))
    const norm = await runNode([cli, 'normalize', '--runner', 'agent', '--input', input, '--output', output], tmp)
    assert.equal(norm.code, 0)
    assert.equal(JSON.parse(norm.stdout.trim()).eventCount, 7)
    assert.ok(readFileSync(output, 'utf8').includes('"kind"'))
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('direct-main guard works through a directory junction', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'ar-junction-'))
  const link = join(tmp, 'linked-agent-run')
  try {
    try {
      symlinkSync(SKILL, link, process.platform === 'win32' ? 'junction' : 'dir')
    } catch (error) {
      t.skip(`junction unavailable: ${error.message}`)
      return
    }
    const cli = join(link, 'scripts', 'cli.mjs')
    const help = await runNode([cli, '--help'], tmp)
    assert.equal(help.code, 0)
    const caps = await runNode([cli, 'capabilities', '--runner', 'pi'], tmp)
    assert.equal(caps.code, 0)
    assert.equal(JSON.parse(caps.stdout.trim()).runners[0].name, 'pi')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
