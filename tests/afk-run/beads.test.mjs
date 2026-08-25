/**
 * Beads adapter integration tests using the real bd CLI and a temporary Dolt store.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBeadsSource } from '../../skills/afk-run/scripts/task-sources/beads.mjs'

const bdJs = join(process.env.APPDATA || '', 'npm', 'node_modules', '@beads', 'bd', 'bin', 'bd.js')

function bd(cwd, args) {
  if (!existsSync(bdJs)) throw new Error(`找不到 bd.js: ${bdJs}`)
  return execFileSync(process.execPath, [bdJs, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
}

function row(cwd, id) {
  return JSON.parse(bd(cwd, ['list', '--id', id, '--json']))[0]
}

function cleanup(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 })
  } catch {
    // The embedded Dolt store can retain a Windows handle past the CLI exit.
  }
}

test('beads: recoverStale 重置超阈值 in_progress，保留近期工单并写审计 comment', () => {
  const dir = mkdtempSync(join(tmpdir(), 'afk-beads-'))
  try {
    bd(dir, ['init', '--quiet', '--skip-agents', '--skip-hooks', '--prefix', 'afk-test'])
    const staleId = bd(dir, ['create', 'stale', '--silent']).trim()
    const source = createBeadsSource({ cwd: dir })
    source.markInProgress(staleId)
    const staleUpdatedAt = row(dir, staleId).updated_at
    // bd sql is unavailable in the embedded Dolt mode used by bd init, so
    // exercise the real adapter with its documented injectable clock instead.
    const staleNow = Date.parse(staleUpdatedAt) + 5 * 60 * 1000

    const recovered = source.recoverStale(60, () => staleNow)
    assert.deepEqual(recovered, [staleId])
    assert.equal(row(dir, staleId).status, 'open')

    const freshId = bd(dir, ['create', 'fresh', '--silent']).trim()
    source.markInProgress(freshId)
    assert.deepEqual(source.recoverStale(60, Date.now), [])
    assert.equal(row(dir, freshId).status, 'in_progress')
    assert.deepEqual(source.describeBlocked(), {
      blocked: [],
      inProgress: [{ id: freshId, title: 'fresh' }],
    })
    assert.match(
      bd(dir, ['comments', staleId, '--json']),
      new RegExp(`afk stale 自动重置: 卡了 5 分钟，updated_at=${staleUpdatedAt}`),
    )

    const disabledId = bd(dir, ['create', 'disabled', '--silent']).trim()
    source.markInProgress(disabledId)
    assert.deepEqual(source.recoverStale(0, () => staleNow), [])
    assert.equal(row(dir, disabledId).status, 'in_progress')
  } finally {
    cleanup(dir)
  }
})
