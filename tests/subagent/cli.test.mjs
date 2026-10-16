/**
 * subagent CLI 的端到端测试。假的子进程是本机 Node 脚本，不联网。
 *
 *   node --test tests/subagent/cli.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runCli } from '../../tools/subagent/cli.mjs'

function capture() {
  const out = []
  const err = []
  return {
    io: { stdout: (t) => out.push(t), stderr: (t) => err.push(t) },
    stdout: () => out.join(''),
    stderr: () => err.join(''),
  }
}

const RESULT = (text) =>
  `process.stdout.write(JSON.stringify({type:'result',subtype:'success',result:${JSON.stringify(text)}})+'\\n')\nprocess.exit(0)\n`

const TABLE = `---
alwaysApply: true
---
# budget: medium (high)
# runner: agent
feature, refactoring: model-a-xhigh
how explorer: model-b-medium
interrogate reviewers: model-a-xhigh, model-b-medium
cheap: auto
`

const MODELS = `provider  model            context
alpha     model-a          1M
beta      model-b          1M
`

/** 建一个临时工作区：角色表、模型表、prompt、假子进程。 */
function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'subagent cli '))
  writeFileSync(join(dir, 'roles.md'), TABLE)
  writeFileSync(join(dir, 'models.txt'), MODELS)
  writeFileSync(join(dir, 'brief-a.md'), 'arm a\n')
  writeFileSync(join(dir, 'brief-b.md'), 'arm b\n')
  writeFileSync(join(dir, 'ok.mjs'), RESULT('ARM-A'))
  writeFileSync(join(dir, 'empty.mjs'), RESULT(''))
  writeFileSync(join(dir, 'boom.mjs'), "process.stderr.write('boom\\n')\nprocess.exit(3)\n")
  return dir
}

function rolesArgs(dir) {
  return ['--roles-file', join(dir, 'roles.md'), '--models-file', join(dir, 'models.txt')]
}

test('roles 打印角色表、budget 与 runner', async () => {
  const dir = workspace()
  const cap = capture()
  try {
    const code = await runCli(['roles', '--roles-file', join(dir, 'roles.md')], cap.io)
    assert.equal(code, 0)
    const result = JSON.parse(cap.stdout().trim())
    assert.equal(result.budget, 'medium')
    assert.equal(result.entries.length, 4)
    assert.deepEqual(result.errors, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('plan 把面板角色展开成每个取值一臂，并定出 provider', async () => {
  const dir = workspace()
  const cap = capture()
  try {
    const code = await runCli(['plan', '--role', 'interrogate reviewers', ...rolesArgs(dir)], cap.io)
    assert.equal(code, 0)
    const result = JSON.parse(cap.stdout().trim())
    assert.equal(result.runner, 'agent')
    assert.equal(result.arms.length, 2)
    const [first, second] = result.arms
    assert.equal(first.model, 'model-a')
    assert.equal(first.thinking, 'xhigh')
    assert.deepEqual(second.slug, 'model-b-medium')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('plan 拒绝多义模型，并列出候选 provider', async () => {
  const dir = workspace()
  writeFileSync(
    join(dir, 'roles.md'),
    '# runner: pi\ndup: model-a-xhigh\n',
  )
  writeFileSync(join(dir, 'models.txt'), 'provider  model\nalpha     model-a\nbeta      model-a\n')
  const cap = capture()
  try {
    const code = await runCli(['plan', '--role', 'dup', ...rolesArgs(dir)], cap.io)
    assert.equal(code, 2)
    assert.match(cap.stderr(), /同时挂在 alpha, beta 下/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('plan 对未知角色列出候选', async () => {
  const dir = workspace()
  const cap = capture()
  try {
    const code = await runCli(['plan', '--role', '不存在', ...rolesArgs(dir)], cap.io)
    assert.equal(code, 2)
    assert.match(cap.stderr(), /候选：feature, refactoring/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('run 单臂：拿到结果、写出 report.jsonl、退出 0', async () => {
  const dir = workspace()
  const outDir = join(dir, 'out one')
  const cap = capture()
  try {
    const code = await runCli(
      [
        'run',
        '--role', 'how explorer',
        '--prompt-file', join(dir, 'brief-a.md'),
        '--out-dir', outDir,
        '--runner', 'agent',
        '--bin', join(dir, 'ok.mjs'),
        ...rolesArgs(dir),
      ],
      cap.io,
    )
    assert.equal(code, 0)
    const result = JSON.parse(cap.stdout().trim())
    assert.equal(result.ok, 1)
    assert.equal(result.runner, 'agent')
    const [arm] = result.arms
    assert.equal(arm.status, 'ok')
    assert.equal(arm.label, 'how-explorer')
    assert.equal(arm.model, 'model-b')
    assert.equal(arm.thinking, 'medium')
    assert.equal(readFileSync(arm.outputFile, 'utf8').trim(), 'ARM-A')
    const records = readFileSync(result.reportFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    assert.equal(records.length, 1)
    assert.equal(records[0].status, 'ok')
    assert.ok(!('text' in records[0]), 'report 只给路径与事实，不内联正文')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('run manifest：两臂并发、各自独占目录、退出 0', async () => {
  const dir = workspace()
  const outDir = join(dir, 'out fan')
  writeFileSync(
    join(dir, 'arms.json'),
    JSON.stringify({
      role: 'interrogate reviewers',
      concurrency: 2,
      arms: [
        { label: 'arm-a', promptFile: 'brief-a.md' },
        { label: 'arm-b', promptFile: 'brief-b.md', thinking: 'low' },
      ],
    }),
  )
  const cap = capture()
  try {
    const code = await runCli(
      [
        'run',
        '--manifest', join(dir, 'arms.json'),
        '--out-dir', outDir,
        '--runner', 'agent',
        '--bin', join(dir, 'ok.mjs'),
        ...rolesArgs(dir),
      ],
      cap.io,
    )
    assert.equal(code, 0)
    const result = JSON.parse(cap.stdout().trim())
    assert.equal(result.ok, 2)
    assert.equal(result.concurrency, 2)
    assert.deepEqual(result.arms.map((arm) => arm.model), ['model-a', 'model-b'])
    assert.deepEqual(result.arms.map((arm) => arm.thinking), ['xhigh', 'low'])
    assert.ok(existsSync(join(outDir, 'arm-a', 'output.txt')))
    assert.ok(existsSync(join(outDir, 'arm-b', 'output.txt')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('run 把空产出与子进程失败都判成不过，退出 1', async () => {
  const dir = workspace()
  const cap = capture()

  const emptyOut = join(dir, 'out empty')
  const emptyCode = await runCli(
    [
      'run', '--role', 'how explorer', '--prompt-file', join(dir, 'brief-a.md'),
      '--out-dir', emptyOut, '--runner', 'agent', '--bin', join(dir, 'empty.mjs'), ...rolesArgs(dir),
    ],
    cap.io,
  )
  assert.equal(emptyCode, 1)
  assert.equal(JSON.parse(cap.stdout().trim()).arms[0].status, 'empty')

  const boomCap = capture()
  const boomOut = join(dir, 'out boom')
  const boomCode = await runCli(
    [
      'run', '--role', 'how explorer', '--prompt-file', join(dir, 'brief-a.md'),
      '--out-dir', boomOut, '--runner', 'agent', '--bin', join(dir, 'boom.mjs'), ...rolesArgs(dir),
    ],
    boomCap.io,
  )
  assert.equal(boomCode, 1)
  const boomResult = JSON.parse(boomCap.stdout().trim())
  assert.equal(boomResult.arms[0].status, 'error')
  const record = JSON.parse(readFileSync(boomResult.reportFile, 'utf8').trim())
  assert.equal(record.exitCode, 3, 'exitCode 只上报')
  assert.equal(record.status, 'error', 'status 由证据决定，不由 exitCode 决定')

  rmSync(dir, { recursive: true, force: true })
})

test('run 守住 --out-dir 与臂名', async () => {
  const dir = workspace()
  const existing = join(dir, 'out exists')
  mkdirSync(existing)
  const cap = capture()
  try {
    const reused = await runCli(
      [
        'run', '--role', 'how explorer', '--prompt-file', join(dir, 'brief-a.md'),
        '--out-dir', existing, ...rolesArgs(dir),
      ],
      cap.io,
    )
    assert.equal(reused, 2)
    assert.match(cap.stderr(), /already exists/)

    const badLabel = capture()
    const badCode = await runCli(
      [
        'run', '--role', 'how explorer', '--prompt-file', join(dir, 'brief-a.md'),
        '--out-dir', join(dir, 'out label'), '--label', 'a/b', ...rolesArgs(dir),
      ],
      badLabel.io,
    )
    assert.equal(badCode, 2)
    assert.match(badLabel.stderr(), /臂名只能含/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('没有角色表也能用：直接给模型旋钮', async () => {
  const dir = workspace()
  const saved = process.env.USERPROFILE
  process.env.USERPROFILE = dir
  const cap = capture()
  try {
    const code = await runCli(
      [
        'run', '--prompt-file', join(dir, 'brief-a.md'), '--out-dir', join(dir, 'out inline'),
        '--runner', 'agent', '--model', 'model-a', '--thinking', 'low', '--bin', join(dir, 'ok.mjs'),
      ],
      cap.io,
    )
    assert.equal(code, 0)
    const result = JSON.parse(cap.stdout().trim())
    assert.equal(result.ok, 1)
    assert.equal(result.rolesFile, null)
    assert.equal(result.arms[0].role, '(inline)')
    assert.equal(result.arms[0].label, 'inline')
    assert.equal(result.arms[0].thinking, 'low')
  } finally {
    if (saved === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = saved
    rmSync(dir, { recursive: true, force: true })
  }
})

test('不给任何旋钮时拒绝起臂', async () => {
  const dir = workspace()
  const cap = capture()
  try {
    const code = await runCli(
      [
        'run', '--prompt-file', join(dir, 'brief-a.md'),
        '--out-dir', join(dir, 'out none'), '--roles-file', join(dir, 'roles.md'),
      ],
      cap.io,
    )
    assert.equal(code, 2)
    assert.match(cap.stderr(), /Missing --role/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('从家目录的默认位置找角色表', async () => {
  const dir = workspace()
  const saved = process.env.USERPROFILE
  mkdirSync(join(dir, '.agents'), { recursive: true })
  writeFileSync(join(dir, '.agents', 'pstack-models.md'), '# runner: agent\nfromtable: model-a-xhigh\n')
  process.env.USERPROFILE = dir
  const cap = capture()
  try {
    const code = await runCli(
      [
        'run', '--role', 'fromtable', '--prompt-file', join(dir, 'brief-a.md'),
        '--out-dir', join(dir, 'out home'), '--bin', join(dir, 'ok.mjs'),
      ],
      cap.io,
    )
    assert.equal(code, 0)
    const result = JSON.parse(cap.stdout().trim())
    assert.equal(result.arms[0].model, 'model-a')
    assert.equal(result.arms[0].thinking, 'xhigh')
    assert.match(result.rolesFile, /pstack-models\.md$/)
  } finally {
    if (saved === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = saved
    rmSync(dir, { recursive: true, force: true })
  }
})

test('run 拒绝非 pi runner 上的 --provider，也拒绝重复臂名', async () => {
  const dir = workspace()
  writeFileSync(
    join(dir, 'bad-provider.json'),
    JSON.stringify({ role: 'how explorer', arms: [{ label: 'a', promptFile: 'brief-a.md', provider: 'alpha' }] }),
  )
  writeFileSync(
    join(dir, 'dup.json'),
    JSON.stringify({
      role: 'how explorer',
      arms: [{ label: 'same', promptFile: 'brief-a.md' }, { label: 'same', promptFile: 'brief-b.md' }],
    }),
  )
  const cap = capture()
  try {
    const providerCode = await runCli(
      [
        'run', '--manifest', join(dir, 'bad-provider.json'), '--out-dir', join(dir, 'o1'),
        '--runner', 'agent', ...rolesArgs(dir),
      ],
      cap.io,
    )
    assert.equal(providerCode, 2)
    assert.match(cap.stderr(), /不支持 --provider/)

    const dupCap = capture()
    const dupCode = await runCli(
      [
        'run', '--manifest', join(dir, 'dup.json'), '--out-dir', join(dir, 'o2'),
        '--runner', 'agent', '--bin', join(dir, 'ok.mjs'), ...rolesArgs(dir),
      ],
      dupCap.io,
    )
    assert.equal(dupCode, 1)
    assert.match(dupCap.stderr(), /臂名重复/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('doctor：坏表报 error 并退出 1，且一个字节都不写', async () => {
  const dir = workspace()
  writeFileSync(
    join(dir, 'broken.md'),
    '# budget: large (xhigh)\n# runner: pi\nfeature: model-a-high\nhow explainer: anthropic/opus-9.9-xhigh\n',
  )
  writeFileSync(join(dir, 'models.txt'), 'provider model\nalpha model-a\nbeta model-b\n')
  const before = readFileSync(join(dir, 'broken.md'), 'utf8')
  const listings = () => readdirSync(dir).sort().join(',')
  const beforeFiles = listings()
  const cap = capture()
  try {
    const code = await runCli(
      ['doctor', '--roles-file', join(dir, 'broken.md'), '--models-file', join(dir, 'models.txt'), '--runner', 'pi'],
      cap.io,
    )
    assert.equal(code, 1)
    const report = JSON.parse(cap.stdout().trim())
    assert.equal(report.ok, false)
    assert.equal(report.runner, 'pi')
    assert.equal(report.modelsSource, join(dir, 'models.txt'))
    assert.equal(report.counts.errors, 1)
    assert.equal(report.counts.warnings, 1, 'feature 的 effort 低于预算 xhigh')
    assert.equal(report.findings.find((item) => item.level === 'error').code, 'unknown-model')
    assert.equal(readFileSync(join(dir, 'broken.md'), 'utf8'), before, 'doctor 只读')
    assert.equal(listings(), beforeFiles, 'doctor 不添文件')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('doctor：干净表退出 0', async () => {
  const dir = workspace()
  writeFileSync(
    join(dir, 'clean.md'),
    '# budget: medium (high)\n# runner: pi\nhow explorer: model-a-high\nswarm workers: model-b-high\n',
  )
  const cap = capture()
  try {
    const code = await runCli(
      ['doctor', '--roles-file', join(dir, 'clean.md'), '--models-file', join(dir, 'models.txt')],
      cap.io,
    )
    assert.equal(code, 0)
    const report = JSON.parse(cap.stdout().trim())
    assert.equal(report.ok, true)
    assert.equal(report.counts.errors, 0)
    assert.equal(report.roles[0].values[0].provider, 'alpha')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('doctor：拿不到模型清单时报 error，不顺下去', async () => {
  const dir = workspace()
  const cap = capture()
  try {
    const code = await runCli(
      ['doctor', '--roles-file', join(dir, 'roles.md'), '--runner', 'codex', '--bin', join(dir, 'nope.mjs')],
      cap.io,
    )
    // runner 不是 pi 时不去拉模型清单，因此无从核对，必须报出来。
    assert.equal(code, 1)
    const report = JSON.parse(cap.stdout().trim())
    assert.equal(report.ok, false)
    assert.equal(report.findings.some((item) => item.code === 'no-model-list'), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
