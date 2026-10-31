/**
 * 内循环「卡住看门狗」（`run.turnStallSec`）：进程还活着，但几十秒一个新输出都没有 → 判卡死、杀掉。
 *
 * 为什么要它：总时长上限是给复杂卡的（实测最长 91 分钟，而且是成功的），
 * 但“活着却什么都不发生”只能靠看门狗区分——不然一张卡死了要干等两小时才释放工位。
 *
 * 用假 pi（PI_CLI_JS）来跑，不碰真模型。
 *
 *   node --test tests/tapd-loop/turn-stall.test.mjs
 */

import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { runTurn } from '../../skills/tapd-loop/scripts/turn.mjs'

function setup(fakeBody) {
  const dir = mkdtempSync(join(tmpdir(), 'tapd-stall-'))
  const fake = join(dir, 'fake-pi.mjs')
  writeFileSync(fake, fakeBody, 'utf8')
  const prompt = join(dir, 'prompt.md')
  writeFileSync(prompt, '# 假 brief\n', 'utf8')
  const outDir = join(dir, 'out')
  const prev = process.env.PI_CLI_JS
  process.env.PI_CLI_JS = fake
  return {
    dir,
    prompt,
    outDir,
    restore: () => {
      if (prev === undefined) delete process.env.PI_CLI_JS
      else process.env.PI_CLI_JS = prev
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

const common = (s, extra = {}) => ({
  workdir: s.dir,
  promptFile: s.prompt,
  outDir: s.outDir,
  sessionId: 'tapd-test-stall',
  timeoutMs: 60_000,
  ...extra,
})

test('一直不出声 → 判卡死并杀掉（总超时还没到）', async () => {
  const s = setup('setTimeout(() => {}, 60000)\n')
  try {
    const started = Date.now()
    const r = await runTurn(common(s, { stallSec: 1 }))
    assert.equal(r.stalled, true)
    assert.equal(r.timedOut, false)
    assert.equal(r.stallSec, 1)
    // 看门狗间隔按 stall/4 但下限 2 秒，所以 1 秒阈值大约 2 秒后动手
    assert.ok(Date.now() - started < 20_000, `用时 ${Date.now() - started}ms`)
  } finally {
    s.restore()
  }
})

test('持续有输出就不算卡死，正常结束', async () => {
  const s = setup(
    'let n = 0\n' +
    'const t = setInterval(() => { console.log(JSON.stringify({ type: "message_update", n: n++ })); if (n >= 8) { clearInterval(t); process.exit(0) } }, 200)\n',
  )
  try {
    const r = await runTurn(common(s, { stallSec: 1 }))
    assert.equal(r.stalled, false)
    assert.equal(r.timedOut, false)
    assert.equal(r.code, 0)
  } finally {
    s.restore()
  }
})

test('stallSec=0（默认）时看门狗关着：不出声也不杀', async () => {
  const s = setup('setTimeout(() => process.exit(0), 2500)\n')
  try {
    const r = await runTurn(common(s, { stallSec: 0 }))
    assert.equal(r.stalled, false)
    assert.equal(r.code, 0)
    assert.equal(r.stallSec, 0)
  } finally {
    s.restore()
  }
})
