/**
 * Owned child-process handle tests.
 *
 *   node --test tests/run-runtime/child-process.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { startOwnedProcess } from '../../lib/run-runtime/child-process.mjs'
import { cleanup, tempDir } from './helpers.mjs'

test('wait reports a normal child exit', async () => {
  const dir = tempDir('rr-child-')
  try {
    const handle = startOwnedProcess({ command: process.execPath, args: ['-e', "process.stdout.write('hi')"], cwd: dir })
    assert.ok(handle.pid > 0)
    const result = await handle.wait()
    assert.equal(result.code, 0)
    assert.equal(handle.exited, true)
    const after = await handle.cancel()
    assert.equal(after.cancelled, false)
  } finally {
    cleanup(dir)
  }
})

test('cancel waits for the owned process to terminate', async () => {
  const dir = tempDir('rr-child-cancel-')
  try {
    const handle = startOwnedProcess({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 60000)'],
      cwd: dir,
    })
    assert.equal(handle.exited, false)
    const outcome = await handle.cancel()
    assert.equal(outcome.cancelled, true)
    assert.equal(handle.exited, true)
    const result = await handle.wait()
    assert.ok(result.code !== 0 || result.signal != null || result.error != null)
  } finally {
    cleanup(dir)
  }
})

test('cancel flushes child output before resolving', async () => {
  const dir = tempDir('rr-child-flush-')
  try {
    const handle = startOwnedProcess({
      command: process.execPath,
      args: ['-e', "process.stdout.write('chunk'); setTimeout(() => {}, 60000)"],
      cwd: dir,
    })
    let out = ''
    handle.stdout.on('data', (chunk) => {
      out += chunk
    })
    await new Promise((resolve) => handle.stdout.once('data', resolve))
    const outcome = await handle.cancel()
    assert.equal(outcome.cancelled, true)
    assert.equal(out, 'chunk')
  } finally {
    cleanup(dir)
  }
})

test('cancel is idempotent and shares one result', async () => {
  const dir = tempDir('rr-child-idem-')
  try {
    const handle = startOwnedProcess({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 60000)'],
      cwd: dir,
    })
    const [a, b] = await Promise.all([handle.cancel(), handle.cancel()])
    assert.deepEqual(a, b)
    assert.equal(a.cancelled, true)
    assert.deepEqual(await handle.cancel(), a)
  } finally {
    cleanup(dir)
  }
})

test('a pre-aborted signal never starts a process', () => {
  const dir = tempDir('rr-child-abort-')
  try {
    const controller = new AbortController()
    controller.abort()
    assert.throws(
      () => startOwnedProcess({ command: process.execPath, args: ['-e', 'setTimeout(() => {}, 60000)'], cwd: dir, signal: controller.signal }),
      (err) => err.name === 'AbortError',
    )
  } finally {
    cleanup(dir)
  }
})

test('an abort during run cancels the owned process', async () => {
  const dir = tempDir('rr-child-abort2-')
  try {
    const controller = new AbortController()
    const handle = startOwnedProcess({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 60000)'],
      cwd: dir,
      signal: controller.signal,
    })
    controller.abort()
    const outcome = await handle.cancel()
    assert.equal(outcome.cancelled, true)
    assert.equal(handle.exited, true)
  } finally {
    cleanup(dir)
  }
})

test('works from a cwd containing spaces', async () => {
  const base = tempDir('rr-child-space-')
  const dir = join(base, 'dir with spaces')
  try {
    mkdirSync(dir, { recursive: true })
    const handle = startOwnedProcess({ command: process.execPath, args: ['-e', 'process.exit(3)'], cwd: dir })
    const result = await handle.wait()
    assert.equal(result.code, 3)
  } finally {
    cleanup(base)
  }
})
