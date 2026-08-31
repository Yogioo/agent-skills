/**
 * exec-review agent runner 单元测试（参数映射 / 配置解析）。
 *
 *   node --test tests/exec-review/agent-runner.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

import {
  applyThinkingToModel,
  buildAgentArgs,
  buildAgentPromptArg,
  mapAgentSandbox,
  createAgentRunner,
} from '../../skills/exec-review/scripts/runners/agent.mjs'
import { createRunner, RUNNERS } from '../../skills/exec-review/scripts/runners/index.mjs'
import { resolveSettings } from '../../skills/exec-review/scripts/load-config.mjs'
import { resolveBin } from '../../skills/exec-review/scripts/runners/resolve-bin.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SKILL = join(__dirname, '..', '..', 'skills', 'exec-review')
const RUN = join(SKILL, 'scripts', 'run-task.mjs')

test('RUNNERS 包含 agent', () => {
  assert.ok(RUNNERS.includes('agent'))
  assert.equal(createRunner('agent').name, 'agent')
})

test('mapAgentSandbox 映射', () => {
  assert.deepEqual(mapAgentSandbox('read-only'), { mode: 'ask' })
  assert.deepEqual(mapAgentSandbox('danger-full-access'), { sandbox: 'disabled' })
  assert.deepEqual(mapAgentSandbox('workspace-write'), { sandbox: 'enabled' })
})

test('applyThinkingToModel 折进 effort', () => {
  assert.equal(applyThinkingToModel('', 'high'), '')
  assert.equal(applyThinkingToModel('composer-2.5', ''), 'composer-2.5')
  assert.equal(applyThinkingToModel('composer-2.5', 'high'), 'composer-2.5[effort=high]')
  assert.equal(
    applyThinkingToModel('composer-2.5[fast=true]', 'high'),
    'composer-2.5[fast=true,effort=high]',
  )
  assert.equal(
    applyThinkingToModel('composer-2.5[effort=low]', 'high'),
    'composer-2.5[effort=low]',
  )
})

test('buildAgentPromptArg 优先文件指针', () => {
  const viaFile = buildAgentPromptArg({
    prompt: 'LONG',
    promptFile: 'C:\\cache\\executor.prompt.md',
  })
  assert.match(viaFile, /C:\/cache\/executor\.prompt\.md/)
  assert.match(viaFile, /Open and follow/)
  assert.equal(buildAgentPromptArg({ prompt: 'inline only' }), 'inline only')
})

test('buildAgentArgs streamPartialOutput adds flag', () => {
  const args = buildAgentArgs(
    { workdir: '/tmp', prompt: 'hi', sandbox: 'workspace-write' },
    { approve: true, streamPartialOutput: true },
  )
  assert.ok(args.includes('--stream-partial-output'))
})

test('buildAgentArgs 默认带 -p/--trust/--force 与 stream-json', () => {
  const args = buildAgentArgs(
    {
      workdir: 'C:/proj',
      promptFile: 'C:/cache/p.md',
      sandbox: 'danger-full-access',
      model: 'composer-2.5',
      thinking: 'high',
    },
    { approve: true },
  )
  assert.ok(args.includes('-p'))
  assert.ok(args.includes('--trust'))
  assert.ok(args.includes('--force'))
  assert.ok(args.includes('--approve-mcps'))
  assert.ok(args.includes('--output-format'))
  assert.equal(args[args.indexOf('--output-format') + 1], 'stream-json')
  assert.ok(args.includes('--workspace'))
  assert.equal(args[args.indexOf('--workspace') + 1], 'C:/proj')
  assert.equal(args[args.indexOf('--sandbox') + 1], 'disabled')
  assert.equal(args[args.indexOf('--model') + 1], 'composer-2.5[effort=high]')
  assert.match(args.at(-1), /C:\/cache\/p\.md/)
})

test('buildAgentArgs approve=false 不加 --force', () => {
  const args = buildAgentArgs(
    { workdir: '/tmp', prompt: 'hi', sandbox: 'workspace-write' },
    { approve: false },
  )
  assert.ok(!args.includes('--force'))
  assert.ok(!args.includes('--approve-mcps'))
  assert.equal(args[args.indexOf('--sandbox') + 1], 'enabled')
})

test('createAgentRunner dry-run 写 outcome 占位与 events', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'er-agent-'))
  try {
    const outFile = join(dir, 'out.md')
    const logFile = join(dir, 'log.txt')
    const eventsFile = join(dir, 'events.jsonl')
    const runner = createAgentRunner({ approve: true })
    const result = await runner.runTurn({
      workdir: dir,
      prompt: '{"status":"done"}',
      outFile,
      logFile,
      eventsFile,
      dryRun: true,
    })
    assert.equal(result.code, 0)
    assert.equal(result.dryRun, true)
    assert.match(readFileSync(outFile, 'utf8'), /blocked/)
    assert.match(readFileSync(logFile, 'utf8'), /\[dry-run\]/)
    const events = readFileSync(eventsFile, 'utf8').trim().split('\n')
    assert.ok(events.length >= 1)
    const last = JSON.parse(events.at(-1))
    assert.equal(last.kind, 'outcome')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resolveSettings 对 agent 默认 bin=agent', () => {
  const settings = resolveSettings(
    { runner: 'agent' },
    { path: 'x', data: { runner: 'agent' } },
  )
  assert.equal(settings.executor.runner, 'agent')
  assert.equal(settings.executor.bin, 'agent')
  assert.equal(settings.reviewer.runner, 'agent')
})

test('resolveBin(agent) 在 Windows 上优先直连 cursor-agent index.js', () => {
  if (process.platform !== 'win32') return
  const resolved = resolveBin('agent', { knownName: 'agent' })
  assert.equal(resolved.shell, false)
  assert.match(resolved.command, /node\.exe$/i)
  assert.equal(resolved.argsPrefix.length, 1)
  assert.match(resolved.argsPrefix[0], /index\.js$/i)
})

function runDryRun(workdir, cacheDir, extraArgs = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        RUN,
        '--workdir',
        workdir,
        '--title',
        'agent dry',
        '--body',
        'smoke',
        '--dry-run',
        '--no-serve',
        '--runner',
        'agent',
        '--cache-dir',
        cacheDir,
        ...extraArgs,
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
        resolve({ summary: JSON.parse(stdout.trim()), stderr })
      } catch (err) {
        reject(new Error(`无法解析 dry-run 摘要: ${err.message}\n${stdout}`))
      }
    })
  })
}

test('dry-run --runner agent 能跑通并写 executor.log 与 events', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'er-agent-wd-'))
  const cache = mkdtempSync(join(tmpdir(), 'er-agent-cache-'))
  try {
    const { summary } = await runDryRun(workdir, cache)
    assert.ok(summary.cacheDir)
    const log = readFileSync(join(summary.cacheDir, 'executor.log'), 'utf8')
    assert.match(log, /\[dry-run\]/)
    assert.match(log, /-p/)
    assert.match(log, /--trust/)
    assert.match(log, /--force/)
    assert.match(log, /stream-json/)
    const events = readFileSync(join(summary.cacheDir, 'executor.events.jsonl'), 'utf8')
    assert.match(events, /"kind":"outcome"/)
  } finally {
    rmSync(workdir, { recursive: true, force: true })
    rmSync(cache, { recursive: true, force: true })
  }
})
