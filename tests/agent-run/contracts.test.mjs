import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCli } from '../../tools/agent-run/cli.mjs'
import { createCodexRunner } from '../../lib/agent-run/runners/codex.mjs'
import { buildAgentPromptArg } from '../../lib/agent-run/runners/agent.mjs'
import { runAgentTurn } from '../../lib/agent-run/run-agent-turn.mjs'
import { readFileSync } from 'node:fs'

test('unsupported invocation options fail before creating artifacts or spawning', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-contract-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const prompt = join(dir, 'task.md')
  writeFileSync(prompt, 'Reply in plain text')
  for (const options of [
    ['--runner', 'codex', '--session', 'existing-session', '--sandbox', 'read-only'],
    ['--runner', 'codex', '--provider', 'sub2api'],
    ['--runner', 'agent', '--provider', 'sub2api'],
  ]) {
    let stdout = '', stderr = ''
    const out = join(dir, 'artifacts')
    const code = await runCli(['run', '--workdir', dir, '--prompt-file', prompt, '--out-dir', out, ...options], {
      stdout: (text) => { stdout += text }, stderr: (text) => { stderr += text },
    })
    assert.equal(code, 2)
    assert.equal(stdout, '')
    assert.equal(JSON.parse(stderr).status, 'error')
    assert.equal(existsSync(out), false)
  }
  assert.throws(() => createCodexRunner({ sandbox: 'read-only' }).runTurn({ session: 'existing' }), /sandbox override/)
})

test('file-backed prompts delegate the requested format without an outcome protocol', () => {
  const prompt = buildAgentPromptArg({ promptFile: 'C:/task with spaces.md' })
  assert.ok(prompt.includes('C:/task with spaces.md'))
  assert.ok(!prompt.includes('JSON'))
  assert.equal(buildAgentPromptArg({ prompt: 'Reply with a poem' }), 'Reply with a poem')
})

test('split UTF-8 stdout chunks preserve final text and normalized events', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-utf8-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const fake = join(dir, 'split.mjs')
  writeFileSync(fake, `const text = '\\u4e2d\\u6587';
const bytes = Buffer.from(JSON.stringify({type:'result',subtype:'success',result:text})+'\\n');
const cut = bytes.indexOf(Buffer.from(text)) + 1;
process.stdout.write(bytes.subarray(0,cut));
setTimeout(()=>process.stdout.write(bytes.subarray(cut)),100);`)
  const outputFile = join(dir, 'answer.txt')
  const eventsFile = join(dir, 'events.jsonl')
  const result = await runAgentTurn({ runner: 'agent', bin: fake, workdir: dir, prompt: 'test',
    outFile: outputFile, eventsFile, logFile: join(dir, 'log.txt') })
  assert.equal(result.exitCode, 0)
  assert.equal(readFileSync(outputFile, 'utf8'), '\u4e2d\u6587')
  assert.ok(readFileSync(eventsFile, 'utf8').includes('\u4e2d\u6587'))
})
