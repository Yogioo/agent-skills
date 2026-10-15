/**
 * normalize-event golden fixtures plus normalize CLI behavior.
 *
 *   node --test tests/agent-run/normalize.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  detectSource,
  extractJsonFromText,
  extractOutTextFromRaw,
  normalizeAgentEvent,
  normalizeCodexEvent,
  normalizeEvent,
  normalizePiEvent,
} from '../../lib/agent-events.mjs'
import { parseStreamJsonChunk } from '../../lib/agent-run/runners/spawn-agent-turn.mjs'
import { runCli } from '../../tools/agent-run/cli.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(__dirname, 'fixtures')

function loadFixture(name) {
  return readFileSync(join(FIXTURES, name), 'utf8').trim().split('\n').filter(Boolean)
}

function capture() {
  const out = []
  const err = []
  return {
    io: { stdout: (t) => out.push(t), stderr: (t) => err.push(t) },
    stdout: () => out.join(''),
    stderr: () => err.join(''),
  }
}

test('normalizeAgentEvent maps assistant / tool / outcome', () => {
  assert.deepEqual(
    normalizeAgentEvent({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'hi' }] },
    }).kind,
    'assistant',
  )
  assert.deepEqual(normalizeAgentEvent({ type: 'result', result: '{"status":"done"}' }).kind, 'outcome')
  const tool = normalizeAgentEvent({
    type: 'tool_call',
    subtype: 'started',
    call_id: 'c1',
    tool_call: { readToolCall: { args: { path: 'a.txt' } } },
  })
  assert.equal(tool.kind, 'tool')
  assert.equal(tool.toolName, 'read')
  assert.equal(tool.phase, 'start')
})

test('normalizeCodexEvent maps items', () => {
  const tool = normalizeCodexEvent({
    type: 'item.completed',
    item: { id: 'i1', type: 'command_execution', command: 'ls', exit_code: 0, output: 'a' },
  })
  assert.equal(tool.kind, 'tool')
  assert.equal(tool.phase, 'done')
  assert.equal(tool.toolName, 'shell')
  const msg = normalizeCodexEvent({ type: 'item.completed', item: { type: 'agent_message', text: 'yo' } })
  assert.equal(msg.kind, 'assistant')
  assert.equal(msg.text, 'yo')
})

test('normalizePiEvent maps tools and messages', () => {
  const tool = normalizePiEvent({
    type: 'tool_execution_end',
    toolCallId: 'tc1',
    toolName: 'read',
    result: { content: 'x' },
  })
  assert.equal(tool.kind, 'tool')
  assert.equal(tool.phase, 'done')
  const msg = normalizePiEvent({
    type: 'message_end',
    message: { role: 'assistant', content: [{ type: 'text', text: '{"status":"done"}' }] },
  })
  assert.equal(msg.kind, 'assistant')
})

test('fixtures produce stable normalized kinds', () => {
  const agent = loadFixture('agent-stream.jsonl').map((l) => normalizeEvent(JSON.parse(l), 'agent'))
  assert.deepEqual(agent.map((e) => e.kind), ['raw', 'raw', 'assistant', 'tool', 'tool', 'assistant', 'outcome'])
  const codex = loadFixture('codex-json.jsonl').map((l) => normalizeEvent(JSON.parse(l), 'codex'))
  assert.deepEqual(codex.map((e) => e.kind), ['raw', 'raw', 'tool', 'tool', 'assistant', 'tool', 'raw'])
  const pi = loadFixture('pi-json.jsonl').map((l) => normalizeEvent(JSON.parse(l), 'pi'))
  assert.deepEqual(pi.map((e) => e.kind), ['raw', 'raw', 'raw', 'raw', 'tool', 'tool', 'assistant', 'outcome', 'outcome'])
})

test('auto detection and out-text extraction', () => {
  assert.equal(detectSource({ type: 'tool_call' }), 'agent')
  assert.equal(detectSource({ type: 'session' }), 'pi')
  assert.equal(detectSource({ type: 'item.completed' }), 'codex')
  assert.equal(extractJsonFromText('```json\n{"status":"done"}\n```').status, 'done')
  assert.equal(
    extractOutTextFromRaw(
      { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'x' }] } },
      'pi',
    ),
    'x',
  )
})

test('parseStreamJsonChunk handles split NDJSON', () => {
  const part = parseStreamJsonChunk(
    '{"type":"assistant","message":{"content":[{"type":"text","text":"a"}]}}\n',
    '',
    'agent',
  )
  assert.equal(part.rawEvents.length, 1)
  const split = parseStreamJsonChunk('{"type":"assistant"', '{"message":{}}\n', 'agent')
  assert.equal(split.rawEvents.length, 1)
})

test('normalize CLI writes new JSONL and reports a count', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ar-norm-'))
  const input = join(dir, 'in.jsonl')
  const output = join(dir, 'out.jsonl')
  writeFileSync(input, loadFixture('pi-json.jsonl').join('\n') + '\n')
  const cap = capture()
  try {
    const code = await runCli(['normalize', '--runner', 'pi', '--input', input, '--output', output], cap.io)
    assert.equal(code, 0)
    const summary = JSON.parse(cap.stdout().trim())
    assert.equal(summary.eventCount, 9)
    const lines = readFileSync(output, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    assert.equal(lines.length, 9)
    assert.ok(lines.every((e) => !('runner' in e)))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('normalize CLI rejects malformed JSONL without writing output', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ar-bad-'))
  const input = join(dir, 'in.jsonl')
  const output = join(dir, 'out.jsonl')
  writeFileSync(input, '{"type":"result"}\nnot json\n')
  const cap = capture()
  try {
    const code = await runCli(['normalize', '--runner', 'agent', '--input', input, '--output', output], cap.io)
    assert.equal(code, 2)
    assert.match(cap.stderr(), /Invalid JSONL at line 2/)
    assert.ok(!existsSync(output))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('normalize CLI refuses an existing output and an empty input', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ar-empty-'))
  const input = join(dir, 'in.jsonl')
  writeFileSync(input, '   \n')
  const existing = join(dir, 'exists.jsonl')
  writeFileSync(existing, 'x')
  const cap = capture()
  try {
    assert.equal(await runCli(['normalize', '--runner', 'pi', '--input', input, '--output', existing], cap.io), 2)
    assert.equal(await runCli(['normalize', '--runner', 'pi', '--input', input, '--output', join(dir, 'new.jsonl')], cap.io), 2)
    assert.match(cap.stderr(), /no JSONL records/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
