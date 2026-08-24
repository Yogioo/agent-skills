/**
 * exec-review 技能回归测试（防回归网）。
 *
 * 位置：仓库 tests/ 下（不在技能内部），随 repo 版本管理。
 * 覆盖三类真实回归：
 *   1. serve.mjs 的 HTML 模板里 `\n` 被求值成真实换行 → 渲染后 <script> 语法错误 → 页面全停
 *   2. render() 引用不存在的元素 id（$('roundCount')）→ null.textContent 抛错 → 时间线/日志渲染中断
 *   3. serve 把 context_start 文件注册耦合在 sentCount 增量里 / 新连接不回放上下文 → 上下文不显示
 *
 * 运行：
 *   cd C:\projects\agent-skills
 *   node --test tests/exec-review/
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import http from 'node:http'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SKILL = join(__dirname, '..', '..', 'skills', 'exec-review')
const SERVE = join(SKILL, 'scripts', 'serve.mjs')

// ---------- 1 & 2：静态渲染校验 ----------

/** 渲染 serve.mjs 的 HTML 模板，抽出 { html, script }。 */
function rendered() {
  const src = readFileSync(SERVE, 'utf8')
  const m = src.match(/const HMTL = `([\s\S]*?)`\s*\.replace/)
  assert.ok(m, 'serve.mjs 应包含 HMTL 模板字面量')
  const html = m[1].replace(/^\s+/gm, '')
  const sm = html.match(/<script>([\s\S]*?)<\/script>/)
  assert.ok(sm, 'HTML 应包含 <script> 块')
  return { html, script: sm[1] }
}

test('渲染后的 <script> 是合法 JS（防 \\n 模板转义回归）', () => {
  const { script } = rendered()
  // new Function 构造时即编译，语法错误会抛 SyntaxError
  assert.doesNotThrow(() => new Function(script), '渲染后脚本必须能解析')
})

test('JS 引用的每个元素 id 都在 HTML 中存在（防空引用回归）', () => {
  const { html, script } = rendered()
  const used = [...new Set([...script.matchAll(/\$\(['"]([a-zA-Z]+)['"]\)/g)].map((m) => m[1]))]
  const defined = new Set([...html.matchAll(/id="([a-zA-Z]+)"/g)].map((m) => m[1]))
  const missing = used.filter((id) => !defined.has(id))
  assert.deepStrictEqual(missing, [], '不应有缺失的元素 id')
})

test('上下文注册与 sentCount 解耦、新连接回放（防 serve 集成回归）', () => {
  const src = readFileSync(SERVE, 'utf8')
  // 注册必须扫描全量事件，而非仅 sentCount 之后的新事件
  assert.match(src, /registerContextFiles\(evs\)/, 'broadcast 应全量扫描注册上下文文件')
  assert.match(src, /registeredFiles/, '注册应有去重守卫')
  // 新连接必须回放 contextBuffer
  assert.match(src, /if \(contextBuffer\.length\) res\.write/, 'connect 处理器应回放 contextBuffer')
})

// ---------- 3：serve 端到端冒烟（真实回归网） ----------

function connectable(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/' }, (res) => {
      res.resume()
      resolve(true)
    })
    req.on('error', () => resolve(false))
    req.setTimeout(300, () => {
      req.destroy()
      resolve(false)
    })
  })
}

function waitFor(fn, timeout = 6000) {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    ;(function tick() {
      fn().then((ok) => {
        if (ok) resolve()
        else if (Date.now() - start > timeout) reject(new Error('等待超时'))
        else setTimeout(tick, 100)
      })
    })()
  })
}

/** 连接 /events，收集 ms 毫秒内的所有 data 事件。 */
function getEvents(port, ms) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/events' }, (res) => {
      let data = ''
      res.on('data', (c) => (data += c))
      setTimeout(() => {
        res.destroy()
        resolve(parseEvents(data))
      }, ms)
    })
    req.on('error', () => resolve([]))
  })
}

function parseEvents(data) {
  const out = []
  for (const line of data.split('\n')) {
    if (!line.startsWith('data: ')) continue
    try {
      out.push(JSON.parse(line.slice(6)))
    } catch {
      /* 忽略坏行 */
    }
  }
  return out
}

test('serve：推送里程碑 + 上下文，且新连接回放上下文', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'er-reg-'))
  const now = Date.now()
  const evs = [
    { t: now - 5000, level: 1, event: 'run_start', title: 't', maxRounds: 2 },
    { t: now - 4000, level: 1, event: 'round_start', round: 1, baseSha: 'abcd' },
    { t: now - 3000, level: 2, event: 'executor_start', round: 1 },
    { t: now - 2000, level: 2, event: 'context_start', role: 'executor', file: join(dir, 'executor.log') },
  ]
  writeFileSync(join(dir, 'progress.jsonl'), evs.map((e) => JSON.stringify(e)).join('\n') + '\n')
  writeFileSync(join(dir, 'executor.log'), 'line one\nline two\nline three\n')

  const port = 19000 + Math.floor(Math.random() * 1000)
  const child = spawn(process.execPath, [SERVE, dir, String(port)], {
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  try {
    await waitFor(() => connectable(port))

    // 第一个连接：里程碑 + 上下文都要有（收集时间须跨过 broadcast 间隔 1500ms）
    const first = await getEvents(port, 2600)
    assert.ok(first.some((e) => e.event === 'run_start'), '首个连接应收到里程碑')
    assert.ok(first.some((e) => e.type === 'context' && e.line === 'line one'), '首个连接应收到上下文')

    // 第二个连接：必须回放上下文 backlog（防"新连接收到 0"回归）
    const second = await getEvents(port, 1800)
    assert.ok(
      second.some((e) => e.type === 'context' && e.line === 'line one'),
      '第二个连接应回放上下文',
    )
  } finally {
    child.kill()
    rmSync(dir, { recursive: true, force: true })
  }
})
