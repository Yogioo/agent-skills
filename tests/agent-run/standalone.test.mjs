/**
 * Runtime-package test: copy the tool runtime (lib/, tools/, and bin/package
 * when present) to a temp dir with no legacy skills alongside and exercise the
 * CLI through a real Node process, including a Windows directory junction entry
 * point for the direct-main guard.
 *
 *   node --test tests/agent-run/standalone.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

import { createRuntimeCopy } from '../support/runtime-package.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
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

test('copied runtime CLI runs without legacy skills', async (t) => {
  const rt = createRuntimeCopy('ar-runtime-')
  t.after(() => rmSync(rt.root, { recursive: true, force: true }))
  const cli = rt.cli('agent-run')
  assert.equal(existsSync(join(rt.root, 'skills')), false)

  const help = await runNode([cli, '--help'], rt.root)
  assert.equal(help.code, 0)
  assert.match(help.stdout, /agent-run/)

  const caps = await runNode([cli, 'capabilities'], rt.root)
  assert.equal(caps.code, 0)
  const parsed = JSON.parse(caps.stdout.trim())
  assert.equal(parsed.runners.length, 3)

  const input = join(rt.root, 'in.jsonl')
  const output = join(rt.root, 'out.jsonl')
  writeFileSync(input, readFileSync(FIXTURE, 'utf8'))
  const norm = await runNode([cli, 'normalize', '--runner', 'agent', '--input', input, '--output', output], rt.root)
  assert.equal(norm.code, 0)
  assert.equal(JSON.parse(norm.stdout.trim()).eventCount, 7)
  assert.ok(readFileSync(output, 'utf8').includes('"kind"'))
})

test('direct-main guard works through a directory junction', async (t) => {
  const rt = createRuntimeCopy('ar-junction-')
  t.after(() => rmSync(rt.root, { recursive: true, force: true }))
  const link = join(mkdtempSync(join(tmpdir(), 'ar-junction-link-')), 'linked-runtime')
  t.after(() => rmSync(dirname(link), { recursive: true, force: true }))
  try {
    symlinkSync(rt.root, link, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    t.skip(`junction unavailable: ${error.message}`)
    return
  }
  const cli = join(link, 'tools', 'agent-run', 'cli.mjs')
  const help = await runNode([cli, '--help'], dirname(link))
  assert.equal(help.code, 0)
  const caps = await runNode([cli, 'capabilities', '--runner', 'pi'], dirname(link))
  assert.equal(caps.code, 0)
  assert.equal(JSON.parse(caps.stdout.trim()).runners[0].name, 'pi')
})
