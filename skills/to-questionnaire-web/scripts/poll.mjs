#!/usr/bin/env node

/**
 * 分段等待问卷提交 —— 可恢复，不会因为工具调用被中断而丢结果。
 *
 * 用法：
 *   node poll.mjs --file <questionnaire.md> [--timeout 60] [--interval 2]
 *
 * 退出码：0 已提交 / 3 仍在等待 / 2 出错（没有进行中的会话）
 * 输出：单行 JSON，含 nextHint 供 Agent 决定下一步。
 */

import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'

function parseArgs(argv) {
  const args = { file: '', status: '', timeout: 0, interval: 2 }
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i]
    if (value === '--file') args.file = argv[++i] || ''
    else if (value === '--status') args.status = argv[++i] || ''
    else if (value === '--timeout') args.timeout = Number(argv[++i] || 0)
    else if (value === '--interval') args.interval = Math.max(1, Number(argv[++i] || 2))
    else if (value === '--help' || value === '-h') {
      console.log('Usage: node poll.mjs --file <questionnaire.md> [--timeout 60] [--interval 2]')
      console.log('Exit codes: 0 submitted, 3 still waiting, 2 error')
      process.exit(0)
    }
  }
  if (!args.file && !args.status) throw new Error('--file or --status is required')
  return args
}

function statusPathFromFile(file) {
  const absolute = resolve(file)
  const base = basename(absolute, extname(absolute))
  return join(dirname(absolute), `${base}-status.json`)
}

function readStatus(path) {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function report(state, status, extra) {
  const payload = {
    state,
    statusFile: status?.__path || '',
    questionnaireFile: status?.file || '',
    submittedAt: status?.submittedAt || '',
    answeredCount: status?.answeredCount,
    questionCount: status?.questionCount,
    responseFile: status?.responseFile || '',
    responseMarkdown: status?.responseMarkdown || '',
    ...extra,
  }
  console.log(JSON.stringify(payload))
  if (state === 'submitted') {
    console.log(`已收到提交：${payload.responseMarkdown}`)
    console.log(`原始数据：${payload.responseFile}`)
  }
}

const args = parseArgs(process.argv.slice(2))
const statusPath = args.status ? resolve(args.status) : statusPathFromFile(args.file)
const deadline = Date.now() + args.timeout * 1000
let waitedSeconds = 0

for (;;) {
  const status = readStatus(statusPath)
  if (!status) {
    report('error', null, {
      error: `no questionnaire session found at ${statusPath}`,
      nextHint: '先启动 serve.mjs，或确认 --file 指向正确的问卷 Markdown',
    })
    process.exit(2)
  }
  status.__path = statusPath

  if (status.state === 'submitted') {
    report('submitted', status, { waitedSeconds })
    process.exit(0)
  }

  if (Date.now() >= deadline) {
    report('waiting', status, {
      waitedSeconds,
      nextHint: '回答者尚未提交。把地址再确认一遍，或再用 --timeout 继续分段等待。',
    })
    process.exit(3)
  }

  await new Promise((done) => setTimeout(done, args.interval * 1000))
  waitedSeconds += args.interval
}
