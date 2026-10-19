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
    // 执行用 agent runner（有假 CLI），但解析语义由**生效的 runner** 决定，所以这里
    // 用 pi 来看 effort 拆分与 provider 归属。
    const code = await runCli(
      ['plan', '--role', 'interrogate reviewers', '--runner', 'pi', ...rolesArgs(dir)],
      cap.io,
    )
    assert.equal(code, 0)
    const result = JSON.parse(cap.stdout().trim())
    assert.equal(result.runner, 'pi')
    assert.equal(result.arms.length, 2)
    const [first, second] = result.arms
    assert.equal(first.model, 'model-a')
    assert.equal(first.thinking, 'xhigh')
    assert.equal(first.provider, 'alpha')
    assert.deepEqual(second.slug, 'model-b-medium')
    assert.equal(second.provider, 'beta')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('plan 对枚举型 runner 原样传模型 id，也不去定 provider', async () => {
  const dir = workspace()
  writeFileSync(
    join(dir, 'cursor-table.md'),
    [
      '# budget: large (xhigh)',
      '# runner: pi',
      'swarm workers: cursor:gpt-5.3-codex-xhigh',
      'interrogate reviewers: cursor:claude-opus-5-thinking-high, pi:model-b-high',
    ].join('\n'),
  )
  const cap = capture()
  try {
    const code = await runCli(
      ['plan', '--role', 'swarm workers', '--role', 'interrogate reviewers', '--roles-file', join(dir, 'cursor-table.md'), '--models-file', join(dir, 'models.txt')],
      cap.io,
    )
    assert.equal(code, 0)
    const [cursorArm, panelCursor, panelPi] = JSON.parse(cap.stdout().trim()).arms
    assert.equal(cursorArm.runner, 'agent', 'cursor 是 agent 的别名')
    assert.equal(cursorArm.model, 'gpt-5.3-codex-xhigh', '枚举型的 id 不能被拆后缀')
    assert.equal(cursorArm.thinking, undefined)
    assert.equal(cursorArm.provider, undefined, 'agent runner 没有 provider 概念')
    assert.equal(panelCursor.runner, 'agent')
    assert.equal(panelCursor.model, 'claude-opus-5-thinking-high')
    assert.equal(panelPi.runner, 'pi', '同一个面板里不同角色可以走不同 CLI')
    assert.equal(panelPi.model, 'model-b')
    assert.equal(panelPi.provider, 'beta')
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
    // 表里的默认 runner 是 agent，而它把推理强度放在模型 id 里，所以整串原样传
    assert.equal(arm.model, 'model-b-medium')
    assert.equal(arm.thinking, undefined)
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
    assert.deepEqual(result.arms.map((arm) => arm.model), ['model-a-xhigh', 'model-b-medium'])
    assert.deepEqual(result.arms.map((arm) => arm.thinking), [undefined, 'low'], '枚举型 runner 忽略值里的后缀，但显式覆盖作数')
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
  assert.match(record.errorMessage, /boom/, '失败必须带上一个可读的原因，不能只给一个 error')
  assert.equal(boomResult.arms[0].errorMessage, record.errorMessage)

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
    assert.equal(result.arms[0].model, 'model-a-xhigh', 'agent runner 不改模型 id')
    assert.equal(result.arms[0].thinking, undefined)
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
    assert.match(cap.stderr(), /没有 provider 概念/)

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
    assert.equal(report.modelLists.pi.source, join(dir, 'models.txt'))
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

test('拼错的 --sandbox 必须在起臂前被拦下，不能静默放权', async () => {
  const dir = workspace()
  const cap = capture()
  try {
    // 打过这个错：`red-only` 之前会落到 runner 的默认放权模式。
    const bad = await runCli(
      [
        'run', '--role', 'how explorer', '--prompt-file', join(dir, 'brief-a.md'),
        '--out-dir', join(dir, 'o-bad'), '--sandbox', 'red-only',
        '--runner', 'agent', '--bin', join(dir, 'ok.mjs'), ...rolesArgs(dir),
      ],
      cap.io,
    )
    assert.equal(bad, 2)
    assert.match(cap.stderr(), /不支持 --sandbox red-only/)
    assert.match(cap.stderr(), /read-only \/ workspace-write \/ danger-full-access/)
    assert.equal(existsSync(join(dir, 'o-bad')), false, '被拦下时不该建出目录')

    const planCap = capture()
    const planCode = await runCli(
      ['plan', '--role', 'how explorer', '--sandbox', 'nonsense', ...rolesArgs(dir)],
      planCap.io,
    )
    assert.equal(planCode, 2)
    assert.match(planCap.stderr(), /不支持 --sandbox nonsense/)

    const good = capture()
    const goodCode = await runCli(
      [
        'run', '--role', 'how explorer', '--prompt-file', join(dir, 'brief-a.md'),
        '--out-dir', join(dir, 'o-good'), '--sandbox', 'read-only',
        '--runner', 'agent', '--bin', join(dir, 'ok.mjs'), ...rolesArgs(dir),
      ],
      good.io,
    )
    assert.equal(goodCode, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('--no-board 已移除：拒绝得明白，且不许静默起臂', async () => {
  const dir = workspace()
  const cap = capture()
  try {
    // 打过这个错：这个按次开关一开，人的看板就空了，而调用方什么提示都收不到。
    // 现在必须硬拒，并把“整机不要看板”指到环境变量上。
    const code = await runCli(
      [
        'run', '--role', 'how explorer', '--prompt-file', join(dir, 'brief-a.md'),
        '--out-dir', join(dir, 'o-noboard'), '--no-board',
        '--runner', 'agent', '--bin', join(dir, 'ok.mjs'), ...rolesArgs(dir),
      ],
      cap.io,
    )
    assert.equal(code, 2)
    assert.match(cap.stderr(), /--no-board 已移除/)
    assert.match(cap.stderr(), /AGENT_TOOLS_BOARD=off/)
    assert.equal(existsSync(join(dir, 'o-noboard')), false, '被拦下时不该建出目录')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('一臂起不来不能带走整批：其余臂的结果照交', async () => {
  const dir = workspace()
  writeFileSync(
    join(dir, 'dead-arm.json'),
    JSON.stringify({
      role: 'how explorer',
      runner: 'agent',
      arms: [
        { label: 'arm-ok', promptFile: 'brief-a.md' },
        { label: 'arm-dead', promptFile: 'brief-b.md', workdir: join(dir, 'no such workdir') },
      ],
    }),
  )
  const outDir = join(dir, 'out partial')
  const cap = capture()
  try {
    const code = await runCli(
      [
        'run', '--manifest', join(dir, 'dead-arm.json'), '--out-dir', outDir,
        '--bin', join(dir, 'ok.mjs'), ...rolesArgs(dir),
      ],
      cap.io,
    )
    assert.equal(code, 1)
    const result = JSON.parse(cap.stdout().trim())
    assert.equal(result.ok, 1)
    assert.equal(result.error, 1)
    const byLabel = Object.fromEntries(result.arms.map((arm) => [arm.label, arm]))
    assert.equal(byLabel['arm-ok'].status, 'ok')
    assert.equal(readFileSync(byLabel['arm-ok'].outputFile, 'utf8').trim(), 'ARM-A')
    assert.equal(byLabel['arm-dead'].status, 'error')

    const records = readFileSync(result.reportFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    assert.equal(records.length, 2, '报告必须完整交给调用方')
    const dead = records.find((record) => record.label === 'arm-dead')
    assert.match(dead.errorMessage, /启动失败/)
    assert.equal(dead.exitCode, null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('嵌套的 --out-dir 会自动建父目录', async () => {
  const dir = workspace()
  const outDir = join(dir, 'deep', 'nested', 'out')
  const cap = capture()
  try {
    const code = await runCli(
      [
        'run', '--role', 'how explorer', '--prompt-file', join(dir, 'brief-a.md'),
        '--out-dir', outDir, '--runner', 'agent', '--bin', join(dir, 'ok.mjs'), ...rolesArgs(dir),
      ],
      cap.io,
    )
    assert.equal(code, 0)
    assert.ok(existsSync(join(outDir, 'how-explorer', 'output.txt')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('init 写出的表直接通过 doctor，且不覆盖已有文件', async () => {
  const dir = workspace()
  const out = join(dir, 'fresh.md')
  const cap = capture()
  try {
    const code = await runCli(['init', '--out', out, '--budget', 'medium', '--runner', 'agent'], cap.io)
    assert.equal(code, 0)
    const result = JSON.parse(cap.stdout().trim())
    assert.equal(result.lines, 17)
    assert.equal(result.roles, 20)
    const text = readFileSync(out, 'utf8')
    assert.match(text, /^# budget: medium \(high\)$/m)
    assert.match(text, /^# runner: agent$/m)
    assert.equal((text.match(/: inherit-parent$/gm) || []).length, 17)

    const again = capture()
    assert.equal(await runCli(['init', '--out', out], again.io), 2)
    assert.match(again.stderr(), /已存在/)

    const bad = capture()
    assert.equal(await runCli(['init', '--out', join(dir, 'x.md'), '--budget', 'huge'], bad.io), 2)
    assert.match(bad.stderr(), /未知 --budget huge/)

    // "开箱可用"不是形容词：拿真 doctor 验一遍。
    const doc = capture()
    assert.equal(await runCli(['doctor', '--roles-file', out, '--models-file', join(dir, 'models.txt')], doc.io), 0)
    const report = JSON.parse(doc.stdout().trim())
    assert.equal(report.ok, true)
    assert.equal(report.counts.errors, 0)
    assert.equal(report.counts.warnings, 0)
    assert.equal(report.roles.length, 17)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('set 就地改角色：拆共用行、保注释、值里的冒号不受影响', async () => {
  const dir = workspace()
  const file = join(dir, 'edit-me.md')
  writeFileSync(
    file,
    [
      '# budget: medium (high)',
      '# runner: agent',
      '# 我自己加的注释',
      'feature, refactoring: model-a-xhigh',
      'how explorer: model-b-medium',
      'interrogate reviewers: model-a-xhigh',
      '',
    ].join('\n'),
  )
  const before = readFileSync(file, 'utf8')
  const cap = capture()
  try {
    // dry-run 一个字节都不能写
    const dryCap = capture()
    const dryCode = await runCli(
      ['set', '--roles-file', file, '--role', 'feature', '--value', 'cursor:composer-2.5', '--dry-run'],
      dryCap.io,
    )
    assert.equal(dryCode, 0)
    assert.equal(readFileSync(file, 'utf8'), before)
    const dry = JSON.parse(dryCap.stdout().trim())
    assert.equal(dry.dryRun, true)
    assert.match(dry.text, /^feature: cursor:composer-2\.5$/m)

    const code = await runCli(
      [
        'set', '--roles-file', file,
        '--role', 'feature', '--value', 'cursor:composer-2.5',
        '--role', 'interrogate reviewers', '--value', 'cursor:claude-opus-5-thinking-high, model-b-xhigh',
      ],
      cap.io,
    )
    assert.equal(code, 0)
    const after = readFileSync(file, 'utf8')
    // 共用行被拆开，另一个角色原样留下
    assert.match(after, /^refactoring: model-a-xhigh$/m)
    assert.ok(!after.includes('feature, refactoring'), '拆开后不该再留着共用行')
    assert.match(after, /^feature: cursor:composer-2\.5$/m, '枚举型 runner 的值带冒号也得完整写回')
    assert.match(after, /^interrogate reviewers: cursor:claude-opus-5-thinking-high, model-b-xhigh$/m)
    // 注释与顺序不动
    assert.match(after, /^# 我自己加的注释$/m)
    assert.ok(after.indexOf('# budget') < after.indexOf('refactoring:'))
    assert.ok(after.indexOf('how explorer:') < after.indexOf('feature:'), '新行追加在尾部')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('set 拒绝未知角色与落单的 --value', async () => {
  const dir = workspace()
  const file = join(dir, 'edit-me.md')
  writeFileSync(file, '# runner: agent\nfeature: model-a-xhigh\n')
  const cap = capture()
  try {
    const unknown = capture()
    const unknownCode = await runCli(
      ['set', '--roles-file', file, '--role', 'nope-role', '--value', 'x'],
      unknown.io,
    )
    assert.equal(unknownCode, 2)
    assert.match(unknown.stderr(), /角色表里没有 nope-role/)

    const lonely = capture()
    assert.equal(await runCli(['set', '--roles-file', file, '--value', 'x'], lonely.io), 2)
    assert.match(lonely.stderr(), /必须跟在一个 --role 后面/)

    const trailing = capture()
    assert.equal(await runCli(['set', '--roles-file', file, '--role', 'feature', '--value', 'x', '--value', 'y'], trailing.io), 2)
    assert.match(trailing.stderr(), /必须跟在一个 --role 后面/)

    const noValue = capture()
    assert.equal(await runCli(['set', '--roles-file', file, '--role', 'feature'], noValue.io), 2)
    assert.match(noValue.stderr(), /缺少对应的 --value/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('probe 用真跑判定可用性，而不是看清单里有没有', async () => {
  const dir = workspace()
  writeFileSync(
    join(dir, 'picky.mjs'),
    "const a=process.argv.join(' ')\n" +
      "if(a.includes('bad-model')){process.stderr.write('no subscription\\n');process.exit(3)}\n" +
      "process.stdout.write(JSON.stringify({type:'result',subtype:'success',result:'PROBE-OK'})+'\\n')\n" +
      'process.exit(0)\n',
  )
  writeFileSync(join(dir, 'probe-models.txt'), 'provider  model\nalpha     good-model\nbeta      bad-model\n')
  const outDir = join(dir, 'out probe')
  const cap = capture()
  try {
    const code = await runCli(
      [
        'probe', '--out-dir', outDir,
        '--model', 'alpha/good-model',
        '--model', 'beta/bad-model',
        '--runner', 'agent', '--bin', join(dir, 'picky.mjs'),
        '--models-file', join(dir, 'probe-models.txt'),
      ],
      cap.io,
    )
    assert.equal(code, 1, '有不可用的目标就该非 0')
    const result = JSON.parse(cap.stdout().trim())
    assert.equal(result.ok, false)
    assert.deepEqual(result.usable.map((item) => item.model), ['good-model'])
    assert.deepEqual(result.unusable.map((item) => item.model), ['bad-model'])
    assert.ok(existsSync(result.reportFile))
    assert.equal(result.probes.length, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('probe 能从表里的角色取目标（清单走 JSON 逐 runner 形式）', async () => {
  const dir = workspace()
  // agent runner 的模型 id 就是枚举变体，所以清单里得写全名。
  writeFileSync(join(dir, 'agent-models.json'), JSON.stringify({ agent: ['model-a-xhigh', 'model-b-medium'] }))
  const outDir = join(dir, 'out by role')
  const cap = capture()
  try {
    const code = await runCli(
      [
        'probe', '--out-dir', outDir, '--role', 'interrogate reviewers',
        '--runner', 'agent', '--bin', join(dir, 'ok.mjs'),
        '--roles-file', join(dir, 'roles.md'), '--models-file', join(dir, 'agent-models.json'),
      ],
      cap.io,
    )
    assert.equal(code, 0)
    const result = JSON.parse(cap.stdout().trim())
    assert.deepEqual(result.usable.map((item) => item.model), ['model-a-xhigh', 'model-b-medium'])
    assert.deepEqual(result.probes.map((item) => item.runner), ['agent', 'agent'])
    assert.equal(result.unresolved.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('probe 对全 inherit-parent 的表没有可探目标，也不建目录', async () => {
  const dir = workspace()
  writeFileSync(join(dir, 'all-alias.md'), '# budget: large (xhigh)\n# runner: pi\nfeature, refactoring: inherit-parent\n')
  const outDir = join(dir, 'out alias')
  const cap = capture()
  try {
    const code = await runCli(
      ['probe', '--out-dir', outDir, '--roles-file', join(dir, 'all-alias.md'), '--models-file', join(dir, 'models.txt')],
      cap.io,
    )
    assert.equal(code, 0)
    const result = JSON.parse(cap.stdout().trim())
    assert.equal(result.ok, true)
    assert.equal(result.probes.length, 0)
    assert.equal(result.reportFile, null)
    assert.match(result.note, /inherit-parent/)
    assert.equal(existsSync(outDir), false, '没探就不该建目录')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('doctor：角色表不存在时报 no-role-file，不倒过来报 ok', async () => {
  const dir = workspace()
  const saved = process.env.USERPROFILE
  const emptyHome = join(dir, 'empty-home')
  mkdirSync(emptyHome, { recursive: true })
  process.env.USERPROFILE = emptyHome
  const cap = capture()
  try {
    const code = await runCli(['doctor', '--models-file', join(dir, 'models.txt'), '--runner', 'pi'], cap.io)
    assert.equal(code, 1)
    const report = JSON.parse(cap.stdout().trim())
    assert.equal(report.rolesFile, null)
    assert.equal(report.ok, false)
    assert.equal(report.findings.some((item) => item.code === 'no-role-file'), true)
  } finally {
    if (saved === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = saved
    rmSync(dir, { recursive: true, force: true })
  }
})

test('doctor：runner 声明了清单却拉不到 = error；声明没有清单 = 未核实', async () => {
  const dir = workspace()
  writeFileSync(
    join(dir, 'codex-table.md'),
    '# budget: large (xhigh)\n# runner: codex\nswarm workers: gpt-5.1-codex-xhigh\n',
  )
  const cap = capture()
  try {
    // pi 声明了 --list-models，所以拉不到就是真故障。
    const piCap = capture()
    const piCode = await runCli(
      ['doctor', '--roles-file', join(dir, 'roles.md'), '--runner', 'pi', '--bin', join(dir, 'nope.mjs')],
      piCap.io,
    )
    assert.equal(piCode, 1)
    const piReport = JSON.parse(piCap.stdout().trim())
    assert.equal(piReport.ok, false)
    assert.equal(piReport.findings.some((item) => item.code === 'no-model-list'), true)

    // codex 没有这种命令，所以只能标未核实，不能假绿也不能假报错。
    const codexCap = capture()
    const codexCode = await runCli(
      ['doctor', '--roles-file', join(dir, 'codex-table.md'), '--runner', 'codex'],
      codexCap.io,
    )
    assert.equal(codexCode, 0)
    const codexReport = JSON.parse(codexCap.stdout().trim())
    assert.equal(codexReport.ok, true)
    assert.equal(codexReport.findings.some((item) => item.code === 'unverified-runner'), true)
    assert.equal(codexReport.roles[0].values[0].verified, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
