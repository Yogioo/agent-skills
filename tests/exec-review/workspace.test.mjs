/**
 * 工作区快照单元测试（git 模式 / walk 模式 / 忽略规则 / 指纹一致性）。
 *
 *   node --test tests/exec-review/workspace.test.mjs
 *
 * 这些测试守着一条真实的回归：快照曾经是「遍历整个工作目录，每个文件读全文算
 * SHA1」，于是 51 GB 的 Unity 工程一次要 5 分钟以上，而且会卡在某个被独占的文件上
 * 永远不返回——整轮运行停在「执行中」，连超时都起不来。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_SKIP,
  blobFingerprint,
  captureWorkspace,
  diff,
  hasSkippedSegment,
  isGitWorkTree,
  snapshot,
} from '../../skills/exec-review/scripts/workspace.mjs'

/** 每个测试一个干净的临时目录，结束就删。 */
async function withDir(fn, prefix = 'ws-') {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  try {
    return await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function git(dir, args) {
  return execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

/** 一个有初始提交的仓库：a.txt、src/b.txt，并忽略 Library/ 与 Temp/。 */
function makeRepo(dir) {
  git(dir, ['init'])
  git(dir, ['config', 'user.name', 'workspace test'])
  git(dir, ['config', 'user.email', 'workspace@example.test'])
  writeFileSync(join(dir, '.gitignore'), 'Library/\nTemp/\n')
  writeFileSync(join(dir, 'a.txt'), 'a\n')
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src', 'b.txt'), 'b\n')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-m', 'base'])
}

// ---------------------------------------------------------------- git 模式

test('git 仓库走 git 模式，只看见已跟踪与被忽略之外的文件', async () => {
  await withDir((dir) => {
    makeRepo(dir)
    const cap = captureWorkspace(dir)

    assert.equal(cap.mode, 'git', '在仓库里就该走 git，不该遍历整个目录')
    assert.ok(Object.keys(cap.files).includes('a.txt'))
    assert.ok(Object.keys(cap.files).includes('src/b.txt'))
    assert.equal(typeof cap.elapsedMs, 'number')
  })
})

test('改动 / 新增 / 删除都被认出', async () => {
  await withDir((dir) => {
    makeRepo(dir)
    const before = captureWorkspace(dir).files

    writeFileSync(join(dir, 'src', 'b.txt'), 'b changed\n')
    writeFileSync(join(dir, 'new.txt'), 'new\n')
    rmSync(join(dir, 'a.txt'))

    const after = captureWorkspace(dir).files
    assert.deepEqual(diff(before, after), {
      changed: ['src/b.txt'],
      added: ['new.txt'],
      removed: ['a.txt'],
    })
  })
})

test('指纹和 git hash-object 一致：索引里的哈希才能直接当内容指纹用', async () => {
  await withDir((dir) => {
    makeRepo(dir)
    const content = '内容 fingerprint\n'
    writeFileSync(join(dir, 'probe.txt'), content)

    const mine = blobFingerprint(Buffer.from(content, 'utf8'))
    const theirs = git(dir, ['hash-object', 'probe.txt'])
    assert.equal(mine, theirs)
  })
})

test('.gitignore 里的目录改了不误报：那不是这次任务的成果', async () => {
  await withDir((dir) => {
    makeRepo(dir)
    const before = captureWorkspace(dir).files

    mkdirSync(join(dir, 'Library'), { recursive: true })
    writeFileSync(join(dir, 'Library', 'junk.bin'), 'junk\n')
    mkdirSync(join(dir, 'Temp'), { recursive: true })
    writeFileSync(join(dir, 'Temp', 'scratch.tmp'), 'x\n')

    const after = captureWorkspace(dir).files
    assert.deepEqual(diff(before, after), { changed: [], added: [], removed: [] })
    assert.ok(!Object.keys(after).some((p) => p.startsWith('Library/')))
  })
})

test('HEAD 移动不影响比对：executor 自己 commit 之后仍要认得出改动', async () => {
  await withDir((dir) => {
    makeRepo(dir)
    const before = captureWorkspace(dir).files

    writeFileSync(join(dir, 'src', 'b.txt'), 'b changed\n')
    writeFileSync(join(dir, 'new.txt'), 'new\n')
    git(dir, ['add', '-A'])
    git(dir, ['commit', '-m', 'executor commit'])

    const afterCommit = captureWorkspace(dir).files
    assert.deepEqual(diff(before, afterCommit), {
      changed: ['src/b.txt'],
      added: ['new.txt'],
      removed: [],
    })
  })
})

test('没动过就是空 diff', async () => {
  await withDir((dir) => {
    makeRepo(dir)
    const a = captureWorkspace(dir).files
    const b = captureWorkspace(dir).files
    assert.deepEqual(diff(a, b), { changed: [], added: [], removed: [] })
  })
})

test('未跟踪文件落在噪音目录里会被跳过：.gitignore 写漏不该把快照拖回遍历', async () => {
  await withDir((dir) => {
    makeRepo(dir)
    // 故意把 build/ 从忽略里漏掉，再往里丢一堆文件
    mkdirSync(join(dir, 'build'), { recursive: true })
    writeFileSync(join(dir, 'build', 'ignored-by-nobody.txt'), 'x\n')

    const cap = captureWorkspace(dir)
    assert.equal(cap.mode, 'git')
    assert.ok(
      !Object.keys(cap.files).some((p) => p.startsWith('build/')),
      'build/ 下的未跟踪文件不该进快照',
    )
  })
})

test('已跟踪文件即使在 build/ 里也照样检测：名字像噪音不等于不是源码', async () => {
  await withDir((dir) => {
    makeRepo(dir)
    mkdirSync(join(dir, 'build'), { recursive: true })
    writeFileSync(join(dir, 'build', 'tracked.txt'), 'v1\n')
    git(dir, ['add', '-f', 'build/tracked.txt'])
    git(dir, ['commit', '-m', 'track build file'])

    const before = captureWorkspace(dir).files
    writeFileSync(join(dir, 'build', 'tracked.txt'), 'v2\n')
    const after = captureWorkspace(dir).files

    assert.deepEqual(diff(before, after).changed, ['build/tracked.txt'])
  })
})

test('在仓库子目录里跑，路径相对子目录，且看不见目录外的东西', async () => {
  await withDir((dir) => {
    makeRepo(dir)
    const sub = join(dir, 'src')

    const cap = captureWorkspace(sub)
    assert.equal(cap.mode, 'git')
    assert.deepEqual(Object.keys(cap.files).sort(), ['b.txt'], '只该看到 src/ 里的文件')

    writeFileSync(join(sub, 'b.txt'), 'b changed\n')
    writeFileSync(join(dir, 'a.txt'), 'a changed\n') // 子目录外，不该进快照
    const after = captureWorkspace(sub).files
    assert.deepEqual(diff(cap.files, after).changed, ['b.txt'])
  })
})

test("显式要 git 但目录不是仓库时退回 walk，不静默丢掉检测", async () => {
  await withDir((dir) => {
    writeFileSync(join(dir, 'plain.txt'), 'x\n')
    const cap = captureWorkspace(dir, { mode: 'git' })
    assert.equal(cap.mode, 'walk')
    assert.ok(Object.keys(cap.files).includes('plain.txt'))
  })
})

test('isGitWorkTree / hasSkippedSegment', async () => {
  await withDir((dir) => {
    assert.equal(isGitWorkTree(dir), false, '不是仓库')
    makeRepo(dir)
    assert.equal(isGitWorkTree(dir), true)
    assert.equal(isGitWorkTree(join(dir, 'src')), true, '仓库子目录也算')

    assert.equal(hasSkippedSegment('src/a.txt'), false)
    assert.equal(hasSkippedSegment('Library/x/y.bin'), true)
    assert.equal(hasSkippedSegment('a/node_modules/b.js'), true)
    assert.equal(hasSkippedSegment('src/a.txt', new Set(['src'])), true, 'skip 可替换')
    assert.ok(DEFAULT_SKIP.has('Library'), 'Unity 的 Library 必须在默认跳过表里')
  })
})

// ---------------------------------------------------------------- walk 模式

test('非 git 目录走 walk 模式，改动 / 新增 / 删除都被认出', async () => {
  await withDir((dir) => {
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src', 'x.txt'), 'x\n')
    writeFileSync(join(dir, 'a.txt'), 'a\n')

    const before = captureWorkspace(dir)
    assert.equal(before.mode, 'walk')

    writeFileSync(join(dir, 'src', 'x.txt'), 'x2\n')
    writeFileSync(join(dir, 'new.txt'), 'new\n')
    rmSync(join(dir, 'a.txt'))

    const after = captureWorkspace(dir)
    assert.deepEqual(diff(before.files, after.files), {
      changed: ['src/x.txt'],
      added: ['new.txt'],
      removed: ['a.txt'],
    })
  })
})

test('walk 模式跳过噪音目录：Unity 工程不该把 Library 也算进去', async () => {
  await withDir((dir) => {
    writeFileSync(join(dir, 'game.cs'), 'v1\n')
    mkdirSync(join(dir, 'Library', 'Artifacts'), { recursive: true })
    writeFileSync(join(dir, 'Library', 'Artifacts', 'huge.bin'), 'junk\n')
    mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'pkg', 'index.js'), 'junk\n')

    const before = captureWorkspace(dir).files
    assert.deepEqual(Object.keys(before), ['game.cs'])

    writeFileSync(join(dir, 'Library', 'Artifacts', 'huge.bin'), 'junk changed\n')
    const after = captureWorkspace(dir).files
    assert.deepEqual(diff(before, after), { changed: [], added: [], removed: [] })

    writeFileSync(join(dir, 'game.cs'), 'v2\n')
    assert.deepEqual(diff(before, captureWorkspace(dir).files).changed, ['game.cs'])
  })
})

test('walk 模式的 skip 可以被调用方整份替换', async () => {
  await withDir((dir) => {
    mkdirSync(join(dir, 'keep'), { recursive: true })
    writeFileSync(join(dir, 'keep', 'a.txt'), 'a\n')
    writeFileSync(join(dir, 'other.txt'), 'o\n')

    const cap = captureWorkspace(dir, { skip: new Set(['other.txt']) })
    assert.deepEqual(Object.keys(cap.files), ['keep/a.txt'])
  })
})

test('snapshot() 等价于 captureWorkspace().files', async () => {
  await withDir((dir) => {
    makeRepo(dir)
    assert.deepEqual(snapshot(dir), captureWorkspace(dir).files)
  })
})

test('diff 是纯函数：只看两个入参，顺序稳定', () => {
  const before = { 'a.txt': '1', 'b.txt': '2', 'gone.txt': '3' }
  const after = { 'a.txt': '1-changed', 'b.txt': '2', 'new.txt': '4' }
  assert.deepEqual(diff(before, after), {
    changed: ['a.txt'],
    added: ['new.txt'],
    removed: ['gone.txt'],
  })
  assert.deepEqual(diff({}, {}), { changed: [], added: [], removed: [] })
})
