/**
 * context-ui formatting unit tests.
 *
 *   node --test tests/exec-review/context-ui.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  mapToolName,
  truncateText,
  extractShellFields,
  extractEditWritePreview,
  fmtToolSummary,
  formatToolBody,
  PAYLOAD_TRUNCATE,
} from '../../skills/exec-review/scripts/context-ui.mjs'

const esc = (s) =>
  String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

test('mapToolName strips ToolCall suffix', () => {
  assert.equal(mapToolName('readToolCall'), 'read')
  assert.equal(mapToolName('shell'), 'shell')
})

test('truncateText respects limit', () => {
  const big = 'x'.repeat(PAYLOAD_TRUNCATE + 100)
  const t = truncateText(big, 100)
  assert.equal(t.truncated, true)
  assert.equal(t.text.length, 100)
})

test('extractShellFields from codex-shaped events', () => {
  const fields = extractShellFields(
    { args: { command: 'npm test' } },
    { result: { exit_code: 1, output: 'fail', stderr: 'err' } },
  )
  assert.equal(fields.command, 'npm test')
  assert.equal(fields.exitCode, 1)
  assert.equal(fields.stdout, 'fail')
  assert.equal(fields.stderr, 'err')
})

test('extractEditWritePreview prefers diff body', () => {
  const preview = extractEditWritePreview(
    { args: { path: 'a.ts', old_string: 'a', new_string: 'b' } },
    null,
    'edit',
  )
  assert.equal(preview.path, 'a.ts')
  assert.match(preview.body, /old/)
  assert.match(preview.body, /new/)
})

test('fmtToolSummary shell one-liner', () => {
  const summary = fmtToolSummary({
    toolName: 'shell',
    phase: 'start',
    args: { command: 'echo hello world' },
  })
  assert.match(summary, /shell · start · echo hello world/)
})

test('formatToolBody shell includes ctx-shell-cmd and ctx-trunc for large stdout', () => {
  const body = formatToolBody(
    { toolName: 'shell', args: { command: 'run' } },
    { toolName: 'shell', result: { exit_code: 0, output: 'y'.repeat(3000) } },
    'shell',
    't1',
    esc,
  )
  assert.match(body, /ctx-shell-cmd/)
  assert.match(body, /ctx-shell-exit/)
  assert.match(body, /ctx-trunc/)
  assert.match(body, /id="t1-stdout"/)
})

test('formatToolBody edit includes ctx-edit-head', () => {
  const body = formatToolBody(
    { toolName: 'edit', args: { path: 'x.mjs', content: 'code' } },
    null,
    'edit',
    't2',
    esc,
  )
  assert.match(body, /ctx-edit-head/)
  assert.match(body, /x\.mjs/)
})
