import { execFile, spawn } from 'node:child_process'
import { createWriteStream, writeFileSync } from 'node:fs'
import { resolveBin } from './resolve-bin.mjs'

/**
 * @typedef {object} TurnRequest
 * @property {string} bin
 * @property {string} [knownName]
 * @property {string} workdir
 * @property {string[]} args CLI args after the resolved binary
 * @property {string} [stdinText] optional stdin payload
 * @property {string} outFile
 * @property {string} logFile
 * @property {boolean} [dryRun]
 * @property {string} [dryRunBody]
 * @property {boolean} [stdoutIsOutput] when true (default), write stdout to outFile
 * @property {NodeJS.ProcessEnv} [env]
 * @property {AbortSignal} [signal] abort → kill the whole process tree
 */

/**
 * Spawn one agent turn; tee stdout/stderr to logFile.
 * By default also write stdout to outFile. Set stdoutIsOutput=false when the CLI
 * itself writes outFile (e.g. Codex `-o`).
 * @param {TurnRequest} req
 * @returns {Promise<{ code: number, dryRun?: boolean, aborted?: boolean }>}
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
      // 已退出或无法杀：忽略
    }
    return
  }
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    try {
      child.kill('SIGTERM')
    } catch {
      // 已退出：忽略
    }
  }
}

export function spawnTurn(req) {
  const {
    bin,
    knownName,
    workdir,
    args,
    stdinText,
    outFile,
    logFile,
    dryRun = false,
    dryRunBody = '{"status":"blocked","note":"dry-run"}\n',
    stdoutIsOutput = true,
    env = process.env,
    signal,
  } = req

  const resolved = resolveBin(bin, { knownName })
  const spawnArgs = [...resolved.argsPrefix, ...args]
  const cmdline = `$ ${resolved.display} ${args.join(' ')}\n\n`

  if (dryRun) {
    writeFileSync(outFile, dryRunBody, 'utf8')
    writeFileSync(logFile, `[dry-run] ${cmdline}`, 'utf8')
    return Promise.resolve({ code: 0, dryRun: true })
  }

  return new Promise((resolvePromise, reject) => {
    const logStream = createWriteStream(logFile, { flags: 'w' })
    logStream.write(cmdline)

    const outChunks = []
    // 非 Windows：detached 让子进程成为进程组组长，abort 时可按组杀（含孙进程）
    const child = spawn(resolved.command, spawnArgs, {
      cwd: workdir,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
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

    child.stdout.on('data', (d) => {
      if (stdoutIsOutput) outChunks.push(d)
      logStream.write(d)
    })
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
      if (stdoutIsOutput) {
        writeFileSync(outFile, Buffer.concat(outChunks).toString('utf8'), 'utf8')
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
