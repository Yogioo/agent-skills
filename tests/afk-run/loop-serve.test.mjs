/** loop 级实时看板：状态投影与静态模板回归。 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SERVE = join(__dirname, '..', '..', 'skills', 'afk-run', 'scripts', 'loop-serve.mjs')

function waitFor(check, timeout = 5000) {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    ;(function tick() {
      check().then((value) => {
        if (value) resolve(value)
        else if (Date.now() - started >= timeout) reject(new Error('等待 loop-serve 超时'))
        else setTimeout(tick, 80)
      })
    })()
  })
}

function readSseState(port) {
  return new Promise((resolve) => {
    const request = http.get({ host: '127.0.0.1', port, path: '/events' }, (response) => {
      let data = ''
      response.on('data', (chunk) => {
        data += chunk
        for (const line of data.split('\n')) {
          if (!line.startsWith('data: ')) continue
          try {
            const payload = JSON.parse(line.slice(6))
            if (payload.type === 'state') {
              response.destroy()
              resolve(payload.state)
              return
            }
          } catch {
            // 继续等待完整 SSE 事件。
          }
        }
      })
    })
    request.on('error', () => resolve(null))
    request.setTimeout(300, () => { request.destroy(); resolve(null) })
  })
}

test('loop-serve 页面提供看板所需区块，且不提供写停止文件入口', () => {
  const src = readFileSync(SERVE, 'utf8')
  const template = src.match(/const HTML = `([\s\S]*?)`\s*\.replace/)
  assert.ok(template, 'loop-serve.mjs 应包含 HTML 模板')
  const html = template[1]
  const script = html.match(/<script>([\s\S]*?)<\/script>/)
  assert.ok(script, 'HTML 应包含脚本')
  assert.doesNotThrow(() => new Function(script[1]), '页面脚本必须可解析')

  const used = [...new Set([...script[1].matchAll(/\$\(['"]([a-zA-Z]+)['"]\)/g)].map((m) => m[1]))]
  const defined = new Set([...html.matchAll(/id="([a-zA-Z]+)"/g)].map((m) => m[1]))
  assert.deepEqual(used.filter((id) => !defined.has(id)), [], '脚本引用的 id 都必须存在')
  for (const id of ['ready', 'active', 'finished', 'failed', 'stage', 'heartbeat', 'stopfile', 'rundir', 'report']) {
    assert.ok(defined.has(id), `页面应有 #${id}`)
  }
  assert.doesNotMatch(html, /<button/i, '看板必须只读')
})

test('loop-serve 将 loop 事件和当前任务进度投影为队列与阶段状态', async () => {
  const { projectLoopState } = await import('../../skills/afk-run/scripts/loop-serve.mjs')
  const state = projectLoopState(
    [
      { t: 1, event: 'loop_start', source: 'beads', stopFile: 'C:/repo/afk-stop', runDir: 'C:/run' },
      { t: 2, event: 'queue_update', tasks: [{ id: 'a', title: 'Ready', priority: 1 }, { id: 'b', title: 'Working', priority: 2 }] },
      { t: 3, event: 'task_start', id: 'b', title: 'Working', priority: 2, attempt: 1, progressFile: 'C:/run/task-b-1.progress.jsonl' },
    ],
    [
      { t: 4, event: 'executor_start' },
      { t: 5, event: 'heartbeat', stage: 'executing', sinceMs: 1000 },
    ],
  )

  assert.deepEqual(state.ready.map((task) => task.id), ['a'])
  assert.equal(state.current.id, 'b')
  assert.equal(state.current.stage, 'executing')
  assert.equal(state.current.heartbeats, 1)
  assert.equal(state.stopFile, 'C:/repo/afk-stop')
  assert.equal(state.lastEventAt, 3)

  const ended = projectLoopState([
    ...state.events,
    { t: 6, event: 'task_end', id: 'b', kind: 'failed', status: 'blocked', reason: 'missing credential', attempts: 1 },
    { t: 7, event: 'loop_end', reason: 'all-done', reportFile: 'C:/run/report.md' },
  ])
  assert.equal(ended.failed[0].reason, 'missing credential')
  assert.equal(ended.reportFile, 'C:/run/report.md')
  assert.equal(ended.reason, 'all-done')
  assert.equal(ended.lastEventAt, 7)
})

test('loop-serve 队列更新会移除不再就绪的任务，同时保留历史结果', async () => {
  const { projectLoopState } = await import('../../skills/afk-run/scripts/loop-serve.mjs')
  const state = projectLoopState([
    { t: 1, event: 'queue_update', tasks: [{ id: 'ready', title: 'Ready' }, { id: 'done', title: 'Done' }] },
    { t: 2, event: 'task_start', id: 'done', title: 'Done' },
    { t: 3, event: 'task_end', id: 'done', kind: 'done' },
    { t: 4, event: 'queue_update', tasks: [] },
  ])

  assert.deepEqual(state.ready, [])
  assert.deepEqual(state.done.map((task) => task.id), ['done'])
  assert.equal(state.lastEventAt, 4)
})

test('loop-serve /task/<id> 复用 exec-review structured context 页', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'afk-task-detail-'))
  const progressFile = join(dir, 'task-b-1.progress.jsonl')
  const port = 20100 + Math.floor(Math.random() * 1000)
  const events = [
    { t: 1, event: 'loop_start', source: 'beads', runDir: dir, stopFile: join(dir, 'afk-stop') },
    {
      t: 2,
      event: 'task_start',
      id: 'b',
      title: 'Detail task',
      priority: 1,
      attempt: 1,
      progressFile,
    },
  ]
  writeFileSync(join(dir, 'loop-progress.jsonl'), events.map((event) => JSON.stringify(event)).join('\n') + '\n')
  writeFileSync(
    progressFile,
    [
      JSON.stringify({ t: 3, event: 'run_start', title: 'Detail task', id: 'b' }),
      JSON.stringify({
        t: 4,
        event: 'context_start',
        role: 'executor',
        eventsFile: join(dir, 'executor.events.jsonl'),
      }),
    ].join('\n') + '\n',
  )
  writeFileSync(
    join(dir, 'executor.events.jsonl'),
    JSON.stringify({
      kind: 'tool',
      phase: 'done',
      callId: 's1',
      toolName: 'shell',
      args: { command: 'echo hi' },
      result: { exit_code: 0, output: 'hi\n' },
    }) + '\n',
  )

  const child = spawn(process.execPath, [SERVE, dir, String(port)], { stdio: ['ignore', 'ignore', 'ignore'] })
  try {
    await waitFor(async () => {
      return new Promise((resolve) => {
        http.get({ host: '127.0.0.1', port, path: '/task/b' }, (res) => {
          let data = ''
          res.on('data', (chunk) => (data += chunk))
          res.on('end', () => resolve(res.statusCode === 200 && data.includes('contextCards')))
        }).on('error', () => resolve(false))
      })
    })
    const html = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/task/b' }, (res) => {
        let data = ''
        res.on('data', (chunk) => (data += chunk))
        res.on('end', () => resolve(data))
      }).on('error', reject)
    })
    assert.match(html, /contextCards/, '详情页应有 structured context 容器')
    assert.match(html, /ctx-shell-cmd/, '详情页应复用 shell 卡片样式')
    assert.match(html, /返回 AFK 总览/, '详情页应有返回链接')
  } finally {
    child.kill()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loop-serve 通过 SSE 推送当前任务的聚合阶段', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'afk-serve-'))
  const progressFile = join(dir, 'task-a-1.progress.jsonl')
  const port = 20000 + Math.floor(Math.random() * 1000)
  const events = [
    { t: 1, event: 'loop_start', source: 'beads', runDir: dir, stopFile: join(dir, 'afk-stop') },
    { t: 2, event: 'task_start', id: 'a', title: 'Current', priority: 1, attempt: 1, progressFile },
  ]
  writeFileSync(join(dir, 'loop-progress.jsonl'), events.map((event) => JSON.stringify(event)).join('\n') + '\n')
  writeFileSync(progressFile, JSON.stringify({ t: 3, event: 'reviewer_start' }) + '\n')
  const child = spawn(process.execPath, [SERVE, dir, String(port)], { stdio: ['ignore', 'ignore', 'ignore'] })
  try {
    const state = await waitFor(() => readSseState(port))
    assert.equal(state.current.id, 'a')
    assert.equal(state.current.stage, 'reviewing')
  } finally {
    child.kill()
    rmSync(dir, { recursive: true, force: true })
  }
})
