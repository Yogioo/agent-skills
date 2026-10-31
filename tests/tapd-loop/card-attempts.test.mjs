/**
 * 「同一张卡最多自动跑 N 次」+「同一处错误连挂几张就停批」。
 *
 * 钉住三件事：
 *   1. 还有额度时只放回队列（不打 afk-failed），到次数才真打住；
 *   2. 失败签名只看「规则 + 位置」，不看 message 里那些每次都变的东西；
 *   3. 两个数都是配置（想改成 3 次只改配置）。
 *
 *   node --test tests/tapd-loop/card-attempts.test.mjs
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { failureSignature, finishFailed, loadConfig, shouldRequeue } from '../../skills/tapd-loop/scripts/loop.mjs'

test('还有额度就放回队列，额度用完才打住（默认 2 次）', () => {
  assert.equal(shouldRequeue({ attempt: 1, maxCardAttempts: 2 }), true)
  assert.equal(shouldRequeue({ attempt: 2, maxCardAttempts: 2 }), false)
  assert.equal(shouldRequeue({ attempt: 3, maxCardAttempts: 2 }), false)
})

test('改成 3 次就是 1/2 放回、3 打住', () => {
  assert.equal(shouldRequeue({ attempt: 1, maxCardAttempts: 3 }), true)
  assert.equal(shouldRequeue({ attempt: 2, maxCardAttempts: 3 }), true)
  assert.equal(shouldRequeue({ attempt: 3, maxCardAttempts: 3 }), false)
})

test('maxCardAttempts=1 = 老行为（一次就判死）', () => {
  assert.equal(shouldRequeue({ attempt: 1, maxCardAttempts: 1 }), false)
  assert.equal(shouldRequeue({ attempt: 1 }), false)
})

test('签名：测试失败取「规则+用例全名」，message 变了也不影响', () => {
  const a = '  ERR  [test] Hlwd.Game.Tests.EnemyInfoExportTests.LanguageRowsProvideEnemyName  Desc_Enemy_20205'
  const b = '  ERR  [test] Hlwd.Game.Tests.EnemyInfoExportTests.LanguageRowsProvideEnemyName  另一个不一样的报错 12345'
  assert.equal(failureSignature(a), 'test:Hlwd.Game.Tests.EnemyInfoExportTests.LanguageRowsProvideEnemyName')
  assert.equal(failureSignature(a), failureSignature(b))
})

test('签名：不同用例 / 不同规则对不上', () => {
  const one = '  ERR  [test] A.Tests.One  boom'
  const two = '  ERR  [test] A.Tests.Two  boom'
  assert.notEqual(failureSignature(one), failureSignature(two))
  const compile = '  ERR  [compile] Assets/Scripts/Game/Foo.cs:42  CS1002: 应输入 ;'
  assert.equal(failureSignature(compile), 'compile:Assets/Scripts/Game/Foo.cs')
  // 同一文件换行号算同一处
  assert.equal(failureSignature(compile), failureSignature('  ERR  [compile] Assets/Scripts/Game/Foo.cs:88  CS1002: 应输入 ;'))
})

test('签名：门禁自己没验（gate）也算一处，能连挂判停', () => {
  const line = '  ERR  [gate] no.such.assembly.tests  门禁没验：映射到的程序集一个用例都没跑到'
  assert.equal(failureSignature(line), 'gate:no.such.assembly.tests')
})

test('签名：没有 ERR 行（超时 / 环境问题 / 没日志）返回空串，不参与连挂判定', () => {
  assert.equal(failureSignature(''), '')
  assert.equal(failureSignature('== 验证门：环境问题，没验证完 =='), '')
  assert.equal(failureSignature(undefined), '')
})

test('默认配置：最多 2 次、连挂 2 张停批', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tapd-attempts-'))
  try {
    const cfgFile = join(dir, 'cfg.json')
    writeFileSync(cfgFile, '{}', 'utf8')
    const cfg = loadConfig(dir, { config: cfgFile })
    assert.equal(cfg.run.maxCardAttempts, 2)
    assert.equal(cfg.run.stopOnSameFailure, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('配置能改次数，也能关掉连挂停批（0）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tapd-attempts-'))
  try {
    const cfgFile = join(dir, 'cfg.json')
    writeFileSync(cfgFile, JSON.stringify({ run: { maxCardAttempts: 3, stopOnSameFailure: 0 } }), 'utf8')
    const cfg = loadConfig(dir, { config: cfgFile })
    assert.equal(cfg.run.maxCardAttempts, 3)
    assert.equal(cfg.run.stopOnSameFailure, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// —— 下面是真正走一遍失败收尾：标签该不该摘，看 tapd 侧收到的是 requeue 还是 fail ——
function fakeEnv({ attempt, maxCardAttempts = 2 }) {
  const calls = []
  const dir = mkdtempSync(join(tmpdir(), 'tapd-fail-'))
  const card = { id: '1152360842001005219', title: '测试卡', priority: 0, priorityLabel: '', status: 'status_11' }
  const ctx = {
    tapd: {
      labels: { claimedLabel: 'afk-claimed', readyLabel: 'ready-for-agent', failedLabel: 'afk-failed' },
      fail: (id, note) => calls.push({ kind: 'fail', id, note }),
      requeue: (id, note) => calls.push({ kind: 'requeue', id, note }),
    },
    git: {
      keepDirtyAs: () => null,
      rollback: () => {},
      diff: () => '',
      parentOf: () => '',
      resetHard: () => {},
      keepAside: () => '',
    },
    baseline: 'aaaaaaa1111',
    log: () => {},
    args: { noWrite: false },
    cfg: { run: { maxCardAttempts } },
    attempt,
    signature: 'test:A.Tests.One',
  }
  return { calls, dir, card, ctx, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('失败第 1 次：只 requeue（不打 afk-failed），评论告诉人还剩几次', () => {
  const env = fakeEnv({ attempt: 1 })
  try {
    const out = finishFailed(env.card, '验证命令失败（exit 1）', env.dir, new Date(), env.ctx)
    assert.equal(env.calls.length, 1)
    assert.equal(env.calls[0].kind, 'requeue')
    assert.match(env.calls[0].note, /第 1\/2 次/)
    assert.match(env.calls[0].note, /自动放回队列/)
    assert.equal(out.status, 'failed')
    assert.equal(out.requeued, true)
    assert.equal(out.attempt, 1)
    assert.equal(out.signature, 'test:A.Tests.One')
  } finally {
    env.cleanup()
  }
})

test('失败到次数：走老的 fail()，并告诉人怎么重跑', () => {
  const env = fakeEnv({ attempt: 2 })
  try {
    const out = finishFailed(env.card, '验证命令失败（exit 1）', env.dir, new Date(), env.ctx)
    assert.equal(env.calls.length, 1)
    assert.equal(env.calls[0].kind, 'fail')
    assert.match(env.calls[0].note, /第 2\/2 次/)
    assert.match(env.calls[0].note, /--retry 1152360842001005219/)
    assert.equal(out.requeued, false)
  } finally {
    env.cleanup()
  }
})

test('只演练（no-write）时不动 TAPD', () => {
  const env = fakeEnv({ attempt: 1 })
  env.ctx.args.noWrite = true
  try {
    finishFailed(env.card, '验证命令失败（exit 1）', env.dir, new Date(), env.ctx)
    assert.equal(env.calls.length, 0)
  } finally {
    env.cleanup()
  }
})
