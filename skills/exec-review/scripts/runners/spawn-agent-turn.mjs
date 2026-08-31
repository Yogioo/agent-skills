import { execFile, spawn } from 'node:child_process'
import { createWriteStream, writeFileSync, appendFileSync } from 'node:fs'
import { resolveBin } from './resolve-bin.mjs'
import { normalizeAgentEvent } from '../normalize-agent.mjs'

/**
 * @typedef {object} AgentTurnRequest
 * @property {string} bin
 * @property {string} [knownName]
 * @property {string} workdir
 * @property {string[]} args
 * @property {string} outFile
 * @property {string} logFile
 * @property {string} eventsFile
 * @property {boolean} [dryRun]
 * @property {string} [dryRunBody]
 * @property {AbortSignal} [signal]
 */

/** Kill the whole process tree (Windows: taskkill /T; else process group). */
function killTree(child) {
  if (!child || child.pid == null) return
  if (process.platform === 'win32') {
    try {
      execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
      })
    } catch {
      /* ignore */
    }
    return
  }
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    try {
      child.kill('SIGTERM')
    } catch {
      /* ignore */
    }
  }
}

/**
 * Parse stream-json NDJSON from stdout chunks.
 * @param {string} chunkText
 * @param {string} remainder
 * @returns {{ remainder: string, rawEvents: object[], resultText: string }}
 */
export function parseStreamJsonChunk(chunkText, remainder = '') {
  const combined = remainder + chunkText
  const lines = combined.split('\n')
  const nextRemainder = lines.pop() || ''
  const rawEvents = []
  let resultText = ''
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const raw = JSON.parse(trimmed)
      rawEvents.push(raw)
      if (raw?.type === 'result' && typeof raw.result === 'string') {
        resultText = raw.result
      }
    } catch {
      /* ignore partial / non-json lines */
    }
  }
  return { remainder: nextRemainder, rawEvents, resultText }
}

/**
 * Spawn agent turn with stream-json parsing and normalized events file.
 * @param {AgentTurnRequest} req
 */
export function spawnAgentStreamTurn(req) {
  const {
    bin,
    knownName,
    workdir,
    args,
    outFile,
    logFile,
    eventsFile,
    dryRun = false,
    dryRunBody = '{"status":"blocked","note":"dry-run"}\n',
    signal,
  } = req

  const resolved = resolveBin(bin, { knownName })
  const spawnArgs = [...resolved.argsPrefix, ...args]
  const cmdline = `$ ${resolved.display} ${args.join(' ')}\n\n`

  if (dryRun) {
    writeFileSync(outFile, dryRunBody, 'utf8')
    writeFileSync(logFile, `[dry-run] ${cmdline}`, 'utf8')
    const outcome = normalizeAgentEvent({
      type: 'result',
      subtype: 'success',
      result: dryRunBody.trim(),
    })
    writeFileSync(eventsFile, JSON.stringify(outcome) + '\n', 'utf8')
    return Promise.resolve({ code: 0, dryRun: true })
  }

  return new Promise((resolvePromise, reject) => {
    const logStream = createWriteStream(logFile, { flags: 'w' })
    logStream.write(cmdline)

    let ndjsonRemainder = ''
    let finalResultText = ''

    const child = spawn(resolved.command, spawnArgs, {
      cwd: workdir,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
      shell: resolved.shell,
      detached: process.platform !== 'win32',
    })

    let settled = false
    const onAbort = () => {
      if (settled) return
      settled = true
      killTree(child)
      logStream.end()
      resolvePromise({ code: 124, aborted: true })
    }
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }

    const handleChunk = (d) => {
      logStream.write(d)
      const parsed = parseStreamJsonChunk(d.toString('utf8'), ndjsonRemainder)
      ndjsonRemainder = parsed.remainder
      if (parsed.resultText) finalResultText = parsed.resultText
      for (const raw of parsed.rawEvents) {
        const normalized = normalizeAgentEvent(raw)
        appendFileSync(eventsFile, JSON.stringify(normalized) + '\n', 'utf8')
      }
    }

    child.stdout.on('data', handleChunk)
    child.stderr.on('data', (d) => logStream.write(d))
    child.on('error', (err) => {
      if (settled) return
      settled = true
      logStream.end()
      reject(err)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      if (ndjsonRemainder.trim()) {
        const parsed = parseStreamJsonChunk('\n', ndjsonRemainder)
        if (parsed.resultText) finalResultText = parsed.resultText
        for (const raw of parsed.rawEvents) {
          const normalized = normalizeAgentEvent(raw)
          appendFileSync(eventsFile, JSON.stringify(normalized) + '\n', 'utf8')
        }
      }
      writeFileSync(outFile, finalResultText, 'utf8')
      logStream.end()
      resolvePromise({ code: code ?? 1 })
    })

    child.stdin.end()
  })
}
