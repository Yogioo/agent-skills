/**
 * 验证失败 → 让 AI 自己修的护栏（`run.verifyRepair`）。
 *
 * 钉住的是「修复轮不许改尺子」这条：`forbidPaths` 命中就立刻判失败。
 * 这一侧的拦截和门禁自己的 protected-file 规则是两道：门禁拦了只会表现为「验证又失败」，
 * 人分不清是代码没改好还是作弊；外循环自己拦下来才能给出说得清的原因。
 *
 *   node --test tests/tapd-loop/verify-repair.test.mjs
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { forbiddenTouches, loadConfig } from '../../skills/tapd-loop/scripts/loop.mjs'

test('护栏：命中禁止目录（含 Windows 反斜杠路径）', () => {
  const rule = ['.workflow/']
  assert.deepEqual(forbiddenTouches(['.workflow/verify/rules.mjs'], rule), ['.workflow/verify/rules.mjs'])
  assert.deepEqual(forbiddenTouches(['.workflow\\verify\\verify_unity.mjs'], rule), ['.workflow\\verify\\verify_unity.mjs'])
  assert.deepEqual(forbiddenTouches(['Assets/Scripts/Game/Foo.cs'], rule), [])
})

test('护栏：写具体文件也算，前后缀不会误伤', () => {
  const rule = ['.workflow/config.mjs']
  assert.deepEqual(forbiddenTouches(['.workflow/config.mjs'], rule), ['.workflow/config.mjs'])
  assert.deepEqual(forbiddenTouches(['.workflow/config.mjs.bak'], rule), [])
  assert.deepEqual(forbiddenTouches(['.workflow/config.mjsx'], rule), [])
  // 目录前缀只按整段比：`.workflow2/` 不该被 `.workflow/` 命中
  assert.deepEqual(forbiddenTouches(['.workflow2/x.js'], ['.workflow/']), [])
})

test('护栏：没配 / 空数组 = 不拦（保持旧行为）', () => {
  assert.deepEqual(forbiddenTouches(['.workflow/verify/rules.mjs'], []), [])
  assert.deepEqual(forbiddenTouches(['.workflow/verify/rules.mjs'], undefined), [])
  assert.deepEqual(forbiddenTouches(undefined, ['.workflow/']), [])
})

test('护栏：多条命中不重复报（一条路径只算一次）', () => {
  const hits = forbiddenTouches(['.workflow/verify/rules.mjs'], ['.workflow/', '.workflow/verify/'])
  assert.equal(hits.length, 1)
})

test('默认配置：verifyRepair 关着，禁止路径默认是 .workflow/', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tapd-repair-'))
  try {
    const cfgFile = join(dir, 'cfg.json')
    writeFileSync(cfgFile, '{}', 'utf8')
    const cfg = loadConfig(dir, { config: cfgFile })
    assert.equal(cfg.run.verifyRepair.enabled, false)
    assert.equal(cfg.run.verifyRepair.maxRounds, 2)
    assert.deepEqual(cfg.run.verifyRepair.forbidPaths, ['.workflow/'])
    // 环境/门禁两组退出码默认也要是空的：不开就完全保持旧行为。
    assert.deepEqual(cfg.run.verifyEnvExitCodes, [])
    assert.deepEqual(cfg.run.verifyGateExitCodes, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('仓库配置能打开 verifyRepair 并加禁止路径（deepMerge 不吞嵌套键）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tapd-repair-'))
  try {
    const cfgFile = join(dir, 'cfg.json')
    writeFileSync(cfgFile, JSON.stringify({
      run: { verifyRepair: { enabled: true, maxRounds: 1, forbidPaths: ['.workflow/', 'Assets/Tests/'] } },
    }), 'utf8')
    const cfg = loadConfig(dir, { config: cfgFile })
    assert.equal(cfg.run.verifyRepair.enabled, true)
    assert.equal(cfg.run.verifyRepair.maxRounds, 1)
    assert.deepEqual(cfg.run.verifyRepair.forbidPaths, ['.workflow/', 'Assets/Tests/'])
    // 没覆盖的兄弟键还在
    assert.equal(cfg.run.verifyRepair.timeoutSec, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
