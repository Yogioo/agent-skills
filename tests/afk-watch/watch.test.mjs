/**
 * afk-watch external behavior.
 *
 * Run:
 *   node --test tests/afk-watch/watch.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loopRegistryPath } from '../../skills/afk-run/scripts/loop.mjs'
import {
  buildExecutionArgs,
  loadConfig,
  runWatcher,
  superviseExecutionRun,
} from '../../skills/afk-watch/scripts/watch.mjs'
import { projectKeyFromWorkdir } from '../../skills/afk-run/scripts/afk-home.mjs'
import {
  appendWatchEvent,
  claimWatcherInstance,
  createWatchRunDir,
  readWatcherRegistry,
  releaseWatcherInstance,
  stopOwnedProcesses,
  watcherRegistryPath,
} from '../../skills/afk-watch/scripts/watch-state.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WATCH = join(__dirname, '..', '..', 'skills', 'afk-watch', 'scripts', 'watch.mjs')
const BAT = join(__dirname, '..', '..', 'skills', 'afk-watch', 'start-watch.bat')

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix))
}

function readySource(overrides = {}) {
  return {
    claimMode: 'atomic',
    listReady: async () => [{ id: 'a', title: 'A', priority: 1 }],
    tryClaim: async () => ({ status: 'claimed', claimMode: 'atomic' }),
    describeBlocked: () => {
      throw new Error('remote in-progress must not be consulted')
    },
    ...overrides,
  }
}

test('strict atomic claim exits before polling or starting a run', async () => {
  let listed = false
  let spawned = false
  const result = await runWatcher({
    config: { requireAtomicClaim: true },
    source: readySource({
      claimMode: 'best-effort',
      listReady: async () => {
        listed = true
        return []
      },
    }),
    spawnRun: async () => {
      spawned = true
      return { code: 0 }
    },
    sleep: async () => {},
    isStopRequested: () => false,
  })
  assert.equal(result.reason, 'require-atomic-claim')
  assert.equal(result.claimMode, 'best-effort')
  assert.equal(listed, false)
  assert.equal(spawned, false)
})

test('atomic claim mode is allowed to poll when strict mode is on', async () => {
  let listed = false
  const result = await runWatcher({
    config: { requireAtomicClaim: true, pollIntervalMs: 5 },
    source: readySource({
      listReady: async () => {
        listed = true
        return []
      },
    }),
    spawnRun: async () => ({ code: 0 }),
    sleep: async () => true,
    isStopRequested: () => false,
  })
  assert.equal(listed, true)
  assert.equal(result.reason, 'stop')
})

test('idle watcher waits and does not start a run', async () => {
  const waits = []
  let spawned = false
  const result = await runWatcher({
    config: { pollIntervalMs: 25, requireAtomicClaim: false },
    source: readySource({ listReady: async () => [] }),
    spawnRun: async () => {
      spawned = true
      return { code: 0 }
    },
    sleep: async (ms) => {
      waits.push(ms)
    },
    isStopRequested: () => waits.length > 0,
  })
  assert.equal(spawned, false)
  assert.deepEqual(waits, [25])
  assert.equal(result.reason, 'stop')
})

test('ready work starts one serialized run and pins the claimed id', async () => {
  let active = 0
  let maxActive = 0
  let calls = 0
  const pinned = []
  let stop = false
  const result = await runWatcher({
    config: { pollIntervalMs: 1 },
    source: readySource(),
    spawnRun: async ({ pinnedIds }) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      calls += 1
      pinned.push(...pinnedIds)
      active -= 1
      if (calls >= 2) stop = true
      return { code: 0 }
    },
    sleep: async () => {},
    isStopRequested: () => stop,
  })
  assert.equal(maxActive, 1)
  assert.equal(calls, 2)
  assert.deepEqual(pinned, ['a', 'a'])
  assert.equal(result.runs, 2)
  assert.equal(result.reason, 'stop')
})

test('remote in-progress does not block a run when other work is ready', async () => {
  let spawned = false
  const result = await runWatcher({
    config: { pollIntervalMs: 1 },
    source: readySource({
      inProgress: [{ id: 'remote', title: 'other env', priority: 0 }],
    }),
    spawnRun: async () => {
      spawned = true
      return { code: 0 }
    },
    sleep: async () => {},
    isStopRequested: () => spawned,
  })
  assert.equal(spawned, true)
  assert.equal(result.runs, 1)
})

test('already-claimed skips the execution run', async () => {
  let spawned = false
  let skipped = false
  const result = await runWatcher({
    config: { pollIntervalMs: 7 },
    source: readySource({
      tryClaim: async () => {
        skipped = true
        return { status: 'already-claimed', claimMode: 'atomic' }
      },
    }),
    spawnRun: async () => {
      spawned = true
      return { code: 0 }
    },
    sleep: async () => {},
    isStopRequested: () => skipped,
  })
  assert.equal(spawned, false)
  assert.equal(skipped, true)
  assert.equal(result.runs, 0)
  assert.equal(result.reason, 'stop')
})

test('source errors use bounded exponential backoff and success resets it', async () => {
  const waits = []
  let n = 0
  let stop = false
  await runWatcher({
    config: {
      pollIntervalMs: 50,
      backoffInitialMs: 100,
      backoffMaxMs: 350,
      backoffFactor: 2,
    },
    source: readySource({
      listReady: async () => {
        n += 1
        if (n === 2) return []
        if (n >= 4) stop = true
        throw new Error('down')
      },
    }),
    spawnRun: async () => ({ code: 0 }),
    sleep: async (ms) => {
      waits.push(ms)
    },
    isStopRequested: () => stop,
  })
  assert.deepEqual(waits, [100, 50, 100, 200])
})

test('stop ends the owned child and dashboard only', async () => {
  const killed = []
  const kill = (pid, opts = {}) => killed.push({ pid: Number(pid), tree: Boolean(opts.tree) })
  let stop = false
  const result = await runWatcher({
    config: { pollIntervalMs: 1 },
    source: readySource(),
    spawnRun: async () => {
      stop = true
      return { code: 130 }
    },
    sleep: async () => {},
    isStopRequested: () => stop,
    stopOwned: () => stopOwnedProcesses({ childPid: 41, dashboardPid: 42, foreignPid: 99 }, kill),
  })
  assert.equal(result.reason, 'stop')
  assert.deepEqual(killed, [
    { pid: 41, tree: true },
    { pid: 42, tree: false },
  ])
})

test('superviseExecutionRun stops only the child and dashboard it started', async () => {
  const killed = []
  let stop = false
  const result = await superviseExecutionRun({
    startChild: () => ({ pid: 7, done: false, code: null }),
    startDashboard: (runDir) => {
      assert.equal(runDir, 'run-1')
      return 8
    },
    readRunDir: () => 'run-1',
    isStopRequested: () => stop,
    sleep: async () => {
      stop = true
    },
    kill: (pid, opts = {}) => killed.push({ pid: Number(pid), tree: Boolean(opts.tree) }),
  })
  assert.equal(result.reason, 'stop')
  assert.deepEqual(killed, [
    { pid: 7, tree: true },
    { pid: 8, tree: false },
  ])
})

test('execution args forward source settings and the claimed id', () => {
  const args = buildExecutionArgs({
    loopPath: 'loop.mjs',
    workdir: 'C:/work',
    source: 'custom',
    repo: 'org/name',
    cacheDir: 'C:/cache',
    maxTasks: 1,
    pinnedIds: ['item-1'],
    stopFile: 'C:/work/afk-stop',
  })
  assert.ok(args.includes('--source'))
  assert.ok(args.includes('custom'))
  assert.ok(args.includes('--repo'))
  assert.ok(args.includes('org/name'))
  assert.ok(args.includes('--pinned-id'))
  assert.ok(args.includes('item-1'))
  assert.ok(args.includes('--no-serve'))
  assert.equal(args.includes('--serve'), false)
})

test('watcher registry is separate and a dead instance does not keep the workdir', () => {
  const cache = tempDir('afk-watch-cache-')
  const workdir = tempDir('afk-watch-wd-')
  try {
    assert.notEqual(watcherRegistryPath(cache, workdir), loopRegistryPath(cache, workdir))
    writeFileSync(watcherRegistryPath(cache, workdir), JSON.stringify({
      pid: 424242,
      workdir,
      childPid: 44,
      dashboardPid: 55,
    }) + '\n')
    const blockedKills = []
    const blocked = claimWatcherInstance(cache, workdir, { runDir: 'y' }, {
      isAlive: () => true,
      kill: (pid) => blockedKills.push(pid),
    })
    assert.equal(blocked.ok, false)
    assert.equal(blocked.reason, 'watcher-busy')
    assert.deepEqual(blockedKills, [])

    const killed = []
    const reclaimed = claimWatcherInstance(cache, workdir, { runDir: 'new', claimMode: 'best-effort' }, {
      isAlive: () => false,
      kill: (pid, opts = {}) => killed.push({ pid: Number(pid), tree: Boolean(opts.tree) }),
    })
    assert.equal(reclaimed.ok, true)
    assert.equal(reclaimed.record.pid, process.pid)
    assert.deepEqual(killed, [
      { pid: 44, tree: true },
      { pid: 55, tree: false },
    ])
    assert.equal(releaseWatcherInstance(cache, workdir, process.pid + 1), false)
    assert.equal(releaseWatcherInstance(cache, workdir, process.pid), true)
    assert.equal(readWatcherRegistry(cache, workdir), null)

    const runDir = createWatchRunDir(cache)
    appendWatchEvent(runDir, { event: 'idle' })
    appendWatchEvent(runDir, { event: 'watch_end', reason: 'stop' })
    const lines = readFileSync(join(runDir, 'events.jsonl'), 'utf8').trim().split(/\n/)
    assert.equal(lines.length, 2)
    assert.equal(JSON.parse(lines[0]).event, 'idle')
    assert.match(runDir, /watch-run-/)
  } finally {
    rmSync(cache, { recursive: true, force: true })
    rmSync(workdir, { recursive: true, force: true })
  }
})

test('launcher is ASCII and the CLI exposes watch, stop, and dry-run', () => {
  const bytes = readFileSync(BAT)
  for (const byte of bytes) assert.ok(byte < 128, `non-ascii byte ${byte}`)
  const text = bytes.toString('ascii')
  assert.match(text, /node "%~dp0scripts\\watch\.mjs" %\*/)

  const src = readFileSync(WATCH, 'utf8')
  assert.equal(src.includes('task-sources/gh.mjs'), false)
  assert.equal(src.includes('task-sources/beads.mjs'), false)
  assert.equal(src.includes('task-sources/tapd.mjs'), false)
  assert.equal(src.includes('--add-label'), false)
  assert.equal(src.includes('ready-for-agent'), false)

  const help = spawnSync(process.execPath, [WATCH, '--help'], { encoding: 'utf8' })
  assert.equal(help.status, 0)
  assert.match(help.stdout, /--require-atomic-claim/)
  assert.match(help.stdout, /--stop/)

  const missing = spawnSync(process.execPath, [WATCH], { encoding: 'utf8' })
  assert.equal(missing.status, 2)

  const workdir = tempDir('afk-watch-cli-')
  const cache = tempDir('afk-watch-cli-cache-')
  const stopFile = join(cache, 'afk-stop')
  try {
    const dry = spawnSync(process.execPath, [
      WATCH,
      '--dry-run',
      '--allow-dirty',
      '--workdir',
      workdir,
      '--source',
      'tapd',
      '--cache-dir',
      cache,
    ], { encoding: 'utf8' })
    assert.equal(dry.status, 0, dry.stderr)
    const dryBody = JSON.parse(dry.stdout)
    assert.equal(dryBody.dryRun, true)
    assert.equal(dryBody.source, 'tapd')
    assert.equal(dryBody.claimMode, 'unsupported')
    assert.equal(dryBody.refusesWork, false)

    const refused = spawnSync(process.execPath, [
      WATCH,
      '--allow-dirty',
      '--require-atomic-claim',
      '--workdir',
      workdir,
      '--source',
      'tapd',
      '--cache-dir',
      cache,
    ], { encoding: 'utf8' })
    assert.equal(refused.status, 2, refused.stderr)
    assert.equal(JSON.parse(refused.stdout).reason, 'require-atomic-claim')

    const stop = spawnSync(process.execPath, [
      WATCH,
      '--stop',
      '--workdir',
      workdir,
      '--stop-file',
      stopFile,
    ], { encoding: 'utf8' })
    assert.equal(stop.status, 0, stop.stderr)
    assert.equal(JSON.parse(stop.stdout).reason, 'stop-requested')
    assert.match(readFileSync(stopFile, 'utf8'), /stop /)
  } finally {
    rmSync(workdir, { recursive: true, force: true })
    rmSync(cache, { recursive: true, force: true })
  }
})

test('loadConfig reads ~/.afk/<label>_<uid>/config.json over ~/.afk/config.json', () => {
  const home = tempDir('afk-home-')
  const workdir = tempDir('my-app-')
  const prev = process.env.AFK_HOME
  process.env.AFK_HOME = home
  try {
    const projectKey = projectKeyFromWorkdir(workdir)
    writeFileSync(join(home, 'config.json'), JSON.stringify({
      task: { source: 'beads', maxTasks: 9 },
      watch: { requireAtomicClaim: false },
    }))
    mkdirSync(join(home, projectKey), { recursive: true })
    writeFileSync(join(home, projectKey, 'config.json'), JSON.stringify({
      task: { source: 'gh', repo: 'acme/demo' },
      watch: { requireAtomicClaim: true },
    }))
    const { cfg } = loadConfig({ workdir })
    assert.equal(cfg.task.source, 'gh')
    assert.equal(cfg.task.repo, 'acme/demo')
    assert.equal(cfg.task.maxTasks, 9)
    assert.equal(cfg.watch.requireAtomicClaim, true)
    assert.equal(loadConfig({}).cfg.task.source, 'beads')
    assert.match(projectKey, /_[\da-f]{8}$/)
  } finally {
    if (prev === undefined) delete process.env.AFK_HOME
    else process.env.AFK_HOME = prev
    rmSync(home, { recursive: true, force: true })
    rmSync(workdir, { recursive: true, force: true })
  }
})

