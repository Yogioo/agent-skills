/**
 * 卡片「现在到底在哪一步」：AI 交卷（turn_end）之后，看板不能再一律显示「内循环中」。
 *
 * 优先级：卡片目录的 stage.json（loop 每次切阶段都写）> 磁盘证据推断（verify.log / repair-N/）> 事件流。
 *
 *   node --test tests/tapd-loop/card-phase.test.mjs
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { listRuns } from '../../skills/tapd-loop/scripts/read-run.mjs'

const CARD = '1152360842001005226'

/** 造一个最小可读的 run 目录：loop_start 用当前进程 pid，保证「活着」。 */
function makeRun({ cardFiles = {}, turnEndedMsAgo = 60_000 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tapd-run-'))
  const runDir = join(root, 'run-20260101000000')
  const cardDir = join(runDir, CARD)
  mkdirSync(cardDir, { recursive: true })
  const now = Date.now()
  const turnEnd = now - turnEndedMsAgo
  const lines = [
    { t: now - 600_000, event: 'loop_start', workdir: 'C:/x/wt', pid: process.pid, maxTasks: 1 },
    { t: now - 590_000, event: 'card_start', id: CARD, title: '测试卡', priorityLabel: 'P0', statusLabel: '实现中' },
    { t: now - 580_000, event: 'turn_start', id: CARD, cli: 'pi' },
    { t: turnEnd, event: 'turn_end', id: CARD, durationMs: 500_000 },
  ]
  writeFileSync(join(runDir, 'progress.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8')
  for (const [name, { body = '', mtime = 0 }] of Object.entries(cardFiles)) {
    const file = join(cardDir, name)
    mkdirSync(file.replace(/[\\/][^\\/]+$/, ''), { recursive: true })
    writeFileSync(file, body, 'utf8')
    if (mtime) utimesSync(file, new Date(mtime), new Date(mtime))
  }
  return { root, cardDir, turnEnd, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

const phaseOf = (root) => listRuns(root)[0].cards[0]

test('AI 交卷后什么都没发生：显示 after-turn（不再是内循环中）', () => {
  const run = makeRun()
  try {
    assert.equal(phaseOf(run.root).phase, 'after-turn')
  } finally {
    run.cleanup()
  }
})

test('stage.json 说了算：loop 写了 verify 就显示 verify', () => {
  const run = makeRun()
  try {
    writeFileSync(join(run.cardDir, 'stage.json'), JSON.stringify({ phase: 'verify', at: Date.now() }), 'utf8')
    const card = phaseOf(run.root)
    assert.equal(card.phase, 'verify')
    assert.ok(card.phaseAt > run.turnEnd)
  } finally {
    run.cleanup()
  }
})

test('没有 stage.json 但验证日志比交卷新：推断成 verify', () => {
  const run = makeRun()
  try {
    writeFileSync(join(run.cardDir, 'verify.log'), '[verify] 测试已开跑\n', 'utf8')
    const later = new Date(Date.now() - 1000)
    utimesSync(join(run.cardDir, 'verify.log'), later, later)
    assert.equal(phaseOf(run.root).phase, 'verify')
  } finally {
    run.cleanup()
  }
})

test('修复轮目录更新：推断成 verify-repair-N', () => {
  const run = makeRun()
  try {
    const dir = join(run.cardDir, 'repair-2')
    mkdirSync(dir, { recursive: true })
    const later = new Date(Date.now() - 1000)
    utimesSync(dir, later, later)
    assert.equal(phaseOf(run.root).phase, 'verify-repair-2')
  } finally {
    run.cleanup()
  }
})

test('验证日志比交卷还旧（上一次留下的）：不瞎推断，保持 after-turn', () => {
  const run = makeRun({ turnEndedMsAgo: 30_000 })
  try {
    writeFileSync(join(run.cardDir, 'verify.log'), 'old\n', 'utf8')
    const older = new Date(Date.now() - 120_000)
    utimesSync(join(run.cardDir, 'verify.log'), older, older)
    assert.equal(phaseOf(run.root).phase, 'after-turn')
  } finally {
    run.cleanup()
  }
})

test('卡片已结束（card_done）时阶段清空，不受残留文件影响', () => {
  const run = makeRun()
  try {
    const progress = join(run.root, 'run-20260101000000', 'progress.jsonl')
    writeFileSync(progress, [
      JSON.stringify({ t: Date.now() - 600_000, event: 'loop_start', workdir: 'C:/x/wt', pid: process.pid }),
      JSON.stringify({ t: Date.now() - 590_000, event: 'card_start', id: CARD, title: '测试卡' }),
      JSON.stringify({ t: Date.now() - 580_000, event: 'turn_start', id: CARD }),
      JSON.stringify({ t: Date.now() - 500_000, event: 'turn_end', id: CARD }),
      JSON.stringify({ t: Date.now() - 100_000, event: 'card_done', id: CARD }),
    ].join('\n') + '\n', 'utf8')
    writeFileSync(join(run.cardDir, 'stage.json'), JSON.stringify({ phase: 'verify', at: Date.now() }), 'utf8')
    const card = phaseOf(run.root)
    assert.equal(card.status, 'done')
    assert.equal(card.phase, '')
  } finally {
    run.cleanup()
  }
})
