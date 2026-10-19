/**
 * 登记簿：跑完的 run 必须留在账上（历史），窗口只影响“发哪些”，不删文件。
 *
 *   node --test tests/run-runtime/registry.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  adoptRun,
  finishRun,
  isRunAlive,
  listRuns,
  pruneRuns,
  readRun,
  registerRun,
  runsDir,
  unregisterRun,
} from '../../lib/run-runtime/run-registry.mjs'

/** 每个用例一个隔离的 AFK_HOME：绝不动真实的 ~/.afk。 */
function withHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'afk-registry-'))
  const previous = process.env.AFK_HOME
  process.env.AFK_HOME = home
  t.after(() => {
    if (previous === undefined) delete process.env.AFK_HOME
    else process.env.AFK_HOME = previous
    rmSync(home, { recursive: true, force: true })
  })
  return home
}

const DAY = 24 * 60 * 60 * 1000

test('收尾保留记录：finishRun 不再删文件，历史才留得下来', (t) => {
  withHome(t)
  const now = Date.now()
  const { runId } = registerRun({
    workdir: 'C:/projects/Demo', outDir: 'C:/projects/Demo/cache/run-1',
    labels: ['feature'], runner: 'pi', pid: process.pid, now: now - 5000,
  })
  assert.equal(isRunAlive(readRun(runId).record), true)

  const finished = finishRun(runId, { outcome: 'ok' })
  assert.equal(finished.updated, true)
  assert.equal(finished.record.outcome, 'ok')
  assert.equal(typeof finished.record.endedAt, 'number')

  // 文件还在，而且“已收尾”比 pid 更权威。
  assert.equal(existsSync(join(runsDir(), `${runId}.json`)), true)
  assert.equal(isRunAlive(readRun(runId).record), false)

  const listed = listRuns()
  assert.equal(listed.runs.length, 1)
  assert.equal(listed.runs[0].alive, false)
  assert.equal(listed.finished, 1)
})

test('窗口只筛发布内容：7 天外的记录仍在账上', (t) => {
  withHome(t)
  const now = Date.now()
  const old = registerRun({
    workdir: 'C:/projects/Demo', outDir: 'C:/projects/Demo/cache/old',
    labels: ['old'], pid: process.pid, now: now - 10 * DAY,
  })
  finishRun(old.runId, { outcome: 'ok', now: now - 10 * DAY + 60000 })
  const recent = registerRun({
    workdir: 'C:/projects/Demo2', outDir: 'C:/projects/Demo2/cache/new',
    labels: ['new'], pid: process.pid, now: now - 1000,
  })

  const week = listRuns({ since: now - 7 * DAY })
  assert.deepEqual(week.runs.map((run) => run.runId), [recent.runId])
  assert.equal(week.finished, 0, '计数只描述本次发布的内容，不是全库')

  const all = listRuns({ since: 0 })
  assert.equal(all.runs.length, 2, '文件没被删，全部窗口下还在')
})

test('pid 已死且没收到尾：标成中断，而不是当成在跑', (t) => {
  withHome(t)
  const dead = registerRun({
    workdir: 'C:/projects/Demo', outDir: 'C:/projects/Demo/cache/dead',
    pid: 2147483646, now: Date.now() - 1000,
  })
  const run = listRuns().runs.find((item) => item.runId === dead.runId)
  assert.equal(run.alive, false)
  assert.equal(run.crashed, true)
})

test('prune 按年龄清，不按死活清', (t) => {
  withHome(t)
  const now = Date.now()
  const old = registerRun({
    workdir: 'C:/projects/Demo', outDir: 'C:/projects/Demo/cache/old',
    pid: process.pid, now: now - 40 * DAY,
  })
  finishRun(old.runId, { outcome: 'ok', now: now - 40 * DAY + 1000 })
  const fresh = registerRun({
    workdir: 'C:/projects/Demo2', outDir: 'C:/projects/Demo2/cache/new',
    pid: process.pid, now: now - 1000,
  })
  finishRun(fresh.runId, { outcome: 'ok', now })

  const pruned = pruneRuns({ olderThanMs: 30 * DAY, now })
  assert.deepEqual(pruned.removed, [old.runId])
  assert.equal(existsSync(join(runsDir(), `${fresh.runId}.json`)), true)
})

test('forget 是显式删除：唯一的删记录入口', (t) => {
  withHome(t)
  const { runId } = registerRun({ workdir: 'C:/projects/Demo', outDir: 'C:/x', pid: process.pid })
  assert.deepEqual(unregisterRun(runId), { runId, removed: true })
  assert.equal(readdirSync(runsDir()).length, 0)
})

test('adopt 从 progress.jsonl 补出历史，且重复执行是幂等的', (t) => {
  withHome(t)
  const outDir = join(mkdtempSync(join(tmpdir(), 'afk-adopt-')), 'run-1')
  t.after(() => rmSync(outDir, { recursive: true, force: true }))
  mkdirSync(outDir, { recursive: true })
  const started = Date.now() - 60000
  const lines = [
    { t: started, level: 1, event: 'arm_start', arm: 'feature', at: started, runner: 'pi' },
    { t: started + 1000, level: 1, event: 'tool', arm: 'feature', name: 'read', detail: 'a.md', ms: 5 },
    { t: started + 5000, level: 1, event: 'arm_end', arm: 'feature', status: 'ok', elapsedMs: 5000 },
  ]
  writeFileSync(join(outDir, 'progress.jsonl'), lines.map((line) => JSON.stringify(line)).join('\n') + '\n')

  const first = adoptRun({ outDir, workdir: 'C:/projects/Demo' })
  assert.equal(first.adopted, true)
  assert.deepEqual(first.record.labels, ['feature'])
  assert.equal(first.record.startedAt, started)
  assert.equal(first.record.outcome, 'ok')
  assert.equal(first.record.endedAt, started + 5000)
  assert.equal(first.record.adopted, true)

  const second = adoptRun({ outDir, workdir: 'C:/projects/Demo' })
  assert.equal(second.record.runId, first.record.runId, '重复 adopt 不产生第二条记录')
  assert.equal(readdirSync(runsDir()).length, 1)

  // 补出来的记录立刻出现在历史里，而且是“已结束”。
  const listed = listRuns({ since: 0 })
  assert.equal(listed.runs.length, 1)
  assert.equal(listed.runs[0].alive, false)
  assert.equal(listed.runs[0].outcome, 'ok')
})

test('registerRun 把每个臂的输入写进记录（历史页靠它回答“这轮在干什么”）', (t) => {
  withHome(t)
  const long = '把地形默认值改成从表里读。'.repeat(100)
  const { record } = registerRun({
    workdir: 'C:/projects/Demo', outDir: 'C:/projects/Demo/cache/run-1', pid: process.pid,
    labels: ['feature', 'review'],
    inputs: [
      { label: 'feature', prompt: long, promptChars: long.length, promptFile: 'C:/briefs/f.md' },
      { label: 'review', prompt: '', promptChars: 0 },
    ],
  })
  assert.equal(record.inputs.length, 2, '空正文的臂也要留一条（至少知道它存在）')
  assert.equal(record.inputs[0].label, 'feature')
  assert.equal(record.inputs[0].promptChars, long.length)
  assert.equal(record.inputs[0].promptFile, 'C:/briefs/f.md')
  assert.equal(record.inputs[0].prompt.length, 701, '记录只存预览，不背全文')
  assert.equal(record.inputs[1].prompt, undefined)
})

test('adopt 从各臂 events.jsonl 找回提示词，连原 brief 路径一起', (t) => {
  withHome(t)
  const root = mkdtempSync(join(tmpdir(), 'afk-adopt-input-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const outDir = join(root, 'run-1')
  mkdirSync(join(outDir, 'feature'), { recursive: true })
  const started = Date.now() - 120000
  writeFileSync(
    join(outDir, 'progress.jsonl'),
    [
      { t: started, level: 1, event: 'arm_start', arm: 'feature', at: started, runner: 'pi' },
      { t: started + 90000, level: 1, event: 'arm_end', arm: 'feature', status: 'ok' },
    ].map((line) => JSON.stringify(line)).join('\n') + '\n',
  )
  const brief = 'C:\\projects\\DigitDoor\\cache\\briefs\\terrain.md'
  const userMessage = {
    type: 'message_end',
    message: { role: 'user', content: [{ type: 'text', text: `<file name="${brief}">\n# 任务：把 TerrainConfigPage 迁到 UI DSL\n` }] },
  }
  writeFileSync(
    join(outDir, 'feature', 'events.jsonl'),
    [JSON.stringify({ type: 'message_start' }), JSON.stringify(userMessage)].join('\n') + '\n',
  )

  const { record } = adoptRun({ outDir, workdir: 'C:/projects/Demo' })
  assert.equal(record.inputs.length, 1)
  assert.equal(record.inputs[0].label, 'feature')
  assert.equal(record.inputs[0].promptFile, brief, '从 <file name="…"> 里取回原 brief 路径')
  assert.match(record.inputs[0].prompt, /^<file name=/)
  assert.match(record.inputs[0].prompt, /TerrainConfigPage/)

  // 页面拿到的摘要里必须带着它
  const listed = listRuns({ since: 0 })
  assert.equal(listed.runs[0].inputs[0].promptFile, brief)
})

test('adopt 对没有 progress.jsonl 的目录给出理由，不写空记录', (t) => {
  withHome(t)
  const outDir = mkdtempSync(join(tmpdir(), 'afk-adopt-empty-'))
  t.after(() => rmSync(outDir, { recursive: true, force: true }))
  const result = adoptRun({ outDir, workdir: 'C:/projects/Demo' })
  assert.equal(result.adopted, false)
  assert.equal(result.reason, 'no-progress')
  assert.equal(existsSync(runsDir()), false, '补登记失败时连目录都不该建')
})
