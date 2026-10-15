/**
 * Progress JSONL and viewer tests.
 *
 *   node --test tests/run-runtime/progress.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { appendEvent, readEvents } from '../../lib/run-runtime/progress.mjs'
import { createViewerServer } from '../../lib/run-runtime/viewer.mjs'
import { CliError } from '../../lib/run-runtime/util.mjs'
import { cleanup, tempDir } from './helpers.mjs'

test('append and read persist records with stable fields', () => {
  const dir = tempDir('rr-progress-')
  try {
    const file = join(dir, 'events.jsonl')
    const first = appendEvent(file, { event: 'run_start', data: { task: 'a' } })
    const second = appendEvent(file, { event: 'settle', level: 0, t: 123456 })
    assert.equal(first.level, 1)
    assert.equal(second.level, 0)
    assert.equal(second.t, 123456)

    const all = readEvents(file)
    assert.equal(all.events.length, 2)
    assert.equal(all.lineCount, 2)
    assert.equal(all.malformed.length, 0)
    assert.deepEqual(all.events[0].task, 'a')

    const tail = readEvents(file, { after: 2 })
    assert.equal(tail.events.length, 0)

    const content = readFileSync(file, 'utf8')
    assert.equal(content.trim().split('\n').length, 2)
  } finally {
    cleanup(dir)
  }
})

test('malformed records are reported, not dropped', () => {
  const dir = tempDir('rr-progress-bad-')
  try {
    const file = join(dir, 'events.jsonl')
    appendEvent(file, { event: 'ok' })
    appendFileSync(file, 'not json\n', 'utf8')
    appendFileSync(file, '{"level":1}\n', 'utf8')
    appendFileSync(file, '{"t":1,"level":1,"event":""}\n', 'utf8')
    const result = readEvents(file)
    assert.equal(result.events.length, 1)
    assert.equal(result.malformed.length, 3)
    assert.equal(result.lineCount, 4)
  } finally {
    cleanup(dir)
  }
})

test('invalid event inputs are rejected', () => {
  const dir = tempDir('rr-progress-invalid-')
  try {
    const file = join(dir, 'events.jsonl')
    assert.throws(() => appendEvent(file, { event: '' }), (e) => e instanceof CliError && e.exitCode === 2)
    assert.throws(() => appendEvent(file, { event: 'x', level: -1 }), (e) => e.exitCode === 2)
    assert.throws(() => appendEvent(file, { event: 'x', t: -5 }), (e) => e.exitCode === 2)
  } finally {
    cleanup(dir)
  }
})

test('read-only viewer serves events and shuts down', async () => {
  const dir = tempDir('rr-viewer-')
  let viewer
  try {
    const file = join(dir, 'events.jsonl')
    appendEvent(file, { event: 'run_start' })
    appendEvent(file, { event: 'done', level: 0 })
    viewer = await createViewerServer({ eventsFile: file })
    assert.match(viewer.url, /^http:\/\/127\.0\.0\.1:\d+\/$/)
    assert.ok(viewer.port > 0)

    const page = await fetch(viewer.url)
    assert.equal(page.status, 200)
    const html = await page.text()
    assert.match(html, /run-runtime events/)
    assert.ok(!/src="https?:/.test(html))
    assert.ok(!/href="https?:/.test(html))

    const events = await (await fetch(`${viewer.url}events?after=0`)).json()
    assert.equal(events.events.length, 2)
    assert.equal(events.lineCount, 2)

    const tail = await (await fetch(`${viewer.url}events?after=2`)).json()
    assert.equal(tail.events.length, 0)

    const missing = await fetch(`${viewer.url}nope`)
    assert.equal(missing.status, 404)
  } finally {
    if (viewer) await viewer.close()
    cleanup(dir)
  }
})
