#!/usr/bin/env node
/**
 * AFK 循环：确定性轨道。
 *
 * 结构：
 *   runLoop(deps) —— 可注入主循环（唯一测试 seam；source/execReview/git 全 fake 可测）
 *   decide(outcome) —— 状态机纯函数
 *   main() —— 参数解析 + 装配真实依赖（子进程 exec-review / beads adapter / git）
 *
 * 保证三条硬性质：必终止（stop-file / max-tasks / all-done / stuck / 熔断）、
 * 每任务至多执行 1+retry 次、全局有上限。
 */

import { spawn } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { createSource } from './task-sources/index.mjs'
import * as gitModule from './git.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SKILL_ROOT = resolve(__dirname, '..')
const RUN_TASK_PATH = resolve(
  __dirname,
  '..',
  '..',
  'exec-review',
  'scripts',
  'run-task.mjs',
)
const DEFAULT_STOP_FILE = 'afk-stop'

// ---------- 状态机 ----------

const DONE_STATUSES = ['approved', 'done']
const RETRY_STATUSES = [
  'no_change',
  'blocked',
  'empty',
  'executor_failed',
  'timeout',
  'review_timeout',
]

/**
 * 单次 exec-review 结果 → 决策。
 * @param {{ status?: string, summary?: string }} outcome
 * @returns {{ kind: 'done' } | { kind: 'retry', reason: string } | { kind: 'failed', reason: string }}
 */
export function decide(outcome) {
  const status = outcome?.status || 'unknown'
  if (DONE_STATUSES.includes(status)) return { kind: 'done' }
  const note = outcome?.summary || outcome?.review?.note || ''
  if (RETRY_STATUSES.includes(status)) {
    return { kind: 'retry', reason: `exec-review status=${status}: ${note}`.trim() }
  }
  return { kind: 'failed', reason: `exec-review 未知状态 ${status}: ${note}`.trim() }
}

// ---------- 任务文本 ----------

/** 生成 exec-review 的 task.md（与 run-task.mjs 的 taskSnap 格式一致）。 */
export function writeTaskMd(detail, taskFile) {
  const snap = [
    `# ${detail.title || detail.id}`,
    detail.id ? `id: ${detail.id}` : '',
    '',
    '## 正文',
    '',
    detail.body || '（正文为空）',
    '',
    '## 要求',
    '',
    detail.requirements || '（无）',
    '',
  ]
    .filter((l, i, arr) => !(l === '' && arr[i - 1] === ''))
    .join('\n')
  writeFileSync(taskFile, snap, 'utf8')
  return taskFile
}

// ---------- 子进程 exec-review ----------

function extractJson(text) {
  const raw = String(text || '').trim()
  if (!raw) return null
  const tryParse = (s) => {
    try {
      return JSON.parse(s)
    } catch {
      return null
    }
  }
  let v = tryParse(raw)
  if (v) return v
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) {
    v = tryParse(fence[1].trim())
    if (v) return v
  }
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start >= 0 && end > start) {
    v = tryParse(raw.slice(start, end + 1))
    if (v) return v
  }
  return null
}

/**
 * 默认 execReview 实现：spawn run-task.mjs 子进程。
 * 主超时语义在 exec-review 层（--timeout）；兜底超时 = timeout + hardTimeoutExtra。
 */
export function createExecReview(workdir, execCfg = {}, onLog = () => {}) {
  return {
    async run(taskFile) {
      const args = [
        RUN_TASK_PATH,
        '--workdir',
        workdir,
        '--task-file',
        taskFile,
        '--git-commit',
        'false',
        '--no-serve',
        '--no-open',
      ]
      const push = (flag, val) => {
        if (val != null && String(val) !== '') args.push(flag, String(val))
      }
      push('--timeout', execCfg.timeout)
      push('--runner', execCfg.runner)
      push('--executor-runner', execCfg.executorRunner)
      push('--reviewer-runner', execCfg.reviewerRunner)
      push('--executor-model', execCfg.executorModel)
      push('--reviewer-model', execCfg.reviewerModel)
      push('--executor-thinking', execCfg.executorThinking)
      push('--reviewer-thinking', execCfg.reviewerThinking)

      const baseTimeout = Number(execCfg.timeout) || 0
      const extra = Number(execCfg.hardTimeoutExtra) || 120
      const hardTimeoutMs = (baseTimeout + extra) * 1000

      const result = await new Promise((resolvePromise) => {
        const child = spawn(process.execPath, args, {
          cwd: workdir,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: hardTimeoutMs,
        })
        let stdout = ''
        child.stdout.on('data', (d) => (stdout += d))
        child.stderr.on('data', (d) => onLog(String(d)))
        child.on('error', (err) => resolvePromise({ error: err.message }))
        child.on('close', (code) => resolvePromise({ code: code ?? 1, stdout }))
      })

      if (result.error) {
        return {
          status: 'executor_failed',
          summary: `无法启动 exec-review: ${result.error}`,
        }
      }
      if (result.code !== 0) {
        return {
          status: 'executor_failed',
          summary: `exec-review 异常退出 (exit=${result.code})`,
        }
      }
      const summary = extractJson(result.stdout)
      if (summary && typeof summary === 'object' && summary.status) {
        return summary
      }
      return {
        status: 'executor_failed',
        summary: 'exec-review 输出无法解析',
      }
    },
  }
}

// ---------- 主循环（可注入） ----------

/**
 * @param {object} deps
 * @param {object} deps.config  { stopFile, maxTasks, maxFailures, retry }
 * @param {object} deps.source  task source adapter（listReady/getDetail/markInProgress/markDone/markFailed/describeBlocked）
 * @param {object} deps.execReview  { run(taskFile) → outcome }
 * @param {object} deps.git     { head(), commitAll(task), resetHard(headRef) } workdir 已在闭包绑定
 * @param {object} [deps.hooks] { onTask(record), taskDir }
 * @returns {Promise<{ reason: string, stats: object, tasks: object[] }>}
 */
export async function runLoop(deps) {
  const { config, source, execReview, git, hooks = {} } = deps
  const stats = { attempted: 0, done: 0, failed: 0 }
  const tasks = []
  let consecutiveFailures = 0

  const finish = (reason) => ({ reason, stats, tasks })

  while (true) {
    if (config.stopFile && existsSync(config.stopFile)) return finish('stop-file')
    if (config.maxTasks > 0 && stats.attempted >= config.maxTasks) return finish('max-tasks')

    let ready
    try {
      ready = await source.listReady()
    } catch (err) {
      return finish(`source-error: ${err.message}`)
    }

    if (ready.length === 0) {
      let blocked = []
      try {
        blocked = await source.describeBlocked()
      } catch {
        blocked = []
      }
      return finish(blocked.length > 0 ? `stuck: ${blocked.length} 个工单未就绪` : 'all-done')
    }

    const task = ready[0]
    await source.markInProgress(task.id)
    const detail = await source.getDetail(task.id)
    const taskFile = join(hooks.taskDir || tmpdir(), `task-${task.id}.md`)
    writeTaskMd(detail, taskFile)
    const startHead = git.head()

    // 每任务尝试循环：attempt = 0 .. retry
    let result = null
    for (let attempt = 0; attempt <= config.retry; attempt++) {
      let outcome
      try {
        outcome = await execReview.run(taskFile)
      } catch (err) {
        outcome = { status: 'executor_failed', summary: `exec-review 异常: ${err.message}` }
      }
      const decision = decide(outcome)
      if (decision.kind === 'done') {
        result = { kind: 'done', outcome, attempts: attempt + 1 }
        break
      }
      git.resetHard(startHead)
      if (decision.kind === 'retry' && attempt < config.retry) continue
      result = { kind: 'failed', reason: decision.reason, outcome, attempts: attempt + 1 }
      break
    }

    stats.attempted++
    if (result.kind === 'done') {
      git.commitAll({
        id: task.id,
        title: task.title,
        status: result.outcome.status,
        summary: result.outcome.summary || '',
      })
      await source.markDone(task.id, {
        status: result.outcome.status,
        summary: result.outcome.summary || '',
      })
      consecutiveFailures = 0
      stats.done++
    } else {
      await source.markFailed(task.id, result.reason)
      consecutiveFailures++
      stats.failed++
    }
    const record = {
      id: task.id,
      title: task.title,
      priority: task.priority,
      kind: result.kind,
      status: result.outcome?.status,
      reason: result.kind === 'failed' ? result.reason : undefined,
      attempts: result.attempts,
      summary: result.outcome?.summary,
    }
    tasks.push(record)
    if (hooks.onTask) hooks.onTask(record)
    if (config.maxFailures > 0 && consecutiveFailures >= config.maxFailures) {
      return finish('circuit-broken')
    }
  }
}

// ---------- CLI 主入口 ----------

function usage(code = 1) {
  const text = `用法:
  node loop.mjs --workdir <目录> [--source beads]
    [--max-tasks <N>] [--max-failures <N>] [--retry <N>]
    [--stop-file <路径>] [--allow-dirty]
    [--git-name <名>] [--git-email <邮箱>]
    [--config <config.json>] [--cache-dir <目录>] [--dry-run]
    透传 exec-review: [--timeout <秒>] [--runner <codex|pi>]
    [--executor-runner <…>] [--reviewer-runner <…>]
    [--executor-model <…>] [--reviewer-model <…>]
    [--executor-thinking <…>] [--reviewer-thinking <…>]
    [--hard-timeout-extra <秒>]

默认来自技能根 config.json。优先级：CLI > env > config > 内置。`
  console.error(text)
  process.exit(code)
}

function parseArgs(argv) {
  const out = {
    workdir: '',
    source: '',
    maxTasks: 0,
    maxFailures: 0,
    retry: 0,
    stopFile: '',
    allowDirty: false,
    gitName: '',
    gitEmail: '',
    configPath: '',
    cacheDir: '',
    dryRun: false,
    timeout: 0,
    runner: '',
    executorRunner: '',
    reviewerRunner: '',
    executorModel: '',
    reviewerModel: '',
    executorThinking: '',
    reviewerThinking: '',
    hardTimeoutExtra: 0,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      const v = argv[++i]
      if (v === undefined) usage()
      return v
    }
    switch (a) {
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
      case '--max-tasks':
        out.maxTasks = Math.max(0, Number(next()) || 0)
        break
      case '--max-failures':
        out.maxFailures = Math.max(0, Number(next()) || 0)
        break
      case '--retry':
        out.retry = Math.max(0, Number(next()) || 0)
        break
      case '--stop-file':
        out.stopFile = next()
        break
      case '--allow-dirty':
        out.allowDirty = true
        break
      case '--git-name':
        out.gitName = next()
        break
      case '--git-email':
        out.gitEmail = next()
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
      case '--timeout':
        out.timeout = Math.max(0, Number(next()) || 0)
        break
      case '--runner':
        out.runner = String(next()).toLowerCase()
        break
      case '--executor-runner':
        out.executorRunner = String(next()).toLowerCase()
        break
      case '--reviewer-runner':
        out.reviewerRunner = String(next()).toLowerCase()
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
        console.error(`未知参数: ${a}`)
        usage()
    }
  }
  return out
}

function loadConfig(path) {
  const defaults = {
    source: 'beads',
    workdir: '',
    maxTasks: 0,
    maxFailures: 3,
    retry: 1,
    allowDirty: false,
    stopFile: '',
    gitIdentity: { name: 'AFK Bot', email: 'afk@local' },
    execReview: {
      timeout: 600,
      runner: '',
      executorRunner: '',
      reviewerRunner: '',
      executorModel: '',
      reviewerModel: '',
      executorThinking: '',
      reviewerThinking: '',
      hardTimeoutExtra: 120,
    },
  }
  const file = resolve(path || join(SKILL_ROOT, 'config.json'))
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
  cfg.gitIdentity = { ...defaults.gitIdentity, ...(data.gitIdentity || {}) }
  cfg.execReview = { ...defaults.execReview, ...(data.execReview || {}) }
  return { cfg, path: file }
}

function localTimestamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return (
    d.getFullYear() +
    p(d.getMonth() + 1) +
    p(d.getDate()) +
    '-' +
    p(d.getHours()) +
    p(d.getMinutes()) +
    p(d.getSeconds())
  )
}

function uniqueDir(parent, prefix) {
  let name = prefix
  let i = 0
  while (existsSync(join(parent, name))) {
    i += 1
    name = `${prefix}-${i}`
  }
  return name
}

function writeReport(runDir, result, startedAt, workdir) {
  const lines = [
    `# AFK 运行报告 ${localTimestamp(startedAt)}`,
    '',
    `- workdir: ${workdir}`,
    `- 停止原因: ${result.reason}`,
    `- 尝试任务: ${result.stats.attempted} | 完成: ${result.stats.done} | 失败: ${result.stats.failed}`,
    '',
  ]
  const doneRows = result.tasks.filter((t) => t.kind === 'done')
  const failedRows = result.tasks.filter((t) => t.kind === 'failed')
  if (doneRows.length) {
    lines.push('## 完成', '', '| id | 标题 | 状态 | 尝试次数 |', '|---|---|---|---|')
    for (const t of doneRows) {
      lines.push(`| ${t.id} | ${t.title} | ${t.status} | ${t.attempts} |`)
    }
    lines.push('')
  }
  if (failedRows.length) {
    lines.push('## 失败', '', '| id | 标题 | 原因 |', '|---|---|---|')
    for (const t of failedRows) {
      lines.push(`| ${t.id} | ${t.title} | ${t.reason} |`)
    }
    lines.push('')
  }
  if (result.reason.startsWith('stuck')) {
    lines.push(
      '## 阻塞（未就绪工单）',
      '',
      '请检查依赖：存在未完成工单因前置阻塞无法执行。',
      '',
    )
  }
  const reportFile = join(runDir, 'report.md')
  writeFileSync(reportFile, lines.join('\n'), 'utf8')
  return reportFile
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const { cfg } = loadConfig(args.configPath)

  const workdir = resolve(args.workdir || cfg.workdir || '')
  if (!workdir || !existsSync(workdir)) {
    console.error(`workdir 不存在: ${workdir}`)
    process.exit(2)
  }

  const sourceName = args.source || cfg.source || 'beads'
  const stopFile = resolve(args.stopFile || cfg.stopFile || join(workdir, DEFAULT_STOP_FILE))
  const gitIdentity = {
    name: args.gitName || cfg.gitIdentity.name,
    email: args.gitEmail || cfg.gitIdentity.email,
  }
  const execCfg = {
    timeout: args.timeout || cfg.execReview.timeout || 0,
    runner: args.runner || cfg.execReview.runner,
    executorRunner: args.executorRunner || cfg.execReview.executorRunner,
    reviewerRunner: args.reviewerRunner || cfg.execReview.reviewerRunner,
    executorModel: args.executorModel || cfg.execReview.executorModel,
    reviewerModel: args.reviewerModel || cfg.execReview.reviewerModel,
    executorThinking: args.executorThinking || cfg.execReview.executorThinking,
    reviewerThinking: args.reviewerThinking || cfg.execReview.reviewerThinking,
    hardTimeoutExtra: args.hardTimeoutExtra || cfg.execReview.hardTimeoutExtra || 120,
  }
  const allowDirty = args.allowDirty || cfg.allowDirty || false

  const cacheRoot = resolve(args.cacheDir || join(tmpdir(), 'afk-run'))
  const runDir = join(cacheRoot, uniqueDir(cacheRoot, `run-${localTimestamp()}`))
  mkdirSync(runDir, { recursive: true })

  // 装配真实依赖（workdir 闭包绑定）
  const git = {
    head: () => gitModule.head(workdir),
    commitAll: (task) => gitModule.commitAll(workdir, task, DEFAULT_STOP_FILE),
    resetHard: (headRef) => gitModule.resetHard(workdir, headRef, DEFAULT_STOP_FILE),
  }
  const source = createSource(sourceName, { cwd: workdir })
  const execReview = createExecReview(workdir, execCfg)
  const hooks = {
    taskDir: runDir,
    onTask: (record) => appendFileSync(join(runDir, 'loop-progress.jsonl'), JSON.stringify(record) + '\n', 'utf8'),
  }
  const config = {
    stopFile,
    maxTasks: args.maxTasks || cfg.maxTasks || 0,
    maxFailures: args.maxFailures || cfg.maxFailures || 0,
    retry: args.retry || cfg.retry || 0,
  }

  // 启动校验：强制 git + 干净工作区（dry-run 跳过实际执行，但保证可验证装配）
  if (args.dryRun) {
    process.stdout.write(JSON.stringify({ dryRun: true, workdir, source: sourceName, stopFile, runDir, execCfg }, null, 2) + '\n')
    return
  }
  gitModule.ensureGit(workdir, gitIdentity)
  if (!gitModule.isClean(workdir) && !allowDirty) {
    console.error(
      `工作区有未提交改动（${workdir}）。失败回滚会重置这些改动；请先提交/stash，或 --allow-dirty 显式放行。`,
    )
    process.exit(2)
  }

  const startedAt = new Date()
  runLoop({ config, source, execReview, git, hooks })
    .then((result) => {
      const reportFile = writeReport(runDir, result, startedAt, workdir)
      const summary = {
        reason: result.reason,
        attempted: result.stats.attempted,
        done: result.stats.done,
        failed: result.stats.failed,
        runDir,
        reportFile,
        progressFile: join(runDir, 'loop-progress.jsonl'),
      }
      process.stdout.write(JSON.stringify(summary, null, 2) + '\n')
    })
    .catch((err) => {
      console.error(`loop 异常: ${err.stack || err}`)
      process.exit(1)
    })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}