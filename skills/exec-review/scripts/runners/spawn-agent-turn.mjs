import { execFile, spawn } from 'node:child_process'
import { createWriteStream, writeFileSync, appendFileSync } from 'node:fs'
import { resolveBin } from './resolve-bin.mjs'
import { normalizeEvent, extractOutTextFromRaw } from '../normalize-event.mjs'

/**
 * @typedef {object} StreamTurnRequest
 * @property {string} bin
 * @property {string} [knownName]
 * @property {'agent' | 'codex' | 'pi'} runner
 * @property {string} workdir
 * @property {string[]} args
 * @property {string} [stdinText]
 * @property {string} outFile
 * @property {string} logFile
 * @property {string} eventsFile
 * @property {boolean} [writeOutFile] when false, CLI writes outFile (codex -o)
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
 * Parse NDJSON from stdout chunks.
 * @param {string} chunkText
 * @param {string} remainder
 * @param {'agent' | 'codex' | 'pi'} runner
 * @returns {{ remainder: string, rawEvents: object[], resultText: string }}
 */
export function parseStreamJsonChunk(chunkText, remainder = '', runner = 'agent') {
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
      const out = extractOutTextFromRaw(raw, runner)
      if (out) resultText = out
    } catch {
      /* ignore partial / non-json lines */
    }
  }
  return { remainder: nextRemainder, rawEvents, resultText }
}

/**
 * Spawn a turn with JSONL stdout parsing and normalized events file.
 * @param {StreamTurnRequest} req
 */
export function spawnStreamTurn(req) {
  const {
    bin,
    knownName,
    runner,
    workdir,
    args,
    stdinText,
    outFile,
    logFile,
    eventsFile,
    writeOutFile = true,
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
    const dryRaw =
      runner === 'agent'
        ? { type: 'result', subtype: 'success', result: dryRunBody.trim() }
        : runner === 'pi'
          ? {
              type: 'message_end',
              message: { role: 'assistant', content: [{ type: 'text', text: dryRunBody.trim() }] },
            }
          : {
              type: 'item.completed',
              item: { id: 'dry', type: 'agent_message', text: dryRunBody.trim() },
            }
    writeFileSync(eventsFile, JSON.stringify(normalizeEvent(dryRaw, runner)) + '\n', 'utf8')
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

    const ingestRawEvents = (rawEvents, resultText) => {
      if (resultText) finalResultText = resultText
      for (const raw of rawEvents) {
        const normalized = normalizeEvent(raw, runner)
        appendFileSync(eventsFile, JSON.stringify(normalized) + '\n', 'utf8')
      }
    }

    const handleChunk = (d) => {
      logStream.write(d)
      const parsed = parseStreamJsonChunk(d.toString('utf8'), ndjsonRemainder, runner)
      ndjsonRemainder = parsed.remainder
      ingestRawEvents(parsed.rawEvents, parsed.resultText)
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
        const parsed = parseStreamJsonChunk('\n', ndjsonRemainder, runner)
        ingestRawEvents(parsed.rawEvents, parsed.resultText)
      }
      if (writeOutFile) {
        writeFileSync(outFile, finalResultText, 'utf8')
      }
      logStream.end()
      resolvePromise({ code: code ?? 1 })
    })

    if (stdinText != null) {
      child.stdin.write(stdinText)
    }
    child.stdin.end()
  })
}

/** @param {StreamTurnRequest} req */
export function spawnAgentStreamTurn(req) {
  return spawnStreamTurn({ ...req, runner: 'agent', writeOutFile: true })
}
