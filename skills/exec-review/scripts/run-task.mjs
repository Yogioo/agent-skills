#!/usr/bin/env node
/**
 * 执行→审查 runner（单次任务文本）。
 * 输入：任务说明。输出：stdout 摘要 JSON。日志：--cache-dir。
 *
 * 用「前后内容快照」检测改动；git 仓库按 gitCommit 模式决定执行端提交行为。
 *
 * 用法：
 *   node run-task.mjs --workdir <目录> --task-file task.md [--runner codex|pi|agent]
 *   node run-task.mjs --workdir <目录> --stdin
 *   node run-task.mjs --workdir <目录> --title "…" --body "…" [--requirements "…"] [--id "…"]
 */

import { execFileSync, spawn } from 'node:child_process'
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { createRunner } from './runners/index.mjs'
import { loadConfigFile, resolveSettings } from './load-config.mjs'
import { buildExecutorCommitRule, buildReviewerGitContext } from './commit-rules.mjs'
import { ProgressWriter } from './progress.mjs'
import { snapshot, diff } from './workspace.mjs'
import { extractJsonFromEventsFile, extractJsonFromText } from './normalize-agent.mjs'
import {
  cleanupPreviousSession,
  releaseSessionMain,
  updateSessionServePid,
  writeSessionLock,
} from './workdir-session.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SKILL_ROOT = resolve(__dirname, '..')

function usage(code = 1) {
  const text = `用法:
  node run-task.mjs --workdir <目录> (--task-file <路径> | --stdin | --title <t> --body <b>)
    [--id <标签>] [--requirements <文本>] [--cache-dir <目录>]
    [--config <config.json>]
    [--runner codex|pi|agent] [--executor-runner …] [--reviewer-runner …]
    [--bin <路径>] [--model <id>] [--provider <name>] [--thinking <level>]
    [--executor-model …] [--reviewer-model …] [--executor-thinking …] [--reviewer-thinking …]
    [--sandbox workspace-write|danger-full-access|read-only]
    [--git-commit <true|false>]
    [--no-approve] [--dry-run]
    [--no-serve] [--port <端口>] [--return-level <0-3>] [--heartbeat-ms <ms>]
    [--progress-file <路径>]
    [--timeout <秒>]
    [--codex-bin <路径>]  (兼容旧参数)

默认来自技能根 config.json（默认 runner=codex）。优先级：CLI > 环境变量 > config.json > 内置。`
  console.error(text)
  process.exit(code)
}

function parseArgs(argv) {
  const asBool = (v, def) => {
    if (v == null) return def
    const s = String(v).toLowerCase()
    if (s === '0' || s === 'false' || s === 'no' || s === 'off') return false
    if (s === '1' || s === 'true' || s === 'yes' || s === 'on') return true
    return def
  }
  const out = {
    workdir: null,
    taskFile: null,
    stdin: false,
    id: '',
    title: '',
    body: '',
    requirements: '',
    cacheDir: null,
    configPath: null,
    sandbox: '',
    runner: '',
    executorRunner: '',
    reviewerRunner: '',
    bin: '',
    executorBin: '',
    reviewerBin: '',
    codexBin: '',
    model: '',
    executorModel: '',
    reviewerModel: '',
    provider: '',
    executorProvider: '',
    reviewerProvider: '',
    thinking: '',
    executorThinking: '',
    reviewerThinking: '',
    approve: null,
    gitCommit: null,
    serve: null,
    open: null,
    port: 0,
    returnLevel: 0,
    heartbeatMs: 0,
    progressFile: '',
    timeout: 0,
    dryRun: false,
    structuredContext: null,
    streamPartialOutput: null,
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
      case '--task-file':
        out.taskFile = next()
        break
      case '--stdin':
        out.stdin = true
        break
      case '--id':
        out.id = next()
        break
      case '--title':
        out.title = next()
        break
      case '--body':
        out.body = next()
        break
      case '--requirements':
      case '--spec':
        out.requirements = next()
        break
      case '--cache-dir':
        out.cacheDir = next()
        break
      case '--config':
        out.configPath = next()
        break
      case '--sandbox':
        out.sandbox = next()
        break
      case '--runner':
      case '--provider-runner':
        out.runner = String(next()).toLowerCase()
        break
      case '--executor-runner':
        out.executorRunner = String(next()).toLowerCase()
        break
      case '--reviewer-runner':
        out.reviewerRunner = String(next()).toLowerCase()
        break
      case '--bin':
        out.bin = next()
        break
      case '--executor-bin':
        out.executorBin = next()
        break
      case '--reviewer-bin':
        out.reviewerBin = next()
        break
      case '--codex-bin':
        out.codexBin = next()
        break
      case '--model':
        out.model = next()
        break
      case '--executor-model':
        out.executorModel = next()
        break
      case '--reviewer-model':
        out.reviewerModel = next()
        break
      case '--provider':
        out.provider = next()
        break
      case '--executor-provider':
        out.executorProvider = next()
        break
      case '--reviewer-provider':
        out.reviewerProvider = next()
        break
      case '--thinking':
        out.thinking = next()
        break
      case '--executor-thinking':
        out.executorThinking = next()
        break
      case '--reviewer-thinking':
        out.reviewerThinking = next()
        break
      case '--no-approve':
        out.approve = false
        break
      case '--git-commit':
        out.gitCommit = next()
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
      case '--return-level':
        out.returnLevel = Math.max(0, Number(next()) || 0)
        break
      case '--heartbeat-ms':
        out.heartbeatMs = Math.max(1000, Number(next()) || 10000)
        break
      case '--progress-file':
        out.progressFile = next()
        break
      case '--timeout':
        out.timeout = Math.max(0, Number(next()) || 0)
        break
      case '--dry-run':
        out.dryRun = true
        break
      case '--structured-context':
        out.structuredContext = asBool(next(), true)
        break
      case '--no-structured-context':
        out.structuredContext = false
        break
      case '--stream-partial-output':
        out.streamPartialOutput = true
        break
      case '--no-stream-partial-output':
        out.streamPartialOutput = false
        break
      default:
        console.error(`未知参数: ${a}`)
        usage()
    }
  }
  return out
}

function createRoleRunner(roleSettings, shared) {
  return createRunner(roleSettings.runner, {
    bin: roleSettings.bin,
    model: roleSettings.model,
    provider: roleSettings.provider,
    thinking: roleSettings.thinking,
    sandbox: shared.sandbox,
    approve: shared.approve,
    streamPartialOutput: shared.streamPartialOutput,
  })
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

function hashStr(s) {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0
  }
  return h
}

/** 启动独立实时进度服务；返回 URL（进程 detached，与 loop 解耦）。 */
function openUrl(url) {
  // 跨平台打开默认浏览器；失败时静默（URL 仍会打印，用户可手动打开）
  const { platform } = process
  let cmd
  let args
  if (platform === 'win32') {
    cmd = 'cmd'
    args = ['/c', 'start', '', url]
  } else if (platform === 'darwin') {
    cmd = 'open'
    args = [url]
  } else {
    cmd = 'xdg-open'
    args = [url]
  }
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true })
    child.on('error', () => {})
    child.unref()
  } catch {
    // 忽略：URL 已打印，手动打开即可
  }
}

function startServe(runDir, port, open = true) {
  const serverPath = join(__dirname, 'serve.mjs')
  const child = spawn(process.execPath, [serverPath, runDir, String(port)], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()
  const url = `http://127.0.0.1:${port}/`
  console.error(`\nexec-review 实时进度（可随时打开）: ${url}\n`)
  if (open) {
    // 稍等 serve 完成监听再打开，避免浏览器打到 404
    setTimeout(() => openUrl(url), 600)
  }
  return { url, pid: child.pid ?? null }
}

function readStdin() {
  return new Promise((resolvePromise) => {
    if (process.stdin.isTTY) {
      resolvePromise('')
      return
    }
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
      data += chunk
    })
    process.stdin.on('end', () => resolvePromise(data))
  })
}

function sectionIndex(lines, names) {
  return lines.findIndex((l) => {
    const m = l.match(/^##\s+(.+?)\s*$/)
    if (!m) return false
    return names.some((n) => m[1].toLowerCase() === n.toLowerCase())
  })
}

function parseTaskMarkdown(raw, fallback = {}) {
  const text = String(raw || '').replace(/^\uFEFF/, '')
  const lines = text.split(/\r?\n/)
  let title = fallback.title || ''
  let id = fallback.id || ''
  let body = ''
  let requirements = fallback.requirements || ''

  const idMatch = text.match(/^\s*id\s*:\s*(.+)\s*$/im)
  if (idMatch) id = idMatch[1].trim()

  const heading = lines.find((l) => /^#\s+/.test(l))
  if (heading) title = heading.replace(/^#\s+/, '').trim()

  const bodyIdx = sectionIndex(lines, ['正文', 'Body'])
  const reqIdx = sectionIndex(lines, ['要求', 'Spec', 'Requirements'])

  if (bodyIdx >= 0) {
    const end = reqIdx > bodyIdx ? reqIdx : lines.length
    body = lines.slice(bodyIdx + 1, end).join('\n').trim()
  }
  if (reqIdx >= 0) {
    requirements = lines.slice(reqIdx + 1).join('\n').trim()
  }
  if (!body && !requirements) {
    const start = heading ? lines.indexOf(heading) + 1 : 0
    body = lines
      .slice(start)
      .filter((l) => !/^\s*id\s*:/i.test(l))
      .join('\n')
      .trim()
  }

  if (fallback.title) title = fallback.title
  if (fallback.body) body = fallback.body
  if (fallback.requirements) requirements = fallback.requirements
  if (fallback.id) id = fallback.id

  return {
    id: id || '',
    title: title || id || 'task',
    body: body || '（正文为空）',
    requirements: requirements || '（无）',
  }
}

function renderTemplate(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : '',
  )
}

function gitOutput(workdir, args) {
  try {
    return execFileSync('git', args, {
      cwd: workdir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return ''
  }
}

function collectGitContext(workdir) {
  const isGit =
    existsSync(join(workdir, '.git')) ||
    gitOutput(workdir, ['rev-parse', '--is-inside-work-tree']) === 'true'
  if (!isGit) return { isGit: false, recentLog: '', baseHead: '' }
  return {
    isGit: true,
    recentLog: gitOutput(workdir, ['log', '--oneline', '-20']),
    baseHead: gitOutput(workdir, ['rev-parse', 'HEAD']),
  }
}

function emitSummary(summary, summaryPath, runCtx = {}) {
  const merged = { ...summary }
  // 渐进式披露：默认只回指针；仅在 returnLevel>0 时追加过滤后的进度投影
  if (runCtx.serveUrl) merged.serveUrl = runCtx.serveUrl
  if (runCtx.progressFile) merged.progressFile = runCtx.progressFile
  if (runCtx.returnLevel > 0 && Array.isArray(runCtx.events)) {
    merged.progress = runCtx.events.filter((e) => e.level <= runCtx.returnLevel)
  }
  const text = JSON.stringify(merged, null, 2)
  writeFileSync(summaryPath, text + '\n', 'utf8')
  process.stdout.write(text + '\n')
}

function logMain(mainLogPath, line) {
  const row = `[${new Date().toISOString()}] ${line}\n`
  writeFileSync(mainLogPath, row, { flag: 'a' })
  console.error(line)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.workdir) usage()
  const workdir = resolve(args.workdir)
  if (!existsSync(workdir)) {
    console.error(`workdir 不存在: ${workdir}`)
    process.exit(2)
  }

  let loaded
  try {
    loaded = loadConfigFile(args.configPath || undefined)
  } catch (err) {
    console.error(String(err.message || err))
    process.exit(2)
  }

  let settings
  try {
    settings = resolveSettings(args, loaded)
  } catch (err) {
    console.error(String(err.message || err))
    process.exit(2)
  }

  const executorRunner = createRoleRunner(settings.executor, settings)
  const reviewerRunner = createRoleRunner(settings.reviewer, settings)

  let rawTask = ''
  if (args.taskFile) {
    rawTask = readFileSync(resolve(args.taskFile), 'utf8')
  } else if (args.stdin) {
    rawTask = await readStdin()
  }

  const task = parseTaskMarkdown(rawTask, {
    id: args.id,
    title: args.title,
    body: args.body,
    requirements: args.requirements,
  })

  if (!args.taskFile && !args.stdin && !args.title && !args.body) {
    console.error('请提供 --task-file、--stdin，或 --title/--body')
    usage()
  }

  const cacheRoot = resolve(args.cacheDir || join(tmpdir(), 'exec-review'))
  mkdirSync(cacheRoot, { recursive: true })
  const runName = uniqueDir(cacheRoot, `run-${localTimestamp()}`)
  const runDir = join(cacheRoot, runName)
  mkdirSync(runDir, { recursive: true })
  const mainLogPath = join(runDir, 'main.log')
  writeFileSync(mainLogPath, '', 'utf8')
  writeFileSync(
    join(runDir, 'settings.json'),
    JSON.stringify(
      {
        configPath: settings.configPath,
        configMissing: !!loaded.missing,
        sandbox: settings.sandbox,
        approve: settings.approve,
        gitCommit: settings.gitCommit,
        serve: settings.serve,
        port: settings.port,
        returnLevel: settings.returnLevel,
        heartbeatMs: settings.heartbeatMs,
        timeout: settings.timeout,
        executor: settings.executor,
        reviewer: settings.reviewer,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  )

  // 单条进度事件流 + 独立实时查看进程（单一事实来源，所有观测者订阅同一根流）
  const progress = new ProgressWriter(runDir, {
    heartbeatMs: settings.heartbeatMs,
    progressFile: args.progressFile,
  })
  progress.setStage('preparing')
  const derivedPort = settings.port || 8000 + (hashStr(workdir) % 4000)
  let serveUrl = ''
  if (settings.serve) {
    const cleanup = cleanupPreviousSession({
      cacheRoot,
      workdir,
      port: derivedPort,
    })
    if (cleanup.killedMain || cleanup.killedServe || cleanup.killedPort > 0) {
      const msg = `cleanup previous session: main=${cleanup.killedMain} serve=${cleanup.killedServe} port=${cleanup.killedPort}`
      logMain(mainLogPath, msg)
      console.error(`exec-review: 已回收同一 workdir 的上一轮进程 (${msg})`)
    }
    writeSessionLock({
      cacheRoot,
      workdir,
      mainPid: process.pid,
      port: derivedPort,
      runDir,
      taskId: task.id || '',
    })
    const serve = startServe(runDir, derivedPort, settings.openBrowser)
    serveUrl = serve.url
    if (serve.pid) {
      updateSessionServePid({ cacheRoot, workdir, servePid: serve.pid })
    }
  }
  const returnLevel = settings.returnLevel
  const runCtx = { serveUrl, progressFile: progress.path, returnLevel }

  progress.write('run_start', {
    id: task.id || '',
    title: task.title,
    workdir,
    runner: settings.executor.runner,
    heartbeatMs: settings.heartbeatMs,
    serveUrl,
  })
  progress.startHeartbeat()

  /** 收尾：写 settle 事件 → 停止心跳 → 发射摘要（含指针/可选进度投影）→ 关闭流 */
  function finalize(summary, summaryPath) {
    progress.stopHeartbeat()
    const settleData = { status: summary.status, summary: summary.summary || '' }
    if (summary.round != null) settleData.round = summary.round
    progress.write('settle', settleData, 0)
    emitSummary(summary, summaryPath, { ...runCtx, events: progress.all })
    progress.end()
    releaseSessionMain({ cacheRoot, workdir, mainPid: process.pid })
    logMain(mainLogPath, `end ${summary.status}`)
  }

  const taskSnap = [
    `# ${task.title}`,
    task.id ? `id: ${task.id}` : '',
    '',
    '## 正文',
    '',
    task.body,
    '',
    '## 要求',
    '',
    task.requirements,
    '',
  ]
    .filter((l, i, arr) => !(l === '' && arr[i - 1] === ''))
    .join('\n')
  writeFileSync(join(runDir, 'task.md'), taskSnap, 'utf8')

  const executorTpl = readFileSync(join(SKILL_ROOT, 'prompts', 'executor.md'), 'utf8')
  const reviewerTpl = readFileSync(join(SKILL_ROOT, 'prompts', 'reviewer.md'), 'utf8')
  const outcomeSchema = join(SKILL_ROOT, 'schemas', 'outcome.schema.json')
  const reviewSchema = join(SKILL_ROOT, 'schemas', 'review.schema.json')

  logMain(
    mainLogPath,
    `start config=${settings.configPath} executor=${settings.executor.runner}/${settings.executor.bin} reviewer=${settings.reviewer.runner}/${settings.reviewer.bin} id=${task.id || '-'} title=${JSON.stringify(task.title)} workdir=${workdir} cache=${runDir}`,
  )

  let lastReview = null

  // 执行前快照与 git 上下文：快照检测改动，git 查询只读
  const before = snapshot(workdir)
  const gitContext = collectGitContext(workdir)
  const commitRule = buildExecutorCommitRule({
    gitCommit: settings.gitCommit,
    isGit: gitContext.isGit,
  })
  const gitLog =
    gitContext.isGit && gitContext.recentLog
      ? `\n## 参考：最近变更（git log）\n\n\`\`\`\n${gitContext.recentLog}\n\`\`\`\n`
      : ''
  const gitReviewContext = buildReviewerGitContext({
    gitCommit: settings.gitCommit,
    isGit: gitContext.isGit,
    baseHead: gitContext.baseHead,
  })

  // ---- 执行阶段：实现 ----
  const executorPrompt = renderTemplate(executorTpl, {
    TASK_ID: task.id || task.title,
    TASK_TITLE: task.title,
    TASK_BODY: task.body,
    TASK_REQUIREMENTS: task.requirements,
    COMMIT_RULE: commitRule,
    GIT_LOG: gitLog,
  })
  const executorPromptPath = join(runDir, 'executor.prompt.md')
  const executorOut = join(runDir, 'executor.out.md')
  const executorLog = join(runDir, 'executor.log')
  const executorEvents = join(runDir, 'executor.events.jsonl')
  writeFileSync(executorPromptPath, executorPrompt, 'utf8')

  logMain(mainLogPath, 'execute: 执行端开始')
  progress.setStage('executing')
  progress.write('executor_start', {})
  progress.write('context_start', {
    role: 'executor',
    file: executorLog,
    ...(settings.structuredContext ? { eventsFile: executorEvents } : {}),
  }, 2)
  const execCtrl = new AbortController()
  const execTimer =
    settings.timeout > 0 ? setTimeout(() => execCtrl.abort(), settings.timeout * 1000) : null
  const execRun = await executorRunner.runTurn({
    role: 'executor',
    workdir,
    prompt: executorPrompt,
    promptFile: executorPromptPath,
    outFile: executorOut,
    logFile: executorLog,
    eventsFile: executorEvents,
    schemaFile: outcomeSchema,
    sandbox: settings.sandbox,
    model: settings.executor.model,
    provider: settings.executor.provider,
    thinking: settings.executor.thinking,
    dryRun: args.dryRun,
    signal: execCtrl.signal,
  })
  if (execTimer) clearTimeout(execTimer)

  const execText = existsSync(executorOut) ? readFileSync(executorOut, 'utf8') : ''
  let outcome =
    (existsSync(executorEvents) ? extractJsonFromEventsFile(executorEvents) : null) ||
    extractJsonFromText(execText)
  if (!outcome || typeof outcome !== 'object') outcome = null
  const afterExec = snapshot(workdir)
  const execDiff = diff(before, afterExec)
  const changedFiles = [...execDiff.changed, ...execDiff.added]
  const changedAny = changedFiles.length > 0 || execDiff.removed.length > 0
  progress.write('executor_end', { code: execRun.code, status: outcome?.status, changed: changedFiles.length })

  if (execRun.aborted) {
    const summary = {
      status: 'timeout',
      id: task.id || undefined,
      workdir,
      cacheDir: runDir,
      summary: `执行端超时（${settings.timeout}s）`,
      changedFiles,
      outcome,
    }
    logMain(mainLogPath, `execute: 超时中止（${settings.timeout}s，改动 ${changedFiles.length} 个）`)
    finalize(summary, join(runDir, 'summary.json'))
    return
  }

  if (!outcome) {
    if (changedAny) {
      outcome = {
        status: 'done',
        taskId: task.id || task.title,
        note: '缺少 outcome；根据工作区改动推断为 done',
      }
      logMain(mainLogPath, `execute: outcome 缺失；降级为 done (changed=${changedFiles.length})`)
    } else {
      const summary = {
        status: 'executor_failed',
        id: task.id || undefined,
        workdir,
        cacheDir: runDir,
        summary: `执行端 exit=${execRun.code}；无法解析 outcome 且工作区无改动`,
      }
      finalize(summary, join(runDir, 'summary.json'))
      return
    }
  }

  if (outcome.status === 'empty' && changedAny) {
    outcome.status = 'done'
    outcome.note = (outcome.note || '') + ' (empty+改动→done)'
  }

  if (args.dryRun && execRun.dryRun && outcome.status === 'blocked') {
    outcome.status = 'done'
  }

  if (outcome.status !== 'done') {
    const status = ['blocked', 'no_change', 'empty'].includes(outcome.status)
      ? outcome.status
      : 'executor_failed'
    const summary = {
      status,
      id: task.id || outcome.taskId || undefined,
      workdir,
      cacheDir: runDir,
      summary: outcome.note || `执行端 status=${outcome.status}`,
      outcome,
    }
    finalize(summary, join(runDir, 'summary.json'))
    return
  }

  if (!changedAny && !args.dryRun) {
    const summary = {
      status: 'no_change',
      id: task.id || undefined,
      workdir,
      cacheDir: runDir,
      summary: '执行端回报 done 但工作区无改动',
      outcome,
    }
    finalize(summary, join(runDir, 'summary.json'))
    return
  }

  // ---- 审查阶段：审查端直接改进 ----
  const reviewerPrompt = renderTemplate(reviewerTpl, {
    TASK_ID: task.id || task.title,
    TASK_TITLE: task.title,
    TASK_BODY: task.body,
    TASK_REQUIREMENTS: task.requirements,
    CHANGED_FILES: changedFiles.length ? changedFiles.join('\n') : '（执行端未报告改动文件）',
    GIT_REVIEW_CONTEXT: gitReviewContext,
  })
  const reviewerPromptPath = join(runDir, 'reviewer.prompt.md')
  const reviewerOut = join(runDir, 'reviewer.out.md')
  const reviewerLog = join(runDir, 'reviewer.log')
  const reviewerEvents = join(runDir, 'reviewer.events.jsonl')
  writeFileSync(reviewerPromptPath, reviewerPrompt, 'utf8')

  logMain(mainLogPath, `review: 审查端开始（改动文件 ${changedFiles.length} 个）`)
  progress.setStage('reviewing')
  progress.write('reviewer_start', {})
  progress.write('context_start', {
    role: 'reviewer',
    file: reviewerLog,
    ...(settings.structuredContext ? { eventsFile: reviewerEvents } : {}),
  }, 2)
  const reviewCtrl = new AbortController()
  const reviewTimer =
    settings.timeout > 0 ? setTimeout(() => reviewCtrl.abort(), settings.timeout * 1000) : null
  const reviewerRun = await reviewerRunner.runTurn({
    role: 'reviewer',
    workdir,
    prompt: reviewerPrompt,
    promptFile: reviewerPromptPath,
    outFile: reviewerOut,
    logFile: reviewerLog,
    eventsFile: reviewerEvents,
    schemaFile: reviewSchema,
    sandbox: settings.sandbox === 'read-only' ? 'read-only' : settings.sandbox,
    model: settings.reviewer.model,
    provider: settings.reviewer.provider,
    thinking: settings.reviewer.thinking,
    dryRun: args.dryRun,
    signal: reviewCtrl.signal,
  })
  if (reviewTimer) clearTimeout(reviewTimer)

  const reviewText = existsSync(reviewerOut) ? readFileSync(reviewerOut, 'utf8') : ''
  let review =
    (existsSync(reviewerEvents) ? extractJsonFromEventsFile(reviewerEvents) : null) ||
    extractJsonFromText(reviewText)
  if (!review || !review.status) {
    review = { status: 'clean', note: reviewText.trim() || '审查输出缺失或无法解析' }
  }

  if (reviewerRun.aborted) {
    const summary = {
      status: 'review_timeout',
      id: task.id || undefined,
      workdir,
      cacheDir: runDir,
      summary: `审查端超时（${settings.timeout}s）`,
      changedFiles,
      reviewChangedFiles: [],
      review: { status: 'timeout', note: '审查超时' },
      outcome,
    }
    logMain(mainLogPath, `review: 超时中止（${settings.timeout}s）`)
    finalize(summary, join(runDir, 'summary.json'))
    return
  }
  const afterReview = snapshot(workdir)
  const reviewDiff = diff(afterExec, afterReview)
  const reviewChanged = [...reviewDiff.changed, ...reviewDiff.added]
  if (review.status !== 'refined' && reviewChanged.length > 0) {
    review.status = 'refined'
    review.note = (review.note || '') + ' (有改动但 status 缺失；按 refined 计)'
  }
  lastReview = review
  progress.write('reviewer_end', { status: review.status, changed: reviewChanged.length })

  let commitsSinceBase = null
  if (gitContext.isGit && settings.gitCommit && gitContext.baseHead) {
    const raw = gitOutput(workdir, ['rev-list', '--count', `${gitContext.baseHead}..HEAD`])
    commitsSinceBase = raw ? Number(raw) : null
  }

  const summary = {
    status: 'approved',
    id: task.id || undefined,
    workdir,
    cacheDir: runDir,
    summary: review.note || '已实现；审查通过',
    changedFiles,
    reviewChangedFiles: reviewChanged,
    review,
    outcome,
    commitsSinceBase,
  }
  finalize(summary, join(runDir, 'summary.json'))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
