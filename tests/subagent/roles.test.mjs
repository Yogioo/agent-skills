/**
 * subagent 纯函数层的单元测试：角色表解析、slug 拆分、provider 归属、结果判定。
 *
 *   node --test tests/subagent/roles.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  describeRunnerInRegistry,
  parseSlug,
  parseRoleTable,
  roleLookup,
  roleNames,
  resolveArm,
  splitRunnerPrefix,
} from '../../lib/subagent/roles.mjs'
import { parseModelList, resolveProvider, classifyTurn, summarize } from '../../lib/subagent/turns.mjs'

const TABLE = `---
alwaysApply: true
---
# pstack model configuration. One line per role.
# budget: large (xhigh)
# runner: pi
feature, refactoring: grok-4.7-xhigh-fast
how explorer: claude-opus-5-5-xhigh
interrogate reviewers: deepseek/deepseek-v4.1-flash-medium, grok-composer-2.5-fast
cheap: auto
`

function turnLine(message) {
  return `${JSON.stringify({ kind: 'assistant', payload: { type: 'turn_end', message } })}\n`
}

test('parseSlug 把 effort 从最后一段拆出来，或从 -fast 前一段拆', () => {
  assert.deepEqual(parseSlug('grok-4.7-xhigh-fast'), {
    slug: 'grok-4.7-xhigh-fast',
    alias: false,
    model: 'grok-4.7',
    thinking: 'xhigh',
    fast: true,
    verbatim: false,
  })
  assert.deepEqual(parseSlug('claude-opus-5-5-xhigh'), {
    slug: 'claude-opus-5-5-xhigh',
    alias: false,
    model: 'claude-opus-5-5',
    thinking: 'xhigh',
    fast: false,
    verbatim: false,
  })
  assert.equal(parseSlug('claude-opus-5-5-max').thinking, 'max')
})

test('parseSlug 不碰 flash、版本号与含 / 的模型 id', () => {
  assert.deepEqual(parseSlug('deepseek/deepseek-v4.1-flash'), {
    slug: 'deepseek/deepseek-v4.1-flash',
    alias: false,
    model: 'deepseek/deepseek-v4.1-flash',
    thinking: undefined,
    fast: false,
    verbatim: false,
  })
  assert.deepEqual(parseSlug('grok-composer-2.5-fast'), {
    slug: 'grok-composer-2.5-fast',
    alias: false,
    model: 'grok-composer-2.5',
    thinking: undefined,
    fast: true,
    verbatim: false,
  })
  assert.equal(parseSlug('gpt-4').model, 'gpt-4')
})

test('effortParam 为 null 的 runner：整串就是模型 id，但别名仍然是别名', () => {
  const parsed = parseSlug('gpt-5.3-codex-xhigh', { effortParam: null })
  assert.equal(parsed.model, 'gpt-5.3-codex-xhigh', '拆了就等于拿钱去跑另一个模型')
  assert.equal(parsed.thinking, undefined)
  assert.equal(parsed.fast, false)
  assert.equal(parsed.verbatim, true)
  assert.equal(parseSlug('claude-opus-5-thinking-high-fast', { effortParam: null }).model, 'claude-opus-5-thinking-high-fast')
  // 别名是“跟父会话模型”的说法，任何 runner 下都得能用。要拿同名的字面模型得写 `<runner>:auto`。
  assert.equal(parseSlug('auto', { effortParam: null }).alias, true)
  assert.equal(parseSlug('inherit-parent', { effortParam: null }).alias, true)
  // 但是带 runner 前缀就是在指名那个 CLI 自己的模型，不再是别名。
  assert.equal(parseSlug('auto', { effortParam: null, aliasAllowed: false }).model, 'auto')
  assert.equal(splitRunnerPrefix('cursor:auto', describeRunnerInRegistry).rest, 'auto', '前缀留给了字面模型 id')
})

test('splitRunnerPrefix 只认认得出的 runner 名，不误拆模型 id 里的冒号', () => {
  assert.deepEqual(splitRunnerPrefix('pi:opencode-go/grok-4.7-xhigh'), {
    runner: 'pi',
    rest: 'opencode-go/grok-4.7-xhigh',
    explicit: true,
  })
  assert.deepEqual(splitRunnerPrefix('cursor:gpt-5.3-codex-xhigh'), {
    runner: 'agent',
    rest: 'gpt-5.3-codex-xhigh',
    explicit: true,
  })
  // 首段不是 runner 名：整串当模型 id，包括它自己的冒号
  const batch = splitRunnerPrefix('anthropic/claude-opus-5.5:batch')
  assert.equal(batch.explicit, false)
  assert.equal(batch.rest, 'anthropic/claude-opus-5.5:batch')
  const bare = splitRunnerPrefix('opencode-go/grok-4.7-xhigh')
  assert.equal(bare.explicit, false)
  assert.equal(bare.rest, 'opencode-go/grok-4.7-xhigh')
})

test('parseSlug 认识两个别名', () => {
  for (const alias of ['auto', 'inherit-parent']) {
    const parsed = parseSlug(alias)
    assert.equal(parsed.alias, true)
    assert.equal(parsed.model, '')
    assert.equal(parsed.thinking, undefined)
  }
})

test('parseRoleTable 跳过 frontmatter 与注释，但留下 budget 与 runner', () => {
  const table = parseRoleTable(TABLE)
  assert.equal(table.budget, 'large')
  assert.equal(table.runner, 'pi')
  assert.deepEqual(table.errors, [])
  assert.equal(table.entries.length, 4)
  assert.deepEqual(table.entries[0], { names: ['feature', 'refactoring'], values: ['grok-4.7-xhigh-fast'] })
  assert.deepEqual(roleLookup(table, 'refactoring'), ['grok-4.7-xhigh-fast'])
  assert.deepEqual(roleLookup(table, 'interrogate reviewers'), [
    'deepseek/deepseek-v4.1-flash-medium',
    'grok-composer-2.5-fast',
  ])
  assert.equal(roleLookup(table, 'nope'), undefined)
  assert.deepEqual(roleNames(table), [
    'feature',
    'refactoring',
    'how explorer',
    'interrogate reviewers',
    'cheap',
  ])
})

test('parseRoleTable 收下 CRLF、空值与坏行', () => {
  const table = parseRoleTable('no colon here\r\nbroken:\r\ngood: a-b\r\n')
  assert.equal(table.entries.length, 1)
  assert.equal(table.errors.length, 2)
  assert.equal(table.errors[0].includes('不是 key: value'), true)
  assert.equal(table.errors[1].includes('没有取值'), true)
})

test('resolveArm 优先级：显式覆盖 > 值里的 runner 前缀 > 默认', () => {
  const table = parseRoleTable(TABLE)
  const fromRole = resolveArm({ role: 'how explorer', values: roleLookup(table, 'how explorer'), defaultRunner: 'pi' })
  assert.equal(fromRole.model, 'claude-opus-5-5')
  assert.equal(fromRole.thinking, 'xhigh')
  assert.equal(fromRole.runner, 'pi')
  assert.equal(fromRole.sources.model, 'role')
  assert.equal(fromRole.sources.runner, 'default')

  const overridden = resolveArm({
    role: 'how explorer',
    values: roleLookup(table, 'how explorer'),
    override: { model: 'x', thinking: 'low', runner: 'codex' },
    defaultRunner: 'pi',
  })
  assert.equal(overridden.model, 'x')
  assert.equal(overridden.thinking, 'low')
  assert.equal(overridden.runner, 'codex')
  assert.equal(overridden.sources.model, 'override')
})

test('值里的 runner 前缀生效，且显式 runner 能盖过它', () => {
  const values = ['cursor:composer-2.5', 'pi:opencode-go/grok-4.7-xhigh']
  const cursor = resolveArm({ role: 'r', values, index: 0, defaultRunner: 'pi' })
  assert.equal(cursor.runner, 'agent', 'cursor 是 agent 的别名')
  assert.equal(cursor.model, 'composer-2.5', '枚举型 runner 原样传')
  assert.equal(cursor.thinking, undefined)
  assert.equal(cursor.runnerExplicit, true)
  assert.equal(cursor.sources.runner, 'value')

  const pi = resolveArm({ role: 'r', values, index: 1, defaultRunner: 'agent' })
  assert.equal(pi.runner, 'pi', '值里的前缀比表里的默认 runner 优先')
  assert.equal(pi.model, 'opencode-go/grok-4.7')
  assert.equal(pi.thinking, 'xhigh')

  const forced = resolveArm({ role: 'r', values, index: 0, override: { runner: 'codex' }, defaultRunner: 'pi' })
  assert.equal(forced.runner, 'codex')
  assert.equal(forced.sources.runner, 'override')
  assert.equal(forced.model, 'composer-2.5', '换 runner 不改模型字符串')
})

test('枚举型 runner 忽略值里的 effort 后缀，但显式覆盖仍然作数', () => {
  const arm = resolveArm({ role: 'r', values: ['cursor:gpt-5.3-codex-xhigh'], defaultRunner: 'pi' })
  assert.equal(arm.model, 'gpt-5.3-codex-xhigh')
  assert.equal(arm.thinking, undefined)
  assert.equal(arm.verbatim, true)
  assert.equal(arm.sources.thinking, 'in-model-id')

  const withOverride = resolveArm({
    role: 'r',
    values: ['cursor:gpt-5.3-codex-xhigh'],
    override: { thinking: 'low' },
    defaultRunner: 'pi',
  })
  assert.equal(withOverride.thinking, 'low', '人明确要的档位不能被规则吞掉')
  assert.equal(withOverride.sources.thinking, 'override')
})

test('cursor:auto 是 Cursor 自己的 auto 模型，裸 auto 是别名', () => {
  const literal = resolveArm({ role: 'r', values: ['cursor:auto'], defaultRunner: 'pi' })
  assert.equal(literal.runner, 'agent')
  assert.equal(literal.alias, false, '带了前缀就不是别名')
  assert.equal(literal.model, 'auto')

  const alias = resolveArm({ role: 'r', values: ['auto'], defaultRunner: 'agent' })
  assert.equal(alias.alias, true)
  assert.equal(alias.model, undefined)
  assert.equal(alias.runner, 'agent')

  // 显式覆盖比别名强：调用方明说了 --model，不该被表里的别名呑掉
  const overridden = resolveArm({ role: 'r', values: ['auto'], override: { model: 'x' }, defaultRunner: 'pi' })
  assert.equal(overridden.model, 'x')
  assert.equal(overridden.sources.model, 'override')
})

test('resolveArm 面板按取值顺序分派，超出就回环', () => {
  const table = parseRoleTable(TABLE)
  const values = roleLookup(table, 'interrogate reviewers')
  assert.equal(resolveArm({ role: 'r', values, index: 0, defaultRunner: 'pi' }).model, 'deepseek/deepseek-v4.1-flash')
  assert.equal(resolveArm({ role: 'r', values, index: 0, defaultRunner: 'pi' }).thinking, 'medium')
  assert.equal(resolveArm({ role: 'r', values, index: 1, defaultRunner: 'pi' }).model, 'grok-composer-2.5')
  assert.equal(resolveArm({ role: 'r', values, index: 2, defaultRunner: 'pi' }).model, 'deepseek/deepseek-v4.1-flash')
})

test('resolveArm 对别名不给模型，跑父会话的', () => {
  const table = parseRoleTable(TABLE)
  const arm = resolveArm({ role: 'cheap', values: roleLookup(table, 'cheap'), defaultRunner: 'pi' })
  assert.equal(arm.alias, true)
  assert.equal(arm.model, undefined)
  assert.equal(arm.sources.model, 'alias')
  assert.equal(arm.runner, 'pi')
})

test('parseModelList 跳过表头，解析 provider 与 model 两列', () => {
  const models = parseModelList('provider     model            context\ncommandcode  a/b-c-flash      1M\ndeepseek     deepseek-flash   1M\n')
  assert.deepEqual(models, [
    { provider: 'commandcode', model: 'a/b-c-flash' },
    { provider: 'deepseek', model: 'deepseek-flash' },
  ])
})

test('resolveProvider 只在唯一匹配时自动定，多义交给调用方拒绝', () => {
  const models = parseModelList('provider model\ndeepseek deepseek-flash\nother deepseek-flash\nsolo solo-model\n')
  assert.deepEqual(resolveProvider({ model: 'solo-model', models }), {
    provider: 'solo',
    model: 'solo-model',
    source: 'models-unique',
  })
  const ambiguous = resolveProvider({ model: 'deepseek-flash', models })
  assert.equal(ambiguous.source, 'unknown')
  assert.deepEqual(ambiguous.candidates, ['deepseek', 'other'])
  assert.deepEqual(resolveProvider({ model: 'deepseek-flash', provider: 'flag-wins', models }), {
    provider: 'flag-wins',
    model: 'deepseek-flash',
    source: 'flag',
  })
  assert.deepEqual(resolveProvider({ model: 'nope', models }), { model: 'nope', source: 'unknown' })
})

test('resolveProvider 认 provider/id 前缀，但不抢含斜杠的模型 id', () => {
  const models = parseModelList(
    ['provider     model', 'grok         grok-4.6', 'commandcode  deepseek/deepseek-v4.1-flash'].join('\n'),
  )
  // 拆开后真有这一行：前缀就是 provider
  assert.deepEqual(resolveProvider({ model: 'grok/grok-4.6', models }), {
    provider: 'grok',
    model: 'grok-4.6',
    source: 'prefix',
  })
  // 拆开后没这一行：整串就是模型 id（它自己含斜杠），再按唯一匹配定
  assert.deepEqual(resolveProvider({ model: 'deepseek/deepseek-v4.1-flash', models }), {
    provider: 'commandcode',
    model: 'deepseek/deepseek-v4.1-flash',
    source: 'models-unique',
  })
  // 两边都对不上：unknown，不硬猜
  assert.deepEqual(resolveProvider({ model: 'grok/grok-9.9', models }), {
    model: 'grok/grok-9.9',
    source: 'unknown',
  })
})

test('classifyTurn 从记录判定，不采信 exitCode', () => {
  // 真实形状：grok 上游 503，三次重试失败，agent-run 仍报 exitCode 0。
  const failed = turnLine({
    role: 'assistant',
    content: [],
    stopReason: 'error',
    errorMessage: '503: Service temporarily unavailable',
    provider: 'grok',
    model: 'grok-4.6',
    thinkingLevel: 'low',
    usage: { totalTokens: 0, cost: { total: 0 } },
  })
  const error = classifyTurn({ eventsText: failed, outputText: '', facts: { exitCode: 0, timedOut: false } })
  assert.equal(error.status, 'error')
  assert.equal(error.stopReason, 'error')
  assert.equal(error.thinking, 'low')
})

test('classifyTurn 区分 ok、empty、timeout 与 aborted', () => {
  const ok = turnLine({
    role: 'assistant',
    content: [{ type: 'text', text: 'hi' }],
    stopReason: 'stop',
    model: 'm',
    usage: { totalTokens: 12, cost: { total: 0.5 } },
  })
  const good = classifyTurn({ eventsText: ok, outputText: 'ARM-A', facts: { exitCode: 0 } })
  assert.equal(good.status, 'ok')
  assert.equal(good.chars, 5)
  assert.equal(good.tokens, 12)
  assert.equal(good.cost, 0.5)

  const empty = classifyTurn({ eventsText: ok, outputText: '   \n', facts: { exitCode: 0 } })
  assert.equal(empty.status, 'empty')

  const timeout = classifyTurn({ eventsText: ok, outputText: 'ARM-A', facts: { exitCode: 0, timedOut: true } })
  assert.equal(timeout.status, 'timeout')

  const aborted = classifyTurn({ eventsText: ok, outputText: 'ARM-A', facts: { exitCode: 0, aborted: true } })
  assert.equal(aborted.status, 'aborted')

  const died = classifyTurn({ eventsText: '', outputText: '', facts: { exitCode: 3 } })
  assert.equal(died.status, 'error')
})

test('summarize 只把 ok 记成 ok', () => {
  const summary = summarize([
    { status: 'ok' },
    { status: 'ok' },
    { status: 'empty' },
    { status: 'error' },
    { status: 'timeout' },
    { status: 'aborted' },
    { status: 'mystery' },
  ])
  assert.deepEqual(summary, { arms: 7, ok: 2, empty: 1, error: 2, timeout: 1, aborted: 1 })
})
