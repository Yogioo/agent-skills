/**
 * TAPD work-item tests with a fake tapd-cli executable.
 *
 * Run: node --test tests/work-items/tapd.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  commentText,
  createTapdSource,
  extractImagePaths,
  htmlToText,
  isBlankRequirement,
  labelList,
  normalizeTapdConfig,
  priorityValue,
  renderTaskBody,
  replaceImagePath,
  safeImageName,
  toLinkPath,
} from '../../lib/work-items/tapd.mjs'

const FAKE_CLI = `import { readFileSync, writeFileSync } from 'node:fs'
const stateFile = process.env.WORK_ITEMS_FAKE_TAPD_STATE
const state = JSON.parse(readFileSync(stateFile, 'utf8'))
const args = process.argv.slice(2)
const save = () => writeFileSync(stateFile, JSON.stringify(state), 'utf8')
const out = (value) => process.stdout.write(JSON.stringify(value))
const params = {}
for (const arg of args) {
  const i = arg.indexOf('=')
  if (i > 0) params[arg.slice(0, i)] = arg.slice(i + 1)
}
const entity = args[0]
const sub = args[1]
state.calls.push({ entity, sub, params })
if (state.error) { process.stderr.write(state.error); process.exit(1) }
if (state.status !== undefined && state.status !== 1) {
  save(); out({ status: state.status, info: state.info || 'boom' })
} else if (entity === 'story' && sub === 'list') {
  const rows = params.id
    ? state.stories.filter((s) => String(s.id) === String(params.id))
    : state.stories.filter((s) =>
        (!params.owner || String(s.owner || '').indexOf(params.owner) >= 0) &&
        (!params.label || state.dropLabelFilter || String(s.label || '').split('|').indexOf(params.label) >= 0))
  save(); out({ status: 1, data: rows.map((s) => ({ Story: s })) })
} else if (entity === 'story' && sub === 'update') {
  const story = state.stories.find((s) => String(s.id) === String(params.id))
  if (story && params.label !== undefined) {
    story.label = state.mangleLabels ? params.label.split('|').join(',') : params.label
  }
  save(); out({ status: 1, data: { Story: story || {} } })
} else if (entity === 'attachment' && sub === 'get-image') {
  save(); out({ status: 1, data: { Attachment: { download_url: state.imageUrl || '', filename: 'tapd.png' } } })
} else if (entity === 'comment' && sub === 'list') {
  const rows = (state.comments || {})[params.entry_id] || []
  save(); out({ status: 1, data: rows.map((c) => ({ Comment: c })) })
} else if (entity === 'comment' && sub === 'add') {
  save(); out({ status: 1, data: { id: 'c1' } })
} else {
  process.stderr.write('unexpected command'); process.exit(1)
}
`

function stories() {
  return [
    { id: '1', name: '低优先级', owner: '彭云洁;', label: 'ready-for-agent', priority: '低', status: 'developing', description: '<p>正文</p>' },
    { id: '2', name: '高优先级', owner: '彭云洁;', label: 'ready-for-agent', priority: '高', status: 'developing', description: '<p>高优先级正文</p>' },
    { id: '3', name: '已认领', owner: '彭云洁;', label: 'ready-for-agent|afk-claimed', priority: '高', status: 'developing', description: '' },
    { id: '4', name: '别人的需求', owner: '张远瞻;', label: 'ready-for-agent', priority: '高', status: 'developing', description: '' },
  ]
}

function fixture(t, list = stories(), extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'work-items-tapd-'))
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }))
  const stateFile = join(dir, 'state.json')
  const cli = join(dir, 'fake-tapd-cli.mjs')
  writeFileSync(stateFile, JSON.stringify({ stories: list, calls: [], comments: {}, ...extra }), 'utf8')
  writeFileSync(cli, FAKE_CLI, 'utf8')
  process.env.WORK_ITEMS_FAKE_TAPD_STATE = stateFile
  const opts = {
    cwd: dir,
    command: process.execPath,
    commandPrefix: [cli],
    retries: 0,
    tapd: { assignee: '彭云洁', commentAuthor: '彭云洁' },
  }
  return {
    dir,
    opts,
    state: () => JSON.parse(readFileSync(stateFile, 'utf8')),
    labels: (id) => JSON.parse(readFileSync(stateFile, 'utf8')).stories.find((s) => s.id === id).label,
    source: (over = {}) => createTapdSource({ ...opts, ...over }),
  }
}

async function withImageServer(bytes, body) {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'image/png' })
    res.end(bytes)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    return await body(`http://127.0.0.1:${server.address().port}/tfl.png`)
  } finally {
    server.close()
  }
}

const PNG_BYTES = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')

test('tapd helpers keep the domain semantics', () => {
  assert.deepEqual(labelList('a|b|c'), ['a', 'b', 'c'])
  assert.deepEqual(labelList('a,b'), ['a,b'])
  assert.equal(priorityValue('高'), 0)
  assert.equal(priorityValue('中'), 1)
  assert.equal(priorityValue('低'), 2)
  assert.equal(priorityValue(''), 1)
  assert.equal(normalizeTapdConfig({}).readyLabel, 'ready-for-agent')
  assert.equal(htmlToText('<div>第一行<br/>第二行<img src="/tfl/a.png" width="10"/></div>'), '第一行\n第二行\n[图片](/tfl/a.png)')
  assert.equal(commentText('a < b && c > d'), 'a < b && c > d')
  assert.equal(commentText('<p>第一行<br/>第二行</p>'), '第一行\n第二行')
  assert.equal(renderTaskBody('正文', []), '正文')
  assert.ok(isBlankRequirement('', []))
  assert.ok(!isBlankRequirement('', [{ description: '有评论' }]))
  assert.deepEqual(extractImagePaths('看 ![图片](/tfl/a.png) 和 /tfl/b.png'), ['/tfl/a.png', '/tfl/b.png'])
  assert.equal(replaceImagePath('[图片](/tfl/a.png)', '/tfl/a.png', 'X'), 'X')
  assert.equal(safeImageName('/tfl/../..//etc/passwd'), 'passwd')
  assert.equal(toLinkPath('C:\\Users\\EDY\\tmp\\a.png'), 'C:/Users/EDY/tmp/a.png')
})

test('tapd list reads by owner without label or machine filtering', (t) => {
  const fx = fixture(t)
  const source = fx.source()
  assert.deepEqual(source.list().map((row) => row.id), ['1', '2', '3'])
  const selected = source.selectReady({ readyLabel: 'ready-for-agent' })
  assert.deepEqual(selected.map((row) => row.id), ['2', '3', '1'])
  const withoutMachines = source.selectReady({ readyLabel: 'ready-for-agent', excludeMachineLabels: true })
  assert.deepEqual(withoutMachines.map((row) => row.id), ['2', '1'])
  assert.throws(() => fx.source({ tapd: {} }).list(), /assignee/)
})

test('tapd list re-checks a server label that tapd-cli silently dropped', (t) => {
  const fx = fixture(t, [...stories(), { id: '9', name: '无标签', owner: '彭云洁;', label: '', priority: '中', status: 'open', description: '' }], { dropLabelFilter: true })
  const source = fx.source()
  const ids = source.selectReady({ readyLabel: 'ready-for-agent' }).map((row) => row.id)
  assert.ok(!ids.includes('9'))
})

test('tapd get renders comments in ascending order and falls back to comments', async (t) => {
  const fx = fixture(t, stories(), {
    comments: {
      1: [
        { id: 'c2', created: '2026-09-18 16:21:26', author: '张远瞻', description: '后来补充的' },
        { id: 'c1', created: '2026-09-18 15:30:02', author: '彭云洁', description: '一开始写的' },
      ],
      3: [{ id: 'c1', created: '2026-09-18 15:00:00', author: '张远瞻', description: '需求是把血条改短' }],
    },
  })
  const source = fx.source()
  const detail = await source.get('1')
  assert.equal(detail.title, '低优先级')
  assert.ok(detail.body.startsWith('正文'))
  assert.match(detail.body, /## 评论（TAPD，时间升序，共 2 条）/)
  assert.ok(detail.body.indexOf('一开始写的') < detail.body.indexOf('后来补充的'))
  assert.deepEqual(detail.comments.map((comment) => comment.text), ['一开始写的', '后来补充的'])
  const fallback = await source.get('3')
  assert.match(fallback.body, /（需求描述为空）/)
  assert.match(fallback.body, /需求是把血条改短/)
})

test('tapd get localizes images into an explicit cache and reports failures', async (t) => {
  await withImageServer(PNG_BYTES, async (imageUrl) => {
    const fx = fixture(
      t,
      [{ id: '20', name: '带图需求', owner: '彭云洁;', label: 'ready-for-agent', priority: '中', status: 'developing', description: '<p>看图</p><p><img src="/tfl/captures/2026-09/pic.png" width="100"/></p>' }],
      { imageUrl },
    )
    const source = fx.source()
    const detail = await source.get('20', { imageDir: fx.dir })
    const local = toLinkPath(join(fx.dir, '20', 'pic.png'))
    assert.ok(detail.body.includes(`![图片](${local})`))
    assert.ok(!detail.body.includes('/tfl/captures/2026-09/pic.png'))
    assert.deepEqual(readFileSync(local), PNG_BYTES)
    assert.equal(detail.images.localized, true)
    assert.deepEqual(detail.images.errors, [])
    const before = fx.state().calls.filter((call) => call.entity === 'attachment').length
    await source.get('20', { imageDir: fx.dir })
    assert.equal(fx.state().calls.filter((call) => call.entity === 'attachment').length, before)
  })
})

test('tapd get without an explicit image dir leaves links untouched', async (t) => {
  const fx = fixture(t, [
    { id: '21', name: '带图', owner: '彭云洁;', label: 'ready-for-agent', priority: '中', status: 'developing', description: '<img src="/tfl/captures/gone.png"/>' },
  ])
  const detail = await fx.source().get('21')
  assert.equal(detail.images.cacheDir, null)
  assert.equal(detail.images.localized, false)
  assert.match(detail.body, /\/tfl\/captures\/gone\.png/)
})

test('tapd get records a detectable image error without blocking the read', async (t) => {
  const fx = fixture(
    t,
    [{ id: '22', name: '图挂了', owner: '彭云洁;', label: 'ready-for-agent', priority: '中', status: 'developing', description: '<p>正文照旧</p><img src="/tfl/captures/gone.png"/>' }],
    { imageUrl: 'http://127.0.0.1:1/tfl.png' },
  )
  const source = fx.source()
  const detail = await source.get('22', { imageDir: fx.dir })
  assert.match(detail.body, /正文照旧/)
  assert.match(detail.body, /\[图片下载失败: \/tfl\/captures\/gone\.png\]/)
  assert.equal(detail.images.errors.length, 1)
  assert.equal(detail.images.errors[0].path, '/tfl/captures/gone.png')
  await assert.rejects(() => source.get('22', { imageDir: fx.dir, failOnImageError: true }), /下载失败|图片/)
})

test('tapd claim rejects a blank record without mutating labels or comments', (t) => {
  const fx = fixture(t, [
    { id: '11', name: '只有标题', owner: '彭云洁;', label: 'ready-for-agent', priority: '中', status: 'developing', description: '' },
  ])
  const source = fx.source()
  const result = source.claim('11', { readyLabel: 'ready-for-agent' })
  assert.equal(result.status, 'error')
  assert.match(result.message, /拒绝认领/)
  assert.equal(fx.labels('11'), 'ready-for-agent')
  assert.equal(fx.state().calls.filter((call) => call.entity === 'comment' && call.sub === 'add').length, 0)
})

test('tapd claim is best-effort, preserves labels, and detects read-back mismatch', (t) => {
  const fx = fixture(t)
  const source = fx.source()
  assert.deepEqual(source.claim('1', { readyLabel: 'ready-for-agent' }), {
    id: '1', status: 'claimed', claimMode: 'best-effort', labels: ['ready-for-agent', 'afk-claimed'],
  })
  assert.equal(fx.labels('1'), 'ready-for-agent|afk-claimed')
  assert.equal(source.claim('1', { readyLabel: 'ready-for-agent', excludeLabels: ['afk-claimed'] }).status, 'already-claimed')

  const mangled = fixture(t, undefined, { mangleLabels: true })
  const error = mangled.source().claim('1', { readyLabel: 'ready-for-agent' })
  assert.equal(error.status, 'error')
  assert.match(error.message, /标签写入未被接受/)
  assert.match(error.message, /多选分隔符必须是/)
})

test('tapd mutations are explicit and close is refused before mutation', (t) => {
  const fx = fixture(t)
  const source = fx.source()
  source.addLabels('1', ['有风险'])
  assert.equal(fx.labels('1'), 'ready-for-agent|有风险')
  source.removeLabels('1', ['有风险'])
  assert.equal(fx.labels('1'), 'ready-for-agent')
  assert.deepEqual(source.setLabels('2', ['a', 'b']).labels, ['a', 'b'])
  assert.equal(fx.labels('2'), 'a|b')
  const comment = source.comment('2', 'hello')
  assert.equal(comment.status, 'commented')
  assert.equal(fx.state().calls.find((call) => call.entity === 'comment' && call.sub === 'add').params.description, 'hello')
  assert.throws(() => source.close('2'), /不支持 close/)
  assert.equal(fx.labels('2'), 'a|b')
  for (const call of fx.state().calls) {
    for (const key of Object.keys(call.params)) assert.ok(!key.includes('-'), `underscore params only: ${key}`)
  }
})

test('tapd deliver swaps the claim label and comments, but is not close', (t) => {
  const fx = fixture(t)
  const source = fx.source()
  const result = source.deliver('3', { summary: '按需求改好了', commit: 'abc1234de' })
  assert.equal(result.status, 'delivered')
  assert.equal(fx.labels('3'), 'ready-for-agent|afk-delivered')
  const comment = fx.state().calls.find((call) => call.entity === 'comment' && call.sub === 'add')
  assert.match(comment.params.description, /\[AFK\] 开发完成/)
  assert.match(comment.params.description, /提交：abc1234de/)
  assert.match(comment.params.description, /按需求改好了/)
})

test('tapd writing a comment without an author fails before any mutation', (t) => {
  const fx = fixture(t)
  const source = fx.source({ tapd: { assignee: '彭云洁' } })
  const previous = process.env.TAPD_NPC_ROLE
  delete process.env.TAPD_NPC_ROLE
  try {
    assert.throws(() => source.deliver('3', { summary: 'x' }), /commentAuthor/)
  } finally {
    if (previous !== undefined) process.env.TAPD_NPC_ROLE = previous
  }
  assert.equal(fx.labels('3'), 'ready-for-agent|afk-claimed')
  assert.equal(fx.state().calls.filter((call) => call.entity === 'comment' && call.sub === 'add').length, 0)
})

test('tapd authentication and missing binary failures are visible', (t) => {
  const fx = fixture(t, undefined, { status: 0, info: 'invalid token' })
  assert.throws(() => fx.source().list(), /invalid token/)
  const missing = createTapdSource({ command: 'work-items-missing-tapd-cli', retries: 0, tapd: { assignee: '彭云洁' } })
  assert.throws(() => missing.list(), /找不到 tapd-cli/)
})
