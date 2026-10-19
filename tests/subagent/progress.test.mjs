/**
 * 臂进度记录：events 进 progress.jsonl 之前必须先压成少量可读记录，
 * 且观察端的任何失败都不允许杀死执行。
 *
 *   node --test tests/subagent/progress.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runArms } from '../../lib/subagent/index.mjs'
import { createArmProgress } from '../../lib/subagent/arm-progress.mjs'

function readProgress(file) {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line))
}

/** 假 runTurn：把 onEvent 按脚本喂进去，不启动任何子进程。 */
function fakeTurn(script) {
  return async (opts) => {
    await script(opts)
    writeFileSync(opts.outFile, 'ok', 'utf8')
    if (!existsSync(opts.eventsFile)) writeFileSync(opts.eventsFile, '', 'utf8')
    writeFileSync(opts.logFile, '', 'utf8')
    return { runner: 'pi', exitCode: 0, timedOut: false, aborted: false }
  }
}

test('progress.jsonl 只留 arm_start / think / tool / arm_end，并成对合并耗时', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'arm-progress-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const outDir = join(root, 'run')

  await runArms({
    arms: [{ label: 'feature', runner: 'pi', workdir: root, prompt: 'x' }],
    outDir,
    runTurn: fakeTurn(async (opts) => {
      opts.onEvent({ kind: 'tool', phase: 'start', toolName: 'Read', callId: 'a' })
      opts.onEvent({ kind: 'tool', phase: 'done', toolName: 'Read', callId: 'a' })
      // 片段一律不写：一轮上千条，写了看板就读不动了。
      opts.onEvent({ kind: 'assistant_partial', text: '字' })
      // 但一整块思考是几十条以内的，要写。
      opts.onEvent({ kind: 'thinking', text: '想' })
      // 一次性 tool 事件（Cursor）没有 phase，也要记一条。
      opts.onEvent({ kind: 'tool', toolName: 'shell' })
    }),
  })

  const records = readProgress(join(outDir, 'progress.jsonl'))
  const events = records.map((record) => record.event)
  assert.deepEqual(events, ['arm_start', 'tool', 'think', 'tool', 'arm_end'])

  assert.equal(records[1].name, 'Read')
  assert.equal(typeof records[1].ms, 'number')
  assert.equal(records[2].event, 'think')
  assert.equal(records[2].text, '想')
  assert.equal(records[3].name, 'shell')
  assert.equal(records[3].ms, undefined, '没有配对 start 就不要编耗时')

  const end = records.at(-1)
  assert.equal(end.arm, 'feature')
  assert.equal(end.status, 'ok')
  assert.equal(end.tools, 2)
  assert.equal(typeof end.elapsedMs, 'number')
})

test('失败的臂也必须留下 arm_end，并带上可读原因', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'arm-progress-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const outDir = join(root, 'run')

  const results = await runArms({
    arms: [{ label: 'review', runner: 'pi', workdir: root, prompt: 'x' }],
    outDir,
    runTurn: async () => {
      throw new Error('bin 不存在')
    },
  })
  assert.equal(results[0].status, 'error')

  const end = readProgress(join(outDir, 'progress.jsonl')).at(-1)
  assert.equal(end.event, 'arm_end')
  assert.equal(end.status, 'error')
  assert.match(String(end.reason), /bin 不存在/)
})

test('tool 行必须说人话：参数在配对的 start 上也要带到完成态', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'arm-progress-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const progressFile = join(root, 'progress.jsonl')
  const progress = createArmProgress({
    file: progressFile,
    arm: 'feature',
    meta: { runner: 'pi', model: 'deepseek-flash', thinking: 'xhigh' },
  })

  // pi：start 带 args，done 只有 result。
  progress.onEvent({ kind: 'tool', phase: 'start', callId: 'a', toolName: 'read',
    args: { path: 'C:/p/Assets/Scripts/Foo.cs' } })
  progress.onEvent({ kind: 'tool', phase: 'done', callId: 'a', toolName: 'read' })
  // Cursor：一次性事件，参数就在自己身上。
  progress.onEvent({ kind: 'tool', toolName: 'shell', args: { command: 'ls -la Temp\n echo hi' } })
  // 认不出形状的 mcp 工具：降级成第一个像样的参数，绝不编。
  progress.onEvent({ kind: 'tool', toolName: 'mcp__unityMCP__read_console', args: { action: 'get' } })
  // 没有参数就什么都别写，别让页面出现“读 undefined”。
  progress.onEvent({ kind: 'tool', toolName: 'edit' })
  progress.end({ status: 'ok' })

  const tools = readProgress(progressFile).filter((record) => record.event === 'tool')
  assert.equal(tools[0].detail, '…/Assets/Scripts/Foo.cs', '不在 workdir 里就留尾巴三段')
  assert.equal(tools[1].detail, 'ls -la Temp (+1 行)', '多行脚本只看首行，但要标出还有几行')
  assert.equal(tools[2].detail, 'get')
  assert.equal(tools[3].detail, undefined)
  assert.equal(tools.every((record) => !String(record.detail || '').includes(record.name)), true,
    'detail 不带工具名：页面自己配图标和动词，两处都写就成了“读 read …”')
})

test('say 只写完整的助手消息：流式片段丢掉、重复文本不重写', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'arm-progress-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const progressFile = join(root, 'progress.jsonl')
  const progress = createArmProgress({ file: progressFile, arm: 'x' })

  progress.onEvent({ kind: 'assistant_partial', text: '字' })
  progress.onEvent({ kind: 'thinking', text: '想' })
  progress.onEvent({ kind: 'assistant', text: '我先看配置表。' })
  progress.onEvent({ kind: 'assistant', text: '我先看配置表。' })
  progress.onEvent({ kind: 'assistant', text: '' })
  progress.end({ status: 'ok' })

  const says = readProgress(progressFile).filter((record) => record.event === 'say')
  assert.deepEqual(says.map((record) => record.text), ['我先看配置表。'])
})

test('arm_start 带上标题信息：谁在跑、什么模型、思考多深', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'arm-progress-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const progressFile = join(root, 'progress.jsonl')
  const progress = createArmProgress({
    file: progressFile, arm: 'x', meta: { runner: 'pi', model: 'm', thinking: 'high' },
  })
  progress.end({ status: 'ok' })

  const start = readProgress(progressFile)[0]
  assert.equal(start.event, 'arm_start')
  assert.deepEqual(
    { runner: start.runner, model: start.model, thinking: start.thinking },
    { runner: 'pi', model: 'm', thinking: 'high' },
  )
})

test('detail 在 workdir 里就写相对路径，多行命令要标出行数', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'arm-progress-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const progressFile = join(root, 'progress.jsonl')
  const workdir = 'C:\\projects\\DigitDoor'
  const progress = createArmProgress({ file: progressFile, arm: 'x', workdir })

  progress.onEvent({ kind: 'tool', phase: 'start', callId: 'a', toolName: 'edit',
    args: { path: 'C:\\projects\\DigitDoor\\Assets\\Scripts_Hotfix\\Game\\UI\\Scroll\\ScrollSceneLayoutRules.cs' } })
  progress.onEvent({ kind: 'tool', phase: 'done', callId: 'a', toolName: 'edit' })
  progress.onEvent({ kind: 'tool', toolName: 'bash', args: { command: 'git add -A\ngit commit -m x\ngit push' } })
  progress.end({ status: 'ok' })

  const tools = readProgress(progressFile).filter((record) => record.event === 'tool')
  assert.equal(tools[0].detail, 'Assets/Scripts_Hotfix/Game/UI/Scroll/ScrollSceneLayoutRules.cs')
  assert.equal(tools[1].detail, 'git add -A (+2 行)')
})

test('think 记录：截断、相邻重复不重写、空白丢弃', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'arm-progress-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const progressFile = join(root, 'progress.jsonl')
  const progress = createArmProgress({ file: progressFile, arm: 'x' })

  progress.onEvent({ kind: 'thinking', text: '先看 配置\n表。' })
  progress.onEvent({ kind: 'thinking', text: '先看 配置\n表。' })
  progress.onEvent({ kind: 'thinking', text: '   ' })
  progress.onEvent({ kind: 'thinking', text: '换' .repeat(600) })
  progress.end({ status: 'ok' })

  const thinks = readProgress(progressFile).filter((record) => record.event === 'think')
  assert.equal(thinks.length, 2, '重复与空白不写')
  assert.equal(thinks[0].text, '先看 配置 表。', '换行压成一行')
  assert.equal(thinks[1].text.length <= 400, true, '思考也截断')
})

test('arm_start 把输入写进去：看板不展示输入就不知道这轮在干什么', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'arm-progress-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const brief = join(root, 'brief.md')
  const body = `把地形配置页的默认值改成从表里读。${'细节'.repeat(500)}`
  writeFileSync(brief, body, 'utf8')
  const outDir = join(root, 'run')

  await runArms({
    arms: [{ label: 'feature', runner: 'pi', workdir: root, promptFile: brief }],
    outDir,
    runTurn: fakeTurn(async () => {}),
  })

  const start = readProgress(join(outDir, 'progress.jsonl'))[0]
  assert.equal(start.event, 'arm_start')
  assert.equal(start.promptChars, body.length)
  assert.equal(start.promptFile, brief)
  assert.equal(start.prompt.length <= 701, true, '预览有上限')
  assert.match(start.prompt, /^把地形配置页/)
  assert.match(start.prompt, /…$/)
})

test('写入失败时 createArmProgress 不抛异常（观察端不许杀执行）', () => {
  const root = mkdtempSync(join(tmpdir(), 'arm-progress-'))
  rmSync(root, { recursive: true, force: true })
  const dirAsFile = root
  writeFileSync(`${root}.marker`, 'x', 'utf8')
  // 目标是目录，appendFileSync 一定失败。
  const progress = createArmProgress({ file: dirAsFile, arm: 'x' })
  assert.doesNotThrow(() => progress.onEvent({ kind: 'tool', phase: 'done', toolName: 'Edit' }))
  assert.doesNotThrow(() => progress.end({ status: 'ok' }))
  rmSync(`${root}.marker`, { force: true })
})
