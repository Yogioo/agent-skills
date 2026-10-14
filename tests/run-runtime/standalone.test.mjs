/**
 * Standalone-skill test: copy only skills/run-runtime to a temp dir (no old
 * siblings) and drive the real CLI, including a Windows directory-junction
 * entry point for the direct-main guard.
 *
 *   node --test tests/run-runtime/standalone.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runNode } from './helpers.mjs'

const SKILL = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'skills', 'run-runtime')

test('copied skill CLI runs without old siblings', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rr-standalone-'))
  const copy = join(tmp, 'run-runtime')
  cpSync(SKILL, copy, { recursive: true })
  const cli = join(copy, 'scripts', 'cli.mjs')
  try {
    const help = await runNode([cli, '--help'], tmp)
    assert.equal(help.code, 0)
    assert.match(help.stdout, /run-runtime/)

    const workdir = join(tmp, 'wd')
    mkdirSync(workdir, { recursive: true })
    const reg = join(tmp, 'reg')

    const dead = await runNode(
      [cli, 'lease', 'acquire', '--registry-dir', reg, '--workdir', workdir, '--pid', '2147483646'],
      tmp,
    )
    assert.equal(dead.code, 2)
    assert.match(dead.stderr, /live process/)

    const acquired = await runNode(
      [cli, 'lease', 'acquire', '--registry-dir', reg, '--workdir', workdir, '--pid', String(process.pid)],
      tmp,
    )
    assert.equal(acquired.code, 0, acquired.stderr)
    const token = JSON.parse(acquired.stdout.trim()).record.token

    const status = await runNode([cli, 'lease', 'status', '--registry-dir', reg, '--workdir', workdir], tmp)
    assert.equal(JSON.parse(status.stdout.trim()).held, true)

    const released = await runNode(
      [cli, 'lease', 'release', '--registry-dir', reg, '--workdir', workdir, '--token', token],
      tmp,
    )
    assert.equal(released.code, 0, released.stderr)

    const events = join(tmp, 'events.jsonl')
    const appended = await runNode([cli, 'progress', 'append', '--file', events, '--event', 'run_start'], tmp)
    assert.equal(appended.code, 0)
    const read = await runNode([cli, 'progress', 'read', '--file', events], tmp)
    assert.equal(JSON.parse(read.stdout.trim()).events.length, 1)

    const invalid = await runNode([cli, 'progress', 'append', '--file', events], tmp)
    assert.equal(invalid.code, 2)
    assert.match(invalid.stderr, /--event/)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('direct-main guard works through a directory junction', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'rr-junction-'))
  const link = join(tmp, 'linked-run-runtime')
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
    assert.match(help.stdout, /run-runtime/)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('CLI path with spaces works', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rr spaces '))
  const copy = join(tmp, 'run runtime')
  cpSync(SKILL, copy, { recursive: true })
  const cli = join(copy, 'scripts', 'cli.mjs')
  try {
    const result = await runNode([cli, '--help'], tmp)
    assert.equal(result.code, 0)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
