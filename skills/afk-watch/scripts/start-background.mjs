#!/usr/bin/env node
/**
 * afk-watch 后台启动器：watcher 不再占人的终端。
 * 用法、退出码、--status 字段见 --help（下面的 USAGE 是唯一权威副本）。
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import {
  isPidAlive,
  readWatcherRegistry,
  readWatchPool,
  watcherLogPath,
  watcherRegistryPath,
} from './watch-state.mjs'

const WATCH_MJS = join(dirname(fileURLToPath(import.meta.url)), 'watch.mjs')
const DEFAULT_CACHE_ROOT = join(tmpdir(), 'afk-watch')
const SETTLE_MS = 1500
const LOG_TAIL_LINES = 12

const USAGE = `用法：
  node start-background.mjs --workdir <目录> [watch.mjs 的其它参数...]  后台启动 watcher
  node start-background.mjs --status --workdir <目录>                  是否在跑、卡在哪一阶段
  node start-background.mjs --stop   --workdir <目录>                  请求停止（下个轮询周期退出）

三种模式都只输出单行 JSON 就退出；watcher 本体 detached 运行，输出写 <cacheDir>/watch-<hash>.log。

退出码：
  0 成功 / 1 启动后立刻退出（输出带 logTail）/ 2 参数或 workdir 问题 / 3 已有 watcher 在跑 / 4 没有在跑

--status 字段：running, pid, state, childPid, dashboardPid, dashboardUrl, pool{ready,blocked,inProgress},
logFile, registryPath, phaseMs, stopHint`

function emit(payload, code = 0) {
  process.stdout.write(JSON.stringify(payload) + '\n')
  process.exit(code)
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/** 只认本脚本自己的参数，其余原样转发给 watch.mjs。 */
function parseArgs(argv) {
  const out = { action: 'start', workdir: '', cacheDir: '', passthrough: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--status' || arg === '--stop') {
      out.action = arg.slice(2)
      continue
    }
    if (arg === '-h' || arg === '--help') {
      process.stdout.write(USAGE + '\n')
      process.exit(0)
    }
    if (arg === '--workdir' || arg === '-C' || arg === '--cache-dir') {
      const value = argv[++i] || ''
      if (arg === '--workdir' || arg === '-C') out.workdir = value
      else out.cacheDir = value
      out.passthrough.push(arg, value)
      continue
    }
    out.passthrough.push(arg)
  }
  return out
}

function readLogTail(logFile, lines = LOG_TAIL_LINES) {
  if (!existsSync(logFile)) return ''
  return readFileSync(logFile, 'utf8').split(/\r?\n/).filter(Boolean).slice(-lines).join('\n')
}

function dashboardUrlFrom(logFile) {
  const matches = readLogTail(logFile, 200).match(/https?:\/\/127\.0\.0\.1:\d+\//g)
  return matches ? matches[matches.length - 1] : ''
}

/** 注册表 + 队列快照。alive 表示 registry 里的 pid 还活着。 */
function snapshot({ cacheDir, workdir }) {
  const record = readWatcherRegistry(cacheDir, workdir)
  const pool = record?.runDir ? readWatchPool(record.runDir) : null
  return {
    record,
    alive: Boolean(record?.pid) && isPidAlive(record.pid),
    pool,
    logFile: watcherLogPath(cacheDir, workdir),
    registryPath: watcherRegistryPath(cacheDir, workdir),
  }
}

function stopHint({ workdir, cacheDir }) {
  const cache = cacheDir ? ` --cache-dir "${cacheDir}"` : ''
  return `node "${join(dirname(fileURLToPath(import.meta.url)), 'start-background.mjs')}" --stop --workdir "${workdir}"${cache}`
}

function runStatus(args) {
  const { record, alive, pool, logFile, registryPath } = snapshot(args)
  if (!alive) {
    emit(
      {
        running: false,
        lastPid: record?.pid || null,
        registryPath,
        logFile,
        logTail: readLogTail(logFile, 6),
      },
      4,
    )
  }
  emit({
    running: true,
    pid: record.pid,
    state: record.state || '',
    childPid: record.childPid || null,
    dashboardPid: record.dashboardPid || null,
    claimMode: record.claimMode || '',
    runDir: record.runDir || '',
    phaseMs: Date.now() - Number(record.phaseStartedAt || record.updatedAt || Date.now()),
    dashboardUrl: dashboardUrlFrom(logFile),
    pool: pool && {
      ready: pool.ready.length,
      blocked: pool.blocked.length,
      inProgress: pool.inProgress.length,
    },
    logFile,
    stopHint: stopHint(args),
  })
}

function runStop(args) {
  const before = snapshot(args)
  const result = spawnSync(process.execPath, [WATCH_MJS, ...args.passthrough, '--stop'], {
    encoding: 'utf8',
    windowsHide: true,
  })
  if (result.status !== 0) {
    emit({ reason: 'stop-failed', exitCode: result.status, stderr: (result.stderr || '').trim() }, 2)
  }
  const detail = JSON.parse((result.stdout || '{}').trim() || '{}')
  emit({
    reason: 'stop-requested',
    stopFile: detail.stopFile || '',
    watcherPid: before.alive ? before.record.pid : null,
    note: before.alive ? 'watcher 下个轮询周期退出，之后注册表释放' : '没有在跑的 watcher',
    statusHint: `node "${join(dirname(fileURLToPath(import.meta.url)), 'start-background.mjs')}" --status --workdir "${args.workdir}"`,
  })
}

async function runStart(args) {
  if (!existsSync(args.workdir)) emit({ reason: 'workdir-missing', workdir: args.workdir }, 2)
  const before = snapshot(args)
  if (before.alive) {
    emit(
      {
        reason: 'already-running',
        pid: before.record.pid,
        state: before.record.state || '',
        dashboardUrl: dashboardUrlFrom(before.logFile),
        logFile: before.logFile,
        stopHint: stopHint(args),
      },
      3,
    )
  }
  mkdirSync(args.cacheDir, { recursive: true })
  const fd = openSync(before.logFile, 'a')
  const child = spawn(process.execPath, [WATCH_MJS, ...args.passthrough], {
    cwd: args.workdir,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', fd, fd],
  })
  closeSync(fd)
  child.unref()
  await sleep(SETTLE_MS)

  const after = snapshot(args)
  if (!after.alive) {
    emit(
      {
        reason: 'exited-early',
        pid: child.pid,
        exitCode: child.exitCode,
        logFile: after.logFile,
        logTail: readLogTail(after.logFile),
      },
      1,
    )
  }
  emit({
    reason: 'started',
    pid: after.record.pid,
    state: after.record.state || '',
    dashboardUrl: dashboardUrlFrom(after.logFile),
    runDir: after.record.runDir || '',
    logFile: after.logFile,
    stopHint: stopHint(args),
  })
}

const args = parseArgs(process.argv.slice(2))
if (!args.workdir) emit({ reason: 'workdir-required', usageHint: 'node start-background.mjs --help' }, 2)
args.workdir = resolve(args.workdir)
args.cacheDir = resolve(args.cacheDir || DEFAULT_CACHE_ROOT)

if (args.action === 'status') runStatus(args)
else if (args.action === 'stop') runStop(args)
else await runStart(args)
