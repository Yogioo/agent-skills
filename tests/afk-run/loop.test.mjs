/**
 * afk-run 循环状态机测试（fake 注入，不依赖真实 LLM / beads / git）。
 *
 * 运行：
 *   cd C:\projects\agent-skills
 *   node --test tests/afk-run/loop.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decide, runLoop, writeTaskMd } from '../../skills/afk-run/scripts/loop.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const LOOP = join(__dirname, '..', '..', 'skills', 'afk-run', 'scripts', 'loop.mjs')

// ---------- 状态机纯函数 ----------

test('decide: approved/done → done', () => {
  assert.equal(decide({ status: 'approved' }).kind, 'done')
  assert.equal(decide({ status: 'done' }).kind, 'done')
})

test('decide: no_change/blocked/timeout/empty/executor_failed → retry', () => {
  for (const s of ['no_change', 'blocked', 'timeout', 'review_timeout', 'empty', 'executor_failed']) {
    const d = decide({ status: s, summary: 'why' })
    assert.equal(d.kind, 'retry', s)
    assert.ok(d.reason.includes(s), s)
  }
})

test('decide: 未知/缺失状态 → failed（不重试）', () => {
  assert.equal(decide({ status: 'weird' }).kind, 'failed')
  assert.equal(decide({}).kind, 'failed')
})

// ---------- runLoop 主循环 ----------

/** 队列式 listReady：依次返回，最后一次重复（空数组恒返回 []）。 */
function queue(items) {
  let i = 0
  return async () => (i < items.length ? items[i++] : items[items.length - 1] ?? [])
}

function makeFakes(overrides = {}) {
  const calls = { inProgress: [], done: [], failed: [], commits: [], resets: 0 }
  const source = {
    listReady: queue([]),
    getDetail: async (id) => ({ id, title: id, body: '正文', requirements: '' }),
    markInProgress: async (id) => calls.inProgress.push(id),
    markDone: async (id, r) => calls.done.push({ id, r }),
    markFailed: async (id, note) => calls.failed.push({ id, note }),
    describeBlocked: async () => [],
    ...overrides.source,
  }
  const execReview = {
    run: async () => ({ status: 'approved', summary: 'ok' }),
    ...overrides.execReview,
  }
  const git = {
    head: () => 'base-head',
    commitAll: (task) => calls.commits.push(task),
    resetHard: () => calls.resets++,
    ...overrides.git,
  }
  return { source, execReview, git, calls }
}

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'afk-loop-'))
}

const baseConfig = { stopFile: '', maxTasks: 0, maxFailures: 0, retry: 0 }

test('runLoop: 全部完成 → all-done（不执行任何任务）', async () => {
  const { source, execReview, git, calls } = makeFakes()
  const dir = tmpDir()
  const r = await runLoop({
    config: baseConfig,
    source,
    execReview,
    git,
    hooks: { taskDir: dir },
  })
  assert.equal(r.reason, 'all-done')
  assert.equal(r.stats.attempted, 0)
  assert.equal(calls.done.length, 0)
  rmSync(dir, { recursive: true, force: true })
})

test('runLoop: 就绪空但有未完成工单 → stuck', async () => {
  const { source, execReview, git } = makeFakes({
    source: { describeBlocked: async () => [{ id: 'b1', title: '被阻塞' }] },
  })
  const dir = tmpDir()
  const r = await runLoop({ config: baseConfig, source, execReview, git, hooks: { taskDir: dir } })
  assert.ok(r.reason.startsWith('stuck'))
  rmSync(dir, { recursive: true, force: true })
})

test('runLoop: done → 提交 + markDone + 连续失败清零', async () => {
  const t1 = { id: 't1', title: 'T1', priority: 1 }
  const { source, execReview, git, calls } = makeFakes({
    source: { listReady: queue([[t1], []]) },
  })
  const dir = tmpDir()
  const r = await runLoop({ config: baseConfig, source, execReview, git, hooks: { taskDir: dir } })
  assert.equal(r.reason, 'all-done')
  assert.deepEqual(r.stats, { attempted: 1, done: 1, failed: 0 })
  assert.deepEqual(calls.inProgress, ['t1'])
  assert.equal(calls.done.length, 1)
  assert.equal(calls.done[0].id, 't1')
  assert.equal(calls.commits.length, 1)
  assert.equal(calls.commits[0].id, 't1')
  assert.equal(calls.resets, 0)
  rmSync(dir, { recursive: true, force: true })
})

test('runLoop: blocked → 回滚重试 → 第二次成功（attempts=2）', async () => {
  const t1 = { id: 't1', title: 'T1', priority: 2 }
  let n = 0
  const { source, execReview, git, calls } = makeFakes({
    source: { listReady: queue([[t1], []]) },
    execReview: {
      run: async () => {
        n++
        return n === 1 ? { status: 'blocked', summary: '第一次阻塞' } : { status: 'approved', summary: '第二次成功' }
      },
    },
  })
  const dir = tmpDir()
  const r = await runLoop({
    config: { ...baseConfig, retry: 1 },
    source,
    execReview,
    git,
    hooks: { taskDir: dir },
  })
  assert.equal(r.reason, 'all-done')
  assert.equal(r.stats.done, 1)
  assert.equal(r.tasks[0].attempts, 2)
  assert.equal(calls.resets, 1, '失败应先回滚再重试')
  assert.equal(calls.failed.length, 0)
  rmSync(dir, { recursive: true, force: true })
})

test('runLoop: no_change 按失败处理，重试上限后放弃 → markFailed', async () => {
  const t1 = { id: 't1', title: 'T1', priority: 1 }
  const { source, execReview, git, calls } = makeFakes({
    source: { listReady: queue([[t1], []]) },
    execReview: { run: async () => ({ status: 'no_change', summary: '条件不足' }) },
  })
  const dir = tmpDir()
  const r = await runLoop({
    config: { ...baseConfig, retry: 1 },
    source,
    execReview,
    git,
    hooks: { taskDir: dir },
  })
  assert.equal(r.stats.failed, 1)
  assert.equal(calls.failed.length, 1)
  assert.ok(calls.failed[0].note.includes('no_change'))
  assert.equal(calls.done.length, 0)
  rmSync(dir, { recursive: true, force: true })
})

test('runLoop: timeout → 失败（retry=0 不重试）', async () => {
  const t1 = { id: 't1', title: 'T1', priority: 1 }
  const { source, execReview, git, calls } = makeFakes({
    source: { listReady: queue([[t1], []]) },
    execReview: { run: async () => ({ status: 'timeout', summary: '超时' }) },
  })
  const dir = tmpDir()
  const r = await runLoop({ config: baseConfig, source, execReview, git, hooks: { taskDir: dir } })
  assert.equal(r.stats.failed, 1)
  assert.equal(calls.failed[0].id, 't1')
  rmSync(dir, { recursive: true, force: true })
})

test('runLoop: 连续失败 ≥ maxFailures → 熔断', async () => {
  const t1 = { id: 't1', title: 'T1', priority: 1 }
  const t2 = { id: 't2', title: 'T2', priority: 2 }
  const { source, execReview, git } = makeFakes({
    source: { listReady: queue([[t1, t2]]) },
    execReview: { run: async () => ({ status: 'blocked', summary: '全阻塞' }) },
  })
  const dir = tmpDir()
  const r = await runLoop({
    config: { ...baseConfig, maxFailures: 2 },
    source,
    execReview,
    git,
    hooks: { taskDir: dir },
  })
  assert.equal(r.reason, 'circuit-broken')
  assert.equal(r.stats.failed, 2)
  assert.equal(r.stats.attempted, 2)
  rmSync(dir, { recursive: true, force: true })
})

test('runLoop: maxTasks 达到上限 → 停止（即使还有任务）', async () => {
  const t1 = { id: 't1', title: 'T1', priority: 1 }
  const { source, execReview, git } = makeFakes({
    source: { listReady: queue([[t1]]) }, // 永不收敛
    execReview: { run: async () => ({ status: 'approved', summary: 'ok' }) },
  })
  const dir = tmpDir()
  const r = await runLoop({
    config: { ...baseConfig, maxTasks: 1 },
    source,
    execReview,
    git,
    hooks: { taskDir: dir },
  })
  assert.equal(r.reason, 'max-tasks')
  assert.equal(r.stats.attempted, 1)
  assert.equal(r.stats.done, 1)
  rmSync(dir, { recursive: true, force: true })
})

test('runLoop: 停止文件存在 → 立即停止（不拉任务）', async () => {
  const dir = tmpDir()
  const stopFile = join(dir, 'stop')
  writeFileSync(stopFile, 'stop')
  let listCalled = false
  const { source, execReview, git } = makeFakes({
    source: { listReady: async () => ((listCalled = true), []) },
  })
  const r = await runLoop({
    config: { ...baseConfig, stopFile },
    source,
    execReview,
    git,
    hooks: { taskDir: dir },
  })
  assert.equal(r.reason, 'stop-file')
  assert.equal(listCalled, false, '停止文件存在时不应拉任务')
  rmSync(dir, { recursive: true, force: true })
})

test('runLoop: listReady 抛错 → source-error 终止', async () => {
  const { source, execReview, git } = makeFakes({
    source: { listReady: async () => { throw new Error('bd 挂了') } },
  })
  const dir = tmpDir()
  const r = await runLoop({ config: baseConfig, source, execReview, git, hooks: { taskDir: dir } })
  assert.ok(r.reason.startsWith('source-error'))
  rmSync(dir, { recursive: true, force: true })
})

test('writeTaskMd: 生成 exec-review 兼容格式（含 id 行）', () => {
  const dir = tmpDir()
  const f = join(dir, 'task.md')
  writeTaskMd({ id: 'bd-1', title: '标题', body: '正文内容', requirements: '要求内容' }, f)
  const text = readFileSync(f, 'utf8')
  assert.ok(text.startsWith('# 标题'))
  assert.ok(text.includes('id: bd-1'))
  assert.ok(text.includes('## 正文'))
  assert.ok(text.includes('## 要求'))
  rmSync(dir, { recursive: true, force: true })
})

test('runLoop: hooks.onTask 每任务写审计记录', async () => {
  const t1 = { id: 't1', title: 'T1', priority: 1 }
  const records = []
  const { source, execReview, git } = makeFakes({
    source: { listReady: queue([[t1], []]) },
  })
  const dir = tmpDir()
  await runLoop({
    config: baseConfig,
    source,
    execReview,
    git,
    hooks: { taskDir: dir, onTask: (r) => records.push(r) },
  })
  assert.equal(records.length, 1)
  assert.equal(records[0].id, 't1')
  assert.equal(records[0].kind, 'done')
  rmSync(dir, { recursive: true, force: true })
})

test('runLoop: 看板 hooks 接收就绪队列、任务开始和最终结果', async () => {
  const t1 = { id: 't1', title: 'T1', priority: 1 }
  const queues = []
  const starts = []
  const ends = []
  const { source, execReview, git } = makeFakes({
    source: { listReady: queue([[t1], []]) },
    execReview: { run: async (_file, options) => ({ status: 'approved', summary: options.progressFile }) },
  })
  const dir = tmpDir()
  await runLoop({
    config: baseConfig,
    source,
    execReview,
    git,
    hooks: {
      taskDir: dir,
      progressFile: (task, attempt) => join(dir, `${task.id}-${attempt}.progress.jsonl`),
      onQueue: (tasks) => queues.push(tasks),
      onTaskStart: (task) => starts.push(task),
      onTask: (record) => ends.push(record),
    },
  })
  assert.equal(queues[0][0].id, 't1')
  assert.deepEqual(starts[0], {
    id: 't1',
    title: 'T1',
    priority: 1,
    attempt: 1,
    progressFile: join(dir, 't1-1.progress.jsonl'),
  })
  assert.equal(ends[0].kind, 'done')
  rmSync(dir, { recursive: true, force: true })
})

test('CLI: --no-serve 不输出 loop 看板 URL', () => {
  const dir = tmpDir()
  try {
    const stdout = execFileSync(process.execPath, [LOOP, '--workdir', dir, '--dry-run', '--no-serve'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    assert.equal(JSON.parse(stdout).serveUrl, '')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
