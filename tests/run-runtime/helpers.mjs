/** Shared test helpers. Node built-ins only. */

import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const ROOT = join(HERE, '..', '..')
export const SKILL = join(ROOT, 'skills', 'run-runtime')
export const CLI = join(SKILL, 'scripts', 'cli.mjs')

/** Disposable OS temp directory; caller must clean it. */
export function tempDir(prefix = 'rr-test-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

export function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true })
}

/** Run a real node process; returns {code, stdout, stderr}. */
export function runNode(args, cwd, options = {}) {
  const child = spawn(process.execPath, args, {
    cwd,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => (stdout += chunk))
  child.stderr.on('data', (chunk) => (stderr += chunk))
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code) => resolve({ code, stdout, stderr }))
  })
}

export function git(workdir, args) {
  return execFileSync('git', args, {
    cwd: workdir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
}

const IDENTITY = ['-c', 'user.email=test@example.com', '-c', 'user.name=Test']

/** Create a repo with one committed file; returns its HEAD. */
export function makeRepo(dir) {
  git(dir, ['init', '-q'])
  writeFileSync(join(dir, 'a.txt'), 'hello\n')
  git(dir, ['add', 'a.txt'])
  git(dir, [...IDENTITY, 'commit', '-q', '-m', 'one'])
  return git(dir, ['rev-parse', 'HEAD']).trim()
}

export function commitAll(dir, message) {
  git(dir, ['add', '-A'])
  git(dir, [...IDENTITY, 'commit', '-q', '-m', message])
  return git(dir, ['rev-parse', 'HEAD']).trim()
}
