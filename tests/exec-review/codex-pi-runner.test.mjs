/**
 * codex / pi runner 单元测试（argv / dry-run / events）。
 *
 *   node --test tests/exec-review/codex-pi-runner.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

import { createCodexRunner } from '../../skills/exec-review/scripts/runners/codex.mjs'
import { createPiRunner } from '../../skills/exec-review/scripts/runners/pi.mjs'
import { createRunner } from '../../skills/exec-review/scripts/runners/index.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SKILL = join(__dirname, '..', '..', 'skills', 'exec-review')
const RUN = join(SKILL, 'scripts', 'run-task.mjs')

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
      { cwd: SKILL, stdio: ['ignore', 'pipe', 'pipe'] },
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
