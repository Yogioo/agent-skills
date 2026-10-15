/**
 * Lease tests: acquire/status/release, live-owner protection, explicit stale
 * and malformed recovery, and two-process contention.
 *
 *   node --test tests/run-runtime/lease.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  acquireLease,
  breakStaleLock,
  leasePath,
  lockPathFor,
  lockStatus,
  recoverLease,
  releaseLease,
  statusLease,
  validateLeaseRecord,
} from '../../lib/run-runtime/lease.mjs'
import { CliError } from '../../lib/run-runtime/util.mjs'
import { CLI, cleanup, runNode, tempDir } from './helpers.mjs'

const DEAD_PID = 2147483646

function setup() {
  const dir = tempDir('rr-lease-')
  return { dir, registryDir: join(dir, 'registry'), workdir: join(dir, 'workdir') }
}

test('acquire, status, token-checked release', () => {
  const { dir, registryDir, workdir } = setup()
  try {
    mkdirSync(workdir, { recursive: true })
    const acquired = acquireLease({ registryDir, workdir, pid: process.pid, label: 'me' })
    assert.equal(acquired.ok, true)
    assert.match(acquired.record.token, /^[0-9a-f]{32}$/)

    const status = statusLease({ registryDir, workdir, pid: process.pid })
    assert.equal(status.held, true)
    assert.equal(status.alive, true)
    assert.equal(status.stale, false)
    assert.equal(status.self, true)

    assert.throws(
      () => releaseLease({ registryDir, workdir, token: 'wrong-token' }),
      (err) => err instanceof CliError && err.exitCode === 1 && err.code === 'NOT_OWNER',
    )

    const released = releaseLease({ registryDir, workdir, token: acquired.record.token })
    assert.equal(released.released, true)
    assert.equal(statusLease({ registryDir, workdir }).present, false)
  } finally {
    cleanup(dir)
  }
})

test('a live owner is never replaced automatically', () => {
  const { dir, registryDir, workdir } = setup()
  try {
    mkdirSync(workdir, { recursive: true })
    assert.equal(acquireLease({ registryDir, workdir, pid: process.pid }).ok, true)
    const second = acquireLease({ registryDir, workdir, pid: process.pid })
    assert.equal(second.ok, false)
    assert.equal(second.reason, 'held')
    assert.throws(
      () => recoverLease({ registryDir, workdir }),
      (err) => err instanceof CliError && err.code === 'LEASE_HELD',
    )
  } finally {
    cleanup(dir)
  }
})

test('stale recovery is explicit, then steal or recover works', () => {
  const { dir, registryDir, workdir } = setup()
  try {
    mkdirSync(workdir, { recursive: true })
    const stale = acquireLease({ registryDir, workdir, pid: DEAD_PID })
    assert.equal(stale.ok, true)
    const status = statusLease({ registryDir, workdir })
    assert.equal(status.held, false)
    assert.equal(status.stale, true)

    const blocked = acquireLease({ registryDir, workdir, pid: process.pid })
    assert.equal(blocked.ok, false)
    assert.equal(blocked.reason, 'stale')

    const recovered = recoverLease({ registryDir, workdir })
    assert.equal(recovered.recovered, true)
    assert.equal(recovered.reason, 'stale')

    const taken = acquireLease({ registryDir, workdir, pid: DEAD_PID })
    assert.equal(taken.ok, true)
    const stolen = acquireLease({ registryDir, workdir, pid: process.pid, stealStale: true })
    assert.equal(stolen.ok, true)
    assert.notEqual(stolen.record.token, taken.record.token)
  } finally {
    cleanup(dir)
  }
})

test('malformed lease is visible and recoverable', () => {
  const { dir, registryDir, workdir } = setup()
  try {
    mkdirSync(workdir, { recursive: true })
    const file = leasePath(registryDir, workdir)
    mkdirSync(registryDir, { recursive: true })
    writeFileSync(file, '{ not json', 'utf8')

    const status = statusLease({ registryDir, workdir })
    assert.equal(status.present, true)
    assert.equal(status.malformed, true)
    assert.match(status.error, /malformed/)

    const blocked = acquireLease({ registryDir, workdir, pid: process.pid })
    assert.equal(blocked.ok, false)
    assert.equal(blocked.reason, 'malformed')

    const recovered = recoverLease({ registryDir, workdir })
    assert.equal(recovered.recovered, true)
    assert.equal(recovered.reason, 'malformed')
    assert.equal(acquireLease({ registryDir, workdir, pid: process.pid }).ok, true)
  } finally {
    cleanup(dir)
  }
})

test('two processes contend for one lease', async () => {
  const { dir, registryDir, workdir } = setup()
  try {
    mkdirSync(workdir, { recursive: true })
    const worker = join(dirname(fileURLToPath(import.meta.url)), 'lease-worker.mjs')
    const [a, b] = await Promise.all([
      runNode([worker, registryDir, workdir], dir),
      runNode([worker, registryDir, workdir], dir),
    ])
    const results = [a, b].map((r) => {
      assert.equal(r.code, 0, r.stderr)
      return JSON.parse(r.stdout.trim())
    })
    const winners = results.filter((r) => r.ok)
    assert.equal(winners.length, 1)
    assert.equal(results.filter((r) => !r.ok).length, 1)
  } finally {
    cleanup(dir)
  }
})

test('invalid owner pid is malformed, not silently stale', () => {
  const { dir, registryDir, workdir } = setup()
  try {
    mkdirSync(workdir, { recursive: true })
    const file = leasePath(registryDir, workdir)
    mkdirSync(registryDir, { recursive: true })
    writeFileSync(
      file,
      JSON.stringify({ tool: 'run-runtime', workdir, token: 'tok', pid: 'not-a-pid', host: hostname() }),
      'utf8',
    )
    assert.equal(validateLeaseRecord({ token: 't', pid: 0, host: 'h', workdir: 'w' }).valid, false)

    const status = statusLease({ registryDir, workdir })
    assert.equal(status.malformed, true)
    assert.equal(status.stale, false)

    const blocked = acquireLease({ registryDir, workdir, pid: process.pid, stealStale: true })
    assert.equal(blocked.ok, false)
    assert.equal(blocked.reason, 'malformed')

    const recovered = recoverLease({ registryDir, workdir })
    assert.equal(recovered.recovered, true)
    assert.equal(recovered.reason, 'malformed')
  } finally {
    cleanup(dir)
  }
})

test('a non-owner cannot release a live lease even with force', () => {
  const { dir, registryDir, workdir } = setup()
  try {
    mkdirSync(workdir, { recursive: true })
    const acquired = acquireLease({ registryDir, workdir, pid: process.pid })
    assert.throws(
      () => releaseLease({ registryDir, workdir, token: 'wrong', force: true }),
      (err) => err instanceof CliError && err.code === 'NOT_OWNER',
    )
    assert.equal(statusLease({ registryDir, workdir }).present, true)
    releaseLease({ registryDir, workdir, token: acquired.record.token })
  } finally {
    cleanup(dir)
  }
})

test('CLI acquire requires a live --pid and the lease survives CLI exit', async () => {
  const { dir, registryDir, workdir } = setup()
  try {
    mkdirSync(workdir, { recursive: true })
    const base = ['lease', 'acquire', '--registry-dir', registryDir, '--workdir', workdir]

    const missing = await runNode([CLI, ...base], dir)
    assert.equal(missing.code, 2)
    assert.match(missing.stderr, /--pid/)

    const dead = await runNode([CLI, ...base, '--pid', String(DEAD_PID)], dir)
    assert.equal(dead.code, 2)
    assert.match(dead.stderr, /live process/)

    const live = await runNode([CLI, ...base, '--pid', String(process.pid)], dir)
    assert.equal(live.code, 0, live.stderr)
    const record = JSON.parse(live.stdout.trim()).record
    assert.equal(record.pid, process.pid)

    const status = statusLease({ registryDir, workdir })
    assert.equal(status.present, true)
    assert.equal(status.alive, true)
    assert.equal(status.stale, false)
  } finally {
    cleanup(dir)
  }
})

test('mutex recovery breaks a dead lock but never a live one', () => {
  const { dir, registryDir, workdir } = setup()
  try {
    mkdirSync(workdir, { recursive: true })
    mkdirSync(registryDir, { recursive: true })
    const lockDir = lockPathFor(registryDir)

    mkdirSync(lockDir)
    writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({ pid: process.pid, host: hostname(), at: new Date().toISOString() }))
    assert.equal(lockStatus(lockDir).stale, false)
    assert.throws(
      () => breakStaleLock(lockDir),
      (err) => err instanceof CliError && err.code === 'LOCK_HELD',
    )
    assert.equal(lockStatus(lockDir).present, true)

    writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({ pid: DEAD_PID, host: hostname(), at: new Date().toISOString() }))
    const broken = breakStaleLock(lockDir)
    assert.equal(broken.broken, true)
    assert.equal(lockStatus(lockDir).present, false)
  } finally {
    cleanup(dir)
  }
})

test('recover clears a crashed mutex and a stale lease', () => {
  const { dir, registryDir, workdir } = setup()
  try {
    mkdirSync(workdir, { recursive: true })
    mkdirSync(registryDir, { recursive: true })
    acquireLease({ registryDir, workdir, pid: DEAD_PID })

    const lockDir = lockPathFor(registryDir)
    mkdirSync(lockDir)
    writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({ pid: DEAD_PID, host: hostname(), at: new Date().toISOString() }))
    const past = new Date(Date.now() - 60000)
    utimesSync(lockDir, past, past)

    const recovered = recoverLease({ registryDir, workdir })
    assert.equal(recovered.recovered, true)
    assert.equal(lockStatus(lockDir).present, false)
    assert.equal(acquireLease({ registryDir, workdir, pid: process.pid }).ok, true)
  } finally {
    cleanup(dir)
  }
})
