/**
 * TAPD adapter tests with a fake tapd-cli executable.
 *
 * 队列由标签定义（docs/adr/0003）：ready-for-agent 是人的开关，afk-* 是机器的三件套。
 *
 * Run:
 *   node --test tests/afk-run/tapd.test.mjs
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
  hasLabel,
  htmlToText,
  isBlankRequirement,
  labelList,
  normalizeTapdConfig,
  priorityValue,
  renderTaskBody,
  replaceImagePath,
  safeImageName,
  toLinkPath,
} from '../../skills/afk-run/scripts/task-sources/tapd.mjs'
import { createSource } from '../../skills/afk-run/scripts/task-sources/index.mjs'

const FAKE_CLI = `import { readFileSync, writeFileSync } from 'node:fs'
const stateFile = process.env.AFK_FAKE_TAPD_STATE
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
if (state.error) {
  process.stderr.write(state.error)
  process.exit(1)
}
if (state.status !== undefined && state.status !== 1) {
  save()
  out({ status: state.status, info: state.info || 'boom' })
} else if (entity === 'story' && sub === 'list') {
  const rows = params.id
    ? state.stories.filter((s) => s.id === params.id)
    : state.stories.filter((s) =>
        (!params.owner || String(s.owner || '').indexOf(params.owner) >= 0) &&
        (!params.label || String(s.label || '').split('|').indexOf(params.label) >= 0))
  save()
  out({ status: 1, data: rows.map((s) => ({ Story: s })) })
} else if (entity === 'story' && sub === 'update') {
  const story = state.stories.find((s) => s.id === params.id)
  if (story && params.label !== undefined) {
    // mangleLabels 模拟 TAPD 的行为：不认识的值被当成**一个新标签名**存下来
    story.label = state.mangleLabels ? params.label.split('|').join(',') : params.label
  }
  save()
  out({ status: 1, data: { Story: story || {} } })
} else if (entity === 'attachment' && sub === 'get-image') {
  save()
  out({ status: 1, data: { Attachment: { download_url: state.imageUrl || '', filename: 'tapd.png' } } })
} else if (entity === 'comment' && sub === 'list') {
  const rows = (state.comments || {})[params.entry_id] || []
  save()
  out({ status: 1, data: rows.map((c) => ({ Comment: c })) })
} else if (entity === 'comment' && sub === 'add') {
  save()
  out({ status: 1, data: { id: 'c1' } })
} else {
  process.stderr.write('unexpected command')
  process.exit(1)
}
`

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'afk-tapd-'))
}

function defaultStories() {
  return [
    { id: '1', name: '低优先级', owner: '彭云洁;', label: 'ready-for-agent', priority: '低', status: 'developing', description: '<p>正文</p>' },
    { id: '2', name: '高优先级', owner: '彭云洁;', label: 'ready-for-agent', priority: '高', status: 'developing', description: '<p>高优先级正文</p>' },
    { id: '3', name: '已认领', owner: '彭云洁;', label: 'ready-for-agent|afk-claimed', priority: '高', status: 'developing', description: '' },
    { id: '4', name: '别人的需求', owner: '张远瞻;', label: 'ready-for-agent', priority: '高', status: 'developing', description: '' },
    { id: '5', name: '交付待验收', owner: '彭云洁;', label: 'ready-for-agent|afk-delivered', priority: '高', status: 'developing', description: '' },
  ]
}

/** 安装 fake tapd-cli，返回 { opts, state() }。 */
function installFakeTapd(dir, stories = defaultStories(), extra = {}) {
  const stateFile = join(dir, 'state.json')
  const cli = join(dir, 'fake-tapd-cli.mjs')
  writeFileSync(stateFile, JSON.stringify({ stories, calls: [], ...extra }), 'utf8')
  writeFileSync(cli, FAKE_CLI, 'utf8')
  process.env.AFK_FAKE_TAPD_STATE = stateFile
  return {
    opts: { command: process.execPath, commandPrefix: [cli], retries: 0, imageDir: dir, tapd: { assignee: '彭云洁' } },
    state: () => JSON.parse(readFileSync(stateFile, 'utf8')),
    labels: (id) => JSON.parse(readFileSync(stateFile, 'utf8')).stories.find((s) => s.id === id).label,
  }
}

function withTempDir(body) {
  const dir = tempDir()
  try {
    return body(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function withTempDirAsync(body) {
  const dir = tempDir()
  try {
    return await body(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** 起一个只服务固定字节的本地 HTTP 服务，模拟 TAPD 的签名直链。 */
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

test('tapd factory is wired into createSource', () => {
  const source = createSource('tapd', { tapd: { assignee: '彭云洁' } })
  assert.equal(source.name, 'tapd')
  assert.equal(source.claimMode, 'best-effort')
})

test('listReady keeps only the queue label and no machine label', () => {
  withTempDir((dir) => {
    const fake = installFakeTapd(dir)
    const source = createTapdSource(fake.opts)
    // id 4 不在本人名下（服务端过滤），id 3/5 带机器标签（本地排除）
    assert.deepEqual(source.listReady(), [
      { id: '2', title: '高优先级', priority: 0 },
      { id: '1', title: '低优先级', priority: 2 },
    ])
  })
})

test('listReady keeps a queue label even if the server drops the label filter', () => {
  withTempDir((dir) => {
    const fake = installFakeTapd(dir, [...defaultStories(), { id: '6', name: '无标签', owner: '彭云洁;', label: '', priority: '高', status: 'developing', description: '' }])
    const source = createTapdSource(fake.opts)
    const ids = source.listReady().map((row) => row.id)
    assert.ok(!ids.includes('6'))
  })
})

test('a label write that TAPD stored as one name is rejected, not accepted', () => {
  withTempDir((dir) => {
    // 真实事故：用逗号拼标签，TAPD 不报错，只新建了一个名字带逗号的标签。
    const fake = installFakeTapd(dir, undefined, { mangleLabels: true })
    const source = createTapdSource(fake.opts)
    const result = source.tryClaim('1')
    assert.equal(result.status, 'error')
    assert.match(result.message, /标签写入未被接受/)
    assert.match(result.message, /多选分隔符必须是/)
  })
})

test('tryClaim writes the full label set including the claim label', () => {
  withTempDir((dir) => {
    const fake = installFakeTapd(dir)
    const source = createTapdSource(fake.opts)
    assert.deepEqual(source.tryClaim('1'), { status: 'claimed', claimMode: 'best-effort' })
    assert.equal(fake.labels('1'), 'ready-for-agent|afk-claimed')
  })
})

test('tryClaim preserves existing labels while claiming', () => {
  withTempDir((dir) => {
    const fake = installFakeTapd(dir, [
      { id: '9', name: '带业务标签', owner: '彭云洁;', label: 'ready-for-agent|有风险', priority: '中', status: 'developing', description: '<p>正文</p>' },
    ])
    const source = createTapdSource(fake.opts)
    assert.equal(source.tryClaim('9').status, 'claimed')
    assert.equal(fake.labels('9'), 'ready-for-agent|有风险|afk-claimed')
  })
})

test('tryClaim reports already-claimed for every machine label', () => {
  withTempDir((dir) => {
    const fake = installFakeTapd(dir, [
      ...defaultStories(),
      { id: '7', name: '失败待重跑', owner: '彭云洁;', label: 'ready-for-agent|afk-failed', priority: '中', status: 'developing', description: '' },
    ])
    const source = createTapdSource(fake.opts)
    assert.match(source.tryClaim('3').message, /afk-claimed/)
    assert.equal(source.tryClaim('5').status, 'already-claimed')
    assert.match(source.tryClaim('5').message, /afk-delivered/)
    assert.match(source.tryClaim('7').message, /afk-failed/)
  })
})

test('tryClaim refuses a story that lost its queue label', () => {
  withTempDir((dir) => {
    const fake = installFakeTapd(dir, [
      { id: '8', name: '没有队列标签', owner: '彭云洁;', label: '', priority: '中', status: 'developing', description: '' },
    ])
    const source = createTapdSource(fake.opts)
    const result = source.tryClaim('8')
    assert.equal(result.status, 'error')
    assert.match(result.message, /ready-for-agent/)
  })
})

test('markInProgress claims through tryClaim', () => {
  withTempDir((dir) => {
    const fake = installFakeTapd(dir)
    const source = createTapdSource(fake.opts)
    source.markInProgress('2')
    assert.equal(fake.labels('2'), 'ready-for-agent|afk-claimed')
  })
})

test('markDone swaps claimed for delivered and comments with the commit', () => {
  withTempDir((dir) => {
    const fake = installFakeTapd(dir)
    const source = createTapdSource(fake.opts)
    source.markDone('3', { status: 'done', summary: '按需求改好了', commit: 'abc1234de' })
    assert.equal(fake.labels('3'), 'ready-for-agent|afk-delivered')
    const comment = fake.state().calls.find((call) => call.entity === 'comment' && call.sub === 'add')
    assert.equal(comment.params.entry_id, '3')
    assert.equal(comment.params.entry_type, 'stories')
    assert.match(comment.params.description, /\[AFK\] 开发完成/)
    assert.match(comment.params.description, /提交：abc1234de/)
    assert.match(comment.params.description, /按需求改好了/)
  })
})

test('markFailed swaps claimed for failed and comments the reason', () => {
  withTempDir((dir) => {
    const fake = installFakeTapd(dir)
    const source = createTapdSource(fake.opts)
    source.markFailed('3', '单测没过')
    assert.equal(fake.labels('3'), 'ready-for-agent|afk-failed')
    const comment = fake.state().calls.find((call) => call.entity === 'comment' && call.sub === 'add')
    assert.match(comment.params.description, /\[AFK\] 失败：单测没过/)
  })
})

test('describeBlocked separates in-progress from re-arm-needed', () => {
  withTempDir((dir) => {
    const fake = installFakeTapd(dir)
    const source = createTapdSource(fake.opts)
    const described = source.describeBlocked()
    assert.deepEqual(described.ready.map((row) => row.id), ['2', '1'])
    assert.deepEqual(described.inProgress.map((row) => row.id), ['3'])
    assert.deepEqual(described.blocked.map((row) => row.id), ['5'])
    assert.match(described.blocked[0].reason, /afk-delivered/)
  })
})

test('getDetail converts the HTML description to text', async () => {
  await withTempDirAsync(async (dir) => {
    const fake = installFakeTapd(dir)
    const source = createTapdSource(fake.opts)
    const detail = await source.getDetail('1')
    assert.equal(detail.id, '1')
    assert.equal(detail.title, '低优先级')
    assert.equal(detail.body, '正文')
    assert.equal(detail.requirements, '')
  })
})

test('every tapd-cli parameter uses underscores', () => {
  withTempDir((dir) => {
    const fake = installFakeTapd(dir)
    const source = createTapdSource(fake.opts)
    source.listReady()
    source.getDetail('1')
    source.markDone('3', { summary: 'x' })
    for (const call of fake.state().calls) {
      for (const key of Object.keys(call.params)) {
        assert.ok(!key.includes('-'), `参数名不能用连字符（tapd-cli 会静默丢弃）: ${key}`)
      }
    }
  })
})

test('a missing assignee fails loudly', () => {
  withTempDir((dir) => {
    const fake = installFakeTapd(dir)
    const source = createTapdSource({ ...fake.opts, tapd: {} })
    assert.throws(() => source.listReady(), /assignee/)
  })
})

test('a missing tapd-cli binary fails loudly instead of returning nothing', () => {
  const source = createTapdSource({
    command: 'afk-definitely-missing-tapd-cli',
    retries: 0,
    tapd: { assignee: '彭云洁' },
  })
  assert.throws(() => source.listReady(), /找不到 tapd-cli/)
})

test('a non-success tapd-cli payload is an error, not an empty list', () => {
  withTempDir((dir) => {
    const fake = installFakeTapd(dir, defaultStories(), { status: 0, info: 'invalid token' })
    const source = createTapdSource(fake.opts)
    assert.throws(() => source.listReady(), /invalid token/)
  })
})

test('getDetail appends comments in ascending time order', async () => {
  await withTempDirAsync(async (dir) => {
    const fake = installFakeTapd(dir, defaultStories(), {
      comments: {
        1: [
          { id: 'c2', created: '2026-09-18 16:21:26', author: '张远瞻', description: '后来补充的' },
          { id: 'c1', created: '2026-09-18 15:30:02', author: '彭云洁', description: '一开始写的' },
        ],
      },
    })
    const source = createTapdSource(fake.opts)
    const body = (await source.getDetail('1')).body
    assert.ok(body.startsWith('正文'))
    assert.match(body, /## 评论（TAPD，时间升序，共 2 条）/)
    assert.ok(body.indexOf('一开始写的') < body.indexOf('后来补充的'), '评论应按时间升序')
    assert.match(body, /- 2026-09-18 15:30:02 彭云洁：一开始写的/)
  })
})

test('getDetail falls back to comments when the description is empty', async () => {
  await withTempDirAsync(async (dir) => {
    const fake = installFakeTapd(
      dir,
      [{ id: '10', name: '只有评论', owner: '彭云洁;', label: 'ready-for-agent', priority: '中', status: 'developing', description: '' }],
      { comments: { 10: [{ id: 'c1', created: '2026-09-18 15:00:00', author: '张远瞻', description: '需求是把血条改短' }] } },
    )
    const source = createTapdSource(fake.opts)
    const body = (await source.getDetail('10')).body
    assert.match(body, /（需求描述为空）/)
    assert.match(body, /需求是把血条改短/)
  })
})

test('a story with no description and no comments is refused, not guessed', () => {
  withTempDir((dir) => {
    const fake = installFakeTapd(dir, [
      { id: '11', name: '只有标题', owner: '彭云洁;', label: 'ready-for-agent', priority: '中', status: 'developing', description: '' },
    ])
    const source = createTapdSource(fake.opts)
    const result = source.tryClaim('11')
    assert.equal(result.status, 'error')
    assert.match(result.message, /描述与评论都为空/)
    assert.equal(fake.labels('11'), 'ready-for-agent|afk-failed')
    const comment = fake.state().calls.find((call) => call.entity === 'comment' && call.sub === 'add')
    assert.match(comment.params.description, /无法开工/)
  })
})

test('a story with an empty description but a spec in the comments is claimable', () => {
  withTempDir((dir) => {
    const fake = installFakeTapd(
      dir,
      [{ id: '12', name: '空描述但评论有料', owner: '彭云洁;', label: 'ready-for-agent', priority: '中', status: 'developing', description: '' }],
      { comments: { 12: [{ id: 'c1', created: '2026-09-18 15:00:00', author: '张远瞻', description: '把血条改短' }] } },
    )
    const source = createTapdSource(fake.opts)
    assert.equal(source.tryClaim('12').status, 'claimed')
    assert.equal(fake.labels('12'), 'ready-for-agent|afk-claimed')
  })
})

test('commentText only strips text that really is html', () => {
  assert.equal(commentText('a < b && c > d'), 'a < b && c > d')
  assert.equal(commentText('<p>第一行<br/>第二行</p>'), '第一行\n第二行')
  assert.equal(renderTaskBody('正文', []), '正文')
  assert.equal(renderTaskBody('', []), '')
  assert.ok(isBlankRequirement('', []))
  assert.ok(isBlankRequirement(htmlToText('<p></p>'), []))
  assert.ok(!isBlankRequirement('', [{ description: '有评论' }]))
  assert.ok(!isBlankRequirement('有描述', []))
})

test('getDetail downloads embedded images and points the body at local files', async () => {
  await withImageServer(PNG_BYTES, async (imageUrl) => {
    await withTempDirAsync(async (dir) => {
      const fake = installFakeTapd(
        dir,
        [
          {
            id: '20',
            name: '带图需求',
            owner: '彭云洁;',
            label: 'ready-for-agent',
            priority: '中',
            status: 'developing',
            description: '<p>看图</p><p><img src="/tfl/captures/2026-09/pic.png" width="100"/></p>',
          },
        ],
        { imageUrl },
      )
      const source = createTapdSource(fake.opts)
      const body = (await source.getDetail('20')).body
      const local = toLinkPath(join(dir, '20', 'pic.png'))

      assert.ok(body.includes(`![图片](${local})`), `正文应指向本地文件，实际:\n${body}`)
      assert.ok(!body.includes('/tfl/captures/2026-09/pic.png'), '原始路径应被替换掉')
      assert.ok(!body.includes('\\'), 'markdown 链接里不应出现反斜杠')
      assert.deepEqual(readFileSync(local), PNG_BYTES)

      // 重跑：文件已在，不再调 get-image
      const before = fake.state().calls.filter((c) => c.entity === 'attachment').length
      await source.getDetail('20')
      const after = fake.state().calls.filter((c) => c.entity === 'attachment').length
      assert.equal(after, before, '已下载过的图片不应重复调用 get-image')
    })
  })
})

test('a failed image download degrades to a placeholder instead of blocking the task', async () => {
  await withTempDirAsync(async (dir) => {
    const fake = installFakeTapd(
      dir,
      [
        {
          id: '21',
          name: '图挂了',
          owner: '彭云洁;',
          label: 'ready-for-agent',
          priority: '中',
          status: 'developing',
          description: '<p>正文照旧</p><img src="/tfl/captures/2026-09/gone.png"/>',
        },
      ],
      { imageUrl: 'http://127.0.0.1:1/tfl.png' },
    )
    const source = createTapdSource(fake.opts)
    const body = (await source.getDetail('21')).body
    assert.match(body, /正文照旧/)
    assert.match(body, /\[图片下载失败: \/tfl\/captures\/2026-09\/gone\.png\]/)
  })
})

test('image path helpers dedupe, rewrite links, and keep file names safe', () => {
  assert.deepEqual(extractImagePaths('看 ![图片](/tfl/captures/a.png) 和 /tfl/captures/b.png'), [
    '/tfl/captures/a.png',
    '/tfl/captures/b.png',
  ])
  assert.deepEqual(extractImagePaths('没有图'), [])
  assert.equal(
    replaceImagePath('[图片](/tfl/captures/a.png)', '/tfl/captures/a.png', '![图片](/tmp/a.png)'),
    '![图片](/tmp/a.png)',
  )
  assert.equal(replaceImagePath('裸路径 /tfl/a.png 结束', '/tfl/a.png', 'X'), '裸路径 X 结束')
  assert.equal(safeImageName('/tfl/captures/a.png'), 'a.png')
  assert.equal(safeImageName('/tfl/../..//etc/passwd'), 'passwd')
  assert.equal(safeImageName('/tfl/a b?.png'), 'a_b_.png')
  assert.equal(toLinkPath('C:\\Users\\EDY\\tmp\\a.png'), 'C:/Users/EDY/tmp/a.png')
})

test('tapd helpers normalize labels, priority, and html', () => {
  assert.deepEqual(labelList('a|b|c'), ['a', 'b', 'c'])
  assert.deepEqual(labelList('a,b'), ['a,b'])
  assert.deepEqual(labelList(''), [])
  assert.ok(hasLabel(labelList('ready-for-agent|有风险'), '有风险'))
  assert.equal(priorityValue('高'), 0)
  assert.equal(priorityValue('中'), 1)
  assert.equal(priorityValue('低'), 2)
  assert.equal(priorityValue(''), 1)
  assert.equal(normalizeTapdConfig({}).readyLabel, 'ready-for-agent')
  assert.equal(
    htmlToText('<div>第一行<br/>第二行<img src="/tfl/a.png" width="10"/></div>'),
    '第一行\n第二行\n[图片](/tfl/a.png)',
  )
})
