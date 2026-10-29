/**
 * 看板常驻入口：detached 拉起 serve.mjs，父进程退出后网页继续在。
 * 幂等：已经在跑就复用，端口写进 board.json，链接之后不会变。
 *
 * 默认绑 0.0.0.0（局域网里别人能打开、能点按钮），因此 `/api/*` 会要密钥：
 * 打出来的 `url` 直接带着 `?k=`，贴给别人就能用。只想本机用就 `--local`。
 */

import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureKey } from './control.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const HOME = flag('--home') || join(homedir(), '.tapd-loop')
const STATE = join(HOME, 'board.json')
const LOG = join(HOME, 'board.log')
const DEFAULT_PORT = 7317
const PORT_TRIES = 8

async function main() {
  if (args.includes('--stop')) return await stop()
  if (args.includes('--status')) return status()

  const wanted = Number(flag('--port') || configBoard().port || DEFAULT_PORT)
  const host = resolveHost()
  const key = ensureKey(HOME)

  // 看板的「重启看板」按钮就是这么用的：它先回包、再拉起这条命令、自己退出。
  // 这里必须先等旧进程死、端口腾出来，否则下面的探活会拗到那一具还没死的旧进程，
  // 回一句 reused:true 然后什么都不起（页面看着重启了，实际还是旧进程）。
  const waitPid = Number(flag('--wait-pid') || 0)
  if (waitPid > 0) await waitForPid(waitPid, wanted)

  const current = readState()
  if (current && (await probe(current.port))) {
    const health = await probe(current.port)
    const state = stateFor({ port: current.port, health, key, reused: true })
    writeState(state)
    console.log(JSON.stringify(state))
    return
  }

  for (let i = 0; i < PORT_TRIES; i++) {
    const port = wanted + i
    const existing = await probe(port)
    if (existing) {
      const state = stateFor({ port, health: existing, key, reused: true })
      writeState(state)
      console.log(JSON.stringify(state))
      return
    }
    const started = await spawnBoard(port, host)
    if (started) {
      writeState(started)
      console.log(JSON.stringify(started))
      return
    }
  }

  console.error(`看板启动失败，日志：${LOG}`)
  process.exitCode = 1
}

async function stop() {
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
  // pid 对不上但端口上确实是自己的看板（比如 state 里的 pid 是旧进程）：用 healthz 的 pid 补一刀。
  if (!stopped && state?.port) {
    const health = await probe(state.port)
    if (health?.pid) {
      try {
        process.kill(health.pid)
        stopped = true
      } catch {
        // 已经没了
      }
    }
  }
  rmSync(STATE, { force: true })
  console.log(JSON.stringify({ stopped, url: state?.url || '' }))
}

async function status() {
  const state = readState()
  const health = state ? await probe(state.port) : null
  console.log(JSON.stringify({ ...(state || {}), alive: Boolean(health), health: health || null }, null, 2))
  process.exitCode = health ? 0 : 4
}

/**
 * 打出来的 `url` 是「能直接发给别人」的那条：出网时给局域网地址，并且带上密钥。
 * 扩展和 loop 只读这一个字段，所以它必须是完整的、点开就能用的链接。
 */
function stateFor({ port, health, key, reused }) {
  const local = health.local || `http://127.0.0.1:${port}/`
  const share = health.share || ''
  const authRequired = Boolean(health.authRequired)
  const previous = readState()
  return {
    host: health.host || '127.0.0.1',
    port,
    local,
    share,
    url: `${share || local}${authRequired ? `?k=${encodeURIComponent(key)}` : ''}`,
    key: authRequired ? key : '',
    authRequired,
    pid: health.pid || 0,
    startedAt: reused ? previous?.startedAt || new Date().toISOString() : new Date().toISOString(),
    reused,
  }
}

async function spawnBoard(port, host) {
  mkdirSync(HOME, { recursive: true })
  const fd = openSync(LOG, 'a')
  const child = spawn(process.execPath, [
    join(HERE, 'serve.mjs'), '--host', host, '--port', String(port), '--home', HOME, ...forwardArgs(),
  ], {
    cwd: HERE,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', fd, fd],
  })
  child.unref()
  closeSync(fd)

  for (let i = 0; i < 30; i++) {
    await sleep(150)
    const health = await probe(port)
    if (health) return stateFor({ port, health: { ...health, pid: health.pid || child.pid }, key: ensureKey(HOME), reused: false })
  }
  return null
}

/**
 * 等一个进程死掉、并（给了 port 时）它占的端口真的空了。
 *
 * 两个条件都要：pid 没了但端口还没被内核放掉时，listen 依旧会 EADDRINUSE，
 * 而 start-board 的端口轮询会默默把看板挤到 7318——分享出去的那条链接就活不过一次重启。
 */
async function waitForPid(pid, port) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (!pidAlive(pid) && (!port || !(await probe(port)))) return
    await sleepAsync(200)
  }
}

function pidAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM = 进程在、但不归我管（比如换了用户起的）—— 当它活着，别去抢端口
    return err?.code === 'EPERM'
  }
}

/** `serve.mjs` 自己的非默认开关：重启时要原样带回去，否则看板会静默丢掉这些设置。 */
function forwardArgs() {
  const extra = []
  const root = flag('--root')
  const loopScript = flag('--loop-script')
  if (root) extra.push('--root', root)
  if (loopScript) extra.push('--loop-script', loopScript)
  if (args.includes('--no-auth')) extra.push('--no-auth')
  return extra
}

/**
 * 探活只认自己的看板：端口可能被别人占了，`/healthz` 上报 `app` 标记必须对上。
 * 绑通配和绑 loopback 的看板在 127.0.0.1 上都答，所以一个目标就够。
 */
async function probe(port) {
  if (!port) return null
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(900) })
    if (!res.ok) return null
    const data = await res.json()
    return data?.app === 'tapd-loop' ? data : null
  } catch {
    return null
  }
}

/** `--local` / `--lan` 是 `--host` 的糖；配置里也能写 board.host。 */
function resolveHost() {
  if (args.includes('--local')) return '127.0.0.1'
  if (args.includes('--lan')) return '0.0.0.0'
  return flag('--host') || process.env.TAPD_LOOP_BOARD_HOST || configBoard().host || '0.0.0.0'
}

function configBoard() {
  try {
    const parsed = JSON.parse(readFileSync(join(HOME, 'config.json'), 'utf8'))
    return parsed?.board && typeof parsed.board === 'object' ? parsed.board : {}
  } catch {
    return {}
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

function sleepAsync(ms) {
  return new Promise((done) => setTimeout(done, ms))
}

await main()
