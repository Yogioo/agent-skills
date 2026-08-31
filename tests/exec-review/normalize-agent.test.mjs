/**
 * normalize-agent 单元测试 + stream-json fixture golden。
 *
 *   node --test tests/exec-review/normalize-agent.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  normalizeAgentEvent,
  extractJsonFromText,
  extractJsonFromEventsFile,
} from '../../skills/exec-review/scripts/normalize-agent.mjs'
import { parseStreamJsonChunk } from '../../skills/exec-review/scripts/runners/spawn-agent-turn.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

const STREAM_FIXTURE = [
  '{"type":"system","subtype":"init","cwd":"/proj","session_id":"s1","model":"Test"}',
  '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Do task"}]},"session_id":"s1"}',
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"I\'ll read the file"}]},"session_id":"s1"}',
  '{"type":"tool_call","subtype":"started","call_id":"call-1","tool_call":{"readToolCall":{"args":{"path":"README.md"}}},"session_id":"s1"}',
  '{"type":"tool_call","subtype":"completed","call_id":"call-1","tool_call":{"readToolCall":{"args":{"path":"README.md"},"result":{"success":{"content":"hello"}}}},"session_id":"s1"}',
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Done"}]},"session_id":"s1"}',
  '{"type":"result","subtype":"success","result":"{\\"status\\":\\"done\\",\\"taskId\\":\\"t1\\",\\"note\\":\\"ok\\"}","session_id":"s1"}',
].join('\n')

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
  assert.equal(toolStart.toolName, 'readToolCall')

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
})

test('fixture stream-json → normalized golden', () => {
  const rawLines = STREAM_FIXTURE.trim().split('\n')
  const normalized = rawLines.map((line) => normalizeAgentEvent(JSON.parse(line)))
  assert.deepEqual(
    normalized.map((e) => e.kind),
    ['raw', 'raw', 'assistant', 'tool', 'tool', 'assistant', 'outcome'],
  )
  assert.equal(normalized[2].text, "I'll read the file")
  assert.equal(normalized[3].phase, 'start')
  assert.equal(normalized[4].phase, 'done')
  assert.equal(normalized[4].callId, 'call-1')
  assert.equal(extractJsonFromText(normalized[6].text)?.status, 'done')
})

test('parseStreamJsonChunk 处理分块 NDJSON', () => {
  const chunk1 = '{"type":"assistant","message":{"content":[{"type":"text","text":"a"}]}}\n{"type":"result","subtype":"success","result":"{\\"status\\":\\"done\\"}"}\n'
  const part = parseStreamJsonChunk(chunk1)
  assert.equal(part.rawEvents.length, 2)
  assert.equal(part.resultText, '{"status":"done"}')
  assert.equal(part.remainder, '')

  const split = parseStreamJsonChunk('{"type":"assistant"', '{"message":{}}\n')
  assert.equal(split.rawEvents.length, 1)
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
