#!/usr/bin/env node
/**
 * afk-watch：前台监督进程。轮询任务源，有就绪工单时启动一次 afk-run，
 * 等它结束再继续。远程 in-progress 不是本地锁。
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isClean } from '../../afk-run/scripts/git.mjs'
import { deepMerge, requireAfkSections, resolveAfkConfigFiles } from '../../afk-run/scripts/afk-home.mjs'
import { emitInboxEvent } from '../../afk-run/scripts/inbox.mjs'
import { resolveEventRequirement } from '../../afk-run/scripts/requirement.mjs'
import { loopRegistryPath } from '../../afk-run/scripts/loop.mjs'
import { createSource } from '../../afk-run/scripts/task-sources/index.mjs'
import {
  appendWatchEvent,
  claimWatcherInstance,
  createWatchRunDir,
  killOwnedProcess,
  releaseWatcherInstance,
  stopOwnedProcesses,
  updateWatcherRegistry,
  watcherRegistryPath,
  writeWatchPool,
} from './watch-state.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const LOOP_PATH = resolve(__dirname, '..', '..', 'afk-run', 'scripts', 'loop.mjs')
const LOOP_SERVE_PATH = resolve(__dirname, '..', '..', 'afk-run', 'scripts', 'loop-serve.mjs')
const DEFAULT_STOP_FILE = 'afk-stop'

function numberOr(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

export function sleepWithStop(ms, isStopRequested = () => false) {
  const step = 200
  let left = Math.max(0, Number(ms) || 0)
  return new Promise((resolvePromise) => {
    const tick = () => {
      if (isStopRequested()) {
        resolvePromise(true)
        return
      }
      if (left <= 0) {
        resolvePromise(isStopRequested())
        return
      }
      const wait = Math.min(step, left)
      left -= wait
      setTimeout(tick, wait)
    }
    tick()
  })
}

export function normalizeClaim(result, fallbackMode = 'unsupported') {
  const claimMode = result?.claimMode || fallbackMode || 'unsupported'
  const status = result?.status
  if (status === 'claimed' || status === 'already-claimed' || status === 'unsupported' || status === 'error') {
    return { status, claimMode, message: result?.message || '' }
  }
  return { status: 'error', claimMode, message: result?.message || 'invalid claim result' }
}

export function buildExecutionArgs(options) {
  const args = [
    options.loopPath || LOOP_PATH,
    '--workdir',
    options.workdir,
    '--source',
    options.source,
    '--cache-dir',
    options.cacheDir,
    '--no-serve',
    '--no-open',
  ]
  if (options.repo) args.push('--repo', options.repo)
  if (options.configPath) args.push('--config', options.configPath)
  if (Number(options.maxTasks) > 0) args.push('--max-tasks', String(options.maxTasks))
  if (Number(options.maxFailures) > 0) args.push('--max-failures', String(options.maxFailures))
  if (Number(options.retry) > 0) args.push('--retry', String(options.retry))
  if (options.stopFile) args.push('--stop-file', options.stopFile)
  if (options.allowDirty) args.push('--allow-dirty')
  // 把需求 id 透给 loop：这样它写的事件直接带上路由，不必反查
  if (options.requirement) args.push('--requirement', options.requirement)
  for (const id of options.pinnedIds || []) {
    if (id) args.push('--pinned-id', String(id))
  }
  const exec = options.execReview || {}
  const push = (flag, value) => {
    if (value == null || value === '' || value === 0) return
    args.push(flag, String(value))
  }
  push('--timeout', exec.timeout)
  push('--runner', exec.runner)
  push('--executor-runner', exec.executorRunner)
  push('--reviewer-runner', exec.reviewerRunner)
  push('--executor-model', exec.executorModel)
  push('--reviewer-model', exec.reviewerModel)
  push('--executor-thinking', exec.executorThinking)
  push('--reviewer-thinking', exec.reviewerThinking)
  push('--hard-timeout-extra', exec.hardTimeoutExtra)
  return args
}

/**
 * 监督一次执行批次：子进程活着就等。
 * 停止信号只杀本次子进程；看板若由本函数 startDashboard 拉起才一并收掉。
 * 常驻看板模式下不传 startDashboard，避免批次切换杀掉页面。
 */
export async function superviseExecutionRun(opts) {
  const child = opts.startChild()
  const kill = opts.kill || killOwnedProcess
  const sleep = opts.sleep || sleepWithStop
  const isStopRequested = opts.isStopRequested || (() => false)
  let dashboardPid = null
  const owned = { childPid: child.pid, runDir: '' }
  if (typeof opts.onOwned === 'function') opts.onOwned({ ...owned })

  while (!child.done) {
    if (isStopRequested()) {
      stopOwnedProcesses({ childPid: child.pid, dashboardPid }, kill)
      if (typeof child.waitForExit === 'function') await child.waitForExit()
      return {
        reason: 'stop',
        code: null,
        childPid: child.pid,
        dashboardPid,
        runDir: owned.runDir,
      }
    }
    if (!owned.runDir && typeof opts.readRunDir === 'function') {
      const runDir = opts.readRunDir() || ''
      if (runDir) {
        owned.runDir = runDir
        if (!dashboardPid && typeof opts.startDashboard === 'function') {
          dashboardPid = opts.startDashboard(runDir) || null
          if (typeof opts.onOwned === 'function') {
            opts.onOwned({ ...owned, dashboardPid })
          }
        } else if (typeof opts.onOwned === 'function') {
          opts.onOwned({ ...owned })
        }
      }
    }
    await sleep(opts.pollMs || 200, isStopRequested)
  }

  return {
    reason: 'exit',
    code: child.code ?? 0,
    childPid: child.pid,
    dashboardPid,
    runDir: owned.runDir,
  }
}

/**
 * 一轮 Work-item pool。有 describeBlocked 则只调它（用 ready 决定是否开工）；
 * 否则回退 listReady，进行中/阻塞为空。
 */
export async function pollWorkItemPool(source) {
  if (typeof source?.describeBlocked === 'function') {
    const described = await source.describeBlocked()
    if (Array.isArray(described)) {
      return { ready: [], blocked: described, inProgress: [] }
    }
    return {
      ready: Array.isArray(described?.ready) ? described.ready : [],
      blocked: Array.isArray(described?.blocked) ? described.blocked : [],
      inProgress: Array.isArray(described?.inProgress) ? described.inProgress : [],
    }
  }
  let ready = []
  if (typeof source?.listReady === 'function') {
    ready = await source.listReady()
  }
  return {
    ready: Array.isArray(ready) ? ready : [],
    blocked: [],
    inProgress: [],
  }
}

export function formatWatchPhaseLog(event) {
  if (!event || !event.event) return ''
  switch (event.event) {
    case 'idle':
      return `idle(ready=${event.readyCount ?? 0})`
    case 'claim_skipped':
      return `claim_skipped ${event.id || ''}`.trim()
    case 'run_start':
      return `run_start ${event.id || ''}`.trim()
    case 'run_end':
      return `run_end ${event.id || ''} code=${event.code ?? 0}`.trim()
    case 'source_error':
      return `backoff ${event.waitMs ?? '?'}ms ${event.message || ''}`.trim()
    case 'watch_stop':
    case 'watch_end':
      return `stop ${event.reason || ''}`.trim()
    case 'watch_start':
      return 'watch_start'
    default:
      return event.event
  }
}

/**
 * 轮询循环。远程 in-progress 不参与是否开工的判断；只看 ready 与本进程停止信号。
 */
export async function runWatcher(deps) {
  const config = deps.config || {}
  const source = deps.source
  const sleep = deps.sleep || sleepWithStop
  const isStopRequested = deps.isStopRequested || (() => false)
  const onEvent = deps.onEvent || (() => {})
  const onPool = deps.onPool || (() => {})
  const spawnRun = deps.spawnRun
  const stopOwned = deps.stopOwned || (() => {})
  const claimMode = source?.claimMode || 'unsupported'
  const initialDelay = numberOr(config.backoffInitialMs, 1000)
  const maxDelay = numberOr(config.backoffMaxMs, 60000)
  const factor = Number(config.backoffFactor) > 1 ? Number(config.backoffFactor) : 2
  const pollIntervalMs = numberOr(config.pollIntervalMs, 15000)
  let delay = initialDelay
  let runs = 0
  let lastExecRunDir = ''

  const finish = (reason) => {
    onEvent({ event: 'watch_end', reason, claimMode })
    return { reason, claimMode, runs }
  }

  const wait = async (ms) => {
    const stopped = await sleep(ms, isStopRequested)
    return stopped === true || isStopRequested()
  }

  const backoff = async (message) => {
    const waitMs = delay
    onEvent({ event: 'source_error', message: String(message || 'source error'), waitMs })
    delay = Math.min(maxDelay, Math.max(1, delay) * factor)
    return wait(waitMs)
  }

  if (config.requireAtomicClaim && claimMode !== 'atomic') {
    return finish('require-atomic-claim')
  }

  while (true) {
    if (isStopRequested()) {
      stopOwned()
      return finish('stop')
    }

    let pool
    try {
      pool = await pollWorkItemPool(source)
      onPool(pool)
    } catch (err) {
      if (await backoff(err?.message || err)) return finish('stop')
      continue
    }

    const ready = Array.isArray(pool.ready) ? pool.ready : []
    if (ready.length === 0) {
      delay = initialDelay
      onEvent({ event: 'idle', claimMode, readyCount: 0 })
      if (await wait(pollIntervalMs)) return finish('stop')
      continue
    }

    let claim
    try {
      claim = typeof source.tryClaim === 'function'
        ? normalizeClaim(await source.tryClaim(ready[0].id), claimMode)
        : { status: 'unsupported', claimMode, message: '' }
    } catch (err) {
      claim = { status: 'error', claimMode, message: err?.message || String(err) }
    }

    if (claim.status === 'already-claimed') {
      delay = initialDelay
      onEvent({
        event: 'claim_skipped',
        id: String(ready[0].id),
        status: 'already-claimed',
        claimMode: claim.claimMode,
      })
      if (await wait(pollIntervalMs)) return finish('stop')
      continue
    }

    if (claim.status === 'error') {
      if (await backoff(claim.message || 'claim error')) return finish('stop')
      continue
    }

    const pinnedIds = claim.status === 'claimed' ? [String(ready[0].id)] : []
    onEvent({
      event: 'run_start',
      id: String(ready[0].id),
      claimStatus: claim.status,
      claimMode: claim.claimMode || claimMode,
      pinnedIds,
      execRunDir: lastExecRunDir || '',
    })

    let childResult = { code: 0, runDir: '' }
    try {
      childResult = await spawnRun({
        pinnedIds,
        ready,
        claim,
        isStopRequested,
        stopOwned,
      })
    } catch (err) {
      if (await backoff(err?.message || err)) return finish('stop')
      continue
    }

    lastExecRunDir = childResult?.runDir || lastExecRunDir || ''
    runs += 1
    delay = initialDelay
    onEvent({
      event: 'run_end',
      id: String(ready[0].id),
      code: childResult?.code ?? 0,
      execRunDir: childResult?.runDir || '',
    })
    if (isStopRequested()) {
      stopOwned()
      return finish('stop')
    }
  }
}

function usage(code = 0) {
  const text = `用法:
  node watch.mjs --workdir <目录> [--source beads|gh|tapd] [--repo <仓库>]
    [--max-tasks <N>] [--poll-interval <毫秒>] [--require-atomic-claim]
    [--stop-file <路径>] [--allow-dirty] [--cache-dir <目录>] [--config <~/.afk/config.json>]
    [--no-serve] [--port <端口>] [--dry-run]
  node watch.mjs --stop --workdir <目录> [--stop-file <路径>]

前台轮询任务源。有就绪工单时启动一次 afk-run，并只清理自己启动的子进程和看板。
--require-atomic-claim 在任务源不能提供 atomic claim 时、开始工作前退出。`
  if (code === 0) process.stdout.write(text + '\n')
  else console.error(text)
  process.exit(code)
}

function parseArgs(argv) {
  const out = {
    workdir: '',
    source: '',
    repo: '',
    maxTasks: null,
    maxFailures: null,
    retry: null,
    pollIntervalMs: null,
    backoffInitialMs: null,
    backoffMaxMs: null,
    stopFile: '',
    allowDirty: false,
    requireAtomicClaim: false,
    configPath: '',
    cacheDir: '',
    dryRun: false,
    requirement: '',
    stop: false,
    serve: null,
    port: null,
    timeout: null,
    runner: '',
    executorRunner: '',
    reviewerRunner: '',
    executorModel: '',
    reviewerModel: '',
    executorThinking: '',
    reviewerThinking: '',
    hardTimeoutExtra: null,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => {
      const value = argv[++i]
      if (value === undefined) usage(1)
      return value
    }
    switch (arg) {
      case '-h':
      case '--help':
        usage(0)
        break
      case '--workdir':
      case '-C':
        out.workdir = next()
        break
      case '--source':
        out.source = String(next()).toLowerCase()
        break
      case '--repo':
        out.repo = next()
        break
      case '--max-tasks':
        out.maxTasks = Math.max(0, Number(next()) || 0)
        break
      case '--max-failures':
        out.maxFailures = Math.max(0, Number(next()) || 0)
        break
      case '--retry':
        out.retry = Math.max(0, Number(next()) || 0)
        break
      case '--poll-interval':
        out.pollIntervalMs = Math.max(0, Number(next()) || 0)
        break
      case '--backoff-initial':
        out.backoffInitialMs = Math.max(0, Number(next()) || 0)
        break
      case '--backoff-max':
        out.backoffMaxMs = Math.max(0, Number(next()) || 0)
        break
      case '--stop-file':
        out.stopFile = next()
        break
      case '--allow-dirty':
        out.allowDirty = true
        break
      case '--requirement':
        out.requirement = next()
        break
      case '--require-atomic-claim':
        out.requireAtomicClaim = true
        break
      case '--config':
        out.configPath = next()
        break
      case '--cache-dir':
        out.cacheDir = next()
        break
      case '--dry-run':
        out.dryRun = true
        break
      case '--stop':
        out.stop = true
        break
      case '--no-serve':
        out.serve = false
        break
      case '--port':
        out.port = Math.max(0, Number(next()) || 0)
        break
      case '--timeout':
        out.timeout = Math.max(0, Number(next()) || 0)
        break
      case '--runner':
        out.runner = next()
        break
      case '--executor-runner':
        out.executorRunner = next()
        break
      case '--reviewer-runner':
        out.reviewerRunner = next()
        break
      case '--executor-model':
        out.executorModel = next()
        break
      case '--reviewer-model':
        out.reviewerModel = next()
        break
      case '--executor-thinking':
        out.executorThinking = next()
        break
      case '--reviewer-thinking':
        out.reviewerThinking = next()
        break
      case '--hard-timeout-extra':
        out.hardTimeoutExtra = Math.max(0, Number(next()) || 0)
        break
      default:
        console.error(`未知参数: ${arg}`)
        usage(1)
    }
  }
  return out
}

/**
 * 用户级配置：~/.afk/<项目名_UID>/config.json 覆盖 ~/.afk/config.json。
 * 本技能读两个分区：`task`（与 afk-run 共用）+ `watch`（自己的）。
 * 配置必须存在（requireAfkSections），缺了就报错，不用内置兜底。
 */
export function resolveWatchConfigPath(workdir, configPath) {
  const { files } = resolveAfkConfigFiles(workdir, configPath)
  return files.length ? files[files.length - 1] : null
}

export function loadConfig({ configPath = '', workdir = '' } = {}) {
  const defaults = {
    task: {
      source: 'beads',
      repo: '',
      maxTasks: 1,
      maxFailures: 3,
      retry: 1,
      allowDirty: false,
      stopFile: '',
      tapd: {
        assignee: '',
        readyLabel: '',
        claimedLabel: '',
        deliveredLabel: '',
        failedLabel: '',
        commentAuthor: '',
      },
    },
    watch: {
      pollIntervalMs: 15000,
      backoffInitialMs: 1000,
      backoffMaxMs: 60000,
      backoffFactor: 2,
      requireAtomicClaim: false,
      serve: { enabled: true, port: 0, open: false },
    },
  }
  const { files, sections } = requireAfkSections(workdir, ['task', 'watch'], configPath)
  return {
    cfg: {
      task: deepMerge(defaults.task, sections.task),
      watch: deepMerge(defaults.watch, sections.watch),
    },
    files,
    path: files.length ? files[files.length - 1] : null,
  }
}

function hashStr(value) {
  let hash = 0
  const text = String(value)
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) >>> 0
  return hash
}

function workspaceIsClean(workdir) {
  try {
    return isClean(workdir)
  } catch {
    return true
  }
}

function openUrl(url) {
  const { platform } = process
  const [cmd, args] =
    platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]]
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true })
    child.on('error', () => {})
    child.unref()
  } catch {
    // 地址仍会出现在事件流里。
  }
}

function readChildRunDir(execCache, workdir, childPid) {
  try {
    const file = loopRegistryPath(execCache, workdir)
    if (!existsSync(file)) return ''
    const data = JSON.parse(readFileSync(file, 'utf8'))
    if (Number(data?.pid) !== Number(childPid)) return ''
    return data.runDir || ''
  } catch {
    return ''
  }
}

function createLiveSpawnRun({
  argsFor,
  execCache,
  workdir,
  isStopRequested,
  onOwned,
}) {
  return async function spawnRun({ pinnedIds }) {
    const child = spawn(process.execPath, argsFor(pinnedIds), {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (child.stdout) child.stdout.on('data', (chunk) => process.stdout.write(chunk))
    if (child.stderr) child.stderr.on('data', (chunk) => process.stderr.write(chunk))
    let done = false
    let code = 1
    child.on('close', (exitCode) => {
      done = true
      code = exitCode ?? 1
    })
    return superviseExecutionRun({
      startChild: () => ({
        pid: child.pid,
        get done() {
          return done
        },
        get code() {
          return code
        },
        waitForExit() {
          if (done) return Promise.resolve(code)
          return new Promise((resolvePromise) => {
            const timer = setTimeout(() => resolvePromise(code), 5000)
            child.once('close', (exitCode) => {
              clearTimeout(timer)
              resolvePromise(exitCode ?? 1)
            })
          })
        },
      }),
      readRunDir: () => readChildRunDir(execCache, workdir, child.pid),
      // 常驻看板由 main 拉起；此处不按批次起停页面。
      startDashboard: null,
      isStopRequested,
      onOwned,
      kill: killOwnedProcess,
      sleep: sleepWithStop,
      pollMs: 200,
    })
  }
}

/**
 * watcher 停下时要不要发信。
 *
 * 白名单，不是黑名单：只有下面这几个原因才叫人。`stop` 既覆盖「人要求停」也覆盖
 * 「出现停止文件」，那种情况人已经知道，发信就是噪音。将来新增停止原因也不会
 * 自动开始发信——要先把它加进这个表。
 */
const WATCH_NOTIFY_REASONS = new Set(['require-atomic-claim', 'error'])

export function inboxPayloadForWatchStop({ requirement, workdir, reason, message, watchRunDir, servePort, error, home }) {
  const crashed = Boolean(error)
  const effectiveReason = crashed ? 'error' : reason
  if (!WATCH_NOTIFY_REASONS.has(effectiveReason)) return null

  const routed = resolveEventRequirement({ home, explicit: requirement })
  return {
    kind: crashed ? 'watch-error' : 'watch-stop',
    requirementId: routed?.requirementId ?? null,
    workdir,
    title: crashed ? `watcher 异常退出：${error}` : `watcher 停了：${effectiveReason}`,
    detail: {
      reason: effectiveReason,
      message: message || '',
      watchRunDir: watchRunDir || '',
      servePort: servePort || 0,
      ...(crashed ? { error } : {}),
    },
    nextStep: '没人看活了。判断是该收尾、修配置再起，还是补一波工单',
  }
}

function startResidentDashboard({ registryPath, watchSession, port, open }) {  const args = [
    LOOP_SERVE_PATH,
    '--watch-registry',
    registryPath,
    '--watch-session',
    watchSession,
    '--port',
    String(port),
  ]
  const dash = spawn(process.execPath, args, {
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  })
  let announced = false
  const onChunk = (chunk) => {
    const text = String(chunk)
    process.stderr.write(text)
    if (!announced) {
      const match = text.match(/https?:\/\/127\.0\.0\.1:\d+\//)
      if (match) {
        announced = true
        console.error(`afk-watch 看板: ${match[0]}`)
        if (open) setTimeout(() => openUrl(match[0]), 600)
      }
    }
  }
  if (dash.stderr) dash.stderr.on('data', onChunk)
  dash.unref()
  return dash.pid
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.workdir) {
    console.error('workdir 必传：--workdir <目录>')
    process.exit(2)
  }
  const workdir = resolve(args.workdir)
  if (!existsSync(workdir)) {
    console.error(`workdir 不存在: ${workdir}`)
    process.exit(2)
  }
  let cfg
  try {
    ;({ cfg } = loadConfig({ configPath: args.configPath, workdir }))
  } catch (err) {
    console.error(err.message || String(err))
    process.exit(2)
  }

  const stopFile = resolve(args.stopFile || cfg.task.stopFile || join(workdir, DEFAULT_STOP_FILE))
  if (args.stop) {
    mkdirSync(dirname(stopFile), { recursive: true })
    writeFileSync(stopFile, `stop ${new Date().toISOString()}\n`, 'utf8')
    process.stdout.write(JSON.stringify({ reason: 'stop-requested', stopFile }) + '\n')
    return
  }

  const allowDirty = args.allowDirty || cfg.task.allowDirty
  if (!workspaceIsClean(workdir) && !allowDirty) {
    console.error(`工作区有未提交改动（${workdir}）。请先提交/stash，或 --allow-dirty。`)
    process.exit(2)
  }

  const sourceName = args.source || cfg.task.source || 'beads'
  const repo = args.repo || cfg.task.repo || ''
  let source
  try {
    source = createSource(sourceName, {
      cwd: workdir,
      ...(repo ? { repo } : {}),
      tapd: cfg.task.tapd,
    })
  } catch (err) {
    console.error(err.message || String(err))
    process.exit(2)
  }

  const claimMode = source.claimMode || 'unsupported'
  const requireAtomicClaim = args.requireAtomicClaim || cfg.watch.requireAtomicClaim
  const summaryBase = {
    workdir,
    source: sourceName,
    claimMode,
    requireAtomicClaim: Boolean(requireAtomicClaim),
    stopFile,
  }
  if (args.dryRun) {
    const previewPort = args.port || cfg.watch.serve.port || 9700 + (hashStr(workdir) % 1000)
    const serveOn = (args.serve ?? cfg.watch.serve.enabled) !== false
    process.stdout.write(JSON.stringify({
      dryRun: true,
      ...summaryBase,
      refusesWork: Boolean(requireAtomicClaim) && claimMode !== 'atomic',
      servePort: serveOn ? previewPort : 0,
      dashboardUrl: serveOn ? `http://127.0.0.1:${previewPort}/` : '',
    }) + '\n')
    return
  }

  const cacheRoot = resolve(args.cacheDir || join(tmpdir(), 'afk-watch'))
  const execCache = join(cacheRoot, 'exec')
  mkdirSync(execCache, { recursive: true })
  const watchRunDir = createWatchRunDir(cacheRoot)
  const claimed = claimWatcherInstance(cacheRoot, workdir, { runDir: watchRunDir, claimMode })
  if (!claimed.ok) {
    const note = { reason: 'watcher-busy', ...summaryBase, pid: claimed.pid }
    process.stdout.write(JSON.stringify(note) + '\n')
    process.exit(2)
  }

  const serveEnabled = args.serve ?? cfg.watch.serve.enabled
  const servePort = args.port || cfg.watch.serve.port || 9700 + (hashStr(workdir) % 1000)
  const registryPath = watcherRegistryPath(cacheRoot, workdir)
  let owned = { childPid: null, dashboardPid: null, runDir: '' }
  let stopRequested = false
  const isStopRequested = () => stopRequested || existsSync(stopFile)
  const onOwned = (next) => {
    owned = {
      ...owned,
      ...next,
      dashboardPid: next.dashboardPid != null ? next.dashboardPid : owned.dashboardPid,
    }
    updateWatcherRegistry(cacheRoot, workdir, {
      childPid: owned.childPid,
      dashboardPid: owned.dashboardPid,
      execRunDir: owned.runDir || '',
      state: 'running',
      claimMode,
      phaseStartedAt: Date.now(),
    })
  }
  const stopOwned = () => {
    stopOwnedProcesses(owned, killOwnedProcess)
    updateWatcherRegistry(cacheRoot, workdir, { state: 'stopping', claimMode, phaseStartedAt: Date.now() })
  }
  const onSignal = () => {
    stopRequested = true
    stopOwned()
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)

  // 只透传 CLI 覆盖；配置文件里的引擎设置由 afk-run / exec-review 读同一分区
  const execReview = {
    ...(args.timeout != null ? { timeout: args.timeout } : {}),
    ...(args.runner ? { runner: args.runner } : {}),
    ...(args.executorRunner ? { executorRunner: args.executorRunner } : {}),
    ...(args.reviewerRunner ? { reviewerRunner: args.reviewerRunner } : {}),
    ...(args.executorModel ? { executorModel: args.executorModel } : {}),
    ...(args.reviewerModel ? { reviewerModel: args.reviewerModel } : {}),
    ...(args.executorThinking ? { executorThinking: args.executorThinking } : {}),
    ...(args.reviewerThinking ? { reviewerThinking: args.reviewerThinking } : {}),
    ...(args.hardTimeoutExtra != null ? { hardTimeoutExtra: args.hardTimeoutExtra } : {}),
  }
  const runConfig = {
    requireAtomicClaim: Boolean(requireAtomicClaim),
    pollIntervalMs: args.pollIntervalMs ?? cfg.watch.pollIntervalMs,
    backoffInitialMs: args.backoffInitialMs ?? cfg.watch.backoffInitialMs,
    backoffMaxMs: args.backoffMaxMs ?? cfg.watch.backoffMaxMs,
    backoffFactor: cfg.watch.backoffFactor,
    maxTasks: args.maxTasks ?? cfg.task.maxTasks,
    maxFailures: args.maxFailures ?? cfg.task.maxFailures,
    retry: args.retry ?? cfg.task.retry,
  }

  appendWatchEvent(watchRunDir, { event: 'watch_start', ...summaryBase, watchRunDir })
  console.error(`afk-watch ${formatWatchPhaseLog({ event: 'watch_start' })}`)
  updateWatcherRegistry(cacheRoot, workdir, {
    state: 'polling',
    claimMode,
    runDir: watchRunDir,
    phaseStartedAt: Date.now(),
    pollIntervalMs: runConfig.pollIntervalMs,
  })

  if (serveEnabled !== false) {
    const dashboardPid = startResidentDashboard({
      registryPath,
      watchSession: watchRunDir,
      port: servePort,
      open: cfg.watch.serve.open,
    })
    owned.dashboardPid = dashboardPid
    updateWatcherRegistry(cacheRoot, workdir, { dashboardPid, claimMode })
  } else {
    console.error('afk-watch 看板: --no-serve（仅控制台留痕）')
  }

  const spawnRun = createLiveSpawnRun({
    execCache,
    workdir,
    isStopRequested,
    onOwned,
    argsFor: (pinnedIds) => buildExecutionArgs({
      workdir,
      source: sourceName,
      repo,
      cacheDir: execCache,
      stopFile,
      allowDirty,
      configPath: args.configPath,
      requirement: args.requirement,
      maxTasks: runConfig.maxTasks,
      maxFailures: runConfig.maxFailures,
      retry: runConfig.retry,
      pinnedIds,
      execReview,
    }),
  })

  const applyPhase = (event) => {
    const line = formatWatchPhaseLog(event)
    if (line) console.error(`afk-watch ${line}`)
    if (event.event === 'idle' || event.event === 'claim_skipped' || event.event === 'run_end') {
      updateWatcherRegistry(cacheRoot, workdir, {
        state: 'polling',
        claimMode,
        childPid: null,
        execRunDir: '',
        phaseStartedAt: Date.now(),
      })
      owned.childPid = null
      owned.runDir = ''
    } else if (event.event === 'source_error') {
      updateWatcherRegistry(cacheRoot, workdir, {
        state: 'backing-off',
        claimMode,
        backoffWaitMs: event.waitMs || 0,
        phaseStartedAt: Date.now(),
      })
    } else if (event.event === 'run_start') {
      updateWatcherRegistry(cacheRoot, workdir, {
        state: 'running',
        claimMode,
        phaseStartedAt: Date.now(),
      })
    }
  }

  runWatcher({
    config: runConfig,
    source,
    spawnRun,
    isStopRequested,
    stopOwned,
    onPool: (pool) => {
      writeWatchPool(watchRunDir, pool)
      updateWatcherRegistry(cacheRoot, workdir, {
        lastPollAt: Date.now(),
        claimMode,
      })
    },
    onEvent: (event) => {
      appendWatchEvent(watchRunDir, event)
      applyPhase(event)
    },
  })
    .then((result) => {
      appendWatchEvent(watchRunDir, { event: 'watch_stop', reason: result.reason })
      console.error(`afk-watch ${formatWatchPhaseLog({ event: 'watch_stop', reason: result.reason })}`)
      const payload = inboxPayloadForWatchStop({
        requirement: args.requirement,
        workdir,
        reason: result.reason,
        watchRunDir,
        servePort: serveEnabled === false ? 0 : servePort,
      })
      if (payload) emitInboxEvent(payload, { log: (line) => console.error(line) })
      stopOwnedProcesses(owned, killOwnedProcess)
      updateWatcherRegistry(cacheRoot, workdir, { state: 'stopped', childPid: null, claimMode })
      releaseWatcherInstance(cacheRoot, workdir, process.pid)
      process.stdout.write(JSON.stringify({
        ...result,
        ...summaryBase,
        watchRunDir,
        servePort: serveEnabled === false ? 0 : servePort,
      }) + '\n')
      process.exit(result.reason === 'require-atomic-claim' ? 2 : 0)
    })
    .catch((err) => {
      appendWatchEvent(watchRunDir, { event: 'watch_stop', reason: 'error', message: err.message })
      emitInboxEvent(
        inboxPayloadForWatchStop({
          requirement: args.requirement,
          workdir,
          reason: 'error',
          message: err.message,
          watchRunDir,
          servePort: serveEnabled === false ? 0 : servePort,
          error: err.message,
        }),
        { log: (line) => console.error(line) },
      )
      stopOwned()
      releaseWatcherInstance(cacheRoot, workdir, process.pid)
      console.error(err.stack || err.message || String(err))
      process.exit(1)
    })
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  main()
}
