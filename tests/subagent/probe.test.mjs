/**
 * 可用性探测的规划逻辑测试。真跑由 cli.test.mjs 用假子进程覆盖。
 *
 *   node --test tests/subagent/probe.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseModelList } from '../../lib/subagent/turns.mjs'
import { PROBE_THINKING, planProbes } from '../../lib/subagent/probe.mjs'
import { CANONICAL_ROLE_GROUPS, renderRoleTable, parseRoleTable } from '../../lib/subagent/roles.mjs'

const MODELS = parseModelList(
  [
    'provider     model',
    'alpha        good-model',
    'beta         bad-model',
    'grok         grok-4.6',
    'opencode-go  grok-4.7',
    'openrouter   anthropic/claude-opus-5.5',
  ].join('\n'),
)

test('同一个 (provider, model) 只探一次，档位不参与去重', () => {
  const { targets } = planProbes({
    values: ['alpha/good-model-xhigh', 'alpha/good-model-low', 'good-model-medium'],
    models: MODELS,
    runner: 'pi',
  })
  assert.equal(targets.length, 1)
  assert.equal(targets[0].provider, 'alpha')
  assert.equal(targets[0].model, 'good-model')
  assert.equal(targets[0].thinking, PROBE_THINKING, '探测与质量无关，一律用最低档')
})

test('别名不探；定不出 provider 的进 unresolved 并说明原因', () => {
  const { targets, unresolved } = planProbes({
    values: ['inherit-parent', 'auto', 'nope-model-high', 'grok-4.6-high'],
    models: MODELS,
  })
  assert.deepEqual(
    targets.map((target) => target.model),
    ['grok-4.6'],
  )
  assert.deepEqual(unresolved, [{ value: 'nope-model-high', runner: 'pi', model: 'nope-model', reason: 'unknown' }])
})

test('多义走 unresolved，不猜 provider', () => {
  const models = parseModelList('provider model\nalpha dup\ntest dup\n')
  const { targets, unresolved } = planProbes({ values: ['dup-high'], models })
  assert.equal(targets.length, 0)
  assert.deepEqual(unresolved, [{ value: 'dup-high', runner: 'pi', model: 'dup', reason: 'ambiguous', candidates: ['alpha', 'test'] }])
})

test('显式候选走同一个解析链，含斜杠的模型 id 不被拆错', () => {
  const { targets } = planProbes({
    candidates: [{ model: 'openrouter/anthropic/claude-opus-5.5' }, { model: 'anthropic/claude-opus-5.5' }],
    models: MODELS,
  })
  assert.equal(targets.length, 1, '写成 provider/id 和只写 id 指的是同一个目标')
  assert.equal(targets[0].provider, 'openrouter')
  assert.equal(targets[0].model, 'anthropic/claude-opus-5.5')
})

test('臂名可以做目录名', () => {
  const { targets } = planProbes({
    candidates: [{ model: 'openrouter/anthropic/claude-opus-5.5' }, { model: 'grok-4.6' }],
    models: MODELS,
  })
  for (const target of targets) assert.match(target.label, /^[A-Za-z0-9._-]+$/)
})

test('init 写出的表解析得动，且一行不缺', () => {
  const text = renderRoleTable({ budget: 'medium', runner: 'codex' })
  const table = parseRoleTable(text)
  assert.deepEqual(table.errors, [])
  assert.equal(table.budget, 'medium')
  assert.equal(table.runner, 'codex')
  assert.equal(table.entries.length, CANONICAL_ROLE_GROUPS.length)
  for (const entry of table.entries) assert.deepEqual(entry.values, ['inherit-parent'])
})
