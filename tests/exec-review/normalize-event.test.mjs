/**
 * normalize-event 单元测试 + 三 runner fixture golden。
 *
 *   node --test tests/exec-review/normalize-event.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  normalizeEvent,
  normalizeAgentEvent,
  normalizeCodexEvent,
  normalizePiEvent,
  detectSource,
  extractJsonFromText,
  extractJsonFromEventsFile,
  extractOutTextFromRaw,
} from '../../skills/exec-review/scripts/normalize-event.mjs'
import { parseStreamJsonChunk } from '../../skills/exec-review/scripts/runners/spawn-agent-turn.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(__dirname, 'fixtures')

function loadFixture(name) {
  return readFileSync(join(FIXTURES, name), 'utf8').trim().split('\n').filter(Boolean)
}

test('normalizeAgentEvent 映射 assistant / tool / outcome / raw', () => {
  const assistant = normalizeAgentEvent({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'hi' }] },
  })
  assert.equal(assistant.kind, 'assistant')
  assert.equal(assistant.text, 'hi')

  const toolStart = normalizeAgentEvent({
    type: 'tool_call',
    subtype: 'started',
    call_id: 'c1',
    tool_call: { readToolCall: { args: { path: 'a.txt' } } },
  })
  assert.equal(toolStart.kind, 'tool')
  assert.equal(toolStart.phase, 'start')
  assert.equal(toolStart.callId, 'c1')
  assert.equal(toolStart.toolName, 'read')

  const toolDone = normalizeAgentEvent({
    type: 'tool_call',
    subtype: 'completed',
    call_id: 'c1',
    tool_call: { readToolCall: { result: { success: { content: 'x' } } } },
  })
  assert.equal(toolDone.phase, 'done')

  const outcome = normalizeAgentEvent({
    type: 'result',
    subtype: 'success',
    result: '{"status":"done"}',
  })
  assert.equal(outcome.kind, 'outcome')
  assert.equal(outcome.text, '{"status":"done"}')

  const raw = normalizeAgentEvent({ type: 'system', subtype: 'init' })
  assert.equal(raw.kind, 'raw')

  const partial = normalizeAgentEvent({
    type: 'assistant',
    subtype: 'partial',
    message: { content: [{ type: 'text', text: 'Hel' }] },
  })
  assert.equal(partial.kind, 'assistant_partial')
  assert.equal(partial.text, 'Hel')
})

test('agent fixture → normalized golden', () => {
  const normalized = loadFixture('agent-stream.jsonl').map((line) =>
    normalizeEvent(JSON.parse(line), 'agent'),
  )
  assert.deepEqual(
    normalized.map((e) => e.kind),
    ['raw', 'raw', 'assistant', 'tool', 'tool', 'assistant', 'outcome'],
  )
  assert.equal(normalized[2].text, "I'll read the file")
  assert.equal(normalized[4].callId, 'call-1')
  assert.equal(extractJsonFromText(normalized[6].text)?.status, 'done')
})

test('codex fixture → normalized golden', () => {
  const normalized = loadFixture('codex-json.jsonl').map((line) =>
    normalizeEvent(JSON.parse(line), 'codex'),
  )
  assert.deepEqual(
    normalized.map((e) => e.kind),
    ['raw', 'raw', 'tool', 'tool', 'assistant', 'tool', 'raw'],
  )
  assert.equal(normalized[2].phase, 'start')
  assert.equal(normalized[2].toolName, 'shell')
  assert.equal(normalized[3].phase, 'done')
  assert.equal(normalized[4].text, 'Found auth module.')
  assert.equal(normalized[5].toolName, 'edit')
})

test('pi fixture → normalized golden', () => {
  const normalized = loadFixture('pi-json.jsonl').map((line) =>
    normalizeEvent(JSON.parse(line), 'pi'),
  )
  assert.deepEqual(
    normalized.map((e) => e.kind),
    ['raw', 'raw', 'raw', 'raw', 'tool', 'tool', 'assistant', 'outcome', 'outcome'],
  )
  assert.equal(normalized[4].toolName, 'read')
  assert.equal(normalized[6].text?.includes('"status":"done"'), true)
  assert.equal(extractJsonFromText(normalized[6].text)?.taskId, 'p1')
})

test('normalizeEvent auto-detects runner source', () => {
  assert.equal(detectSource({ type: 'tool_call' }), 'agent')
  assert.equal(detectSource({ type: 'session' }), 'pi')
  assert.equal(detectSource({ type: 'item.completed' }), 'codex')
  assert.equal(normalizeEvent({ type: 'message_end', message: { role: 'assistant', text: 'x' } }).kind, 'assistant')
})

test('normalized events 不含 runner 名', () => {
  for (const line of loadFixture('codex-json.jsonl')) {
    const ev = normalizeEvent(JSON.parse(line), 'codex')
    assert.ok(!('runner' in ev))
    assert.ok(!JSON.stringify(ev).includes('"codex"'))
  }
})

test('parseStreamJsonChunk 处理分块 NDJSON', () => {
  const chunk1 =
    '{"type":"assistant","message":{"content":[{"type":"text","text":"a"}]}}\n{"type":"result","subtype":"success","result":"{\\"status\\":\\"done\\"}"}\n'
  const part = parseStreamJsonChunk(chunk1, '', 'agent')
  assert.equal(part.rawEvents.length, 2)
  assert.equal(part.resultText, '{"status":"done"}')

  const split = parseStreamJsonChunk('{"type":"assistant"', '{"message":{}}\n', 'agent')
  assert.equal(split.rawEvents.length, 1)
})

test('extractOutTextFromRaw pi message_end', () => {
  const raw = {
    type: 'message_end',
    message: { role: 'assistant', content: [{ type: 'text', text: '{"status":"done"}' }] },
  }
  assert.equal(extractOutTextFromRaw(raw, 'pi'), '{"status":"done"}')
})

test('extractJsonFromEventsFile 优先 outcome', () => {
  const tmp = join(tmpdir(), `er-events-${Date.now()}.jsonl`)
  const events = [
    JSON.stringify(normalizeAgentEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'thinking' }] } })),
    JSON.stringify(normalizeAgentEvent({ type: 'result', subtype: 'success', result: '{"status":"done","taskId":"x"}' })),
  ].join('\n') + '\n'
  writeFileSync(tmp, events, 'utf8')
  try {
    const parsed = extractJsonFromEventsFile(tmp)
    assert.equal(parsed?.status, 'done')
    assert.equal(parsed?.taskId, 'x')
  } finally {
    rmSync(tmp, { force: true })
  }
})
