/**
 * Runtime-package test: copy the tool runtime (lib/, tools/, and bin/package
 * when present) to a temp dir with no legacy skills alongside and drive the
 * real CLI, including a Windows directory-junction entry point for the
 * direct-main guard.
 *
 *   node --test tests/run-runtime/standalone.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runNode } from './helpers.mjs'
import { createRuntimeCopy } from '../support/runtime-package.mjs'

test('copied runtime CLI runs without legacy skills', async (t) => {
  const rt = createRuntimeCopy('rr-runtime-')
  t.after(() => rmSync(rt.root, { recursive: true, force: true }))
  assert.equal(existsSync(join(rt.root, 'skills')), false)
  const cli = rt.cli('run-runtime')

  const help = await runNode([cli, '--help'], rt.root)
  assert.equal(help.code, 0)
  assert.match(help.stdout, /run-runtime/)

  const workdir = join(rt.root, 'wd')
  mkdirSync(workdir, { recursive: true })
  const reg = join(rt.root, 'reg')

  const dead = await runNode(
    [cli, 'lease', 'acquire', '--registry-dir', reg, '--workdir', workdir, '--pid', '2147483646'],
    rt.root,
  )
  assert.equal(dead.code, 2)
  assert.match(dead.stderr, /live process/)

  const acquired = await runNode(
    [cli, 'lease', 'acquire', '--registry-dir', reg, '--workdir', workdir, '--pid', String(process.pid)],
    rt.root,
  )
  assert.equal(acquired.code, 0, acquired.stderr)
  const token = JSON.parse(acquired.stdout.trim()).record.token

  const status = await runNode([cli, 'lease', 'status', '--registry-dir', reg, '--workdir', workdir], rt.root)
  assert.equal(JSON.parse(status.stdout.trim()).held, true)

  const released = await runNode(
    [cli, 'lease', 'release', '--registry-dir', reg, '--workdir', workdir, '--token', token],
    rt.root,
  )
  assert.equal(released.code, 0, released.stderr)

  const events = join(rt.root, 'events.jsonl')
  const appended = await runNode([cli, 'progress', 'append', '--file', events, '--event', 'run_start'], rt.root)
  assert.equal(appended.code, 0)
  const read = await runNode([cli, 'progress', 'read', '--file', events], rt.root)
  assert.equal(JSON.parse(read.stdout.trim()).events.length, 1)

  const invalid = await runNode([cli, 'progress', 'append', '--file', events], rt.root)
  assert.equal(invalid.code, 2)
  assert.match(invalid.stderr, /--event/)
})

test('direct-main guard works through a directory junction', async (t) => {
  const rt = createRuntimeCopy('rr-junction-')
  t.after(() => rmSync(rt.root, { recursive: true, force: true }))
  const link = join(mkdtempSync(join(tmpdir(), 'rr-junction-')), 'linked-runtime')
  t.after(() => rmSync(join(link, '..'), { recursive: true, force: true }))
  try {
    symlinkSync(rt.root, link, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    t.skip(`junction unavailable: ${error.message}`)
    return
  }
  const cli = join(link, 'tools', 'run-runtime', 'cli.mjs')
  const help = await runNode([cli, '--help'], join(link, '..'))
  assert.equal(help.code, 0)
  assert.match(help.stdout, /run-runtime/)
})

test('CLI path with spaces works', async (t) => {
  const rt = createRuntimeCopy('rr-runtime-spaces-')
  t.after(() => rmSync(rt.root, { recursive: true, force: true }))
  const spaced = join(mkdtempSync(join(tmpdir(), 'rr spaces ')), 'run runtime')
  t.after(() => rmSync(join(spaced, '..'), { recursive: true, force: true }))
  cpSync(rt.root, spaced, { recursive: true })
  const cli = join(spaced, 'tools', 'run-runtime', 'cli.mjs')
  const result = await runNode([cli, '--help'], spaced)
  assert.equal(result.code, 0)
})
