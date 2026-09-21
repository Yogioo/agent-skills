/**
 * 总览页启动器测试（start / status / stop 三种模式与退出码）。
 *
 *   node --test tests/afk-watch/overview-background.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const START = join(__dirname, '..', '..', 'skills', 'afk-watch', 'scripts', 'start-overview.mjs')

/**
 * 三种模式都只输出单行 JSON 就退出；退出码是契约的一部分。
 * 用临时 cache-dir，免得和真机上那份总览页抢注册表。
 */
function tryParse(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * 三种模式都只输出单行 JSON 就退出（`--help` 除外，它是给人看的文本）；
 * 退出码是契约的一部分。用临时 cache-dir，免得和真机上那份总览页抢注册表。
 */
function call(args, env) {
  try {
    const text = execFileSync(process.execPath, [START, ...args], {
      encoding: 'utf8',
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
    return { code: 0, text, payload: tryParse(text) }
  } catch (err) {
    const text = ((err.stdout || '') + (err.stderr || '')).trim()
    return { code: err.status, text, payload: tryParse(text) }
  }
}

async function withServers(fn) {
  const cacheDir = mkdtempSync(join(tmpdir(), 'afk-ovbg-cache-'))
  const home = mkdtempSync(join(tmpdir(), 'afk-ovbg-home-'))
  const env = { ...process.env, AFK_HOME: home }
  try {
    return await fn({ cacheDir, env })
  } finally {
    // 绝不在开发机上留下孤儿服务：不管测试怎么结束，都尝试停一次
    try {
      execFileSync(process.execPath, [START, '--stop', '--cache-dir', cacheDir], {
        encoding: 'utf8',
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch {
      /* 本来就没在跑 */
    }
    rmSync(cacheDir, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
}

/** 探一下端口是否还在响应。 */
async function reachable(url) {
  try {
    const response = await fetch(url)
    return response.ok
  } catch {
    return false
  }
}

test('没在跑时 --status 退出码 4', async () => {
  await withServers(async ({ cacheDir, env }) => {
    const result = call(['--status', '--cache-dir', cacheDir], env)
    assert.equal(result.code, 4)
    assert.equal(result.payload.running, false)
    assert.equal(result.payload.lastPid, null)
  })
})

test('默认起一份：单行 JSON 带 pid / port / url，页面能打开', async () => {
  await withServers(async ({ cacheDir, env }) => {
    const started = call(['--cache-dir', cacheDir], env)
    assert.equal(started.code, 0)
    assert.equal(started.payload.running, true)
    assert.ok(started.payload.pid > 0)
    assert.match(started.payload.url, /^http:\/\/127\.0\.0\.1:\d+\/$/)
    assert.equal(started.payload.port, Number(new URL(started.payload.url).port))
    assert.ok(existsSync(started.payload.registryPath), '要留下注册表供 --status 读')
    assert.equal(await reachable(started.payload.url), true)

    const page = await fetch(started.payload.url).then((r) => r.text())
    assert.match(page, /AFK 总览/)
    assert.match(page, /待人工处理/)
  })
})

test('--status 在跑时退出码 0，url 与启动时一致', async () => {
  await withServers(async ({ cacheDir, env }) => {
    const started = call(['--cache-dir', cacheDir], env)
    const status = call(['--status', '--cache-dir', cacheDir], env)

    assert.equal(status.code, 0)
    assert.equal(status.payload.running, true)
    assert.equal(status.payload.pid, started.payload.pid)
    assert.equal(status.payload.url, started.payload.url)
    assert.ok(status.payload.stopHint, '要给出怎么停')
  })
})

test('再起一份时复用，不另起（退出码 3）', async () => {
  await withServers(async ({ cacheDir, env }) => {
    const first = call(['--cache-dir', cacheDir], env)
    const second = call(['--cache-dir', cacheDir], env)

    assert.equal(second.code, 3)
    assert.equal(second.payload.reason, 'already-running')
    assert.equal(second.payload.reused, true)
    assert.equal(second.payload.pid, first.payload.pid)
    assert.equal(second.payload.url, first.payload.url)
  })
})

test('--stop 停掉并释放端口与注册表；再停退出码 4', async () => {
  await withServers(async ({ cacheDir, env }) => {
    const started = call(['--cache-dir', cacheDir], env)
    assert.equal(await reachable(started.payload.url), true)

    const stopped = call(['--stop', '--cache-dir', cacheDir], env)
    assert.equal(stopped.code, 0)
    assert.equal(stopped.payload.reason, 'stopped')
    assert.equal(stopped.payload.pid, started.payload.pid)

    // 进程要真的退出、端口要真的放开，不能只是删了注册表
    await new Promise((resolve) => setTimeout(resolve, 600))
    assert.equal(await reachable(started.payload.url), false)
    assert.equal(existsSync(started.payload.registryPath), false)

    const again = call(['--stop', '--cache-dir', cacheDir], env)
    assert.equal(again.code, 4)
    assert.equal(again.payload.reason, 'not-running')
  })
})

test('上一次运行留下的启动行不能冒充这一次的：日志是跨次追加的', async () => {
  await withServers(async ({ cacheDir, env }) => {
    // 模拟上一次运行死得不安详：日志里留了一条旧启动行，端口早就没人监听了
    writeFileSync(
      join(cacheDir, 'overview.log'),
      `${JSON.stringify({ event: 'overview_started', pid: 999999, port: 1, url: 'http://127.0.0.1:1/' })}\n`,
      'utf8',
    )

    const started = call(['--cache-dir', cacheDir], env)
    assert.equal(started.code, 0)
    assert.notEqual(started.payload.port, 1, '不能把旧端口配到新 pid 上')
    assert.notEqual(started.payload.url, 'http://127.0.0.1:1/')
    assert.equal(
      started.payload.port,
      Number(new URL(started.payload.url).port),
      'pid / port / url 必须来自同一次启动',
    )
    assert.equal(await reachable(started.payload.url), true)

    // --status 读的是注册表，也不能是旧端口
    const status = call(['--status', '--cache-dir', cacheDir], env)
    assert.equal(status.payload.port, started.payload.port)
  })
})

test('未知参数退出码 2,并指到 --help', async () => {
  await withServers(async ({ cacheDir, env }) => {
    const result = call(['--并不存在的参数', '--cache-dir', cacheDir], env)
    assert.equal(result.code, 2)
    assert.equal(result.payload.reason, 'unknown-arg')
    assert.match(result.payload.usageHint, /--help/)
  })
})

test('--help 退出码 0，列出三种模式', async () => {
  await withServers(async ({ env }) => {
    const result = call(['--help'], env)
    assert.equal(result.code, 0)
    assert.match(result.text, /--status/)
    assert.match(result.text, /--stop/)
    assert.equal(result.payload, null, '--help 是给人看的文本，不是 JSON')
  })
})
