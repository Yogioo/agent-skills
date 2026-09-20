/**
 * afk-watch 注册表与事件。与 afk-run 的 loop/serve 注册表分开存放。
 */

import { execFileSync } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

function hashStr(value) {
  let hash = 0
  const text = String(value)
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) >>> 0
  return hash
}

export function watcherRegistryPath(cacheRoot, workdir) {
  return join(cacheRoot, `watch-${hashStr(workdir)}.json`)
}

export function readWatcherRegistry(cacheRoot, workdir) {
  const registryPath = watcherRegistryPath(cacheRoot, workdir)
  if (!existsSync(registryPath)) return null
  try {
    return JSON.parse(readFileSync(registryPath, 'utf8'))
  } catch {
    return null
  }
}

export function isPidAlive(pid) {
  const value = Number(pid)
  if (!Number.isInteger(value) || value <= 0) return false
  try {
    process.kill(value, 0)
    return true
  } catch {
    return false
  }
}

export function killOwnedProcess(pid, { tree = false } = {}) {
  const value = Number(pid)
  if (!Number.isInteger(value) || value <= 0 || value === process.pid) return
  try {
    if (process.platform === 'win32') {
      const args = ['/PID', String(value), '/F']
      if (tree) args.push('/T')
      execFileSync('taskkill', args, { stdio: 'ignore', windowsHide: true })
      return
    }
    if (tree) {
      try {
        execFileSync('pkill', ['-P', String(value)], { stdio: 'ignore' })
      } catch {
        // 无子进程或 pkill 不可用。
      }
    }
    process.kill(value, 'SIGTERM')
  } catch {
    // 进程可能已退出。
  }
}

/** 只停止注册表里记录的子进程和看板，不碰其它 pid。 */
export function stopOwnedProcesses(record, kill = killOwnedProcess) {
  const stopped = []
  if (!record) return stopped
  if (record.childPid && Number(record.childPid) !== process.pid) {
    kill(record.childPid, { tree: true })
    stopped.push({ pid: Number(record.childPid), role: 'child', tree: true })
  }
  if (
    record.dashboardPid &&
    Number(record.dashboardPid) !== process.pid &&
    Number(record.dashboardPid) !== Number(record.childPid)
  ) {
    kill(record.dashboardPid, { tree: false })
    stopped.push({ pid: Number(record.dashboardPid), role: 'dashboard', tree: false })
  }
  return stopped
}

function writeRegistry(cacheRoot, workdir, record) {
  writeFileSync(watcherRegistryPath(cacheRoot, workdir), JSON.stringify(record) + '\n', 'utf8')
}

/**
 * 占用 workdir 的 watcher 槽位。活着的其它 watcher 不会被抢占。
 * 上一实例已退出时，清掉它登记的子进程和看板。
 */
export function claimWatcherInstance(cacheRoot, workdir, fields = {}, deps = {}) {
  const alive = deps.isAlive || isPidAlive
  const kill = deps.kill || killOwnedProcess
  mkdirSync(cacheRoot, { recursive: true })
  const current = readWatcherRegistry(cacheRoot, workdir)
  if (current?.pid && current.pid !== process.pid && alive(current.pid)) {
    return { ok: false, reason: 'watcher-busy', pid: current.pid }
  }
  if (current && (!current.pid || !alive(current.pid))) {
    stopOwnedProcesses(current, kill)
  }
  const record = {
    pid: process.pid,
    workdir,
    childPid: null,
    dashboardPid: null,
    runDir: fields.runDir || '',
    execRunDir: '',
    state: 'polling',
    claimMode: fields.claimMode || '',
    startedAt: Date.now(),
    updatedAt: Date.now(),
  }
  writeRegistry(cacheRoot, workdir, record)
  return { ok: true, record }
}

export function updateWatcherRegistry(cacheRoot, workdir, patch, pid = process.pid) {
  const current = readWatcherRegistry(cacheRoot, workdir)
  if (!current || current.pid !== pid) return null
  const next = { ...current, ...patch, pid, updatedAt: Date.now() }
  writeRegistry(cacheRoot, workdir, next)
  return next
}

export function releaseWatcherInstance(cacheRoot, workdir, pid = process.pid) {
  const registryPath = watcherRegistryPath(cacheRoot, workdir)
  const current = readWatcherRegistry(cacheRoot, workdir)
  if (!current || current.pid !== pid) return false
  try {
    unlinkSync(registryPath)
    return true
  } catch {
    return false
  }
}

function localTimestamp(date) {
  const pad = (value) => String(value).padStart(2, '0')
  return (
    date.getFullYear() +
    pad(date.getMonth() + 1) +
    pad(date.getDate()) +
    '-' +
    pad(date.getHours()) +
    pad(date.getMinutes()) +
    pad(date.getSeconds())
  )
}

export function createWatchRunDir(cacheRoot, now = new Date()) {
  mkdirSync(cacheRoot, { recursive: true })
  const prefix = `watch-run-${localTimestamp(now)}`
  let name = prefix
  let i = 0
  while (existsSync(join(cacheRoot, name))) {
    i += 1
    name = `${prefix}-${i}`
  }
  const runDir = join(cacheRoot, name)
  mkdirSync(runDir, { recursive: true })
  return runDir
}

export function appendWatchEvent(runDir, event) {
  mkdirSync(runDir, { recursive: true })
  appendFileSync(
    join(runDir, 'events.jsonl'),
    JSON.stringify({ t: Date.now(), ...event }) + '\n',
    'utf8',
  )
}

/** 上次成功轮询的 Work-item pool；页面只读此文件，不查任务源。 */
export function writeWatchPool(sessionDir, pool = {}) {
  mkdirSync(sessionDir, { recursive: true })
  const payload = {
    updatedAt: Date.now(),
    ready: Array.isArray(pool.ready) ? pool.ready : [],
    blocked: Array.isArray(pool.blocked) ? pool.blocked : [],
    inProgress: Array.isArray(pool.inProgress) ? pool.inProgress : [],
  }
  writeFileSync(join(sessionDir, 'pool.json'), JSON.stringify(payload) + '\n', 'utf8')
  return payload
}

export function readWatchPool(sessionDir) {
  const file = join(sessionDir, 'pool.json')
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}
