#!/usr/bin/env node
/**
 * AFK 循环：确定性轨道。
 *
 * 结构：
 *   recoverAndRunLoop(deps) —— 启动期 stale 恢复 + 可注入主循环
 *   decide(outcome) —— 状态机纯函数
 *   main() —— 参数解析 + 装配真实依赖（子进程 exec-review / beads adapter / git）
 *
 * 保证三条硬性质：必终止（stop-file / max-tasks / all-done / stuck / 熔断）、
 * 每任务至多执行 1+retry 次、全局有上限。
 */

import { execFileSync, spawn } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { createSource } from './task-sources/index.mjs'
import * as gitModule from './git.mjs'
import { deepMerge, requireAfkSections, resolveAfkConfigFiles } from './afk-home.mjs'
import { emitInboxEvent } from './inbox.mjs'
import { resolveEventRequirement } from './requirement.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const RUN_TASK_PATH = resolve(
  __dirname,
  '..',
  '..',
  'exec-review',
  'scripts',
  'run-task.mjs',
)
const LOOP_SERVE_PATH = resolve(__dirname, 'loop-serve.mjs')
const DEFAULT_STOP_FILE = 'afk-stop'

// ---------- 状态机 ----------

const DONE_STATUSES = ['approved', 'done']
// 「无需改代码」是确定性判断：同一棵树跑第二遍只会得到同一结论，重试毫无意义。
const NOOP_STATUSES = ['no_change']
const RETRY_STATUSES = [
  'blocked',
  'empty',
  'executor_failed',
  'timeout',
  'review_timeout',
]

/**
 * 单次 exec-review 结果 → 决策。
 * @param {{ status?: string, summary?: string }} outcome
 * @returns {{ kind: 'done' } | { kind: 'noop', reason: string } | { kind: 'retry', reason: string } | { kind: 'failed', reason: string }}
 */
export function decide(outcome) {
  const status = outcome?.status || 'unknown'
  if (DONE_STATUSES.includes(status)) return { kind: 'done' }
  const note = outcome?.summary || outcome?.review?.note || ''
  const reason = `exec-review status=${status}: ${note}`.trim()
  if (NOOP_STATUSES.includes(status)) return { kind: 'noop', reason }
  if (RETRY_STATUSES.includes(status)) return { kind: 'retry', reason }
  return { kind: 'failed', reason: `exec-review 未知状态 ${status}: ${note}`.trim() }
}

// 7–40 位十六进制：git 短/长 SHA。前后不允许再连着十六进制字符，避免截断长哈希。
const COMMIT_TOKEN_RE = /(?<![0-9a-f])[0-9a-f]{7,40}(?![0-9a-f])/gi

/**
 * `no_change` 时从执行端说明里找「需求已由现有提交满足」的证据。
 *
 * 只认能在 git 历史里核实到的提交号——执行端自称「已实现」不算证据；
 * 核实不了（git 不支持这个方法 / 提交不在历史里）就当没证据，转人工。
 *
 * @param {object} outcome exec-review 的 summary.json
 * @param {{ isAncestor?: (ref: string) => boolean }} git
 * @returns {string|null} 核实到的提交号
 */
export function findSatisfiedCommit(outcome, git) {
  if (!git || typeof git.isAncestor !== 'function') return null
  const tokens = new Set()
  for (const text of [outcome?.summary, outcome?.note, outcome?.outcome?.note, outcome?.reason]) {
    for (const match of String(text || '').matchAll(COMMIT_TOKEN_RE)) {
      tokens.add(match[0].toLowerCase())
    }
  }
  for (const token of tokens) {
    try {
      if (git.isAncestor(token)) return token
    } catch {
      // git 查询失败 → 当没证据（宁转人工，不静默关单）
    }
  }
  return null
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
    async run(taskFile, runOptions = {}) {
      const args = [
        RUN_TASK_PATH,
        '--workdir',
        workdir,
        '--task-file',
        taskFile,
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
      push('--progress-file', runOptions.progressFile)

      const baseTimeout = Number(execCfg.timeout) || 0
      const extra = Number(execCfg.hardTimeoutExtra) || 120
      const spawnOpts = {
        cwd: workdir,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
      // timeout=0 表示 exec-review 无时限；loop 也不应再用 hardTimeoutExtra 强杀子进程
      if (baseTimeout > 0) spawnOpts.timeout = (baseTimeout + extra) * 1000

      const result = await new Promise((resolvePromise) => {
        const child = spawn(process.execPath, args, spawnOpts)
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

/**
 * 把调用方已认领、但 listReady 不再返回的 pinned 工单补进本轮队列。
 * 本批次已处理过的 id 不再补入，否则会反复领取同一工单。
 */
async function includePinnedReady(ready, source, pinnedIds, attemptedIds) {
  const ids = Array.isArray(pinnedIds) ? pinnedIds.map((id) => String(id)).filter(Boolean) : []
  const tasks = Array.isArray(ready) ? ready : []
  if (!ids.length) return tasks
  const seen = new Set(tasks.map((task) => String(task.id)))
  const extras = []
  for (const id of ids) {
    if (seen.has(id) || attemptedIds?.has(id)) continue
    seen.add(id)
    let title = id
    try {
      const detail = await source.getDetail(id)
      if (detail?.title) title = detail.title
    } catch {
      // watcher 已认领的工单仍要进入本批次，即使 listReady 因 in-progress 把它排除了。
    }
    extras.push({ id, title, priority: 2 })
  }
  return extras.length ? [...extras, ...tasks] : tasks
}

// ---------- 主循环（可注入） ----------

async function emitPipelineSnapshot(source, hooks) {
  if (!hooks.onPipeline || typeof source.describeBlocked !== 'function') return
  try {
    const described = await source.describeBlocked()
    const pipeline = Array.isArray(described)
      ? { ready: [], blocked: described, inProgress: [] }
      : {
          ready: Array.isArray(described?.ready) ? described.ready : [],
          blocked: Array.isArray(described?.blocked) ? described.blocked : [],
          inProgress: Array.isArray(described?.inProgress) ? described.inProgress : [],
        }
    hooks.onPipeline(pipeline)
  } catch {
    // 看板快照失败不应中断 loop
  }
}

/**
 * @param {object} deps
 * @param {object} deps.config  { stopFile, maxTasks, maxFailures, retry }
 * @param {object} deps.source  task source adapter（listReady/getDetail/markInProgress/markDone/markFailed/describeBlocked）
 * @param {object} deps.execReview  { run(taskFile) → outcome }
 * @param {object} deps.git     { head(), resetHard(headRef), isClean(), isAncestor(ref) } workdir 已在闭包绑定
 * @param {object} [deps.hooks] { onQueue(tasks), onTaskStart(task), onTask(record), taskDir, progressFile(task, attempt) }
 * @returns {Promise<{ reason: string, stats: object, tasks: object[] }>}
 */
export async function runLoop(deps) {
  const { config, source, execReview, git, hooks = {} } = deps
  const stats = { attempted: 0, done: 0, failed: 0, noop: 0 }
  const tasks = []
  const attemptedIds = new Set()
  let consecutiveFailures = 0

  const finish = (reason) => ({ reason, stats, tasks })

  await emitPipelineSnapshot(source, hooks)

  while (true) {
    if (typeof deps.isActive === 'function' && !deps.isActive()) return finish('superseded')
    if (config.stopFile && existsSync(config.stopFile)) return finish('stop-file')
    if (config.maxTasks > 0 && stats.attempted >= config.maxTasks) return finish('max-tasks')

    await emitPipelineSnapshot(source, hooks)

    let ready
    try {
      ready = await source.listReady()
      ready = await includePinnedReady(ready, source, config.pinnedIds, attemptedIds)
    } catch (err) {
      return finish(`source-error: ${err.message}`)
    }

    if (ready.length === 0) {
      let blockedState = { ready: [], blocked: [], inProgress: [] }
      try {
        const described = await source.describeBlocked()
        blockedState = Array.isArray(described)
          ? { ready: [], blocked: described, inProgress: [] }
          : {
              ready: Array.isArray(described?.ready) ? described.ready : [],
              blocked: Array.isArray(described?.blocked) ? described.blocked : [],
              inProgress: Array.isArray(described?.inProgress) ? described.inProgress : [],
            }
      } catch {
        blockedState = { ready: [], blocked: [], inProgress: [] }
      }
      // 仍有 in_progress 时继续等待（含 parent 容器），勿因 blocked 子 ticket 误判 stuck
      if (blockedState.inProgress.length > 0) {
        return finish(`in-progress: ${blockedState.inProgress.length} 个工单进行中`)
      }
      if (blockedState.blocked.length > 0) {
        return finish(`stuck: ${blockedState.blocked.length} 个工单未就绪`)
      }
      return finish('all-done')
    }

    if (hooks.onQueue) hooks.onQueue(ready)

    const task = ready[0]
    attemptedIds.add(String(task.id))
    await source.markInProgress(task.id)
    const detail = await source.getDetail(task.id)
    const taskFile = join(hooks.taskDir || tmpdir(), `task-${task.id}.md`)
    writeTaskMd(detail, taskFile)
    const startHead = git.head()

    // 每任务尝试循环：attempt = 0 .. retry
    let result = null
    let lastProgressFile
    for (let attempt = 0; attempt <= config.retry; attempt++) {
      const progressFile = hooks.progressFile ? hooks.progressFile(task, attempt + 1) : undefined
      lastProgressFile = progressFile
      if (hooks.onTaskStart) {
        hooks.onTaskStart({
          id: task.id,
          title: task.title,
          priority: task.priority,
          attempt: attempt + 1,
          progressFile,
        })
      }
      let outcome
      try {
        outcome = await execReview.run(taskFile, { progressFile })
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
      result = {
        kind: decision.kind === 'noop' ? 'noop' : 'failed',
        reason: decision.reason,
        outcome,
        attempts: attempt + 1,
      }
      break
    }

    stats.attempted++
    let closedParents = []
    // no_change + 可核实的提交号 = 需求已由现有代码满足，是终态成功，不是失败。
    const satisfiedBy = result.kind === 'noop' ? findSatisfiedCommit(result.outcome, git) : null
    if (satisfiedBy) result = { ...result, kind: 'done', satisfiedBy }
    if (result.kind === 'done') {
      // satisfiedBy：成果已在历史提交里，工作区干净与否与验收无关（reset 已回滚执行端残留）
      if (!satisfiedBy && !git.isClean()) {
        git.resetHard(startHead)
        await source.markFailed(task.id, 'git: 任务通过后工作区仍有未提交改动')
        consecutiveFailures++
        stats.failed++
        const record = {
          id: task.id,
          title: task.title,
          priority: task.priority,
          kind: 'failed',
          status: result.outcome?.status,
          reason: 'git: dirty after approved',
          attempts: result.attempts,
          summary: result.outcome?.summary,
          progressFile: lastProgressFile,
        }
        tasks.push(record)
        if (hooks.onTask) hooks.onTask(record)
        await emitPipelineSnapshot(source, hooks)
        if (config.maxFailures > 0 && consecutiveFailures >= config.maxFailures) {
          return finish('circuit-broken')
        }
        continue
      }
      await source.markDone(task.id, {
        status: satisfiedBy ? 'done' : result.outcome.status,
        summary: satisfiedBy
          ? `无需改动：已由现有提交 ${satisfiedBy} 满足。${result.outcome.summary || ''}`.trim()
          : result.outcome.summary || '',
        commit: satisfiedBy || (git.head() || '').slice(0, 9),
      })
      closedParents =
        typeof source.closeEligibleParents === 'function'
          ? source.closeEligibleParents() || []
          : []
      if (closedParents.length) {
        console.error(
          `[afk-run] epic close-eligible: ${closedParents.join(', ')}`,
        )
      }
      consecutiveFailures = 0
      stats.done++
    } else if (result.kind === 'noop') {
      // 需人确认：不重试、不冒充失败（afk-failed 是退避标记，打了就再也拉不到）、不静默关单。
      stats.noop++
      consecutiveFailures = 0
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
      status: satisfiedBy ? 'done' : result.outcome?.status,
      reason: result.kind === 'noop' || result.kind === 'failed' ? result.reason : undefined,
      attempts: result.attempts,
      summary: result.outcome?.summary,
      progressFile: lastProgressFile,
      ...(satisfiedBy ? { satisfiedBy } : {}),
      ...(result.kind === 'done' && closedParents.length ? { closedParents } : {}),
    }
    tasks.push(record)
    if (hooks.onTask) hooks.onTask(record)
    await emitPipelineSnapshot(source, hooks)
    if (config.maxFailures > 0 && consecutiveFailures >= config.maxFailures) {
      return finish('circuit-broken')
    }
  }
}

// ---------- CLI 主入口 ----------

/**
 * 一批干完就往收件箱放一封信——唤醒环的源头之一。
 * 永不抛：写不成收件箱不能弄挂 loop。
 * 一批一个事件（不是一单一个），因为人要做的决定是「这批行不行」。
 */
export function inboxPayloadForRun({ requirement, sourceName, workdir, result, runDir, reportFile, progressFile, serveUrl, error, home }) {
  const tasks = result?.tasks || []
  const workItems = tasks.map((task) => ({ taskSource: sourceName, id: task.id })).filter((item) => item.id)
  const routed = resolveEventRequirement({ home, explicit: requirement, workItems })
  const done = result?.stats?.done || 0
  const failed = result?.stats?.failed || 0
  const noop = result?.stats?.noop || 0
  const failedTasks = tasks
    .filter((task) => task.kind === 'failed')
    .map((task) => ({ id: task.id, title: task.title, reason: task.reason || task.summary || '' }))
  const noopTasks = tasks
    .filter((task) => task.kind === 'noop')
    .map((task) => ({ id: task.id, title: task.title, reason: task.reason || task.summary || '' }))
  const crashed = Boolean(error)

  return {
    kind: crashed ? 'run-error' : 'run-end',
    requirementId: routed?.requirementId ?? null,
    workdir,
    workItems,
    title: crashed
      ? `执行链异常退出：${error}`
      : `一批干完：${done} 完成 / ${failed} 失败${noop ? ` / ${noop} 无需改动` : ''}`,
    detail: {
      reason: result?.reason || (crashed ? 'error' : ''),
      attempted: result?.stats?.attempted || 0,
      done,
      failed,
      noop,
      runDir,
      reportFile: reportFile || '',
      progressFile: progressFile || '',
      serveUrl: serveUrl || '',
      failedTasks,
      noopTasks,
      ...(crashed ? { error } : {}),
    },
    nextStep:
      crashed || failed > 0
        ? '看失败原因，判断是修 bug 还是重开一单'
        : noop > 0
          ? '看「无需改动」的工单：确认需求是否已满足，清掉 in-progress 重新武装'
          : '读报告，出验收清单（准备到只差人点）',
  }
}

function usage(code = 1) {
  const text = `用法:
  node loop.mjs --workdir <目录> [--source beads|gh] [--repo owner/name]
    [--max-tasks <N>] [--max-failures <N>] [--retry <N>]
    [--stop-file <路径>] [--allow-dirty] [--pinned-id <id>]
    [--use-bot-identity] [--no-bot-identity]
    [--git-name <名>] [--git-email <邮箱>]
    [--config <~/.afk/config.json>] [--cache-dir <目录>] [--dry-run]
    [--requirement <需求 id>]
    [--no-serve] [--no-open] [--port <端口>]
    透传 exec-review: [--timeout <秒>] [--runner <codex|pi>]
    [--executor-runner <…>] [--reviewer-runner <…>]
    [--executor-model <…>] [--reviewer-model <…>]
    [--executor-thinking <…>] [--reviewer-thinking <…>]
    [--hard-timeout-extra <秒>]

--workdir 必传（由调用方/Agent 传入）；其余默认来自 ~/.afk/<项目名_UID>/config.json（回落 ~/.afk/config.json）的 task / run / execReview 分区与内置。
优先级：CLI > env > config > 内置。`
  console.error(text)
  process.exit(code)
}

function parseArgs(argv) {
  const out = {
    workdir: '',
    source: '',
    repo: '',
    maxTasks: 0,
    maxFailures: 0,
    retry: 0,
    stopFile: '',
    allowDirty: false,
    pinnedIds: [],
    useBotIdentity: null,
    gitName: '',
    gitEmail: '',
    configPath: '',
    cacheDir: '',
    dryRun: false,
    requirement: '',
    timeout: 0,
    runner: '',
    executorRunner: '',
    reviewerRunner: '',
    executorModel: '',
    reviewerModel: '',
    executorThinking: '',
    reviewerThinking: '',
    hardTimeoutExtra: 0,
    serve: null,
    open: null,
    port: 0,
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
      case '--stop-file':
        out.stopFile = next()
        break
      case '--allow-dirty':
        out.allowDirty = true
        break
      case '--pinned-id':
        out.pinnedIds.push(String(next()))
        break
      case '--use-bot-identity':
        out.useBotIdentity = true
        break
      case '--no-bot-identity':
        out.useBotIdentity = false
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
      case '--requirement':
        out.requirement = next()
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
      case '--no-serve':
        out.serve = false
        break
      case '--no-open':
        out.open = false
        break
      case '--port':
        out.port = Math.max(0, Number(next()) || 0)
        break
      default:
        console.error(`未知参数: ${a}`)
        usage()
    }
  }
  return out
}

/**
 * 用户级配置：~/.afk/<项目名_UID>/config.json 覆盖 ~/.afk/config.json。
 * 本技能读两个分区：`task`（与 afk-watch 共用）+ `run`（自己的）；
 * 配置必须存在（requireAfkSections），缺了就报错，不用内置兜底。
 */
export function resolveRunConfigPath(workdir, configPath) {
  const { files } = resolveAfkConfigFiles(workdir, configPath)
  return files.length ? files[files.length - 1] : null
}

export function loadConfig({ configPath = '', workdir = '' } = {}) {
  const defaults = {
    task: {
      source: 'beads',
      repo: '',
      maxTasks: 0,
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
    run: {
      hardTimeoutExtra: 120,
      git: {
        useBotIdentity: false,
        name: 'AFK Bot',
        email: 'afk@local',
      },
      serve: {
        enabled: true,
        port: 0,
        open: false,
      },
      // staleThresholdSec 故意不在此处：缺省时由 timeout 推导（见 main）
    },
    execReview: {
      timeout: 600,
    },
  }
  const { files, sections } = requireAfkSections(
    workdir,
    ['task', 'run', 'execReview'],
    configPath,
  )
  return {
    cfg: {
      task: deepMerge(defaults.task, sections.task),
      run: deepMerge(defaults.run, sections.run),
      execReview: deepMerge(defaults.execReview, sections.execReview),
    },
    files,
    path: files.length ? files[files.length - 1] : null,
  }
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

/** 在首次 listReady 前执行一次可选 stale 恢复；错误保留为启动失败。 */
export async function recoverAndRunLoop(deps, now = Date.now) {
  const thresholdSec = Number(deps.config?.staleThresholdSec)
  if (Number.isFinite(thresholdSec) && thresholdSec > 0 && typeof deps.source.recoverStale === 'function') {
    await deps.source.recoverStale(thresholdSec, now)
  }
  if (typeof deps.beforeRun === 'function') await deps.beforeRun()
  return runLoop(deps)
}

function hashStr(s) {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return h
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
    // URL 会包含在摘要中，浏览器打开失败时仍可手动访问。
  }
}

function serveRegistryPath(cacheRoot, workdir) {
  return join(cacheRoot, `serve-${hashStr(workdir)}.json`)
}

/** 同一 workdir 只允许一个 loop 进程；注册表与 serve 分开存放。 */
export function loopRegistryPath(cacheRoot, workdir) {
  return join(cacheRoot, `loop-${hashStr(workdir)}.json`)
}

function readLoopRegistry(registryPath) {
  if (!existsSync(registryPath)) return null
  try {
    return JSON.parse(readFileSync(registryPath, 'utf8'))
  } catch {
    return null
  }
}

function sleepMs(ms) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    // 等待旧 loop 进程树退出，避免与新 loop 争用 git 工作区。
  }
}

function killPid(pid, { tree = false } = {}) {
  if (!pid || Number(pid) <= 0 || Number(pid) === process.pid) return
  try {
    if (process.platform === 'win32') {
      const args = ['/PID', String(pid), '/F']
      if (tree) args.push('/T')
      execFileSync('taskkill', args, {
        stdio: 'ignore',
        windowsHide: true,
      })
      return
    }
    if (tree) {
      try {
        execFileSync('pkill', ['-P', String(pid)], { stdio: 'ignore' })
      } catch {
        // 无子进程或 pkill 不可用。
      }
    }
    process.kill(Number(pid), 'SIGTERM')
  } catch {
    // 旧进程可能已退出；忽略。
  }
}

/**
 * 停止同一 workdir 上一次注册的 loop 及其看板。
 * @returns {{ killed: boolean, previousPid: number|null }}
 */
export function stopRegisteredLoop(cacheRoot, workdir) {
  const registryPath = loopRegistryPath(cacheRoot, workdir)
  const previous = readLoopRegistry(registryPath)
  if (!previous?.pid || previous.pid === process.pid) {
    try {
      unlinkSync(registryPath)
    } catch {
      // ignore
    }
    return { killed: false, previousPid: null }
  }
  const previousPid = previous.pid
  killPid(previousPid, { tree: true })
  stopRegisteredServe(cacheRoot, workdir)
  try {
    unlinkSync(registryPath)
  } catch {
    // ignore
  }
  return { killed: true, previousPid }
}

/** 当前进程是否仍是 workdir 的注册 loop 实例。 */
export function isActiveLoopInstance(cacheRoot, workdir, pid = process.pid) {
  const current = readLoopRegistry(loopRegistryPath(cacheRoot, workdir))
  return current?.pid === pid
}

/** 仅当注册 pid 匹配时移除 loop 注册表。 */
export function releaseLoopInstance(cacheRoot, workdir, pid = process.pid) {
  const registryPath = loopRegistryPath(cacheRoot, workdir)
  const current = readLoopRegistry(registryPath)
  if (current?.pid !== pid) return false
  try {
    unlinkSync(registryPath)
    return true
  } catch {
    return false
  }
}

/**
 * 声明 workdir 单实例：kill 旧 loop → 注册当前 pid → 安装退出清理。
 * @returns {{ killed: boolean, previousPid: number|null }}
 */
export function claimLoopInstance(cacheRoot, workdir, runDir) {
  mkdirSync(cacheRoot, { recursive: true })
  const stopped = stopRegisteredLoop(cacheRoot, workdir)
  if (stopped.killed) {
    sleepMs(300)
    console.error(`[afk-run] 已终止 workdir 上一 loop (pid=${stopped.previousPid})`)
  }
  writeFileSync(
    loopRegistryPath(cacheRoot, workdir),
    JSON.stringify({
      pid: process.pid,
      workdir,
      runDir,
      startedAt: Date.now(),
    }) + '\n',
    'utf8',
  )
  const release = () => releaseLoopInstance(cacheRoot, workdir, process.pid)
  process.on('exit', release)
  const onSignal = (code) => {
    release()
    process.exit(code)
  }
  process.once('SIGINT', () => onSignal(130))
  process.once('SIGTERM', () => onSignal(143))
  return stopped
}

/** 停止同一 workdir 上一次 loop 注册的看板进程，避免固定端口展示陈旧终态。 */
function stopRegisteredServe(cacheRoot, workdir) {
  const registryPath = serveRegistryPath(cacheRoot, workdir)
  if (!existsSync(registryPath)) return
  try {
    const previous = JSON.parse(readFileSync(registryPath, 'utf8'))
    if (previous?.pid) killPid(previous.pid)
  } catch {
    // 注册表损坏时继续启动新看板。
  }
  try {
    unlinkSync(registryPath)
  } catch {
    // ignore
  }
}

function startLoopServe(runDir, port, open, cacheRoot, workdir) {
  stopRegisteredServe(cacheRoot, workdir)
  const child = spawn(process.execPath, [LOOP_SERVE_PATH, runDir, String(port)], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()
  try {
    writeFileSync(
      serveRegistryPath(cacheRoot, workdir),
      JSON.stringify({
        pid: child.pid,
        port,
        runDir,
        startedAt: Date.now(),
      }) + '\n',
      'utf8',
    )
  } catch {
    // 看板仍可用；只是下次可能需手动刷新端口。
  }
  const runLabel = runDir.split(/[/\\]/).pop() || runDir
  const url = `http://127.0.0.1:${port}/`
  console.error(`\nafk-run 实时看板（可随时打开）: ${url}`)
  console.error(`afk-run 当前 run: ${runLabel}\n`)
  if (open) setTimeout(() => openUrl(url), 600)
  return url
}

export function writeReport(runDir, result, startedAt, workdir) {
  const lines = [
    `# AFK 运行报告 ${localTimestamp(startedAt)}`,
    '',
    `- workdir: ${workdir}`,
    `- 停止原因: ${result.reason}`,
    `- 尝试任务: ${result.stats.attempted} | 完成: ${result.stats.done} | 无需改动: ${result.stats.noop || 0} | 失败: ${result.stats.failed}`,
    '',
  ]
  const doneRows = result.tasks.filter((t) => t.kind === 'done')
  const noopRows = result.tasks.filter((t) => t.kind === 'noop')
  const failedRows = result.tasks.filter((t) => t.kind === 'failed')
  if (doneRows.length) {
    lines.push('## 完成', '', '| id | 标题 | 状态 | 尝试次数 |', '|---|---|---|---|')
    for (const t of doneRows) {
      lines.push(
        `| ${t.id} | ${t.title} | ${t.status}${t.satisfiedBy ? `（已由 ${t.satisfiedBy} 满足）` : ''} | ${t.attempts} |`,
      )
    }
    lines.push('')
  }
  if (noopRows.length) {
    lines.push(
      '## 无需改动（需人确认，不计失败）',
      '',
      '执行端判定无需改代码，但没给出可核实的提交号：既不算失败（不打 `afk-failed`），也不静默关单。',
      '',
      '| id | 标题 | 说明 |',
      '|---|---|---|',
    )
    for (const t of noopRows) {
      lines.push(`| ${t.id} | ${t.title} | ${t.reason || t.summary || ''} |`)
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
  if (result.reason.startsWith('in-progress')) {
    lines.push('## 进行中', '', '没有可拉取的就绪工单；已有工单仍在进行中。', '')
    if (noopRows.length) {
      lines.push(
        `其中 ${noopRows.length} 个是上面「无需改动」的工单：它们仍被认领，人工确认后清掉 in-progress 才会重新进入队列。`,
        '',
      )
    }
  }
  const reportFile = join(runDir, 'report.md')
  writeFileSync(reportFile, lines.join('\n'), 'utf8')
  return reportFile
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.workdir) {
    console.error('workdir 必传：--workdir <目录>（由调用方/Agent 传入，不支持配置默认）')
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

  const sourceName = args.source || cfg.task.source || 'beads'
  const repo = args.repo || cfg.task.repo || ''
  const stopFile = resolve(args.stopFile || cfg.task.stopFile || join(workdir, DEFAULT_STOP_FILE))
  const useBotIdentity =
    args.useBotIdentity ??
    cfg.run.git.useBotIdentity ??
    false
  const gitIdentity = {
    useBotIdentity,
    name: args.gitName || cfg.run.git.name || 'AFK Bot',
    email: args.gitEmail || cfg.run.git.email || 'afk@local',
  }
  // CLI 覆盖照旧透传给 exec-review；配置文件里的引擎设置由 exec-review 自己读同一分区
  const execCfg = {
    runner: args.runner,
    executorRunner: args.executorRunner,
    reviewerRunner: args.reviewerRunner,
    executorModel: args.executorModel,
    reviewerModel: args.reviewerModel,
    executorThinking: args.executorThinking,
    reviewerThinking: args.reviewerThinking,
    timeout: args.timeout || cfg.execReview.timeout || 0,
    hardTimeoutExtra: args.hardTimeoutExtra || cfg.run.hardTimeoutExtra || 120,
  }
  const configuredStaleThreshold = Number(cfg.run.staleThresholdSec)
  const staleThresholdSec = Number.isFinite(configuredStaleThreshold)
    ? Math.max(0, configuredStaleThreshold)
    : Number(execCfg.timeout) > 0
      ? 2 * (Number(execCfg.timeout) + Number(execCfg.hardTimeoutExtra))
      : 0
  const allowDirty = args.allowDirty || cfg.task.allowDirty || false
  const serveEnabled = args.serve ?? cfg.run.serve.enabled
  const servePort = args.port || cfg.run.serve.port || 8700 + (hashStr(workdir) % 1000)
  const serveOpen = args.open ?? cfg.run.serve.open

  const cacheRoot = resolve(args.cacheDir || join(tmpdir(), 'afk-run'))
  const runDir = join(cacheRoot, uniqueDir(cacheRoot, `run-${localTimestamp()}`))
  mkdirSync(runDir, { recursive: true })

  // 装配真实依赖（workdir 闭包绑定）
  const git = {
    head: () => gitModule.head(workdir),
    isClean: () => gitModule.isClean(workdir),
    resetHard: (headRef) => gitModule.resetHard(workdir, headRef, DEFAULT_STOP_FILE),
    isAncestor: (ref) => gitModule.isAncestor(workdir, ref),
  }
  const source = createSource(sourceName, {
    cwd: workdir,
    ...(repo ? { repo } : {}),
    ...(cfg.task.tapd ? { tapd: cfg.task.tapd } : {}),
  })
  const execReview = createExecReview(workdir, execCfg)
  const loopProgressFile = join(runDir, 'loop-progress.jsonl')
  const emitLoopEvent = (event, data = {}) =>
    appendFileSync(loopProgressFile, JSON.stringify({ t: Date.now(), event, ...data }) + '\n', 'utf8')
  const serveUrl = serveEnabled ? `http://127.0.0.1:${servePort}/` : ''
  const hooks = {
    taskDir: runDir,
    progressFile: (task, attempt) => join(runDir, `task-${String(task.id).replace(/[^a-zA-Z0-9._-]/g, '_')}-${attempt}.progress.jsonl`),
    onQueue: (tasks) => emitLoopEvent('queue_update', { tasks }),
    onPipeline: (pipeline) => emitLoopEvent('pipeline_snapshot', pipeline),
    onTaskStart: (task) => emitLoopEvent('task_start', task),
    onTask: (record) => emitLoopEvent('task_end', record),
  }
  const config = {
    stopFile,
    maxTasks: args.maxTasks || cfg.task.maxTasks || 0,
    maxFailures: args.maxFailures || cfg.task.maxFailures || 0,
    retry: args.retry || cfg.task.retry || 0,
    staleThresholdSec,
    pinnedIds: args.pinnedIds,
  }

  // 启动校验：强制 git + 干净工作区（dry-run 跳过实际执行，但保证可验证装配）
  if (args.dryRun) {
    process.stdout.write(JSON.stringify({ dryRun: true, workdir, source: sourceName, stopFile, staleThresholdSec, runDir, execCfg, serveUrl }, null, 2) + '\n')
    return
  }
  const loopClaim = claimLoopInstance(cacheRoot, workdir, runDir)
  gitModule.ensureGit(workdir, gitIdentity)
  if (loopClaim.killed && !gitModule.isClean(workdir)) {
    console.error('[afk-run] 上一 loop 中断后工作区未净，重置到 HEAD')
    gitModule.resetHard(workdir, gitModule.head(workdir), DEFAULT_STOP_FILE)
  }
  if (!gitModule.isClean(workdir) && !allowDirty) {
    releaseLoopInstance(cacheRoot, workdir, process.pid)
    console.error(
      `工作区有未提交改动（${workdir}）。失败回滚会重置这些改动；请先提交/stash，或 --allow-dirty 显式放行。`,
    )
    process.exit(2)
  }

  const startedAt = new Date()
  emitLoopEvent('loop_start', {
    workdir,
    runDir,
    source: sourceName,
    stopFile,
    maxTasks: config.maxTasks,
    maxFailures: config.maxFailures,
    retry: config.retry,
    serveUrl,
  })
  recoverAndRunLoop({
    config,
    source,
    execReview,
    git,
    hooks,
    isActive: () => isActiveLoopInstance(cacheRoot, workdir),
    beforeRun: () => {
      if (serveEnabled) startLoopServe(runDir, servePort, serveOpen, cacheRoot, workdir)
    },
  })
    .then((result) => {
      const reportFile = writeReport(runDir, result, startedAt, workdir)
      emitLoopEvent('loop_end', { reason: result.reason, reportFile })
      releaseLoopInstance(cacheRoot, workdir, process.pid)
      emitInboxEvent(
        inboxPayloadForRun({
          requirement: args.requirement,
          sourceName,
          workdir,
          result,
          runDir,
          reportFile,
          progressFile: loopProgressFile,
          serveUrl,
        }),
        { log: (line) => console.error(line) },
      )
      const summary = {
        reason: result.reason,
        attempted: result.stats.attempted,
        done: result.stats.done,
        noop: result.stats.noop,
        failed: result.stats.failed,
        runDir,
        reportFile,
        progressFile: loopProgressFile,
        serveUrl,
      }
      process.stdout.write(JSON.stringify(summary, null, 2) + '\n')
    })
    .catch((err) => {
      emitInboxEvent(
        inboxPayloadForRun({ requirement: args.requirement, sourceName, workdir, runDir, error: err.message }),
        { log: (line) => console.error(line) },
      )
      releaseLoopInstance(cacheRoot, workdir, process.pid)
      console.error(`loop 异常: ${err.stack || err}`)
      process.exit(1)
    })
}

// 入口守卫：用 realpath 比较，避免技能目录是 junction/symlink 时路径字符串不等导致 main() 被跳过
if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  main()
}
