/**
 * afk-watch 后台启动器外部行为。
 *
 * Run:
 *   node --test tests/afk-watch/watch-background.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { killOwnedProcess, readWatcherRegistry, watcherRegistryPath } from '../../skills/afk-watch/scripts/watch-state.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const LAUNCHER = join(__dirname, '..', '..', 'skills', 'afk-watch', 'scripts', 'start-background.mjs')

// 测试不读开发机的 ~/.afk：beads 源在无 .beads 目录时只会进入错误退避，不会启动执行批次。
const TEST_AFK_HOME = mkdtempSync(join(tmpdir(), 'afk-watch-bg-home-'))
writeFileSync(join(TEST_AFK_HOME, 'config.json'), JSON.stringify({ task: { source: 'beads' } }))
const TEST_ENV = { ...process.env, AFK_HOME: TEST_AFK_HOME }

function fixtures() {
  const workdir = mkdtempSync(join(tmpdir(), 'afk-watch-bg-work-'))
  const cacheDir = mkdtempSync(join(tmpdir(), 'afk-watch-bg-cache-'))
  return { workdir, cacheDir }
}

function runLauncher(args, opts = {}) {
  const result = spawnSync(process.execPath, [LAUNCHER, ...args], {
    encoding: 'utf8',
    env: TEST_ENV,
    windowsHide: true,
    ...opts,
  })
  const line = (result.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop() || '{}'
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '', json: JSON.parse(line) }
}

function cleanup(fixture) {
  const record = readWatcherRegistry(fixture.cacheDir, fixture.workdir)
  if (record?.childPid) killOwnedProcess(record.childPid, { tree: true })
  if (record?.dashboardPid) killOwnedProcess(record.dashboardPid)
  if (record?.pid) killOwnedProcess(record.pid)
  rmSync(fixture.workdir, { recursive: true, force: true })
  rmSync(fixture.cacheDir, { recursive: true, force: true })
}

test('idle workdir reports running:false and points at the log file', () => {
  const fixture = fixtures()
  try {
    const { status, json } = runLauncher(['--status', '--workdir', fixture.workdir, '--cache-dir', fixture.cacheDir])
    assert.equal(status, 4)
    assert.equal(json.running, false)
    assert.equal(json.registryPath, watcherRegistryPath(fixture.cacheDir, fixture.workdir))
    assert.ok(json.logFile.endsWith('.log'))
  } finally {
    cleanup(fixture)
  }
})

test('detached watcher starts, refuses a second instance, and stops on request', async () => {
  const fixture = fixtures()
  const baseArgs = [
    '--workdir',
    fixture.workdir,
    '--cache-dir',
    fixture.cacheDir,
    '--no-serve',
    '--poll-interval',
    '500',
    '--backoff-initial',
    '200',
    '--backoff-max',
    '500',
  ]
  try {
    const started = runLauncher(baseArgs)
    assert.equal(started.status, 0, started.stdout + started.stderr)
    assert.equal(started.json.reason, 'started')
    assert.ok(started.json.state.length > 0, '应报告 watcher 阶段')
    assert.ok(Number.isInteger(started.json.pid) && started.json.pid > 0)
    assert.ok(existsSync(started.json.logFile), '启动日志应已落盘')

    const again = runLauncher(baseArgs)
    assert.equal(again.status, 3)
    assert.equal(again.json.reason, 'already-running')
    assert.equal(again.json.pid, started.json.pid)

    const status = runLauncher(['--status', '--workdir', fixture.workdir, '--cache-dir', fixture.cacheDir])
    assert.equal(status.status, 0)
    assert.equal(status.json.running, true)
    assert.equal(status.json.pid, started.json.pid)
    assert.ok('pool' in status.json, '未成功轮询过时 pool 应为 null，但字段要在')

    const stopped = runLauncher(['--stop', '--workdir', fixture.workdir, '--cache-dir', fixture.cacheDir])
    assert.equal(stopped.status, 0, stopped.stdout + stopped.stderr)
    assert.equal(stopped.json.reason, 'stop-requested')
    assert.equal(stopped.json.watcherPid, started.json.pid)

    const deadline = Date.now() + 20000
    let last = null
    while (Date.now() < deadline) {
      last = runLauncher(['--status', '--workdir', fixture.workdir, '--cache-dir', fixture.cacheDir])
      if (last.status === 4) break
      await new Promise((r) => setTimeout(r, 500))
    }
    assert.equal(last.status, 4, '停止文件写入后 watcher 应退出')
    assert.equal(existsSync(watcherRegistryPath(fixture.cacheDir, fixture.workdir)), false, '注册表应释放')
    assert.match(readFileSync(join(fixture.workdir, 'afk-stop'), 'utf8'), /^stop /)
  } finally {
    cleanup(fixture)
  }
})

test('--help is the authority for modes and exit codes', () => {
  const result = spawnSync(process.execPath, [LAUNCHER, '--help'], { encoding: 'utf8', windowsHide: true })
  assert.equal(result.status, 0)
  for (const needle of ['--status', '--stop', '退出码', 'logTail']) {
    assert.ok(result.stdout.includes(needle), `--help 应包含 ${needle}`)
  }
})

test('missing workdir fails before spawning anything', () => {
  const fixture = fixtures()
  try {
    const { status, json } = runLauncher(['--workdir', join(fixture.workdir, 'nope'), '--cache-dir', fixture.cacheDir])
    assert.equal(status, 2)
    assert.equal(json.reason, 'workdir-missing')
  } finally {
    cleanup(fixture)
  }
})
