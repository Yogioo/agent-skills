/**
 * 看板顶部「需要人处理」清单的挑选规则。
 *
 * 一条规则：这张卡**最后一个决定性结局**是失败/被挡 → 进清单；`card_done` 算已解决。
 * `card_skipped` / `card_interrupted` 不清除结论（那只是一次未遂的尝试），
 * 否则“失败 → 重试时被跳过 → 从清单消失”会把还没解决的卡藏起来。
 *
 *   node --test tests/tapd-loop/needs-human.test.mjs
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { pickNeedsHuman, filterNeedsHuman } from '../../skills/tapd-loop/scripts/control.mjs'

const now = Date.now()
const entry = (ago, kind, card, note = '', extra = {}) => ({ t: now - ago, kind, card, note, runId: `run-${card}`, ...extra })

test('最后一个结局是失败/被挡的卡进清单，已完成的卡不进', () => {
  const rows = pickNeedsHuman([
    entry(10_000, 'card_failed', 'A', '验证命令失败（exit 1）'),
    entry(20_000, 'card_failed', 'B', '卡住不动'),
    entry(15_000, 'card_done', 'B', ''), // B 后来被解决了
    entry(5_000, 'card_blocked', 'D', '同步冲突'),
  ], { since: now - 86_400_000 })
  assert.deepEqual(rows.map((r) => r.card).sort(), ['A', 'D'])
  const a = rows.find((r) => r.card === 'A')
  assert.equal(a.kind, 'card_failed')
  assert.equal(a.reason, '验证命令失败（exit 1）')
})

test('跳过/中断不清除结论：失败后重试被 skip，仍算需要人处理', () => {
  const rows = pickNeedsHuman([
    entry(30_000, 'card_failed', 'C', '门禁没验'),
    entry(25_000, 'card_skipped', 'C', '已带 afk-claimed'),
  ], { since: now - 86_400_000 })
  assert.deepEqual(rows.map((r) => r.card), ['C'])
  assert.equal(rows[0].reason, '门禁没验')
})

test('还在跑（只有 card_start / phase）的卡不进清单', () => {
  const rows = pickNeedsHuman([
    entry(100, 'card_start', 'E', ''),
    entry(90, 'card_phase', 'E', 'fetch'),
    entry(90_000, 'card_failed', 'F', 'x'),
    entry(80_000, 'card_phase', 'F', 'claim'), // 失败后在重跑，但还没结局
  ], { since: now - 86_400_000 })
  assert.deepEqual(rows.map((r) => r.card), ['F'])
})

test('太久以前的失败不算（默认看近两周）', () => {
  const rows = pickNeedsHuman([
    entry(20 * 86_400_000, 'card_failed', 'OLD', '两周前的'),
    entry(1_000, 'card_failed', 'NEW', '刚刚'),
  ], { since: now - 14 * 86_400_000 })
  assert.deepEqual(rows.map((r) => r.card), ['NEW'])
})

test('按时间倒序、可以限条数', () => {
  const rows = pickNeedsHuman([
    entry(10_000, 'card_failed', 'A'),
    entry(1_000, 'card_failed', 'B'),
    entry(5_000, 'card_failed', 'C'),
  ], { since: now - 86_400_000, limit: 2 })
  assert.deepEqual(rows.map((r) => r.card), ['B', 'C'])
})

test('空输入 / 垃圾行不炸', () => {
  assert.deepEqual(pickNeedsHuman(), [])
  assert.deepEqual(pickNeedsHuman([null, {}, { t: now, kind: 'card_failed' }]), [])
})

// —— 第二道筛：拿 TAPD 现状核实（本地索引会失真：人会直接在 TAPD 上把卡流转完）——
const row = (card, at = now - 1000) => ({ card, at, kind: 'card_failed', reason: 'x' })
const state = (labels, status, statusLabel = '') => ({ known: true, labels, status, statusLabel })

const base = {
  claimableStatuses: ['status_11', 'developing'],
  failedLabel: 'afk-failed',
  dismissed: {},
}

test('真没处理的才留下：仍带 afk-failed 且状态可接单', () => {
  const rows = filterNeedsHuman([row('A')], {
    ...base,
    stateOf: () => state(['afk-failed'], 'status_11', '实现中'),
  })
  assert.deepEqual(rows.map((r) => r.card), ['A'])
  assert.equal(rows[0].verified, true)
  assert.equal(rows[0].statusLabel, '实现中')
})

test('TAPD 上已流转（已完成）的就藏起来，哪怕本地只记得失败', () => {
  const rows = filterNeedsHuman([row('A'), row('B')], {
    ...base,
    stateOf: (card) => (card === 'A'
      ? state(['afk-failed'], 'status_7', '已完成')
      : state(['afk-delivered'], 'status_11', '实现中')),
  })
  assert.deepEqual(rows, [])
})

test('标签被撕掉（没 afk-failed）也不留', () => {
  const rows = filterNeedsHuman([row('A')], {
    ...base,
    stateOf: () => state(['ready-for-agent'], 'status_11'),
  })
  assert.deepEqual(rows, [])
})

test('问不到 TAPD 就留着（宁可多扰一次，不能把真要处理的藏起来）', () => {
  const rows = filterNeedsHuman([row('A')], {
    ...base,
    stateOf: () => ({ known: false }),
  })
  assert.deepEqual(rows.map((r) => r.card), ['A'])
  assert.equal(rows[0].verified, undefined)
})

test('点过「已处理」就划掉；但以后再失败（时间更新）还会回来', () => {
  const rows = filterNeedsHuman([row('A', now - 5000), row('B', now - 5000)], {
    ...base,
    stateOf: () => state(['afk-failed'], 'status_11'),
    dismissed: { A: now - 1000, B: now - 60_000 },
  })
  assert.deepEqual(rows.map((r) => r.card), ['B'])
})

test('没配可接单状态时只按标签判', () => {
  const rows = filterNeedsHuman([row('A')], {
    ...base,
    claimableStatuses: [],
    stateOf: () => state(['afk-failed'], 'status_7', '已完成'),
  })
  assert.deepEqual(rows.map((r) => r.card), ['A'])
})
