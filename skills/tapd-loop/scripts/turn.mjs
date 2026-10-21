/**
 * 起一次 pi turn，跑一张卡的内循环。
 * 这里只负责进程、超时和事件留档；做没做对由 loop 的 git 与 verify 判定。
 */

import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

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

/** 正在跑的 inner-loop 子进程。中断时要一起收掉，否则父进程退了 pi 还在改工作区。 */
const live = new Set()

export function abortAllTurns() {
  for (const child of live) killTree(child)
  live.clear()
}

function killTree(child) {
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
    else child.kill('SIGKILL')
  } catch {
    // 已经退了
  }
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
  // 技能正文由 pi 直接读进系统提示，不靠模型自觉去 read。
  // 光靠 --skill 不够：它只在系统提示里登记 name/description/path，不注入正文，
  // 而 yogioo-mode 还带着 disable-model-invocation，连自动选择都关了。
  // --append-system-prompt 给路径时读的是文件内容，所以正文是确定性地进上下文的。
  if (skillPath) {
    const skillFile = join(skillPath, 'SKILL.md')
    if (existsSync(skillFile)) {
      args.push('--append-system-prompt', `以下是技能 ${basename(skillPath)} 的完整指令，它引用的相对路径都相对 ${skillPath}。`)
      args.push('--append-system-prompt', skillFile)
    }
    args.push('--skill', skillPath)
  }
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
      killTree(child)
    }, timeoutMs)

    live.add(child)
    child.stdout.pipe(events)
    child.stderr.pipe(log)

    child.on('error', (err) => {
      log.write(`\nspawn error: ${err.message}\n`)
      finish(null, null)
    })
    child.on('close', (code, signal) => finish(code, signal))

    function finish(code, signal) {
      clearTimeout(timer)
      live.delete(child)
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
