import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { diffHtml, describeEvent, paneHtml, timelineHtml, verbFor } from '../../lib/web-ui/client.mjs'
import { fromPiEvent, fromProgress, fromProgressEvent } from '../../lib/web-ui/events.mjs'
import { clock, dur, msText, project, rel } from '../../lib/web-ui/format.mjs'
import { esc, md } from '../../lib/web-ui/markdown.mjs'

const fixtures = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/markdown.json', import.meta.url)), 'utf8'))
const format = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/format.json', import.meta.url)), 'utf8'))

test('markdown keeps the tapd output, including images', () => {
  for (const row of fixtures.tapd) {
    assert.equal(md(row.src, { images: true }), row.html, JSON.stringify(row.src))
  }
})

test('markdown keeps the board output when images are off', () => {
  for (const row of fixtures.board) {
    assert.equal(md(row.src), row.html, JSON.stringify(row.src))
  }
})

test('time formatters keep the tapd output', () => {
  for (const [value, expected] of format.dur) assert.equal(dur(value), expected)
  for (const [value, expected] of format.clock) assert.equal(clock(value), expected)
  for (const [value, expected] of format.msText) assert.equal(msText(value), expected)
})

test('rel reads against the current clock', () => {
  const real = Date.now
  const now = 1_700_000_000_000
  Date.now = () => now
  try {
    assert.equal(rel(0), '')
    assert.equal(rel(now - 500), '刚刚')
    assert.equal(rel(now - 5_000), '5 秒前')
    assert.equal(rel(now - 3_600_000), '1h0m前')
  } finally {
    Date.now = real
  }
})

test('esc escapes text nodes the way the browser does', () => {
  assert.equal(esc('<b> & "x"'), '&lt;b&gt; &amp; "x"')
  assert.equal(esc(null), '')
})

test('project takes the last path segment across separators', () => {
  assert.equal(project('C:\\a\\b\\c.cs'), 'c.cs')
  assert.equal(project('/a/b/c.cs'), 'c.cs')
  assert.equal(project(''), '')
})

test('progress records normalize to one event shape', () => {
  const items = fromProgress([
    { t: 1, arm: 'a', event: 'say', text: 'hi' },
    { t: 2, arm: 'a', event: 'think', text: 'hmm' },
    { t: 3, arm: 'a', event: 'tool', name: 'read', detail: 'x.cs', ms: 7 },
    { t: 4, arm: 'a', event: 'arm_start', runner: 'pi', model: 'm', thinking: 'high' },
    { t: 5, arm: 'a', event: 'arm_end', status: 'ok', tokens: 12 },
    { t: 6, event: 'malformed_lines', count: 2 },
  ])
  assert.deepEqual(items.map((item) => item.kind), ['say', 'think', 'tool', 'arm_start', 'arm_end', 'note'])
  assert.equal(items[2].ms, 7)
  assert.equal(items[3].text, 'pi · m · high')
  assert.equal(items[4].tokens, 12)
  assert.match(items[5].text, /2 行/)
})

test('pi events normalize and unknown events are dropped', () => {
  assert.equal(fromPiEvent({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } }, 9).text, 'ok')
  assert.equal(fromPiEvent({ type: 'tool_execution_start', toolName: 'edit', args: { path: 'a.tsx' } }, 9).detail, 'a.tsx')
  assert.equal(fromPiEvent({ type: 'tool_execution_end', toolName: 'edit', durationMs: 12 }, 9).kind, 'tool_end')
  assert.equal(fromPiEvent({ type: 'agent_settled', aborted: true }, 9).text, '被中断')
  assert.equal(fromPiEvent({ type: 'unknown' }, 9), null)
  assert.equal(fromPiEvent({ type: 'message_end', message: { role: 'assistant', content: [] } }, 9), null)
})

test('tool verbs cover the known families', () => {
  assert.deepEqual(verbFor('read'), ['📖', '读'])
  assert.deepEqual(verbFor('mcp__tapd__search'), ['🔌', 'tapd：search'])
  assert.equal(verbFor('weird_tool')[0], '⚙')
})

test('describeEvent covers arm start and end', () => {
  assert.match(describeEvent({ kind: 'arm_start', text: 'pi · m' }).text, /开跑/)
  assert.equal(describeEvent({ kind: 'arm_end', status: 'ok', tokens: 3 }).cls, 'ok')
  assert.equal(describeEvent({ kind: 'arm_end', status: 'error' }).cls, 'bad')
})

test('timeline rows carry time, offset, markdown and duration', () => {
  const html = timelineHtml([
    { t: 1000, kind: 'say', text: '**hi**' },
    { t: 3500, kind: 'tool', name: 'read', detail: 'a.cs', ms: 21 },
    { t: 5000, kind: 'arm_end', status: 'ok', tokens: 12 },
  ], { base: 1000 })
  assert.match(html, /tl say/)
  assert.match(html, /<strong>hi<\/strong>/)
  assert.match(html, /3s/)
  assert.match(html, /21ms/)
  assert.match(html, /tl arm/)
  assert.match(html, /12 tok/)
})

test('pane markup keeps its open state', () => {
  assert.match(paneHtml('k', '标题', 'x', true), /data-pane="k" open/)
  assert.doesNotMatch(paneHtml('k', '标题', 'x', false), /open/)
})

test('diff renders both modes', () => {
  const text = 'diff --git a/x b/x\n@@ -1 +1 @@\n-old\n+new'
  assert.match(diffHtml(text, 'single'), /dline ddel/)
  assert.match(diffHtml(text, 'single'), /dline dadd/)
  assert.match(diffHtml(text, 'dual'), /ldel/)
  assert.match(diffHtml(text, 'dual'), /radd/)
})

test('served browser modules stay free of node APIs', () => {
  const files = [
    '../../lib/web-ui/client.mjs',
    '../../lib/web-ui/events.mjs',
    '../../lib/web-ui/markdown.mjs',
    '../../lib/web-ui/format.mjs',
    '../../skills/tapd-loop/scripts/page-app.js',
    '../../skills/tapd-loop/scripts/control.js',
    '../../skills/tapd-loop/scripts/auth.js',
  ]
  for (const name of files) {
    const source = readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8')
    assert.doesNotMatch(source, /\bnode:/, name)
    assert.doesNotMatch(source, /\brequire\(/, name)
    assert.doesNotMatch(source, /\bprocess\./, name)
  }
})
