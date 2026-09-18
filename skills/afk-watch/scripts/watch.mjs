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
} from './watch-state.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SKILL_ROOT = resolve(__dirname, '..')
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
  if (Number(options.maxTasks) > 0) args.push('--max-tasks', String(options.maxTasks))
  if (Number(options.maxFailures) > 0) args.push('--max-failures', String(options.maxFailures))
  if (Number(options.retry) > 0) args.push('--retry', String(options.retry))
  if (options.stopFile) args.push('--stop-file', options.stopFile)
  if (options.allowDirty) args.push('--allow-dirty')
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
 * 监督一次执行批次：子进程活着就等，停止信号只杀掉本次登记的子进程和看板。
 */
export async function superviseExecutionRun(opts) {
  const child = opts.startChild()
  const kill = opts.kill || killOwnedProcess
  const sleep = opts.sleep || sleepWithStop
  const isStopRequested = opts.isStopRequested || (() => false)
  let dashboardPid = null
  const owned = { childPid: child.pid, dashboardPid: null, runDir: '' }
  if (typeof opts.onOwned === 'function') opts.onOwned(owned)

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
          owned.dashboardPid = dashboardPid
          if (typeof opts.onOwned === 'function') opts.onOwned({ ...owned })
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
 * 轮询循环。远程 in-progress 不参与判断；只看 listReady 和本进程的停止信号。
 */
export async function runWatcher(deps) {
  const config = deps.config || {}
  const source = deps.source
  const sleep = deps.sleep || sleepWithStop
  const isStopRequested = deps.isStopRequested || (() => false)
  const onEvent = deps.onEvent || (() => {})
  const spawnRun = deps.spawnRun
  const stopOwned = deps.stopOwned || (() => {})
  const claimMode = source?.claimMode || 'unsupported'
  const initialDelay = numberOr(config.backoffInitialMs, 1000)
  const maxDelay = numberOr(config.backoffMaxMs, 60000)
  const factor = Number(config.backoffFactor) > 1 ? Number(config.backoffFactor) : 2
  const pollIntervalMs = numberOr(config.pollIntervalMs, 15000)
  let delay = initialDelay
  let runs = 0

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

    let ready = []
    try {
      ready = await source.listReady()
      if (!Array.isArray(ready)) ready = []
    } catch (err) {
      if (await backoff(err?.message || err)) return finish('stop')
      continue
    }

    if (ready.length === 0) {
      delay = initialDelay
      onEvent({ event: 'idle', claimMode })
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
    })

    let childResult = { code: 0 }
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

    runs += 1
    delay = initialDelay
    onEvent({ event: 'run_end', id: String(ready[0].id), code: childResult?.code ?? 0 })
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
    [--stop-file <路径>] [--allow-dirty] [--cache-dir <目录>] [--config <config.json>]
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

function loadConfig(configPath) {
  const defaults = {
    source: 'beads',
    maxTasks: 1,
    maxFailures: 3,
    retry: 1,
    pollIntervalMs: 15000,
    backoffInitialMs: 1000,
    backoffMaxMs: 60000,
    backoffFactor: 2,
    requireAtomicClaim: false,
    allowDirty: false,
    stopFile: '',
    serve: { enabled: true, port: 0, open: false },
    execReview: {
      timeout: 0,
      runner: '',
      executorRunner: '',
      reviewerRunner: '',
      executorModel: '',
      reviewerModel: '',
      executorThinking: '',
      reviewerThinking: '',
      hardTimeoutExtra: 0,
    },
    tapd: {
      claimMode: '',
      statusField: '',
      ownerField: '',
      readyValue: '',
      claimedValue: '',
      doneValue: '',
      failedValue: '',
      ownerValue: '',
      customFields: {},
    },
  }
  const file = resolve(configPath || join(SKILL_ROOT, 'config.json'))
  let data = {}
  if (existsSync(file)) {
    try {
      data = JSON.parse(readFileSync(file, 'utf8'))
    } catch (err) {
      console.error(`无法解析配置 ${file}: ${err.message}`)
      process.exit(2)
    }
  }
  const cfg = { ...defaults, ...data }
  cfg.serve = { ...defaults.serve, ...(data.serve || {}) }
  cfg.execReview = { ...defaults.execReview, ...(data.execReview || {}) }
  cfg.tapd = {
    ...defaults.tapd,
    ...(data.tapd || {}),
    customFields: {
      ...defaults.tapd.customFields,
      ...((data.tapd && data.tapd.customFields) || {}),
    },
  }
  return cfg
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
  serve,
  isStopRequested,
  onOwned,
}) {
  let dashboardPid = null
  return async function spawnRun({ pinnedIds }) {
    if (dashboardPid) {
      killOwnedProcess(dashboardPid, { tree: false })
      dashboardPid = null
    }
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
    const result = await superviseExecutionRun({
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
      startDashboard: serve.enabled
        ? (runDir) => {
            const dash = spawn(process.execPath, [LOOP_SERVE_PATH, runDir, String(serve.port)], {
              detached: true,
              stdio: 'ignore',
              windowsHide: true,
            })
            dash.unref()
            dashboardPid = dash.pid
            if (serve.open) setTimeout(() => openUrl(`http://127.0.0.1:${serve.port}/`), 600)
            return dash.pid
          }
        : null,
      isStopRequested,
      onOwned,
      kill: killOwnedProcess,
      sleep: sleepWithStop,
      pollMs: 200,
    })
    dashboardPid = result.dashboardPid || dashboardPid
    return result
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const cfg = loadConfig(args.configPath)
  if (!args.workdir) {
    console.error('workdir 必传：--workdir <目录>')
    process.exit(2)
  }
  const workdir = resolve(args.workdir)
  if (!existsSync(workdir)) {
    console.error(`workdir 不存在: ${workdir}`)
    process.exit(2)
  }

  const stopFile = resolve(args.stopFile || cfg.stopFile || join(workdir, DEFAULT_STOP_FILE))
  if (args.stop) {
    mkdirSync(dirname(stopFile), { recursive: true })
    writeFileSync(stopFile, `stop ${new Date().toISOString()}\n`, 'utf8')
    process.stdout.write(JSON.stringify({ reason: 'stop-requested', stopFile }) + '\n')
    return
  }

  const allowDirty = args.allowDirty || cfg.allowDirty
  if (!workspaceIsClean(workdir) && !allowDirty) {
    console.error(`工作区有未提交改动（${workdir}）。请先提交/stash，或 --allow-dirty。`)
    process.exit(2)
  }

  const sourceName = args.source || cfg.source || 'beads'
  let source
  try {
    source = createSource(sourceName, {
      cwd: workdir,
      ...(args.repo ? { repo: args.repo } : {}),
      tapd: cfg.tapd,
    })
  } catch (err) {
    console.error(err.message || String(err))
    process.exit(2)
  }

  const claimMode = source.claimMode || 'unsupported'
  const requireAtomicClaim = args.requireAtomicClaim || cfg.requireAtomicClaim
  const summaryBase = {
    workdir,
    source: sourceName,
    claimMode,
    requireAtomicClaim: Boolean(requireAtomicClaim),
    stopFile,
  }
  if (args.dryRun) {
    process.stdout.write(JSON.stringify({
      dryRun: true,
      ...summaryBase,
      refusesWork: Boolean(requireAtomicClaim) && claimMode !== 'atomic',
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

  const serveEnabled = args.serve ?? cfg.serve.enabled
  const servePort = args.port || cfg.serve.port || 9700 + (hashStr(workdir) % 1000)
  let owned = { childPid: null, dashboardPid: null, runDir: '' }
  let stopRequested = false
  const isStopRequested = () => stopRequested || existsSync(stopFile)
  const onOwned = (next) => {
    owned = { ...owned, ...next }
    updateWatcherRegistry(cacheRoot, workdir, {
      childPid: owned.childPid,
      dashboardPid: owned.dashboardPid,
      execRunDir: owned.runDir || '',
      state: 'running',
      claimMode,
    })
  }
  const stopOwned = () => {
    stopOwnedProcesses(owned, killOwnedProcess)
    updateWatcherRegistry(cacheRoot, workdir, { state: 'stopping', claimMode })
  }
  const onSignal = () => {
    stopRequested = true
    stopOwned()
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)

  const execReview = {
    ...cfg.execReview,
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
    pollIntervalMs: args.pollIntervalMs ?? cfg.pollIntervalMs,
    backoffInitialMs: args.backoffInitialMs ?? cfg.backoffInitialMs,
    backoffMaxMs: args.backoffMaxMs ?? cfg.backoffMaxMs,
    backoffFactor: cfg.backoffFactor,
    maxTasks: args.maxTasks ?? cfg.maxTasks,
    maxFailures: args.maxFailures ?? cfg.maxFailures,
    retry: args.retry ?? cfg.retry,
  }

  appendWatchEvent(watchRunDir, { event: 'watch_start', ...summaryBase, watchRunDir })
  updateWatcherRegistry(cacheRoot, workdir, { state: 'polling', claimMode, runDir: watchRunDir })

  const spawnRun = createLiveSpawnRun({
    execCache,
    workdir,
    serve: { enabled: serveEnabled !== false, port: servePort, open: cfg.serve.open },
    isStopRequested,
    onOwned,
    argsFor: (pinnedIds) => buildExecutionArgs({
      workdir,
      source: sourceName,
      repo: args.repo,
      cacheDir: execCache,
      stopFile,
      allowDirty,
      maxTasks: runConfig.maxTasks,
      maxFailures: runConfig.maxFailures,
      retry: runConfig.retry,
      pinnedIds,
      execReview,
    }),
  })

  runWatcher({
    config: runConfig,
    source,
    spawnRun,
    isStopRequested,
    stopOwned,
    onEvent: (event) => {
      appendWatchEvent(watchRunDir, event)
      if (event.event === 'idle') {
        updateWatcherRegistry(cacheRoot, workdir, { state: 'idle', claimMode, childPid: null })
      }
    },
  })
    .then((result) => {
      appendWatchEvent(watchRunDir, { event: 'watch_stop', reason: result.reason })
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
