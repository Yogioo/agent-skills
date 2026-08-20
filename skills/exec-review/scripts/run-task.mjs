#!/usr/bin/env node
/**
 * 执行→审查 runner（单次任务文本）。
 * 输入：任务说明。输出：stdout 摘要 JSON。日志：--cache-dir。
 *
 * 用法：
 *   node run-task.mjs --workdir <仓库> --task-file task.md [--max-rounds 3]
 *   node run-task.mjs --workdir <仓库> --stdin
 *   node run-task.mjs --workdir <仓库> --title "…" --body "…" [--requirements "…"] [--id "…"]
 */

import { spawn } from 'node:child_process'
import {
  createWriteStream,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SKILL_ROOT = resolve(__dirname, '..')
const DEFAULT_MAX_ROUNDS = 3

function usage(code = 1) {
  const text = `用法:
  node run-task.mjs --workdir <仓库> (--task-file <路径> | --stdin | --title <t> --body <b>)
    [--id <标签>] [--requirements <文本>] [--max-rounds N] [--cache-dir <目录>]
    [--sandbox workspace-write|danger-full-access|read-only]
    [--codex-bin <路径>] [--model <id>] [--dry-run]`
  console.error(text)
  process.exit(code)
}

function parseArgs(argv) {
  const out = {
    workdir: null,
    taskFile: null,
    stdin: false,
    id: '',
    title: '',
    body: '',
    requirements: '',
    maxRounds: DEFAULT_MAX_ROUNDS,
    cacheDir: null,
    sandbox: 'workspace-write',
    codexBin: process.env.CODEX_BIN || 'codex',
    model: process.env.CODEX_MODEL || '',
    dryRun: false,
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
      case '--max-rounds':
        out.maxRounds = Math.max(1, Number(next()) || DEFAULT_MAX_ROUNDS)
        break
      case '--cache-dir':
        out.cacheDir = next()
        break
      case '--sandbox':
        out.sandbox = next()
        break
      case '--codex-bin':
        out.codexBin = next()
        break
      case '--model':
        out.model = next()
        break
      case '--dry-run':
        out.dryRun = true
        break
      default:
        console.error(`未知参数: ${a}`)
        usage()
    }
  }
  return out
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
  const outcome = raw.match(/<outcome>\s*([\s\S]*?)\s*<\/outcome>/i)
  if (outcome) {
    v = tryParse(outcome[1].trim())
    if (v) return v
  }
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

function normalizeOutcome(outcome) {
  if (!outcome || typeof outcome !== 'object') return outcome
  if (!outcome.taskId && outcome.ticketId) outcome.taskId = outcome.ticketId
  return outcome
}

function runGit(workdir, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('git', args, {
      cwd: workdir,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => {
      stdout += d
    })
    child.stderr.on('data', (d) => {
      stderr += d
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolvePromise(stdout.trim())
      else reject(new Error(`git ${args.join(' ')} failed (${code}): ${stderr || stdout}`))
    })
  })
}

async function countCommits(workdir, baseSha) {
  try {
    const out = await runGit(workdir, ['rev-list', '--count', `${baseSha}..HEAD`])
    return Number(out) || 0
  } catch {
    return 0
  }
}

function runCodex({
  codexBin,
  workdir,
  sandbox,
  model,
  prompt,
  outFile,
  logFile,
  schemaFile,
  dryRun,
}) {
  const args = [
    'exec',
    '-C',
    workdir,
    '-s',
    sandbox,
    '-o',
    outFile,
    '--color',
    'never',
  ]
  if (schemaFile) args.push('--output-schema', schemaFile)
  if (model) args.push('-m', model)
  args.push('-')

  if (dryRun) {
    writeFileSync(outFile, '{"status":"blocked","note":"dry-run"}\n', 'utf8')
    writeFileSync(logFile, `[dry-run] ${codexBin} ${args.join(' ')}\n`, 'utf8')
    return Promise.resolve({ code: 0, dryRun: true })
  }

  return new Promise((resolvePromise, reject) => {
    const logStream = createWriteStream(logFile, { flags: 'w' })
    logStream.write(`$ ${codexBin} ${args.join(' ')}\n\n`)

    // Windows: spawning npm's codex.cmd with piped stdin yields spawn EINVAL on
    // modern Node. Prefer `node <codex.js> …`; fall back to shell for .cmd/.bat.
    let command = codexBin
    let spawnArgs = args
    let shell = false
    if (process.platform === 'win32') {
      const hasSep = /[\\/]/.test(codexBin)
      const hasExt = /\.(cmd|exe|bat|js|mjs)$/i.test(codexBin)
      const bare = !hasSep && !hasExt
      const asCmd = bare ? `${codexBin}.cmd` : codexBin
      if (/\.m?js$/i.test(codexBin)) {
        command = process.execPath
        spawnArgs = [resolve(codexBin), ...args]
      } else if (bare || /\.(cmd|bat)$/i.test(asCmd)) {
        const jsGuess = process.env.APPDATA
          ? join(
              process.env.APPDATA,
              'npm',
              'node_modules',
              '@openai',
              'codex',
              'bin',
              'codex.js',
            )
          : ''
        if (jsGuess && existsSync(jsGuess)) {
          command = process.execPath
          spawnArgs = [jsGuess, ...args]
        } else {
          command = asCmd
          shell = true
        }
      }
    }

    const child = spawn(command, spawnArgs, {
      cwd: workdir,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
      shell,
    })

    child.stdin.write(prompt)
    child.stdin.end()

    child.stdout.on('data', (d) => logStream.write(d))
    child.stderr.on('data', (d) => logStream.write(d))
    child.on('error', (err) => {
      logStream.end()
      reject(err)
    })
    child.on('close', (code) => {
      logStream.end()
      resolvePromise({ code: code ?? 1 })
    })
  })
}

function emitSummary(summary, summaryPath) {
  const text = JSON.stringify(summary, null, 2)
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
    `start id=${task.id || '-'} title=${JSON.stringify(task.title)} workdir=${workdir} rounds=${args.maxRounds} cache=${runDir}`,
  )

  let lastFindings = ''
  let lastReview = null
  let lastBaseSha = ''
  let lastStatus = 'escalate'
  let lastRound = 0
  let settled = false

  for (let round = 1; round <= args.maxRounds && !settled; round++) {
    lastRound = round
    const loopName = uniqueDir(runDir, `${String(round).padStart(2, '0')}-${localTimestamp()}`)
    const loopDir = join(runDir, loopName)
    mkdirSync(loopDir, { recursive: true })

    let baseSha
    try {
      baseSha = await runGit(workdir, ['rev-parse', 'HEAD'])
    } catch (err) {
      emitSummary(
        {
          status: 'error',
          id: task.id || undefined,
          round,
          workdir,
          cacheDir: runDir,
          summary: String(err.message || err),
        },
        join(loopDir, 'summary.json'),
      )
      process.exit(2)
    }
    lastBaseSha = baseSha

    const fixBlock = lastFindings
      ? `\n# 上一轮审查要求修改\n\n${lastFindings}\n\n只处理上述要点，其余行为保持不变；重新提交并给出新的 outcome。\n`
      : ''

    const executorPrompt = renderTemplate(executorTpl, {
      TASK_ID: task.id || task.title,
      TASK_TITLE: task.title,
      TASK_BODY: task.body,
      TASK_REQUIREMENTS: task.requirements,
      FIX_BLOCK: fixBlock,
    })
    const executorPromptPath = join(loopDir, 'executor.prompt.md')
    const executorOut = join(loopDir, 'executor.out.md')
    const executorLog = join(loopDir, 'executor.log')
    writeFileSync(executorPromptPath, executorPrompt, 'utf8')

    logMain(mainLogPath, `round ${round}: executor baseSha=${baseSha}`)
    const execRun = await runCodex({
      codexBin: args.codexBin,
      workdir,
      sandbox: args.sandbox,
      model: args.model,
      prompt: executorPrompt,
      outFile: executorOut,
      logFile: executorLog,
      schemaFile: outcomeSchema,
      dryRun: args.dryRun,
    })

    const execText = existsSync(executorOut) ? readFileSync(executorOut, 'utf8') : ''
    let outcome = normalizeOutcome(extractJson(execText))
    const commits = await countCommits(workdir, baseSha)

    if (!outcome) {
      if (commits > 0) {
        outcome = {
          status: 'done',
          taskId: task.id || task.title,
          baseSha,
          note: '缺少 outcome；根据提交推断为 done',
        }
        logMain(mainLogPath, `round ${round}: outcome 缺失；降级为 done (commits=${commits})`)
      } else {
        lastStatus = 'executor_failed'
        settled = true
        const summary = {
          status: 'executor_failed',
          id: task.id || undefined,
          round,
          baseSha,
          workdir,
          cacheDir: runDir,
          summary: `执行端 exit=${execRun.code}；无法解析 outcome 且无提交`,
        }
        emitSummary(summary, join(loopDir, 'summary.json'))
        logMain(mainLogPath, `end ${summary.status}`)
        return
      }
    }

    if (outcome.status === 'empty' && commits > 0) {
      outcome.status = 'done'
      outcome.note = (outcome.note || '') + ' (empty+commits→done)'
    }

    if (outcome.status !== 'done') {
      lastStatus =
        outcome.status === 'blocked' ||
        outcome.status === 'no_change' ||
        outcome.status === 'empty'
          ? outcome.status
          : 'executor_failed'
      settled = true
      const summary = {
        status: lastStatus,
        id: task.id || outcome.taskId || undefined,
        round,
        baseSha: outcome.baseSha || baseSha,
        workdir,
        cacheDir: runDir,
        summary: outcome.note || `执行端 status=${outcome.status}`,
        outcome,
      }
      emitSummary(summary, join(loopDir, 'summary.json'))
      logMain(mainLogPath, `end ${summary.status}`)
      return
    }

    if (commits === 0 && !args.dryRun) {
      lastStatus = 'no_change'
      settled = true
      const summary = {
        status: 'no_change',
        id: task.id || undefined,
        round,
        baseSha,
        workdir,
        cacheDir: runDir,
        summary: '执行端回报 done 但没有新提交',
        outcome,
      }
      emitSummary(summary, join(loopDir, 'summary.json'))
      logMain(mainLogPath, `end ${summary.status}`)
      return
    }

    const reviewerPrompt = renderTemplate(reviewerTpl, {
      TASK_ID: task.id || task.title,
      TASK_TITLE: task.title,
      TASK_BODY: task.body,
      TASK_REQUIREMENTS: task.requirements,
      BASE_SHA: baseSha,
    })
    const reviewerPromptPath = join(loopDir, 'reviewer.prompt.md')
    const reviewerOut = join(loopDir, 'reviewer.out.md')
    const reviewerLog = join(loopDir, 'reviewer.log')
    writeFileSync(reviewerPromptPath, reviewerPrompt, 'utf8')

    logMain(mainLogPath, `round ${round}: reviewer range ${baseSha}..HEAD`)
    await runCodex({
      codexBin: args.codexBin,
      workdir,
      sandbox: args.sandbox === 'read-only' ? 'read-only' : args.sandbox,
      model: args.model,
      prompt: reviewerPrompt,
      outFile: reviewerOut,
      logFile: reviewerLog,
      schemaFile: reviewSchema,
      dryRun: args.dryRun,
    })

    const reviewText = existsSync(reviewerOut) ? readFileSync(reviewerOut, 'utf8') : ''
    let review = extractJson(reviewText)
    if (!review || !review.verdict) {
      const m = reviewText.match(/\bVERDICT\s*:\s*(APPROVE|REVISE)\b/i)
      review = {
        verdict: m ? m[1].toUpperCase() : 'REVISE',
        findings: reviewText.trim() || '审查输出缺失或无法解析',
      }
    }
    lastReview = review

    if (String(review.verdict).toUpperCase() === 'APPROVE') {
      lastStatus = 'approved'
      settled = true
      const summary = {
        status: 'approved',
        id: task.id || undefined,
        round,
        baseSha,
        workdir,
        cacheDir: runDir,
        summary: review.findings || '审查通过',
        review,
        outcome,
      }
      emitSummary(summary, join(loopDir, 'summary.json'))
      logMain(mainLogPath, `end approved`)
      return
    }

    lastFindings = review.findings || '审查要求修改（无细节）'
    logMain(mainLogPath, `round ${round}: REVISE — 回炉`)
  }

  const summary = {
    status: settled ? lastStatus : 'escalate',
    id: task.id || undefined,
    round: lastRound,
    baseSha: lastBaseSha || undefined,
    workdir,
    cacheDir: runDir,
    summary: lastFindings || '达到轮次上限仍未通过',
    review: lastReview || undefined,
  }
  emitSummary(summary, join(runDir, 'summary.json'))
  logMain(mainLogPath, `end ${summary.status}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
