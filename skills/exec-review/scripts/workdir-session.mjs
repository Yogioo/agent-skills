/**
 * 同一 workdir 串行 exec-review：启动前回收上一轮残留的 run-task / serve 进程树。
 */
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'

export function hashWorkdir(workdir) {
  let h = 0
  const s = resolve(workdir)
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0
  }
  return h
}

export function lockPath(cacheRoot, workdir) {
  return join(resolve(cacheRoot), 'locks', `${hashWorkdir(workdir)}.json`)
}

function readLock(file) {
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function writeLock(file, data) {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
}

function removeLock(file) {
  if (!existsSync(file)) return
  try {
    unlinkSync(file)
  } catch {
    // ignore
  }
}

export function isProcessAlive(pid) {
  const n = Number(pid)
  if (!Number.isInteger(n) || n <= 0) return false
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist', ['/FI', `PID eq ${n}`, '/NH'], {
        encoding: 'utf8',
        windowsHide: true,
      })
      return out.includes(String(n))
    }
    process.kill(n, 0)
    return true
  } catch {
    return false
  }
}

/** Kill one PID and its children (Windows: taskkill /T). */
export function killPidTree(pid) {
  const n = Number(pid)
  if (!Number.isInteger(n) || n <= 0 || n === process.pid) return false
  if (!isProcessAlive(n)) return false
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/pid', String(n), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      })
    } else {
      try {
        process.kill(-n, 'SIGTERM')
      } catch {
        process.kill(n, 'SIGTERM')
      }
    }
    return true
  } catch {
    return false
  }
}

/** PIDs listening on tcp port (best-effort). */
export function findListeningPids(port) {
  const p = Number(port)
  if (!Number.isInteger(p) || p <= 0) return []
  const pids = new Set()
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('netstat', ['-ano'], {
        encoding: 'utf8',
        windowsHide: true,
      })
      const needle = `:${p}`
      for (const line of out.split(/\r?\n/)) {
        if (!line.includes(needle) || !/LISTENING/i.test(line)) continue
        const parts = line.trim().split(/\s+/)
        const pid = Number(parts[parts.length - 1])
        if (pid > 0) pids.add(pid)
      }
    } else {
      const out = execFileSync('lsof', ['-ti', `tcp:${p}`, '-sTCP:LISTEN'], {
        encoding: 'utf8',
      })
      for (const line of out.split(/\r?\n/)) {
        const pid = Number(line.trim())
        if (pid > 0) pids.add(pid)
      }
    }
  } catch {
    // no listener / tool missing
  }
  return [...pids]
}

function killPortListeners(port, except = new Set()) {
  let killed = 0
  for (const pid of findListeningPids(port)) {
    if (except.has(pid) || pid === process.pid) continue
    if (killPidTree(pid)) killed += 1
  }
  return killed
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * 回收同一 workdir 的上一轮 exec-review 会话（run-task + detached serve + 占端口进程）。
 * @returns {{ killedMain: boolean, killedServe: boolean, killedPort: number, previous: object|null }}
 */
export function cleanupPreviousSession({ cacheRoot, workdir, port, currentPid = process.pid }) {
  const file = lockPath(cacheRoot, workdir)
  const previous = readLock(file)
  let killedMain = false
  let killedServe = false

  if (previous?.mainPid && previous.mainPid !== currentPid) {
    killedMain = killPidTree(previous.mainPid)
  }
  if (previous?.servePid && previous.servePid !== currentPid) {
    killedServe = killPidTree(previous.servePid)
  }

  const except = new Set([currentPid])
  if (previous?.mainPid) except.add(previous.mainPid)
  if (previous?.servePid) except.add(previous.servePid)
  const killedPort = killPortListeners(port, except)

  if (killedMain || killedServe || killedPort > 0) {
    sleepMs(350)
    killPortListeners(port, new Set([currentPid]))
  }

  return { killedMain, killedServe, killedPort, previous, lockFile: file }
}

export function writeSessionLock({
  cacheRoot,
  workdir,
  mainPid,
  servePid = null,
  port,
  runDir,
  taskId = '',
}) {
  const file = lockPath(cacheRoot, workdir)
  writeLock(file, {
    workdir: resolve(workdir),
    mainPid,
    servePid,
    port,
    runDir,
    taskId,
    updatedAt: new Date().toISOString(),
  })
  return file
}

export function updateSessionServePid({ cacheRoot, workdir, servePid }) {
  const file = lockPath(cacheRoot, workdir)
  const lock = readLock(file)
  if (!lock) return
  lock.servePid = servePid
  lock.updatedAt = new Date().toISOString()
  writeLock(file, lock)
}

export function releaseSessionMain({ cacheRoot, workdir, mainPid = process.pid }) {
  const file = lockPath(cacheRoot, workdir)
  const lock = readLock(file)
  if (!lock || lock.mainPid !== mainPid) return
  lock.mainPid = null
  lock.runFinishedAt = new Date().toISOString()
  writeLock(file, lock)
}

/** @deprecated 仅测试用；正常运行应 releaseSessionMain 保留 servePid 供下轮回收 */
export function clearSessionLock({ cacheRoot, workdir, mainPid = process.pid }) {
  const file = lockPath(cacheRoot, workdir)
  const lock = readLock(file)
  if (lock?.mainPid === mainPid) removeLock(file)
}
