/**
 * argv mapping and capability tests for all three runners.
 *
 *   node --test tests/agent-run/argv.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  applyThinkingToModel,
  buildAgentArgs,
  buildAgentPromptArg,
  createAgentRunner,
  mapAgentSandbox,
} from '../../lib/agent-run/runners/agent.mjs'
import { createCodexRunner } from '../../lib/agent-run/runners/codex.mjs'
import { createPiRunner } from '../../lib/agent-run/runners/pi.mjs'
import {
  RUNNERS,
  capabilities,
  createRunner,
  runnerSessionMode,
} from '../../lib/agent-run/runners/index.mjs'

/** dry-run writes the full command line into the log, so argv is observable. */
async function argvOf(runner, dir, tag, extra = {}) {
  const paths = {
    outFile: join(dir, `${tag}.out`),
    logFile: join(dir, `${tag}.log`),
    eventsFile: join(dir, `${tag}.jsonl`),
  }
  await runner.runTurn({ workdir: dir, prompt: 'task', ...paths, dryRun: true, ...extra })
  return readFileSync(paths.logFile, 'utf8').replace(/^\[dry-run\] \$\s*/, '').replace(/\s+/g, ' ')
}

test('RUNNERS and runnerSessionMode expose all three tiers', () => {
  assert.deepEqual([...RUNNERS].sort(), ['agent', 'codex', 'pi'])
  assert.equal(createRunner('pi').name, 'pi')
  assert.equal(createRunner('codex').name, 'codex')
  assert.equal(createRunner('agent').name, 'agent')
  assert.equal(runnerSessionMode('pi'), 'create-or-resume')
  assert.equal(runnerSessionMode('codex'), 'resume')
  assert.equal(runnerSessionMode('agent'), 'none')
  assert.throws(() => createRunner('nope'), /未知 runner/)
})

test('capabilities reports limitations for each runner', () => {
  const all = capabilities()
  assert.equal(all.runners.length, 3)
  const agent = capabilities('agent').runners[0]
  assert.equal(agent.sessionMode, 'none')
  assert.equal(agent.outputSchema, false)
  assert.ok(agent.limitations.length > 0)
  const codex = capabilities('codex').runners[0]
  assert.equal(codex.outputSchema, true)
  assert.throws(() => capabilities('nope'), /未知 runner/)
})

test('pi: session yields --session-id, fresh turn yields --no-session', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ar-pi-'))
  try {
    const runner = createPiRunner()
    const fresh = await argvOf(runner, dir, 'fresh')
    assert.match(fresh, /--no-session/)
    assert.ok(!fresh.includes('--session-id'))

    const resumed = await argvOf(runner, dir, 'resumed', { session: 'sess-abc' })
    assert.match(resumed, /--session-id sess-abc/)
    assert.ok(!resumed.includes('--no-session'))

    const readOnly = await argvOf(runner, dir, 'ro', { sandbox: 'read-only' })
    assert.match(readOnly, /--exclude-tools write,edit/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('codex: fresh uses -C/-s, resume drops them and cannot create', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ar-codex-'))
  try {
    const runner = createCodexRunner()
    const fresh = await argvOf(runner, dir, 'fresh')
    assert.match(fresh, /codex exec -C /)
    assert.match(fresh, /-s workspace-write/)
    assert.match(fresh, /--color never/)

    const resumed = await argvOf(runner, dir, 'resumed', { session: 'abc-123' })
    assert.match(resumed, /codex exec resume abc-123/)
    assert.ok(!/ -C /.test(resumed))
    assert.ok(!/ -s /.test(resumed))
    assert.ok(!resumed.includes('--color'))
    assert.match(resumed, /--json/)

    const schema = await argvOf(runner, dir, 'schema', { schemaFile: 'schema.json' })
    assert.match(schema, /--output-schema schema\.json/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('codex is the only runner accepting a schema', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ar-schema-'))
  try {
    const turn = {
      workdir: dir,
      prompt: 'task',
      outFile: join(dir, 'o'),
      logFile: join(dir, 'l'),
      eventsFile: join(dir, 'e'),
      schemaFile: 'schema.json',
    }
    assert.throws(() => createPiRunner().runTurn({ ...turn, dryRun: true }), /不支持 --output-schema/)
    assert.throws(() => createAgentRunner().runTurn({ ...turn, dryRun: true }), /不支持 --output-schema/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('agent: no role permissions and a rejected resume', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ar-agent-'))
  try {
    const runner = createAgentRunner()
    const fresh = await argvOf(runner, dir, 'fresh')
    assert.match(fresh, /^agent -p --output-format stream-json --workspace /)
    assert.match(fresh, /--trust/)
    assert.match(fresh, /--force/)
    assert.match(fresh, /--sandbox enabled/)

    const noApprove = await argvOf(createAgentRunner({ approve: false }), dir, 'noapprove')
    assert.ok(!noApprove.includes('--force'))
    assert.ok(!noApprove.includes('--approve-mcps'))

    assert.throws(
      () => runner.runTurn({
        workdir: dir,
        prompt: 'task',
        outFile: join(dir, 'o'),
        logFile: join(dir, 'l'),
        eventsFile: join(dir, 'e'),
        session: 'sess-abc',
        dryRun: true,
      }),
      /不支持续会话/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('agent sandbox mapping and thinking fold', () => {
  assert.deepEqual(mapAgentSandbox('read-only'), { mode: 'ask' })
  assert.deepEqual(mapAgentSandbox('danger-full-access'), { sandbox: 'disabled' })
  assert.deepEqual(mapAgentSandbox('workspace-write'), { sandbox: 'enabled' })
  assert.equal(applyThinkingToModel('composer-2.5', 'high'), 'composer-2.5[effort=high]')
  assert.equal(applyThinkingToModel('composer-2.5[effort=low]', 'high'), 'composer-2.5[effort=low]')
  assert.equal(applyThinkingToModel('', 'high'), '')
  const args = buildAgentArgs({ workdir: '/tmp', prompt: 'hi' }, { approve: false })
  assert.ok(!args.some((a) => /reviewer|executor/.test(a)))
  assert.match(buildAgentPromptArg({ promptFile: 'C:\\cache\\p.md' }), /C:\/cache\/p\.md/)
})

test('run dry-run writes normalized events without a runner field', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ar-events-'))
  try {
    const paths = {
      outFile: join(dir, 'o'),
      logFile: join(dir, 'l'),
      eventsFile: join(dir, 'e.jsonl'),
    }
    const result = await createPiRunner().runTurn({
      workdir: dir,
      prompt: '{"status":"done"}',
      ...paths,
      dryRun: true,
    })
    assert.equal(result.code, 0)
    const last = JSON.parse(readFileSync(paths.eventsFile, 'utf8').trim().split('\n').at(-1))
    assert.equal(last.kind, 'assistant')
    assert.ok(!('runner' in last))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
