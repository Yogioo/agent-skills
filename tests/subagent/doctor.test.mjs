/**
 * 角色表体检的单元测试。
 *
 *   node --test tests/subagent/doctor.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseRoleTable } from '../../lib/subagent/roles.mjs'
import { parseModelList } from '../../lib/subagent/turns.mjs'
import { diagnose } from '../../lib/subagent/doctor.mjs'

const MODELS = parseModelList(
  [
    'provider     model',
    'grok         grok-4.6',
    'commandcode  deepseek/deepseek-v4.1-flash',
    'openai       gpt-5.5-pro',
  ].join('\n'),
)

const of = (report, code) => report.findings.filter((item) => item.code === code)
const check = (text, models = MODELS, extra = {}) =>
  diagnose({ table: parseRoleTable(text), models, runner: 'pi', rolesFile: 'x.md', modelsSource: 'fixture', ...extra })

test('干净的表没有 error', () => {
  const report = check(`# budget: large (xhigh)
# runner: pi
feature, refactoring: grok/grok-4.6-xhigh
how explorer: grok-4.6-xhigh
interrogate reviewers: grok/grok-4.6-xhigh, openai/gpt-5.5-pro-xhigh
cheap: auto
`)
  assert.equal(report.ok, true)
  assert.equal(report.counts.errors, 0)
  assert.equal(report.counts.roles, 4)
  assert.equal(report.counts.arms, 5)
  assert.equal(report.budget.effort, 'xhigh')
  // provider 前缀被拆开，裸 id 靠唯一匹配定
  assert.deepEqual(report.roles[0].values[0], {
    value: 'grok/grok-4.6-xhigh',
    runner: 'pi',
    alias: false,
    model: 'grok-4.6',
    provider: 'grok',
    providerSource: 'prefix',
    thinking: 'xhigh',
    fast: false,
    verbatim: false,
    verified: true,
  })
  assert.equal(report.roles[1].values[0].provider, 'grok')
  assert.equal(report.roles[1].values[0].providerSource, 'models-unique', '裸 id 靠唯一匹配定')
  assert.equal(report.roles[2].values[0].providerSource, 'prefix')
  assert.equal(report.roles[2].values[1].providerSource, 'prefix')
  assert.equal(report.roles[3].values[0].alias, true)
})

test('不存在的模型是 error', () => {
  const report = check('# budget: large (xhigh)\nhow explainer: anthropic/claude-opus-5.5-xhigh\n')
  assert.equal(report.ok, false)
  const [item] = of(report, 'unknown-model')
  assert.equal(item.role, 'how explainer')
  assert.match(item.message, /claude-opus-5\.5/)
})

test('多义模型是 error：真跑时会拒绕', () => {
  const models = parseModelList('provider model\nalpha dup\ntest dup\n')
  const report = check('swarm workers: dup-high\n', models)
  const [item] = of(report, 'ambiguous-provider')
  assert.equal(item.level, 'error')
  assert.deepEqual(item.candidates, ['alpha', 'test'])
  assert.match(item.message, /写成 <provider>\/dup/)
  assert.equal(report.ok, false)
})

test('重复角色行与退役角色名各报一次', () => {
  const report = check(`# budget: large (xhigh)
feature: grok/grok-4.6-xhigh
feature, refactoring: grok/grok-4.6-xhigh
reflect reviewers: grok/grok-4.6-xhigh
`)
  assert.equal(of(report, 'duplicate-role').length, 1)
  assert.equal(of(report, 'unknown-role').length, 1)
  assert.match(of(report, 'unknown-role')[0].message, /reflect reviewers/)
})

test('effort 低于预算、以及 -fast 都会被点出来', () => {
  const report = check('# budget: large (xhigh)\nswarm workers: grok-4.6-high\nquick: grok-4.6-xhigh-fast\n')
  assert.equal(of(report, 'below-budget').length, 1)
  assert.equal(of(report, 'fast-unsupported').length, 1)
})

test('面板里重复的模型和单一厂商都会被点出来', () => {
  const report = check('# budget: large (xhigh)\ninterrogate reviewers: grok/grok-4.6-xhigh, grok-4.6-xhigh, grok-4.6-medium\n')
  assert.equal(of(report, 'panel-duplicate').length, 2, '后两个都跟第一个撞车')
  assert.equal(of(report, 'panel-same-vendor').length, 1)
})

test('拿不到模型清单时报 error，不假装绿，也不派生假警报', () => {
  const report = check('# budget: large (xhigh)\nfeature: grok-4.6-xhigh\n', [], { modelsError: '无法运行 pi --list-models' })
  assert.equal(report.ok, false)
  assert.equal(of(report, 'no-model-list').length, 1)
  assert.match(of(report, 'no-model-list')[0].message, /无法运行/)
  assert.equal(of(report, 'unknown-model').length, 0, '清单缺失时不能把每个模型都报成不存在')
  assert.equal(report.counts.errors, 1)
  assert.equal(report.roles[0].values[0].verified, false)
  assert.equal(report.roles[0].values[0].thinking, 'xhigh', '与清单无关的检查照做')
})

test('表里的坏行也算 error，并带上行号', () => {
  const report = check('# budget: large (xhigh)\nno colon here\nfeature: grok-4.6-xhigh\n', MODELS, {
    parseErrors: ['第 2 行不是 key: value：no colon here'],
  })
  assert.equal(report.ok, false)
  assert.equal(of(report, 'bad-line').length, 1)
})

test('没有角色表时报 error，不让 ok 变假', () => {
  const report = diagnose({ table: parseRoleTable(''), models: MODELS, runner: 'pi', triedPaths: ['a.md', 'b.md'] })
  assert.equal(report.ok, false)
  assert.equal(report.counts.roles, 0)
  const [item] = of(report, 'no-role-file')
  assert.equal(item.level, 'error')
  assert.match(item.message, /a\.md \/ b\.md/)
})

test('裸 auto 在枚举型 runner 下仍按别名处理，清单里真有同名模型就提醒', () => {
  const models = parseModelList('provider model\nx auto\n')
  const report = diagnose({
    table: parseRoleTable('# budget: large (xhigh)\n# runner: agent\nswarm workers: auto\n'),
    lists: { agent: { models, source: 'fixture' } },
    runner: 'agent',
    rolesFile: 'x.md',
  })
  const [item] = of(report, 'alias-shadowed')
  assert.equal(item.level, 'warning')
  assert.match(item.message, /agent:auto/, '告诉人怎么写那个字面模型')
  assert.equal(report.roles[0].values[0].alias, true, '裸 auto 仍然是别名')
})

test('缺预算行、缺规范角色都是可读的提示', () => {
  const report = check('feature: grok-4.6-xhigh\n')
  assert.equal(of(report, 'no-budget').length, 1)
  const [missing] = of(report, 'missing-roles')
  assert.equal(missing.roles.includes('swarm workers'), true)
  assert.equal(report.ok, true, '缺角色会回落到技能默认值，不算错')
})

test('认识不出来的预算标签会被指出来', () => {
  const report = check('# budget: enormous (max)\nfeature: grok-4.6-xhigh\n')
  assert.equal(of(report, 'unknown-budget').length, 1)
  assert.equal(report.budget.effort, null)
})
