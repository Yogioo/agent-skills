/**
 * codex / pi runner 单元测试（argv / dry-run / events）。
 *
 *   node --test tests/exec-review/codex-pi-runner.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

import { createCodexRunner } from '../../skills/exec-review/scripts/runners/codex.mjs'
import { createPiRunner } from '../../skills/exec-review/scripts/runners/pi.mjs'
import { createRunner, runnerSessionMode } from '../../skills/exec-review/scripts/runners/index.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SKILL = join(__dirname, '..', '..', 'skills', 'exec-review')
const RUN = join(SKILL, 'scripts', 'run-task.mjs')
// 测试不读开发机的 ~/.afk：自带一份最小配置（run-task 现在要求配置必须存在）
const AFK_HOME = mkdtempSync(join(tmpdir(), 'er-afk-home-'))
writeFileSync(join(AFK_HOME, 'config.json'), JSON.stringify({ execReview: { runner: 'codex' } }))

test('createCodexRunner dry-run 写 events 且 log 含 --json', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'er-codex-'))
  try {
    const outFile = join(dir, 'out.md')
    const logFile = join(dir, 'log.txt')
    const eventsFile = join(dir, 'events.jsonl')
    const runner = createCodexRunner()
    const result = await runner.runTurn({
      workdir: dir,
      prompt: 'task',
      outFile,
      logFile,
      eventsFile,
      dryRun: true,
    })
    assert.equal(result.code, 0)
    assert.match(readFileSync(logFile, 'utf8'), /--json/)
    assert.match(readFileSync(logFile, 'utf8'), /-o/)
    const events = readFileSync(eventsFile, 'utf8').trim().split('\n')
    assert.ok(events.length >= 1)
    const last = JSON.parse(events.at(-1))
    assert.equal(last.kind, 'assistant')
    assert.ok(!('runner' in last))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('createPiRunner dry-run 写 events 且 log 含 --mode json', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'er-pi-'))
  try {
    const outFile = join(dir, 'out.md')
    const logFile = join(dir, 'log.txt')
    const eventsFile = join(dir, 'events.jsonl')
    const runner = createPiRunner()
    const result = await runner.runTurn({
      workdir: dir,
      prompt: '{"status":"done"}',
      outFile,
      logFile,
      eventsFile,
      dryRun: true,
    })
    assert.equal(result.code, 0)
    assert.match(readFileSync(logFile, 'utf8'), /--mode/)
    assert.match(readFileSync(logFile, 'utf8'), /json/)
    const events = readFileSync(eventsFile, 'utf8').trim().split('\n')
    const last = JSON.parse(events.at(-1))
    assert.equal(last.kind, 'assistant')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('RUNNERS 包含 codex 与 pi', () => {
  assert.equal(createRunner('codex').name, 'codex')
  assert.equal(createRunner('pi').name, 'pi')
})

test('runnerSessionMode 报出三档续会话能力', () => {
  // pi 能建能续，codex 只能续，agent 没有已验证的接口。
  // 调用方靠这个值决定是「接上原会话」还是「把上下文重喂一遍」。
  assert.equal(runnerSessionMode('pi'), 'create-or-resume')
  assert.equal(runnerSessionMode('codex'), 'resume')
  assert.equal(runnerSessionMode('agent'), 'none')
  assert.throws(() => runnerSessionMode('并不存在'), /未知 runner/)
})

/** dry-run 会把完整命令行写进 log，所以可以不真调 CLI 就验 argv。 */
async function argvOf(runner, dir, tag, extra = {}) {
  const paths = {
    outFile: join(dir, `${tag}.out`),
    logFile: join(dir, `${tag}.log`),
    eventsFile: join(dir, `${tag}.jsonl`),
  }
  await runner.runTurn({ workdir: dir, prompt: 'task', ...paths, dryRun: true, ...extra })
  return readFileSync(paths.logFile, 'utf8').replace(/^\[dry-run\] \$\s*/, '').replace(/\s+/g, ' ')
}

test('pi：不给 session 就是一次性无痕 turn，给 session 就接着原会话', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'er-pi-session-'))
  try {
    const runner = createPiRunner()

    const plain = await argvOf(runner, dir, 'new')
    assert.match(plain, /--no-session/)
    assert.ok(!plain.includes('--session-id'), '默认不该带 session')

    const resumed = await argvOf(runner, dir, 'resume', { session: 'sess-abc' })
    assert.match(resumed, /--session-id sess-abc/)
    assert.ok(!resumed.includes('--no-session'), '续会话时带 --no-session 会让这一轮不落进原 session')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('codex：续会话走 exec resume，且丢掉 resume 不接受的开关', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'er-codex-session-'))
  try {
    const runner = createCodexRunner()

    const plain = await argvOf(runner, dir, 'new')
    assert.match(plain, /codex exec -C /)
    assert.match(plain, /-s workspace-write/)

    const resumed = await argvOf(runner, dir, 'resume', { session: 'abc-123' })
    assert.match(resumed, /codex exec resume abc-123/)
    // exec resume 不接受 -C / -s / --color（见 references/runners.md）
    assert.ok(!/ -C /.test(resumed), 'resume 不接受 -C；工作目录由 spawn 的 cwd 负责')
    assert.ok(!/ -s /.test(resumed), 'resume 没有沙箱开关')
    assert.ok(!resumed.includes('--color'), 'resume 不接受 --color')
    assert.match(resumed, /--json/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

function runDryRun(workdir, cacheDir, runner) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        RUN,
        '--workdir',
        workdir,
        '--title',
        `${runner} dry`,
        '--body',
        'smoke',
        '--dry-run',
        '--no-serve',
        '--runner',
        runner,
        '--cache-dir',
        cacheDir,
      ],
      { cwd: SKILL, env: { ...process.env, AFK_HOME }, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => (stdout += c))
    child.stderr.on('data', (c) => (stderr += c))
    child.once('error', reject)
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(`dry-run exit=${code}: ${stderr}`))
        return
      }
      try {
        resolve(JSON.parse(stdout.trim()))
      } catch (err) {
        reject(new Error(`无法解析 dry-run 摘要: ${err.message}\n${stdout}`))
      }
    })
  })
}

test('dry-run --runner codex 能跑通并写 events', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'er-codex-wd-'))
  const cache = mkdtempSync(join(tmpdir(), 'er-codex-cache-'))
  try {
    const summary = await runDryRun(workdir, cache, 'codex')
    assert.ok(summary.cacheDir)
    assert.match(readFileSync(join(summary.cacheDir, 'executor.log'), 'utf8'), /--json/)
    assert.match(readFileSync(join(summary.cacheDir, 'executor.events.jsonl'), 'utf8'), /"kind"/)
  } finally {
    rmSync(workdir, { recursive: true, force: true })
    rmSync(cache, { recursive: true, force: true })
  }
})

test('dry-run --runner pi 能跑通并写 events', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'er-pi-wd-'))
  const cache = mkdtempSync(join(tmpdir(), 'er-pi-cache-'))
  try {
    const summary = await runDryRun(workdir, cache, 'pi')
    assert.ok(summary.cacheDir)
    assert.match(readFileSync(join(summary.cacheDir, 'executor.log'), 'utf8'), /json/)
    assert.match(readFileSync(join(summary.cacheDir, 'executor.events.jsonl'), 'utf8'), /"kind"/)
  } finally {
    rmSync(workdir, { recursive: true, force: true })
    rmSync(cache, { recursive: true, force: true })
  }
})
