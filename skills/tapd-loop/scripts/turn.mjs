/**
 * 起一次 pi turn，跑一张卡的内循环。
 * 这里只负责进程、超时和事件留档；做没做对由 loop 的 git 与 verify 判定。
 */

import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

function quote(value) {
  const text = String(value)
  return /[\s"]/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text
}

/** 直接跑 pi 的 cli.js，绕开 .cmd shim 与 shell 拼接。 */
function resolvePi() {
  const envJs = process.env.PI_CLI_JS
  if (envJs && existsSync(envJs)) return { cmd: process.execPath, prefix: [envJs], shell: false }
  const npmJs = join(homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js')
  if (existsSync(npmJs)) return { cmd: process.execPath, prefix: [npmJs], shell: false }
  return { cmd: process.env.PI_BIN || 'pi', prefix: [], shell: true }
}

export function runTurn(opts) {
  const {
    workdir,
    promptFile,
    outDir,
    skillPath = '',
    model = '',
    provider = '',
    thinking = '',
    timeoutMs = 3600_000,
    extraArgs = [],
  } = opts

  const args = [
    '--print',
    '--mode', 'json',
    '--session-id', opts.sessionId || `tapd-${Date.now()}`,
  ]
  if (skillPath) args.push('--skill', skillPath)
  if (provider) args.push('--provider', provider)
  if (model) args.push('--model', model)
  if (thinking) args.push('--thinking', thinking)
  args.push(...extraArgs)
  args.push(`@${promptFile}`)

  const eventsPath = join(outDir, 'events.jsonl')
  const logPath = join(outDir, 'pi.log')
  const events = createWriteStream(eventsPath)
  const log = createWriteStream(logPath)
  events.on('error', () => {})
  log.on('error', () => {})
  const startedAt = Date.now()
  const pi = resolvePi()

  return new Promise((resolve) => {
    const child = spawn(pi.cmd, [...pi.prefix, ...args.map(quote)], {
      cwd: workdir,
      shell: pi.shell,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
      } else {
        child.kill('SIGKILL')
      }
    }, timeoutMs)

    child.stdout.pipe(events)
    child.stderr.pipe(log)

    child.on('error', (err) => {
      log.write(`\nspawn error: ${err.message}\n`)
      finish(null, null)
    })
    child.on('close', (code, signal) => finish(code, signal))

    function finish(code, signal) {
      clearTimeout(timer)
      events.end()
      log.end()
      resolve({
        code,
        signal,
        timedOut,
        durationMs: Date.now() - startedAt,
        eventsPath,
        logPath,
      })
    }
  })
}

/** 从事件流里读结论：有没有跑完、被没被中断、最后一句说了什么。 */
export function readSettled(eventsPath) {
  let settled = null
  let aborted = false
  let lastText = ''
  let tools = 0

  const text = readText(eventsPath)
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (event.type === 'agent_settled') {
      settled = true
      aborted = Boolean(event.aborted)
    }
    if (event.type === 'message_end' && event.message?.role === 'assistant') {
      const content = event.message.content
      if (typeof content === 'string') lastText = content
      else if (Array.isArray(content)) {
        lastText = content.filter((part) => part?.type === 'text').map((part) => part.text).join('\n')
      }
    }
    if (event.type === 'tool_end') tools += 1
  }
  return { settled, aborted, lastText, tools }
}

function readText(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}
