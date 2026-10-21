/**
 * 两个只读看板的 HTTP 契约。这一层先钉住，重构期间不许漂。
 *
 *   node --test tests/web-ui/http-pages.test.mjs
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const tapdServe = fileURLToPath(new URL('../../skills/tapd-loop/scripts/serve.mjs', import.meta.url))

test('agent runs board serves its page and read-only APIs', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'web-ui-board-'))
  const saved = process.env.AFK_HOME
  process.env.AFK_HOME = home
  t.after(() => {
    if (saved === undefined) delete process.env.AFK_HOME
    else process.env.AFK_HOME = saved
    rmSync(home, { recursive: true, force: true })
  })

  const { startBoardServer } = await import('../../lib/run-runtime/board.mjs')
  const board = await startBoardServer({ host: '127.0.0.1', port: 0 })
  t.after(() => board.close())

  const page = await fetch(`${board.local}`)
  assert.equal(page.status, 200)
  assert.match(page.headers.get('content-type'), /text\/html/)
  const html = await page.text()
  assert.match(html, /<title>agent runs<\/title>/)
  assert.match(html, /<script type="module" src="\/app\.js">/)
  assert.match(html, /href="\/assets\/theme\.css"/)
  assertNoCrossOrigin(html)

  const app = await fetch(`${board.local}app.js`)
  assert.equal(app.status, 200)
  assert.match(app.headers.get('content-type'), /text\/javascript/)
  assert.match(await app.text(), /api\/runs/)
  const css = await fetch(`${board.local}assets/theme.css`)
  assert.equal(css.status, 200)
  assert.match(css.headers.get('content-type'), /text\/css/)
  const client = await fetch(`${board.local}assets/client.mjs`)
  assert.equal(client.status, 200)
  assert.match(client.headers.get('content-type'), /text\/javascript/)

  const runs = await (await fetch(`${board.local}api/runs`)).json()
  assert.ok(Array.isArray(runs.runs), 'runs.runs is an array')
  assert.ok(runs.window && typeof runs.window.days === 'number', 'window is reported')

  const missing = await fetch(`${board.local}api/runs/does-not-exist`)
  assert.equal(missing.status, 404)
  assert.equal((await missing.json()).error !== undefined, true)
})

test('tapd-loop board serves its page and read-only APIs', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'web-ui-tapd-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const port = await freePort()
  const child = spawn(process.execPath, [tapdServe, '--root', root, '--port', String(port)], {
    cwd: repoRoot,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const logs = []
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => logs.push(chunk))
  t.after(() => child.kill())

  const url = await waitForUrl(logs, `http://127.0.0.1:${port}/`)
  const page = await fetch(url)
  assert.equal(page.status, 200)
  assert.match(page.headers.get('content-type'), /text\/html/)
  const html = await page.text()
  assert.match(html, /<title>tapd-loop<\/title>/)
  assert.match(html, /<script type="module" src="\/app\.js">/)
  assertNoCrossOrigin(html)

  const app = await fetch(`${url}app.js`)
  assert.equal(app.status, 200)
  assert.match(app.headers.get('content-type'), /text\/javascript/)
  assert.match(await app.text(), /api\/state/)

  const state = await (await fetch(`${url}api/state`)).json()
  assert.ok(Array.isArray(state.runs))

  const missing = await fetch(`${url}api/card?run=nope&id=nope`)
  assert.equal(missing.status, 404)
})

test('shared assets reject anything outside the whitelist', async () => {
  const home = mkdtempSync(join(tmpdir(), 'web-ui-assets-'))
  const saved = process.env.AFK_HOME
  process.env.AFK_HOME = home
  const { startBoardServer } = await import('../../lib/run-runtime/board.mjs')
  const board = await startBoardServer({ host: '127.0.0.1', port: 0 })
  try {
    const unknown = await fetch(`${board.local}assets/nope.mjs`)
    assert.equal(unknown.status, 404)
  } finally {
    await board.close()
    if (saved === undefined) delete process.env.AFK_HOME
    else process.env.AFK_HOME = saved
    rmSync(home, { recursive: true, force: true })
  }
})

function assertNoCrossOrigin(html) {
  const refs = [...html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1])
  const external = refs.filter((ref) => /^(?:https?:)?\/\//i.test(ref))
  assert.deepEqual(external, [], 'pages must not load anything off-origin')
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

async function waitForUrl(logs, fallback) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    for (const line of logs.join('').split('\n')) {
      if (!line.trim()) continue
      try {
        const value = JSON.parse(line)
        if (value.url) return value.url
      } catch {
        // 还没凑成完整的一行
      }
    }
    if (await healthy(fallback)) return fallback
    await new Promise((done) => setTimeout(done, 100))
  }
  throw new Error(`tapd-loop board did not start: ${logs.join('')}`)
}

async function healthy(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(500) })
    return res.ok
  } catch {
    return false
  }
}
