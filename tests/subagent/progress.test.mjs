/**
 * 臂进度记录：events 进 progress.jsonl 之前必须先压成少量可读记录，
 * 且观察端的任何失败都不允许杀死执行。
 *
 *   node --test tests/subagent/progress.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runArms } from '../../lib/subagent/index.mjs'
import { createArmProgress } from '../../lib/subagent/arm-progress.mjs'

function readProgress(file) {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line))
}

/** 假 runTurn：把 onEvent 按脚本喂进去，不启动任何子进程。 */
function fakeTurn(script) {
  return async (opts) => {
    await script(opts)
    writeFileSync(opts.outFile, 'ok', 'utf8')
    if (!existsSync(opts.eventsFile)) writeFileSync(opts.eventsFile, '', 'utf8')
    writeFileSync(opts.logFile, '', 'utf8')
    return { runner: 'pi', exitCode: 0, timedOut: false, aborted: false }
  }
}

test('progress.jsonl 只留 arm_start / tool / arm_end，并成对合并耗时', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'arm-progress-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const outDir = join(root, 'run')

  await runArms({
    arms: [{ label: 'feature', runner: 'pi', workdir: root, prompt: 'x' }],
    outDir,
    runTurn: fakeTurn(async (opts) => {
      opts.onEvent({ kind: 'tool', phase: 'start', toolName: 'Read', callId: 'a' })
      opts.onEvent({ kind: 'tool', phase: 'done', toolName: 'Read', callId: 'a' })
      // 片段一律不写：一轮上千条，写了看板就读不动了。
      opts.onEvent({ kind: 'assistant_partial', text: '字' })
      opts.onEvent({ kind: 'thinking', text: '想' })
      // 一次性 tool 事件（Cursor）没有 phase，也要记一条。
      opts.onEvent({ kind: 'tool', toolName: 'shell' })
    }),
  })

  const records = readProgress(join(outDir, 'progress.jsonl'))
  const events = records.map((record) => record.event)
  assert.deepEqual(events, ['arm_start', 'tool', 'tool', 'arm_end'])

  assert.equal(records[1].name, 'Read')
  assert.equal(typeof records[1].ms, 'number')
  assert.equal(records[2].name, 'shell')
  assert.equal(records[2].ms, undefined, '没有配对 start 就不要编耗时')

  const end = records.at(-1)
  assert.equal(end.arm, 'feature')
  assert.equal(end.status, 'ok')
  assert.equal(end.tools, 2)
  assert.equal(typeof end.elapsedMs, 'number')
})

test('失败的臂也必须留下 arm_end，并带上可读原因', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'arm-progress-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const outDir = join(root, 'run')

  const results = await runArms({
    arms: [{ label: 'review', runner: 'pi', workdir: root, prompt: 'x' }],
    outDir,
    runTurn: async () => {
      throw new Error('bin 不存在')
    },
  })
  assert.equal(results[0].status, 'error')

  const end = readProgress(join(outDir, 'progress.jsonl')).at(-1)
  assert.equal(end.event, 'arm_end')
  assert.equal(end.status, 'error')
  assert.match(String(end.reason), /bin 不存在/)
})

test('写入失败时 createArmProgress 不抛异常（观察端不许杀执行）', () => {
  const root = mkdtempSync(join(tmpdir(), 'arm-progress-'))
  rmSync(root, { recursive: true, force: true })
  const dirAsFile = root
  writeFileSync(`${root}.marker`, 'x', 'utf8')
  // 目标是目录，appendFileSync 一定失败。
  const progress = createArmProgress({ file: dirAsFile, arm: 'x' })
  assert.doesNotThrow(() => progress.onEvent({ kind: 'tool', phase: 'done', toolName: 'Edit' }))
  assert.doesNotThrow(() => progress.end({ status: 'ok' }))
  rmSync(`${root}.marker`, { force: true })
})
