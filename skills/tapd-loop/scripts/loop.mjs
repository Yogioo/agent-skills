#!/usr/bin/env node
/**
 * TAPD 外循环：拉一张就绪卡，交给内循环（yogioo-mode）跑完，按 git 与 verify 判定，回写标签和评论。
 * 外循环只做确定性的四件事：取卡、占住、判定、回写。做没做对不看模型自述。
 */

import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTapd } from './tapd.mjs'
import { buildBrief, buildCardMd, commitMessage, writeBrief } from './brief.mjs'
import { abortAllTurns, readSettled, runTurn } from './turn.mjs'

const HOME = join(homedir(), '.tapd-loop')
const HERE = dirname(fileURLToPath(import.meta.url))
const STOP_NAME = 'tapd-loop-stop'
const CONFIG_NAME = 'tapd-loop.json'
// 心跳间隔。看板主要靠 pid 判死活，心跳是 pid 判不了时的依据，顺带让「进程还活着」可观测。
const HEARTBEAT_SEC = 15
/** 当前处理到哪张卡。信号中断时靠它给正在跑的那张写 card_interrupted。 */
let currentCardId = ''
/** 卡的标题。看板拿它显示「在跑哪张」，比一串 19 位 id 好认。心跳里一起带出去。 */
let currentCardTitle = ''

/**
 * 仓库级配置放 .git/ 下，不放工作区。
 * 用 --git-common-dir 而不是 --git-dir：同一仓库的所有 worktree 共用一份配置，不用每棵树重复写。
 */
function gitPath(workdir, flag) {
  try {
    const out = execFileSync('git', ['rev-parse', flag], {
      cwd: workdir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }).trim()
    return out ? resolve(workdir, out) : ''
  } catch {
    return ''
  }
}

/** 配置用这个：同一仓库的所有 worktree 拿到同一个目录，一份配置管所有树。 */
function gitCommonDir(workdir) {
  return gitPath(workdir, '--git-common-dir')
}

/** 停止文件用这个：每棵树各自的 git dir，停一棵不影响另一棵。 */
function gitOwnDir(workdir) {
  return gitPath(workdir, '--git-dir')
}

/** 把老位置的 .tapd-loop.json 搬进 .git/，搬完把旧的删掉。 */
function migrateConfig(workdir) {
  const commonDir = gitCommonDir(workdir)
  if (!commonDir) throw new Error(`${workdir} 不在 git 仓库里，没有 .git 可以放配置`)
  const from = join(workdir, '.tapd-loop.json')
  const to = join(commonDir, CONFIG_NAME)
  if (!existsSync(from)) throw new Error(`没有要搬的文件：${from}`)
  if (existsSync(to)) throw new Error(`目标已存在，不覆盖：${to}（确认后自己合并或删除）`)
  const parsed = JSON.parse(readFileSync(from, 'utf8'))
  mkdirSync(dirname(to), { recursive: true })
  writeFileSync(to, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8')
  rmSync(from)
  return { moved: true, from: plainPath(from), to: plainPath(to), topKeys: Object.keys(parsed) }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) return printHelp()

  const workdir = resolve(args.workdir || process.cwd())
  if (args.migrateConfig) {
    console.log(JSON.stringify(migrateConfig(workdir), null, 2))
    return
  }

  const cfg = loadConfig(workdir, args)
  if (cfg.sources?.legacyInWorkdir) {
    process.stderr.write(
      `[tapd-loop] ${cfg.sources.legacyInWorkdir} 在仓库根目录，会被 git 看到。建议搬进 .git/：加 --migrate-config 跑一次（目标 ${cfg.sources.repo}）\n`,
    )
  }
  const tapd = createTapd({
    cwd: workdir,
    workspaceId: cfg.task.workspaceId,
    assignee: cfg.task.assignee,
    statuses: cfg.task.statuses,
    labels: cfg.task.labels,
    commentAuthor: cfg.task.commentAuthor,
    // 依赖检查用 tapd-cli 的 story time-relations（>= 1.16）；老版本会自动降级成不检查。
    checkDependencies: cfg.task.checkDependencies !== false,
    doneStatuses: cfg.task.doneStatuses,
  })

  if (args.list) {
    console.log(JSON.stringify({
      source: 'tapd',
      workspaceId: tapd.workspaceId,
      allowedStatuses: tapd.statuses.map((key) => `${key}(${tapd.statusLabel(key)})`),
      ready: tapd.listReady(),
      rejected: tapd.listRejected(),
      checkDependencies: tapd.checkDependencies,
    }, null, 2))
    return
  }

  if (args.show) {
    // 只读：确认「这条链接指的是哪张卡、现在能不能接」。不写标签、不评论、不建 runDir。
    // 给看板的「贴链接接单」用：先看清楚再开工，别为了一个打错的 id 启一个注定跳过的批次。
    const card = tapd.getCard(String(args.show))
    const readyLabel = tapd.labels.readyLabel
    const machine = card.labels.find((label) => [tapd.labels.claimedLabel, tapd.labels.deliveredLabel, tapd.labels.failedLabel].includes(label)) || ''
    const claimable = tapd.statuses.includes(card.status)
    const blockers = tapd.blockersOf(card.id)
    // 三条都会挡住「接这张」：机器标签在（可能正被别的批次占着）、状态不对、前置还没完成。
    // 分开说清楚，人一次就能把都处理掉，不用改完标签再发现状态也不对。
    const blockedReason = [
      machine ? `已带 ${machine}（可能正在跑、已交付或上次失败），要先在 TAPD 上把这个标签摘掉` : '',
      claimable ? '' : `状态 ${card.statusLabel}，只有「开发中 / 实现中」能接`,
      blockers.length ? `前置未完成: ${blockers.map((b) => `${b.id}(${b.statusLabel})`).join('、')}` : '',
    ].filter(Boolean).join('；')
    console.log(JSON.stringify({
      source: 'tapd',
      workspaceId: tapd.workspaceId,
      id: card.id,
      title: card.title,
      status: card.status,
      statusLabel: card.statusLabel,
      priorityLabel: card.priorityLabel,
      labels: card.labels,
      readyLabel,
      hasReadyLabel: card.labels.includes(readyLabel),
      machineLabel: machine,
      claimable,
      blockers,
      blockedReason,
      allowedStatuses: tapd.statuses.map((key) => `${key}(${tapd.statusLabel(key)})`),
      url: `https://www.tapd.cn/tapd_fe/${tapd.workspaceId}/story/detail/${card.id}`,
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
  // --dry-run 只看配置，不写任何东西，脏工作区也让它跑；否则想看「生效的是哪份配置」反而看不到。
  if (!args.allowDirty && !args.dryRun && !args.migrateConfig && !git.isClean()) {
    throw new Error('工作区不干净，先处理后重跑（或加 --allow-dirty）')
  }

  const runDir = join(cfg.run.cacheDir || join(HOME, 'runs'), `run-${stamp()}`)
  if (!args.dryRun) mkdirSync(runDir, { recursive: true })

  let boardUrl = ''
  if (!args.noBoard) {
    try {
      const out = execFileSync(process.execPath, [join(HERE, 'start-board.mjs')], { encoding: 'utf8', timeout: 15000, windowsHide: true })
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
    console.log(JSON.stringify({ dryRun: true, workdir, runDir, stopFile, sources: cfg.sources, cfg, ready: tapd.listReady(), rejected: tapd.listRejected() }, null, 2))
    return
  }

  // 推送到共享分支的前置条件提前报错：等一张卡跑完二十分钟才因为没配 verify 被拒，代价太大。
  if (cfg.run.push.enabled && !cfg.run.verify && !cfg.run.push.allowUnverified) {
    throw new Error('push 已开启但 verify 为空。不许把没人验证过的改动推到共享分支：先配 run.verify，或显式写 push.allowUnverified: true')
  }

  let taskCount = 0
  log('loop_start', {
    workdir,
    source: 'tapd',
    assignee: cfg.task.assignee,
    statuses: cfg.task.statuses,
    maxTasks: cfg.run.maxTasks,
    // 这一批用的 CLI / 模型 / 思考等级：卡片自己的 turn_start 没带时（旧事件、被中断的卡）
    // 看板拿这里的值兜底，不然弹窗里只剩一个空。
    runtime: {
      cli: process.env.PI_BIN || 'pi',
      provider: cfg.run.provider || '',
      model: cfg.run.model || '(default)',
      thinking: cfg.run.thinking || '(default)',
    },
    // pid 与 host 给看板判生死用：被 taskkill /F 掉的 run 不会有 loop_end。
    pid: process.pid,
    host: hostname(),
  })

  const beat = setInterval(() => log('heartbeat', { pid: process.pid, card: currentCardId, title: currentCardTitle }), HEARTBEAT_SEC * 1000)
  beat.unref?.()
  // 能收到信号就自己把现场写完；收不到（taskkill /F、断电）就由看板按 pid 是否还在直接判中断。
  // 信号里不跑 git/TAPD：它们会 block 很久，也可能把半完成的收尾写进去。
  const onInterrupt = (signal) => {
    clearInterval(beat)
    abortAllTurns()
    if (currentCardId) log('card_interrupted', { id: currentCardId, reason: `收到 ${signal}，这一批被中断` })
    log('loop_end', { reason: 'interrupted', signal })
    process.exit(130)
  }
  process.once('SIGINT', () => onInterrupt('SIGINT'))
  process.once('SIGTERM', () => onInterrupt('SIGTERM'))
  if (process.platform === 'win32') process.once('SIGBREAK', () => onInterrupt('SIGBREAK'))
  while (true) {
    if (existsSync(stopFile)) break
    if (taskCount >= cfg.run.maxTasks) break
    if (failures >= cfg.run.maxFailures) break

    const queued = tapd.listTagged()
    // 不单看状态：前置没完成的卡也算接不了，一并进 rejected，否则选卡时会被默默跳过。
    const scanned = tapd.partitionTagged(queued)
    log('queue', {
      ready: scanned.ready.map((card) => card.id),
      rejected: scanned.rejected.map((card) => ({ id: card.id, status: card.statusLabel, reason: card.reason, title: card.title })),
    })

    const card = args.card
      ? scanned.ready.find((item) => item.id === args.card) || tapd.getCard(args.card)
      : scanned.ready[0]
    if (!card) {
      if (!cfg.run.watch) break
      sleep(cfg.run.pollSec * 1000)
      continue
    }

    const outcome = await runCard(card, { tapd, git, cfg, runDir, workdir, args, log })
    currentCardId = ''
    currentCardTitle = ''
    ledger.push(outcome)
    taskCount += 1
    // blocked 是环境/前置条件坏了（同步冲突、护栏留下脏改动），不是这张卡的问题：
    // 继续下一张只会在同一个坏基线上重复浪费内循环，所以整批停在这里。
    if (outcome.status === 'blocked') {
      log('loop_blocked', { reason: outcome.note })
      break
    }
    if (outcome.status === 'failed') failures += 1
  }

  const reason = existsSync(stopFile) ? 'stop-file'
    : ledger.some((entry) => entry.status === 'blocked') ? 'blocked'
      : taskCount >= cfg.run.maxTasks ? 'max-tasks'
        : failures >= cfg.run.maxFailures ? 'max-failures'
          : 'empty-queue'
  clearInterval(beat)
  log('loop_end', { reason })
  const reportFile = writeReport(runDir, workdir, ledger, { reason, rejected: tapd.listRejected() })
  console.log(JSON.stringify({
    attempted: ledger.length,
    board: boardUrl,
    done: ledger.filter((row) => row.status === 'done').length,
    failed: ledger.filter((row) => row.status === 'failed').length,
    blocked: ledger.find((row) => row.status === 'blocked')?.note || '',
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
  const log = ctx.log || (() => {})
  log('card_start', { id: card.id, title: card.title, priorityLabel: card.priorityLabel, statusLabel: card.statusLabel })
  currentCardId = card.id
  currentCardTitle = String(card.title || '')

  if (!tapd.statuses.includes(card.status)) {
    log('card_skipped', { id: card.id, reason: `状态 ${card.statusLabel}，不在可接单范围` })
    return row(card, 'skipped', `状态 ${card.statusLabel}，不在可接单范围`, dir, startedAt)
  }

  // 前置没完成的卡先在这里拦：preflight 要跑 sync/afterSync，代价不小，
  // 而且开完工才发现前置没做，前面那十几分钟全白花。
  const blockers = ctx.args.noWrite ? [] : tapd.blockersOf(card.id)
  if (blockers.length) {
    const note = `前置未完成: ${blockers.map((b) => `${b.id}(${b.statusLabel})`).join('、')}`
    log('card_skipped', { id: card.id, reason: note, blockers })
    return row(card, 'skipped', note, dir, startedAt)
  }

  // 同步与开工前护栏必须跑在取基线之前：rebase 会改写历史，基线若取在它前面，
  // 失败时 reset --hard <基线> 会把刚拉到的上游 commit 一起抹掉。
  const guard = preflight(card, { git, cfg, workdir, dir, log })
  if (!guard.ok) {
    log(guard.fatal ? 'card_blocked' : 'card_skipped', { id: card.id, reason: guard.reason })
    return row(card, guard.fatal ? 'blocked' : 'skipped', guard.reason, dir, startedAt)
  }
  const baseline = git.head()

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
  log('turn_start', {
    id: card.id,
    // 看板靠这几个字段展示「这张卡用的是哪个 CLI / 模型 / 思考等级」。
    // 配置为空时显式记 (default)，不要留空——否则页面分不清「没配」和「没传」。
    cli: process.env.PI_BIN || 'pi',
    provider: cfg.run.provider || '',
    model: cfg.run.model || '(default)',
    thinking: cfg.run.thinking || '(default)',
    skill: cfg.run.skillPath,
  })

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
    // diff 先落盘：rebased 把 sha 换掉之后，旧 commit 对象可能已经不可达。
    try { writeFileSync(join(dir, 'diff.txt'), git.diff(commit), 'utf8') } catch {}

    const published = ctx.args.noWrite
      ? { ok: true, pushed: false, reason: 'no-write 模式不推' }
      : publish(card, { git, cfg, log })
    if (!published.ok) {
      return finishFailed(card, `提交成功但没能推送：${published.reason}。${evidence}`, dir, startedAt, {
        tapd, git, baseline, log, args: ctx.args, keepCommit: git.head(),
      })
    }

    const sha = git.head()
    const note = [
      '[tapd-loop] 开发完成，请验收。',
      clip(settled.lastText, 2000),
      published.pushed
        ? `提交：${sha.slice(0, 10)}（已推送 ${published.remote}/${published.branch}）`
        : `提交：${sha.slice(0, 10)}（未推送，留在本地：${published.reason}）`,
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
    log('card_done', { id: card.id, status: 'done', commit: sha.slice(0, 10), pushed: published.pushed, durationMs: result.durationMs, writeBack })
    const summary = published.pushed ? `${sha.slice(0, 10)} 已推送` : sha.slice(0, 10)
    return row(card, 'done', writeBack ? `${summary}（回写异常: ${writeBack}）` : summary, dir, startedAt, result.durationMs)
  })
}

function finishFailed(card, reason, dir, startedAt, ctx) {
  // keepCommit：发布阶段失败时带的本地 sha。这时已经提交过了，回滚等于把这张卡的活丢掉。
  // 但也不能就这么留在当前分支上：下一张卡的 push 会把它一起带上去，而 TAPD 上已经写了「未推送」。
  // 所以存到一个带名字的分支，当前分支退回这个提交的父节点。
  const kept = ctx.keepCommit || ''
  const savedRef = kept ? ctx.git.keepAside(`tapd-loop-unpushed/${card.id}`, kept) : ''
  if (savedRef) {
    try { writeFileSync(join(dir, 'diff.txt'), ctx.git.diff(kept), 'utf8') } catch {}
    ctx.git.resetHard(ctx.git.parentOf(kept) || ctx.baseline)
  } else {
    try { writeFileSync(join(dir, 'diff.txt'), ctx.git.diff(), 'utf8') } catch {}
    ctx.git.rollback(ctx.baseline)
  }
  ctx.log?.('card_failed', { id: card.id, reason, kept: kept.slice(0, 10), savedRef })
  try {
    if (!ctx.args.noWrite) {
      const lines = [
        `[tapd-loop] 失败：${reason}`,
        savedRef
          ? `改动已提交但没能推送，存在本地分支 \`${savedRef}\`（${kept.slice(0, 10)}），当前分支已退回。解决后合入再推，然后把标签换回来。`
          : `基线已回滚到 ${ctx.baseline.slice(0, 10)}。`,
      ]
      ctx.tapd.fail(card.id, lines.join('\n\n'))
    }
  } catch (err) {
    reason += `（回写 TAPD 也失败: ${err.message}）`
  }
  return row(card, 'failed', savedRef ? `${reason}（改动在 ${savedRef}）` : reason, dir, startedAt)
}

function runVerify(command, workdir, dir) {
  try {
    const output = decodeOutput(execFileSync(command, {
      cwd: workdir,
      shell: true,
      encoding: 'buffer',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 600_000,
      // 批次是被 detached + windowsHide 起的（没有控制台），子进程不显式给 CREATE_NO_WINDOW
      // 就会被系统配一个新控制台 —— 那就是人看到的 cmd 弹窗。
      windowsHide: true,
    }))
    writeFileSync(join(dir, 'verify.log'), output, 'utf8')
    return { ok: true, code: 0 }
  } catch (err) {
    writeFileSync(join(dir, 'verify.log'), `${decodeOutput(err.stdout)}\n${decodeOutput(err.stderr)}`, 'utf8')
    return { ok: false, code: err.status ?? 1 }
  }
}

/**
 * 提交之后、回写之前的发布动作：再同步一次，然后推。
 *
 * 卡跑了十几到几十分钟，这段时间里别人可能又推了，所以 push 之前必须再造一次 rebase。
 * 失败时的关键区别：commit 已经在本地，绝不能回滚。回滚等于把这张卡干出来的活扔了，
 * 只能把「提交了但没推出去」这个事实写进卡片，让人来合。
 */
export function publish(card, { git, cfg, log = () => {} }) {
  const pushCfg = cfg.run.push || {}
  if (!pushCfg.enabled) return { ok: true, pushed: false, reason: '未开启 push' }
  if (!cfg.run.verify && !pushCfg.allowUnverified) {
    return { ok: false, reason: 'push 已开启但 verify 为空：不会把没人验证过的改动推到共享分支（确认要这样写 push.allowUnverified: true）' }
  }

  const remote = pushCfg.remote || 'origin'
  const syncRemote = pushCfg.remote || ''
  const attempts = Math.max(1, Number(pushCfg.retries ?? 3) + 1)
  let last = null

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const sync = git.sync({ remote: syncRemote, retries: 0 })
    if (!sync.ok) {
      // 没 upstream / 已跟踪文件脏 / detached 都不阻碍直接 push，只是缺少「先对齐」这一步。
      // 真冲突或未跟踪文件被撞才是 fatal，那种再推就一定被拒。
      if (sync.fatal) {
        log('card_publish_sync_failed', { id: card.id, attempt, reason: sync.reason, files: sync.files?.slice(0, 10) })
        return { ok: false, reason: `推送前的同步没成功：${sync.reason}` }
      }
      log('card_publish_sync_skipped', { id: card.id, attempt, reason: sync.reason })
    }

    const push = git.push({ remote })
    if (push.ok) {
      const sha = git.head()
      log('card_pushed', { id: card.id, attempt, remote: push.remote, branch: push.branch, sha: sha.slice(0, 10), moved: Boolean(sync.moved) })
      return { ok: true, pushed: true, remote: push.remote, branch: push.branch, moved: Boolean(sync.moved) }
    }

    last = push
    log('card_push_failed', { id: card.id, attempt, retry: push.retry, protected: push.protected, err: push.err.split('\n').slice(-3).join(' ') })
    if (!push.retry) break
    if (attempt + 1 < attempts) sleep(2000)
  }

  const detail = pickGitError(last?.err)
  return {
    ok: false,
    reason: `git push ${last?.remote}/${last?.branch} 失败：${detail || '未知原因'}${last?.protected ? '（分支保护或权限不足）' : ''}`,
  }
}

/**
 * git 的报错后面总跟着一串 help/hint 行，直接取末尾几行会拿到「See the 'Note about
 * fast-forwards'」这种废话。优先挑真正说明原因的那一行。
 */
function pickGitError(err) {
  const lines = String(err || '').split('\n').map((line) => line.trim()).filter(Boolean)
  return lines.find((line) => /rejected|error|fatal|denied|non-fast-forward|fail|conflict/i.test(line)) || lines[0] || ''
}

export function createGit(cwd) {
  const tryRun = (args) => {
    try {
      const out = execFileSync('git', args, { cwd, encoding: 'buffer', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      return { ok: true, out: decodeOutput(out).trim() }
    } catch (err) {
      return {
        ok: false,
        out: decodeOutput(err.stdout).trim(),
        err: decodeOutput(err.stderr).trim() || String(err.message || '').trim(),
      }
    }
  }
  const run = (args) => {
    const result = tryRun(args)
    if (!result.ok) throw new Error(`git ${args.join(' ')} 失败: ${result.err}`)
    return result.out
  }
  const gitPath = (name) => {
    const result = tryRun(['rev-parse', '--git-path', name])
    return result.ok && result.out ? resolve(cwd, result.out) : ''
  }
  // 序列进行中的标记文件。rebase/merge/cherry-pick 停下时这些文件在，git 会拒绝任何
  // 改动工作区的操作，所以任何收尾动作都要先把它们清掉。
  const SEQUENCE_MARKERS = ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG']
  const sequence = () => SEQUENCE_MARKERS.find((name) => {
    const path = gitPath(name)
    return path && existsSync(path)
  }) || ''
  const conflicts = () => tryRun(['diff', '--name-only', '--diff-filter=U']).out
    .split('\n').map((line) => line.trim()).filter(Boolean)
  const abortSequence = (marker) => {
    if (!marker) return false
    if (marker.startsWith('rebase')) tryRun(['rebase', '--abort'])
    else if (marker === 'MERGE_HEAD') tryRun(['merge', '--abort'])
    else if (marker === 'CHERRY_PICK_HEAD') tryRun(['cherry-pick', '--abort'])
    else if (marker === 'REVERT_HEAD') tryRun(['revert', '--abort'])
    else return false
    return !sequence()
  }
  const transient = (text) => /could not resolve|unable to access|connection (refused|reset|timed out)|timed out|temporary failure|early EOF|RPC failed|network is unreachable|\b(502|503|504)\b/i.test(text)

  return {
    isRepo: () => { try { run(['rev-parse', '--git-dir']); return true } catch { return false } },
    head: () => run(['rev-parse', 'HEAD']),
    isClean: () => !run(['status', '--porcelain']),
    isDirty: () => Boolean(run(['status', '--porcelain'])),
    dirtyPaths: () => run(['status', '--porcelain']).split('\n').map((line) => line.trim()).filter(Boolean),
    changedSince: (rev) => Boolean(run(['status', '--porcelain'])) || run(['rev-parse', 'HEAD']) !== rev,
    commitAll: (message) => { run(['add', '-A']); run(['commit', '-m', message]); return run(['rev-parse', 'HEAD']) },
    rollback: (rev) => { run(['reset', '--hard', rev]); run(['clean', '-fd']) },
    sequence,
    conflicts,
    /** 把某个 commit 挪到一个具名分支上，主分支上就不再带着它了。失败时用来存已提交但推不出去的活。 */
    keepAside: (name, sha) => {
      if (!tryRun(['rev-parse', '--verify', '--quiet', `${sha}^{commit}`]).ok) return ''
      if (!tryRun(['branch', '-f', name, sha]).ok) return ''
      return name
    },
    parentOf: (rev) => {
      const result = tryRun(['rev-parse', `${rev}^`])
      return result.ok ? result.out : ''
    },
    resetHard: (rev) => { run(['reset', '--hard', rev]) },
    branch: () => {
      const name = run(['rev-parse', '--abbrev-ref', 'HEAD'])
      return name === 'HEAD' ? '' : name
    },
    isTransient: transient,
    /**
     * 推当前分支。永远不带 --force：共享分支上强推等于删别人的提交。
     * retry=true 表示「重来一轮 sync 再推」有意义（没快进、对端刚动过、网络抖）；
     * protected=true 表示推不上去不是时间问题，重试也没用。
     */
    push: ({ remote = 'origin' } = {}) => {
      const name = run(['rev-parse', '--abbrev-ref', 'HEAD'])
      if (!name || name === 'HEAD') return { ok: false, retry: false, remote, branch: '', err: 'detached HEAD，不知道推哪个分支' }
      const result = tryRun(['push', remote, name])
      if (result.ok) return { ok: true, remote, branch: name }
      const err = result.err || result.out || '未知原因'
      return {
        ok: false,
        remote,
        branch: name,
        err,
        retry: transient(err) || /non-fast-forward|fetch first|\brejected\b/i.test(err),
        protected: /protected branch|pre-receive hook declined|permission denied|not allowed to push|\b403\b/i.test(err),
      }
    },
    /**
     * 把当前分支 rebase 到上游。只在卡边界调，且必须在取基线之前。
     * 三个不动的情况直接退化成「不同步」而不是报错：detached HEAD、没 upstream、工作区脏。
     */
    sync: ({ remote = '', retries = 0 } = {}) => {
      const from = run(['rev-parse', 'HEAD'])
      const branch = run(['rev-parse', '--abbrev-ref', 'HEAD'])
      if (!branch || branch === 'HEAD') return { ok: false, reason: 'detached HEAD，跳过同步' }
      if (!tryRun(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).ok) {
        return { ok: false, reason: '当前分支没有 upstream，跳过同步' }
      }
      // 只看已跟踪文件的改动：未跟踪文件本身不阻碍 rebase；如果它恰好撞上上游新增的同名文件，
      // 挡住 pull 的是 git 自己（"untracked working tree files would be overwritten"），
      // 那种情况必须报出来让人处理，不能当成「工作区脏」静默跳过。
      if (run(['status', '--porcelain', '--untracked-files=no'])) return { ok: false, reason: '已跟踪文件有未提交改动，跳过同步' }

      const gitArgs = ['pull', '--rebase']
      if (remote) gitArgs.push(remote)
      const attempts = Math.max(1, Number(retries) + 1)
      let last = null
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        last = tryRun(gitArgs)
        if (last.ok) break
        if (!transient(last.err)) break
        if (attempt + 1 < attempts) sleep(3000)
      }
      if (!last.ok) {
        const marker = sequence()
        const files = conflicts()
        abortSequence(marker)
        const blocked = files.length > 0 || /untracked working tree files would be overwritten|local changes would be overwritten/i.test(last.err)
        return {
          ok: false,
          fatal: blocked,
          files,
          reason: files.length
            ? `同步时产生冲突（${files.slice(0, 5).join(', ')}${files.length > 5 ? ' 等' : ''}），已回退 rebase`
            : /untracked working tree files would be overwritten/i.test(last.err)
              ? '同步被未跟踪文件挡住（上游新增了同名文件），已放弃同步'
              : `git pull --rebase 失败：${last.err.split('\n').slice(-3).join(' ')}`,
        }
      }
      const to = run(['rev-parse', 'HEAD'])
      return { ok: true, moved: from !== to, from, to }
    },
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

/**
 * 开工前的前置动作：同步到最新基线，然后跑项目自己的 afterSync 护栏。
 *
 * afterSync 不是「sync 真的 rebase 了才跑」——它无条件跑，因为脏导出不只由本循环的
 * pull 造成：人在外面 rebase / cherry-pick / reset 都不会触发 git 的 post-merge /
 * post-checkout（DigitDoor 的 Luban 导表守卫就挂在那两个钩子上），本循环每张卡开工前
 * 跑一次是唯一能兜住这些口子的位置。护栏脚本自己应该在「不用导表」时秒退。
 */
export function preflight(card, { git, cfg, workdir, dir, log }) {
  const syncCfg = cfg.run.sync || {}
  if (syncCfg.enabled) {
    log('card_phase', { id: card.id, phase: 'sync' })
    const result = git.sync({ remote: syncCfg.remote, retries: syncCfg.retries })
    if (result.ok) {
      log('card_sync', { id: card.id, moved: result.moved, from: result.from?.slice(0, 10), to: result.to?.slice(0, 10) })
    } else {
      log('card_sync_skipped', { id: card.id, fatal: Boolean(result.fatal), reason: result.reason, files: result.files?.slice(0, 10) })
      if (result.fatal) return { ok: false, fatal: true, reason: result.reason }
      // strict：同步没成功就不开工。默认关（通用行为：只是告警）。
      // 多工位并行时建议打开：工位上一张卡留下的脏工作区会让 pull --rebase 静默跳过，
      // 于是一整张卡都干在陈旧基线上，最后 cherry-pick 回主树才爆炸。
      // 不设 fatal：这是这个工位的问题，不该把其他工位的批次一起停掉。
      if (syncCfg.strict === true) {
        return { ok: false, fatal: false, reason: `同步没成功（${result.reason}），sync.strict 下不在陈旧基线上开工` }
      }
    }
  }

  if (!cfg.run.afterSync) return { ok: true }
  log('card_phase', { id: card.id, phase: 'after-sync' })
  const dirtyBefore = git.dirtyPaths()
  const guard = runGuard(cfg.run.afterSync, workdir, dir, cfg.run.afterSyncTimeoutSec)
  if (!guard.ok) {
    log('card_after_sync_failed', { id: card.id, code: guard.code, elapsedMs: guard.elapsedMs, tail: guard.tail, log: plainPath(guard.logPath) })
    return {
      ok: false,
      fatal: true,
      reason: `afterSync 失败（exit ${guard.code}），导出/生成物还是旧的，开了工也白做：${guard.tail || '原因见日志'}（日志 ${plainPath(guard.logPath)}）`,
    }
  }
  log('card_after_sync', { id: card.id, elapsedMs: guard.elapsedMs })

  // 护栏脚本不允许在工作区留下改动：那些改动会被 add -A 算进本卡提交。
  const introduced = git.dirtyPaths().filter((line) => !dirtyBefore.includes(line))
  if (introduced.length) {
    log('card_after_sync_dirty', { id: card.id, paths: introduced.slice(0, 10) })
    return {
      ok: false,
      fatal: true,
      reason: `afterSync 在工作区留下改动（${introduced.slice(0, 3).join(' / ')}${introduced.length > 3 ? ' 等' : ''}），这些改动会被算成本卡 diff：让它自己还原或把产物加进 .gitignore`,
    }
  }
  return { ok: true }
}

/**
 * Windows 上同一条命令的 stderr 可能是两种编码混在一起：cmd.exe / powershell 的中文走控制台
 * 代码页（GBK），而 sh / bash 输出走 UTF-8。全按 UTF-8 解就会得到一串问号，而那串问号
 * 恰好是护栏失败时唯一能告诉人「到底哪步坏了」的东西。所以解出替换字符就回头试 GBK，取更干净的。
 */
function decodeOutput(value) {
  if (!value) return ''
  if (typeof value === 'string') return value
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value))
  const utf8 = buffer.toString('utf8')
  if (!utf8.includes('\uFFFD')) return utf8
  try {
    const gbk = new TextDecoder('gbk').decode(buffer)
    return gbk.split('\uFFFD').length < utf8.split('\uFFFD').length ? gbk : utf8
  } catch {
    return utf8
  }
}

function runGuard(command, workdir, dir, timeoutSec) {
  const logPath = join(dir, 'after-sync.log')
  const startedAt = Date.now()
  const write = (text) => { try { writeFileSync(logPath, text, 'utf8') } catch {} }
  try {
    const output = decodeOutput(execFileSync(command, {
      cwd: workdir,
      shell: true,
      encoding: 'buffer',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: Math.max(60, Number(timeoutSec) || 1800) * 1000,
      windowsHide: true,
    }))
    write(output)
    return { ok: true, code: 0, elapsedMs: Date.now() - startedAt, logPath }
  } catch (err) {
    write(`${decodeOutput(err.stdout)}\n${decodeOutput(err.stderr)}`)
    const detail = (decodeOutput(err.stderr) || decodeOutput(err.stdout) || err.message || '').trim()
    return {
      ok: false,
      code: err.status ?? (err.signal ? `signal ${err.signal}` : 1),
      elapsedMs: Date.now() - startedAt,
      logPath,
      tail: detail.split('\n').map((line) => line.trim()).filter(Boolean).slice(-3).join(' '),
    }
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

function loadConfig(workdir, args = {}) {
  const globalFile = join(HOME, 'config.json')
  const commonDir = gitCommonDir(workdir)
  // 仓库级配置住在 .git/ 里：工作区干净，且同一仓库的所有 worktree 共用一份。
  const repoFile = commonDir ? join(commonDir, CONFIG_NAME) : ''
  const legacyFile = join(workdir, '.tapd-loop.json')
  const explicitFile = args.config
    ? resolve(process.cwd(), String(args.config))
    : process.env.TAPD_LOOP_CONFIG
      ? resolve(process.env.TAPD_LOOP_CONFIG)
      : ''
  // 老位置还能用（不静默失效），但只要 .git/ 里已经有了就以新的为准。
  const legacyUsed = !existsSync(repoFile) && existsSync(legacyFile)
  const base = {
    task: { workspaceId: '', assignee: '', commentAuthor: '', statuses: ['developing', 'status_11'], labels: {}, checkDependencies: true, doneStatuses: [] },
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
      sync: { enabled: false, remote: '', retries: 0 },
      afterSync: '',
      afterSyncTimeoutSec: 1800,
      push: { enabled: false, remote: '', retries: 3, allowUnverified: false },
    },
  }
  const merged = deepMerge(
    base,
    readJson(globalFile),
    readJson(legacyUsed ? legacyFile : ''),
    readJson(repoFile),
    readJson(explicitFile),
  )
  if (!merged.run.stopFile) merged.run.stopFile = join(gitOwnDir(workdir) || workdir, STOP_NAME)
  merged.sources = {
    global: plainPath(globalFile),
    repo: repoFile ? plainPath(repoFile) : '(不在 git 仓库里)',
    repoExists: Boolean(repoFile) && existsSync(repoFile),
    legacyInWorkdir: existsSync(legacyFile) ? plainPath(legacyFile) : '',
    legacyUsed,
    explicit: explicitFile ? plainPath(explicitFile) : '',
  }
  if (args.maxTasks) merged.run.maxTasks = Number(args.maxTasks)
  if (args.timeoutSec) merged.run.timeoutSec = Number(args.timeoutSec)
  if (args.watch) merged.run.watch = true
  if (args.verify) merged.run.verify = args.verify
  if (args.sync) merged.run.sync.enabled = true
  if (args.noSync) merged.run.sync.enabled = false
  if (args.afterSync) merged.run.afterSync = args.afterSync
  if (args.noAfterSync) merged.run.afterSync = ''
  if (args.afterSyncTimeoutSec) merged.run.afterSyncTimeoutSec = Number(args.afterSyncTimeoutSec)
  if (args.push) merged.run.push.enabled = true
  if (args.noPush) merged.run.push.enabled = false
  if (args.pushRetries) merged.run.push.retries = Number(args.pushRetries)
  if (args.allowUnverified) merged.run.push.allowUnverified = true
  if (args.model) merged.run.model = args.model
  if (args.thinking) merged.run.thinking = args.thinking
  if (args.assignee) merged.task.assignee = args.assignee
  if (args.commentAuthor) merged.task.commentAuthor = args.commentAuthor
  if (args.statuses) merged.task.statuses = String(args.statuses).split(',').map((s) => s.trim()).filter(Boolean)
  merged.run.allowDirty = Boolean(args.allowDirty)
  if (!merged.task.assignee && !args.fetch && !args.show) throw new Error('缺少 task.assignee（TAPD 处理人）')
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
  --show <id>         只读：看一张卡现在什么状态、能不能接（不写 TAPD）
  --fetch <id>        只抓取工单标题/详情/评论/图片到本地 md
  --dry-run           打印配置来源、运行目录与就绪卡
  --config <path>     额外合并一份配置文件（优先级最高，也可用 $TAPD_LOOP_CONFIG）
  --migrate-config    把仓库根的 .tapd-loop.json 搬进 .git/ 并删掉旧的
  --card <id>         只跑指定卡片
  --max-tasks <n>     本批最多跑几张（默认 1）
  --watch             队列空了继续轮询
  --verify <cmd>      每个 turn 之后必过的命令
  --sync / --no-sync  开工前 git pull --rebase（默认不拉）
  --after-sync <cmd>  同步之后、取基线之前必过的命令（脏导出护栏）
  --no-after-sync     关掉 afterSync
  --after-sync-timeout-sec <n>  afterSync 超时（默认 1800）
  --push / --no-push  提交后再同步并 git push（默认不推，要求 verify 非空）
  --push-retries <n>  push 重试轮数（默认 3，每轮先 rebase 再推）
  --allow-unverified  绕过「push 必须有 verify」的限制
  --statuses <list>   允许接单的状态 key，逗号分隔（默认 developing,status_11）
  --timeout-sec <n>   单卡超时（默认 3600）
  --model / --thinking / --assignee
  --allow-dirty       允许脏工作区启动（不推荐）
  --no-write          不写 TAPD（不认领、不标完成、不评论），用于本地演练
  --no-board          不起看板（默认会自动启动或复用）
  --help

配置文件，从低到高：
  ~/.tapd-loop/config.json              机器级默认
  <git-common-dir>/tapd-loop.json       仓库级（.git/ 里，worktree 共用一份）
  --config / $TAPD_LOOP_CONFIG          额外追加
仓库根目录的 .tapd-loop.json 仍能读，但会告警：用 --migrate-config 搬进 .git/。
停止文件默认在 <git-dir>/tapd-loop-stop（每棵树一份），不再落在工作区。
`)
}

// 被直接执行才跑循环；被测试 import 时只导出函数。
// 必须比 realpath：`~/.agents` 在本机是指向 `C:/projects/agent-skills` 的 junction，
// Node 会把 import.meta.url 解析成真实路径，而 argv[1] 是调用时的那条软链接路径，直接比永远不相等。
const invokedDirectly = (() => {
  if (!process.argv[1]) return false
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
  } catch {
    return false
  }
})()

if (invokedDirectly) {
  main().catch((err) => {
    console.error(err.message)
    process.exit(1)
  })
}

export { loadConfig, runGuard, finishFailed }