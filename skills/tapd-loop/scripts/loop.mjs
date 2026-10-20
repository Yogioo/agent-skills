#!/usr/bin/env node
/**
 * TAPD 外循环：拉一张就绪卡，交给内循环（yogioo-mode）跑完，按 git 与 verify 判定，回写标签和评论。
 * 外循环只做确定性的四件事：取卡、占住、判定、回写。做没做对不看模型自述。
 */

import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTapd } from './tapd.mjs'
import { buildBrief, buildCardMd, commitMessage, writeBrief } from './brief.mjs'
import { readSettled, runTurn } from './turn.mjs'

const HOME = join(homedir(), '.tapd-loop')
const HERE = dirname(fileURLToPath(import.meta.url))
const STOP_NAME = '.tapd-loop-stop'

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) return printHelp()

  const workdir = resolve(args.workdir || process.cwd())
  const cfg = loadConfig(workdir, args)
  const tapd = createTapd({
    cwd: workdir,
    workspaceId: cfg.task.workspaceId,
    assignee: cfg.task.assignee,
    statuses: cfg.task.statuses,
    labels: cfg.task.labels,
    commentAuthor: cfg.task.commentAuthor,
  })

  if (args.list) {
    console.log(JSON.stringify({
      source: 'tapd',
      workspaceId: tapd.workspaceId,
      allowedStatuses: tapd.statuses.map((key) => `${key}(${tapd.statusLabel(key)})`),
      ready: tapd.listReady(),
      rejected: tapd.listRejected(),
    }, null, 2))
    return
  }

  if (args.fetch) {
    const dir = join(cfg.run.cacheDir || join(HOME, 'cards'), String(args.fetch))
    const detail = await tapd.getDetail(args.fetch, { imageDir: join(dir, 'images') })
    const cardMd = join(dir, 'card.md')
    mkdirSync(dir, { recursive: true })
    writeFileSync(cardMd, buildCardMd(detail), 'utf8')
    console.log(JSON.stringify({
      cardMd,
      title: detail.title,
      status: detail.statusLabel,
      comments: detail.commentCount,
      images: detail.images},
    null, 2))
    return
  }

  const git = createGit(workdir)
  if (!git.isRepo()) throw new Error(`不是 git 仓库: ${workdir}`)
  if (!args.allowDirty && !git.isClean()) throw new Error('工作区不干净，先处理后重跑（或加 --allow-dirty）')

  const runDir = join(cfg.run.cacheDir || join(HOME, 'runs'), `run-${stamp()}`)
  mkdirSync(runDir, { recursive: true })

  let boardUrl = ''
  if (!args.noBoard) {
    try {
      const out = execFileSync(process.execPath, [join(HERE, 'start-board.mjs')], { encoding: 'utf8', timeout: 15000 })
      boardUrl = JSON.parse(out).url
      process.stdout.write(`board: ${boardUrl}\n`)
    } catch {
      // 看板起不来不影响干活，看 board.log
    }
  }
  const progressFile = join(runDir, 'progress.jsonl')
  const log = (event, data = {}) => {
    try {
      appendFileSync(progressFile, JSON.stringify({ t: Date.now(), event, ...data }) + '\n')
    } catch {
      // 进度写不进去不能阻止干活
    }
  }
  const stopFile = cfg.run.stopFile || join(workdir, STOP_NAME)
  const ledger = []
  let failures = 0

  if (args.dryRun) {
    console.log(JSON.stringify({ dryRun: true, workdir, runDir, stopFile, cfg, ready: tapd.listReady(), rejected: tapd.listRejected() }, null, 2))
    return
  }

  let taskCount = 0
  log('loop_start', {
    workdir,
    source: 'tapd',
    assignee: cfg.task.assignee,
    statuses: cfg.task.statuses,
    maxTasks: cfg.run.maxTasks,
  })
  while (true) {
    if (existsSync(stopFile)) break
    if (taskCount >= cfg.run.maxTasks) break
    if (failures >= cfg.run.maxFailures) break

    const queued = tapd.listTagged()
    log('queue', {
      ready: queued.filter((card) => tapd.statuses.includes(card.status)).map((card) => card.id),
      rejected: queued.filter((card) => !tapd.statuses.includes(card.status)).map((card) => ({ id: card.id, status: card.statusLabel, title: card.title })),
    })

    const card = args.card
      ? queued.find((item) => item.id === args.card) || tapd.getCard(args.card)
      : queued.find((item) => tapd.statuses.includes(item.status))
    if (!card) {
      if (!cfg.run.watch) break
      sleep(cfg.run.pollSec * 1000)
      continue
    }

    const outcome = await runCard(card, { tapd, git, cfg, runDir, workdir, args, log })
    ledger.push(outcome)
    taskCount += 1
    if (outcome.status === 'failed') failures += 1
  }

  log('loop_end', { reason: existsSync(stopFile) ? 'stop-file' : taskCount >= cfg.run.maxTasks ? 'max-tasks' : failures >= cfg.run.maxFailures ? 'max-failures' : 'empty-queue' })
  const reportFile = writeReport(runDir, workdir, ledger, {
    reason: existsSync(stopFile) ? 'stop-file' : taskCount >= cfg.run.maxTasks ? 'max-tasks' : failures >= cfg.run.maxFailures ? 'max-failures' : 'empty-queue',
    rejected: tapd.listRejected(),
  })
  console.log(JSON.stringify({
    attempted: ledger.length,
    board: boardUrl,
    done: ledger.filter((row) => row.status === 'done').length,
    failed: ledger.filter((row) => row.status === 'failed').length,
    runDir,
    reportFile,
    ledger: ledger.map((row) => `${row.id} ${row.status}`),
  }))
}

async function runCard(card, ctx) {
  const { tapd, git, cfg, runDir, workdir } = ctx
  const dir = join(runDir, card.id)
  mkdirSync(dir, { recursive: true })
  const startedAt = new Date()
  const baseline = git.head()
  const log = ctx.log || (() => {})
  log('card_start', { id: card.id, title: card.title, priorityLabel: card.priorityLabel, statusLabel: card.statusLabel })

  if (!tapd.statuses.includes(card.status)) {
    log('card_skipped', { id: card.id, reason: `状态 ${card.statusLabel}，不在可接单范围` })
    return row(card, 'skipped', `状态 ${card.statusLabel}，不在可接单范围`, dir, startedAt)
  }

  log('card_phase', { id: card.id, phase: 'claim' })
  const claim = ctx.args.noWrite ? { ok: true } : tapd.claim(card.id)
  if (!claim.ok) {
    log('card_skipped', { id: card.id, reason: claim.reason })
    return row(card, 'skipped', claim.reason, dir, startedAt)
  }

  let detail
  try {
    log('card_phase', { id: card.id, phase: 'fetch' })
    detail = await tapd.getDetail(card.id, { imageDir: join(dir, 'images') })
  } catch (err) {
    log('card_failed', { id: card.id, reason: `读取需求失败: ${err.message}` })
    return finishFailed(card, `读取需求失败: ${err.message}`, dir, startedAt, { tapd, git, baseline, log, args: ctx.args })
  }
  log('card_phase', { id: card.id, phase: 'fetched', comments: detail.commentCount, images: detail.images.length })

  const attempt = (detail.body.match(/\[tapd-loop\] 失败/g) || []).length + 1
  const cardMd = buildCardMd(detail)
  const cardMdPath = join(dir, 'card.md')
  writeFileSync(cardMdPath, cardMd, 'utf8')

  const brief = buildBrief({
    card: { ...card, body: detail.body.replaceAll('](images/', `](${join(dir, 'images')}/`) },
    workdir,
    skillPath: cfg.run.skillPath,
    verify: cfg.run.verify,
    attempt,
    cardMdPath,
  })
  const briefFile = writeBrief(dir, brief)
  writeFileSync(join(dir, 'card.json'), JSON.stringify({ card, detail }, null, 2), 'utf8')

  const turn = runTurn({
    workdir,
    promptFile: briefFile,
    outDir: dir,
    skillPath: cfg.run.skillPath,
    sessionId: `tapd-${card.id}-${Date.now()}`,
    model: cfg.run.model,
    provider: cfg.run.provider,
    thinking: cfg.run.thinking,
    timeoutMs: cfg.run.timeoutSec * 1000,
  })
  log('turn_start', { id: card.id, model: cfg.run.model || '(default)', skill: cfg.run.skillPath })

  return turn.then((result) => {
    log('turn_end', { id: card.id, code: result.code, timedOut: result.timedOut, durationMs: result.durationMs })
    const settled = readSettled(result.eventsPath)
    const changed = git.changedSince(baseline)
    const evidence = `日志 ${plainPath(result.eventsPath)}`

    if (result.timedOut) return finishFailed(card, `超时 ${cfg.run.timeoutSec}s。${evidence}`, dir, startedAt, { tapd, git, baseline, log, args: ctx.args })
    if (!settled.settled || settled.aborted) {
      return finishFailed(card, `内循环没有正常结束（settled=${settled.settled}, aborted=${settled.aborted}）。${evidence}`, dir, startedAt, { tapd, git, baseline, log, args: ctx.args })
    }
    if (!changed) return finishFailed(card, `内循环结束了，但工作区没有任何改动。${evidence}`, dir, startedAt, { tapd, git, baseline, log, args: ctx.args })

    if (cfg.run.verify) {
      const verify = runVerify(cfg.run.verify, workdir, dir)
      if (!verify.ok) {
        return finishFailed(card, `验证命令失败（exit ${verify.code}）。${evidence}`, dir, startedAt, { tapd, git, baseline, log, args: ctx.args })
      }
    }

    let commit = git.head()
    if (ctx.args.noWrite) {
      log('card_done', { id: card.id, status: 'preview', durationMs: result.durationMs })
      return row(card, 'preview', `改动留在工作区，未提交。${clip(settled.lastText, 300)}`, dir, startedAt, result.durationMs)
    }
    if (git.isDirty()) {
      commit = git.commitAll(commitMessage(settled.lastText, card))
    }

    const note = [
      '[tapd-loop] 开发完成，请验收。',
      clip(settled.lastText, 2000),
      `提交：${commit.slice(0, 10)}`,
      `证据：${plainPath(join(dir, 'events.jsonl'))}`,
    ].filter(Boolean).join('\n\n')
    let writeBack = ''
    if (!ctx.args.noWrite) {
      try {
        tapd.deliver(card.id, note)
      } catch (err) {
        writeBack = err.message
      }
    }
    try { writeFileSync(join(dir, 'diff.txt'), git.diff(commit), 'utf8') } catch {}
    log('card_done', { id: card.id, status: 'done', commit: commit.slice(0, 10), durationMs: result.durationMs, writeBack })
    return row(card, 'done', writeBack ? `${commit.slice(0, 10)}（回写异常: ${writeBack}）` : commit.slice(0, 10), dir, startedAt, result.durationMs)
  })
}

function finishFailed(card, reason, dir, startedAt, ctx) {
  try { writeFileSync(join(dir, 'diff.txt'), ctx.git.diff(), 'utf8') } catch {}
  ctx.git.rollback(ctx.baseline)
  ctx.log?.('card_failed', { id: card.id, reason })
  try {
    if (!ctx.args.noWrite) {
      ctx.tapd.fail(card.id, [`[tapd-loop] 失败：${reason}`, `基线已回滚到 ${ctx.baseline.slice(0, 10)}。`].join('\n\n'))
    }
  } catch (err) {
    reason += `（回写 TAPD 也失败: ${err.message}）`
  }
  return row(card, 'failed', reason, dir, startedAt)
}

function runVerify(command, workdir, dir) {
  try {
    const output = execFileSync(command, {
      cwd: workdir,
      shell: true,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 600_000,
    })
    writeFileSync(join(dir, 'verify.log'), output, 'utf8')
    return { ok: true, code: 0 }
  } catch (err) {
    writeFileSync(join(dir, 'verify.log'), `${err.stdout || ''}\n${err.stderr || ''}`, 'utf8')
    return { ok: false, code: err.status ?? 1 }
  }
}

function createGit(cwd) {
  const run = (args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  return {
    isRepo: () => { try { run(['rev-parse', '--git-dir']); return true } catch { return false } },
    head: () => run(['rev-parse', 'HEAD']),
    isClean: () => !run(['status', '--porcelain']),
    isDirty: () => Boolean(run(['status', '--porcelain'])),
    changedSince: (rev) => Boolean(run(['status', '--porcelain'])) || run(['rev-parse', 'HEAD']) !== rev,
    commitAll: (message) => { run(['add', '-A']); run(['commit', '-m', message]); return run(['rev-parse', 'HEAD']) },
    rollback: (rev) => { run(['reset', '--hard', rev]); run(['clean', '-fd']) },
    diff: (rev) => {
      let out = ''
      try {
        out = rev ? run(['show', '--format=', '--patch', rev]) : run(['diff', 'HEAD'])
      } catch {
        return ''
      }
      return out.length > 200000 ? `${out.slice(0, 200000)}\n... 已截断` : out
    },
  }
}

function row(card, status, note, dir, startedAt, durationMs) {
  return {
    id: card.id,
    title: card.title,
    status,
    note: String(note || ''),
    dir,
    startedAt: startedAt.toISOString(),
    durationMs: durationMs ?? Date.now() - startedAt.getTime(),
  }
}

function writeReport(runDir, workdir, ledger, meta) {
  const lines = [
    `# tapd-loop 运行报告`,
    '',
    `- 工作区：${workdir}`,
    `- 开始：${new Date().toISOString()}`,
    `- 结束原因：${meta.reason}`,
    '',
    '| 卡片 | 状态 | 说明 |',
    '| --- | --- | --- |',
    ...ledger.map((row) => `| ${row.id} | ${row.status} | ${String(row.note).replace(/\n/g, ' ').slice(0, 160)} |`),
    '',
    '## 被状态挡住（未接单）',
    '',
    ...(meta.rejected?.length
      ? meta.rejected.map((card) => `- ${card.id} ${card.statusLabel} ${card.title}`)
      : ['- 无']),
  ]
  const file = join(runDir, 'report.md')
  writeFileSync(file, lines.join('\n') + '\n', 'utf8')
  return file
}

function loadConfig(workdir, args) {
  const projectFile = join(workdir, '.tapd-loop.json')
  const globalFile = join(HOME, 'config.json')
  const base = {
    task: { workspaceId: '', assignee: '', commentAuthor: '', statuses: ['developing', 'status_11'], labels: {} },
    run: {
      maxTasks: 1,
      maxFailures: 2,
      timeoutSec: 3600,
      verify: '',
      watch: false,
      pollSec: 60,
      skillPath: join(homedir(), '.agents', 'skills', 'yogioo-mode'),
      model: '',
      provider: '',
      thinking: '',
      cacheDir: '',
      stopFile: '',
    },
  }
  const merged = deepMerge(base, readJson(globalFile), readJson(projectFile))
  if (args.maxTasks) merged.run.maxTasks = Number(args.maxTasks)
  if (args.timeoutSec) merged.run.timeoutSec = Number(args.timeoutSec)
  if (args.watch) merged.run.watch = true
  if (args.verify) merged.run.verify = args.verify
  if (args.model) merged.run.model = args.model
  if (args.thinking) merged.run.thinking = args.thinking
  if (args.assignee) merged.task.assignee = args.assignee
  if (args.commentAuthor) merged.task.commentAuthor = args.commentAuthor
  if (args.statuses) merged.task.statuses = String(args.statuses).split(',').map((s) => s.trim()).filter(Boolean)
  merged.run.allowDirty = Boolean(args.allowDirty)
  if (!merged.task.assignee && !args.fetch) throw new Error('缺少 task.assignee（TAPD 处理人）')
  return merged
}

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (!token.startsWith('--')) { out._.push(token); continue }
    const key = token.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) { out[key] = next; i++ } else { out[key] = true }
  }
  return out
}

function readJson(path) {
  if (!existsSync(path)) return {}
  return JSON.parse(readFileSync(path, 'utf8'))
}

function deepMerge(...objects) {
  const out = {}
  for (const obj of objects) {
    for (const [key, value] of Object.entries(obj || {})) {
      if (value && typeof value === 'object' && !Array.isArray(value)) out[key] = deepMerge(out[key], value)
      else if (value !== undefined) out[key] = value
    }
  }
  return out
}

/**
 * 按句子边界截断。直接 slice 会把最后一句切一半，评论里看着像写崩了。
 */
function clip(text, max) {
  const source = String(text || '').trim()
  if (source.length <= max) return source
  const head = source.slice(0, max)
  const cut = Math.max(
    head.lastIndexOf('。'),
    head.lastIndexOf('\n'),
    head.lastIndexOf('；'),
    head.lastIndexOf('！'),
    head.lastIndexOf('？'),
    head.lastIndexOf('. '),
  )
  const keep = cut >= max * 0.5 ? head.slice(0, cut + 1) : head
  return `${keep.trimEnd()}…`
}

/**
 * 路径写进 TAPD 评论时统一用正斜杠：Markdown 把 `\.` 当转义，`C:\\Users\\EDY\\.tapd-loop` 会变成
 * `C:\\Users\\EDY.tapd-loop`，人照着复制就找不到了。Windows 本身也认正斜杠。
 */
function plainPath(path) {
  return String(path || '').replace(/\\/g, '/')
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace('T', '').slice(0, 14)
}

function printHelp() {
  console.log(`用法: node scripts/loop.mjs --workdir <仓库> [选项]

  --list              只列出 TAPD 就绪卡，不执行
  --fetch <id>        只抓取工单标题/详情/评论/图片到本地 md
  --dry-run           打印配置、运行目录与就绪卡
  --card <id>         只跑指定卡片
  --max-tasks <n>     本批最多跑几张（默认 1）
  --watch             队列空了继续轮询
  --verify <cmd>      每个 turn 之后必过的命令
  --statuses <list>   允许接单的状态 key，逗号分隔（默认 developing,status_11）
  --timeout-sec <n>   单卡超时（默认 3600）
  --model / --thinking / --assignee
  --allow-dirty       允许脏工作区启动（不推荐）
  --no-write          不写 TAPD（不认领、不标完成、不评论），用于本地演练
  --no-board          不起看板（默认会自动启动或复用）
  --help

配置: <仓库>/.tapd-loop.json 覆盖 ~/.tapd-loop/config.json
`)
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
