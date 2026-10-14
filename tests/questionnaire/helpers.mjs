import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const skill = fileURLToPath(new URL('../../skills/questionnaire/', import.meta.url))
export const serve = join(skill, 'scripts', 'serve.mjs')
export const poll = join(skill, 'scripts', 'poll.mjs')

export function tempDir(t, prefix = 'questionnaire-') {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }))
  return dir
}

/** Run a CLI to completion and return the spawnSync result. */
export function invoke(executable, args, options = {}) {
  const result = spawnSync(process.execPath, [executable, ...args], {
    cwd: options.cwd, encoding: 'utf8', windowsHide: true, timeout: options.timeout || 30_000,
  })
  if (result.error) throw result.error
  return result
}

export function json(result) {
  return JSON.parse(result.stdout)
}

/** Start serve.mjs and collect JSONL events until it exits. */
export function startServer(args, options = {}) {
  const executable = options.executable || serve
  const child = spawn(process.execPath, [executable, ...args], {
    cwd: options.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  const events = []
  const waiters = []
  let buffer = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (!line) continue
      let value
      try { value = JSON.parse(line) } catch { continue }
      events.push(value)
      for (const waiter of [...waiters]) {
        if (!waiter.predicate(value)) continue
        waiters.splice(waiters.indexOf(waiter), 1)
        waiter.resolve(value)
      }
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => { stderr += chunk })
  let exited = false
  const closed = new Promise((resolve) => child.on('close', (code) => { exited = true; resolve(code) }))
  function waitFor(predicate, timeoutMs = 10_000) {
    const existing = events.find(predicate)
    if (existing) return Promise.resolve(existing)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { clearInterval(check); reject(new Error(`timeout waiting for event; stderr=${stderr}`)) }, timeoutMs)
      const check = setInterval(() => { if (exited) { clearInterval(check); clearTimeout(timer); reject(new Error(`server exited early; stderr=${stderr}`)) } }, 20)
      check.unref()
      waiters.push({ predicate, resolve: (value) => { clearInterval(check); clearTimeout(timer); resolve(value) } })
    })
  }
  return { child, events, closed, waitFor, stderr: () => stderr }
}
