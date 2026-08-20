import { spawn } from 'node:child_process'
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
 */

/**
 * Spawn one agent turn; tee stdout/stderr to logFile.
 * By default also write stdout to outFile. Set stdoutIsOutput=false when the CLI
 * itself writes outFile (e.g. Codex `-o`).
 * @param {TurnRequest} req
 * @returns {Promise<{ code: number, dryRun?: boolean }>}
 */
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
    const child = spawn(resolved.command, spawnArgs, {
      cwd: workdir,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      shell: resolved.shell,
    })

    child.stdout.on('data', (d) => {
      if (stdoutIsOutput) outChunks.push(d)
      logStream.write(d)
    })
    child.stderr.on('data', (d) => logStream.write(d))
    child.on('error', (err) => {
      logStream.end()
      reject(err)
    })
    child.on('close', (code) => {
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
