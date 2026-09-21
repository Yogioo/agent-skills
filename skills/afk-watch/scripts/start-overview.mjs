#!/usr/bin/env node
/**
 * 总览页启动器：detached 起 `overview.mjs`，不占人的终端。
 *
 * 总览页要比任何 watcher 活得久（ADR-0009），所以它有自己的生命周期，
 * 不能像 `loop-serve` 那样由 watcher / run 顺手拉起。
 *
 * 三种模式都只输出单行 JSON 就退出：
 *   node start-overview.mjs             后台起一份（已经在跑就复用，不另起）
 *   node start-overview.mjs --status    在不在跑、地址是什么
 *   node start-overview.mjs --stop      停掉
 * 退出码：0 成功 / 1 启动后立刻退出（输出带 logTail）/ 2 参数问题 / 3 已在跑（复用输出里的 pid）/ 4 没在跑。
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { isPidAlive, killOwnedProcess } from './watch-state.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OVERVIEW_MJS = join(__dirname, 'overview.mjs')
const START_MJS = join(__dirname, 'start-overview.mjs')
const DEFAULT_CACHE_ROOT = join(tmpdir(), 'afk-watch')
const REGISTRY_NAME = 'overview.json'
const LOG_NAME = 'overview.log'
const SETTLE_MS = 1200
const WAIT_MS = 10000
const LOG_TAIL_LINES = 12

const USAGE = `用法：
  node start-overview.mjs [--port <端口>] [--cache-dir <目录>]   后台起总览页
  node start-overview.mjs --status [--cache-dir <目录>]          是否在跑、地址是什么
  node start-overview.mjs --stop   [--cache-dir <目录>]          停掉

退出码：0 成功 / 1 启动后立刻退出 / 2 参数问题 / 3 已在跑 / 4 没在跑`

function emit(payload, code = 0) {
  process.stdout.write(`${JSON.stringify(payload)}\n`)
  process.exit(code)
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function parseArgs(argv) {
  const out = { action: 'start', cacheDir: '', port: 0 }
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
    if (arg === '--cache-dir') {
      out.cacheDir = argv[++i] || ''
      continue
    }
    if (arg === '--port') {
      out.port = Number(argv[++i] || 0)
      continue
    }
    emit({ reason: 'unknown-arg', arg, usageHint: `node "${START_MJS}" --help` }, 2)
  }
  return out
}

function registryPath(cacheDir) {
  return join(cacheDir, REGISTRY_NAME)
}

function logPath(cacheDir) {
  return join(cacheDir, LOG_NAME)
}

function readRegistry(cacheDir) {
  const file = registryPath(cacheDir)
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function readLogTail(cacheDir, lines = LOG_TAIL_LINES) {
  const file = logPath(cacheDir)
  if (!existsSync(file)) return ''
  return readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).slice(-lines).join('\n')
}

/** 从日志里捞启动行：总览页自己打印了真实端口（可能因为被占而顺延）。 */
function startedInfoFromLog(cacheDir) {
  const text = readLogTail(cacheDir, 400)
  const line = text.split('\n').reverse().find((row) => row.includes('overview_started'))
  if (!line) return null
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

function snapshot(cacheDir) {
  const record = readRegistry(cacheDir)
  return { record, alive: Boolean(record?.pid) && isPidAlive(record.pid) }
}

function statusPayload(args, snapshotValue) {
  const { record, alive } = snapshotValue
  const base = {
    cacheDir: args.cacheDir,
    logFile: logPath(args.cacheDir),
    registryPath: registryPath(args.cacheDir),
    statusHint: `node "${START_MJS}" --status --cache-dir "${args.cacheDir}"`,
  }
  if (!alive) {
    return {
      ...base,
      running: false,
      lastPid: record?.pid || null,
      logTail: readLogTail(args.cacheDir, 6),
    }
  }
  return {
    ...base,
    running: true,
    pid: record.pid,
    port: record.port || 0,
    url: record.url || '',
    startedAt: record.startedAt || 0,
    stopHint: `node "${START_MJS}" --stop --cache-dir "${args.cacheDir}"`,
  }
}

function runStatus(args) {
  const snap = snapshot(args.cacheDir)
  const payload = statusPayload(args, snap)
  emit(payload, snap.alive ? 0 : 4)
}

function runStop(args) {
  const snap = snapshot(args.cacheDir)
  if (!snap.alive) {
    emit({ ...statusPayload(args, snap), reason: 'not-running' }, 4)
  }
  killOwnedProcess(snap.record.pid, { tree: true })
  try {
    unlinkSync(registryPath(args.cacheDir))
  } catch {
    /* 已经不在了 */
  }
  emit({ reason: 'stopped', pid: snap.record.pid, url: snap.record.url || '' })
}

async function runStart(args) {
  const existing = snapshot(args.cacheDir)
  if (existing.alive) {
    emit({ ...statusPayload(args, existing), reason: 'already-running', reused: true }, 3)
  }

  mkdirSync(args.cacheDir, { recursive: true })
  const logFile = logPath(args.cacheDir)
  const fd = openSync(logFile, 'a')
  const childArgs = [OVERVIEW_MJS]
  if (args.port) childArgs.push('--port', String(args.port))
  const child = spawn(process.execPath, childArgs, {
    detached: true,
    stdio: ['ignore', fd, fd],
    windowsHide: true,
  })
  closeSync(fd)
  child.unref()

  // 等它打印启动行：那里的端口才是真的（默认 0 会让内核分配，占用了会顺延）
  const deadline = Date.now() + WAIT_MS
  let info = null
  while (Date.now() < deadline) {
    if (!isPidAlive(child.pid)) break
    info = startedInfoFromLog(args.cacheDir)
    if (info) break
    await sleep(200)
  }

  if (!info) {
    emit(
      {
        reason: isPidAlive(child.pid) ? 'no-startup-line' : 'exited-early',
        pid: child.pid,
        logFile,
        logTail: readLogTail(args.cacheDir, 6),
      },
      1,
    )
  }

  writeFileSync(
    registryPath(args.cacheDir),
    `${JSON.stringify({
      pid: child.pid,
      port: info.port,
      url: info.url,
      startedAt: Date.now(),
      updatedAt: Date.now(),
    })}\n`,
    'utf8',
  )
  await sleep(SETTLE_MS)
  if (!isPidAlive(child.pid)) {
    emit({ reason: 'died-after-start', pid: child.pid, logFile, logTail: readLogTail(args.cacheDir, 6) }, 1)
  }

  emit({
    running: true,
    pid: child.pid,
    port: info.port,
    url: info.url,
    logFile,
    registryPath: registryPath(args.cacheDir),
    stopHint: `node "${START_MJS}" --stop --cache-dir "${args.cacheDir}"`,
  })
}

const args = parseArgs(process.argv.slice(2))
args.cacheDir = resolve(args.cacheDir || DEFAULT_CACHE_ROOT)

if (args.action === 'status') runStatus(args)
else if (args.action === 'stop') runStop(args)
else await runStart(args)
