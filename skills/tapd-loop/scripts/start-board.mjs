/**
 * 看板常驻入口：detached 拉起 serve.mjs，父进程退出后网页继续在。
 * 幂等：已经在跑就复用，端口写进 board.json，链接之后不会变。
 */

import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const HOME = join(homedir(), '.tapd-loop')
const STATE = join(HOME, 'board.json')
const LOG = join(HOME, 'board.log')
const DEFAULT_PORT = 7317
const PORT_TRIES = 8

const args = process.argv.slice(2)

if (args.includes('--stop')) {
  const state = readState()
  let stopped = false
  if (state?.pid) {
    try {
      process.kill(state.pid)
      stopped = true
    } catch {
      // 进程已经不在了，下面照样清 state
    }
  }
  rmSync(STATE, { force: true })
  console.log(JSON.stringify({ stopped, url: state?.url || '' }))
  process.exit(0)
}

if (args.includes('--status')) {
  const state = readState()
  const alive = state ? await healthy(state.url + 'api/state') : false
  console.log(JSON.stringify({ ...(state || {}), alive }, null, 2))
  process.exit(alive ? 0 : 4)
}

const wanted = Number(flag('--port') || DEFAULT_PORT)

const current = readState()
if (current && (await healthy(current.url + 'api/state'))) {
  console.log(JSON.stringify({ ...current, reused: true }))
  process.exit(0)
}

for (let i = 0; i < PORT_TRIES; i++) {
  const port = wanted + i
  const url = `http://127.0.0.1:${port}/`
  if (await healthy(url + 'api/state')) {
    const state = { host: '127.0.0.1', port, url, pid: 0, reused: true }
    writeState(state)
    console.log(JSON.stringify(state))
    process.exit(0)
  }
  const started = await spawnBoard(port, url)
  if (started) {
    console.log(JSON.stringify(started))
    process.exit(0)
  }
}

console.error(`看板启动失败，日志：${LOG}`)
process.exit(1)

async function spawnBoard(port, url) {
  mkdirSync(HOME, { recursive: true })
  const fd = openSync(LOG, 'a')
  const child = spawn(process.execPath, [join(HERE, 'serve.mjs'), '--port', String(port)], {
    cwd: HERE,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', fd, fd],
  })
  child.unref()
  closeSync(fd)

  for (let i = 0; i < 25; i++) {
    await sleep(150)
    if (await healthy(url + 'api/state')) {
      const state = { host: '127.0.0.1', port, url, pid: child.pid, startedAt: new Date().toISOString(), reused: false }
      writeState(state)
      return state
    }
  }
  return null
}

async function healthy(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(900) })
    if (!res.ok) return false
    const data = await res.json()
    return Array.isArray(data.runs)
  } catch {
    return false
  }
}

function readState() {
  if (!existsSync(STATE)) return null
  try {
    return JSON.parse(readFileSync(STATE, 'utf8'))
  } catch {
    return null
  }
}

function writeState(state) {
  mkdirSync(HOME, { recursive: true })
  writeFileSync(STATE, `${JSON.stringify(state)}\n`, 'utf8')
}

function flag(name) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : ''
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}
