/**
 * 验证门的「环境问题」重试：`run.verifyEnvExitCodes` / `verifyEnvRetries` / `verifyEnvRetryDelaySec`。
 *
 * 钉住的是 2026-10-31 那次 5219 的教训：verify 脚本按约定 exit 2 = 环境问题（Unity 没起来），
 * 而外循环只看「是不是 0」，于是把一张已经干完的卡记成失败（存档分支 + 摘 ready + afk-failed）。
 *
 *   node --test tests/tapd-loop/verify-env-retry.test.mjs
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { runVerifyWithEnvRetry } from '../../skills/tapd-loop/scripts/loop.mjs'

/** 一个假验证脚本：前 flaky 次 exit 2（环境问题），之后 exit 0；code 非空就固定退那个码。 */
function makeVerify(dir, { flaky = 0, code = null } = {}) {
  const counter = join(dir, 'count.txt')
  const script = join(dir, 'verify.mjs')
  writeFileSync(counter, '0', 'utf8')
  writeFileSync(script, [
    "import { readFileSync, writeFileSync } from 'node:fs'",
    `const file = ${JSON.stringify(counter)}`,
    'const n = Number(readFileSync(file, "utf8")) + 1',
    'writeFileSync(file, String(n), "utf8")',
    `const fixed = ${JSON.stringify(code)}`,
    `const flaky = ${Number(flaky)}`,
    'if (fixed !== null) process.exit(fixed)',
    'if (n <= flaky) { console.log("Unity 端点超时（模拟）"); process.exit(2) }',
    'console.log("通过第 " + n + " 次")',
  ].join('\n'), 'utf8')
  return { script, counter, runs: () => Number(readFileSync(counter, 'utf8')) }
}

function setup(options) {
  const root = mkdtempSync(join(tmpdir(), 'tapd-envretry-'))
  const workdir = join(root, 'wt')
  const dir = join(root, 'card')
  mkdirSync(workdir, { recursive: true })
  mkdirSync(dir, { recursive: true })
  const verify = makeVerify(root, options)
  const cfg = {
    run: {
      verify: `"${process.execPath}" "${verify.script}"`,
      verifyEnvExitCodes: options.envCodes === undefined ? [2] : options.envCodes,
      verifyEnvRetries: options.retries ?? 2,
      verifyEnvRetryDelaySec: 0,
    },
  }
  return { root, workdir, dir, cfg, verify, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test('环境问题重跑后通过：不算失败，次数记在 attempts 里', () => {
  const s = setup({ flaky: 2 })
  try {
    const out = runVerifyWithEnvRetry(s.cfg, s.workdir, s.dir)
    assert.equal(out.ok, true)
    assert.equal(out.code, 0)
    assert.equal(out.attempts, 3)
    assert.equal(out.envProblem, false)
    assert.equal(s.verify.runs(), 3)
    const log = readFileSync(join(s.dir, 'verify.log'), 'utf8')
    // 每次尝试都留在 verify.log 里，人看得出「Unity 卡了两次，第三次才过」
    assert.equal((log.match(/环境问题（exit 2）/g) || []).length, 2)
    assert.match(log, /Unity 端点超时/)
    assert.match(log, /通过第 3 次/)
  } finally {
    s.cleanup()
  }
})

test('重跑完还是环境问题：落回失败，但 envProblem 标出来，原因能和人说清', () => {
  const s = setup({ flaky: 99 })
  try {
    const out = runVerifyWithEnvRetry(s.cfg, s.workdir, s.dir)
    assert.equal(out.ok, false)
    assert.equal(out.code, 2)
    assert.equal(out.envProblem, true)
    assert.equal(out.attempts, 3) // 1 次 + 重试 2 次
  } finally {
    s.cleanup()
  }
})

test('代码问题（exit 1）不重试：那是 AI 该回去修的东西，不是等一等就好', () => {
  const s = setup({ code: 1 })
  try {
    const out = runVerifyWithEnvRetry(s.cfg, s.workdir, s.dir)
    assert.equal(out.ok, false)
    assert.equal(out.code, 1)
    assert.equal(out.attempts, 1)
    assert.equal(out.envProblem, false)
    assert.equal(s.verify.runs(), 1)
  } finally {
    s.cleanup()
  }
})

test('没配 verifyEnvExitCodes 的仓库保持旧行为：exit 2 也不重试', () => {
  const s = setup({ code: 2, envCodes: [] })
  try {
    const out = runVerifyWithEnvRetry(s.cfg, s.workdir, s.dir)
    assert.equal(out.ok, false)
    assert.equal(out.code, 2)
    assert.equal(out.attempts, 1)
    assert.equal(out.envProblem, false)
    assert.equal(s.verify.runs(), 1)
  } finally {
    s.cleanup()
  }
})

// 「一个用例都没跑到」不是通过（以前是假绿），也不是环境扇动：自退 3，且不重试。
test('门禁没验（exit 3）：标成 gateProblem，不重试，不当环境问题', () => {
  const s = setup({ code: 3 })
  s.cfg.run.verifyGateExitCodes = [3]
  try {
    const out = runVerifyWithEnvRetry(s.cfg, s.workdir, s.dir)
    assert.equal(out.ok, false)
    assert.equal(out.code, 3)
    assert.equal(out.gateProblem, true)
    assert.equal(out.envProblem, false)
    assert.equal(out.attempts, 1) // 门禁自己坏了，重试不会好
    assert.equal(s.verify.runs(), 1)
  } finally {
    s.cleanup()
  }
})

test('没配 verifyGateExitCodes 时 exit 3 就当普通失败（旧行为）', () => {
  const s = setup({ code: 3 })
  try {
    const out = runVerifyWithEnvRetry(s.cfg, s.workdir, s.dir)
    assert.equal(out.gateProblem, false)
    assert.equal(out.envProblem, false)
    assert.equal(out.attempts, 1)
  } finally {
    s.cleanup()
  }
})
