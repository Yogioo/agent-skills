import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

export function runtimeBuilt() {
  return existsSync(join(repoRoot, 'lib')) && existsSync(join(repoRoot, 'tools'))
}

export function makeTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix))
}

export function cleanup(path) {
  rmSync(path, { recursive: true, force: true })
}

export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env || {}) },
      windowsHide: true,
      shell: options.shell === true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.once('error', reject)
    child.once('close', (code) => resolve({ code, stdout, stderr }))
  })
}

export function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

// Prefer running npm's JS entry point directly. This avoids shell:true (and its
// DEP0190 warning) while remaining compatible with Node 20+ on Windows.
export function npmInvocation(args) {
  const cli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (existsSync(cli)) {
    return { command: process.execPath, args: [cli, ...args], shell: false }
  }
  return { command: npmCommand(), args, shell: process.platform === 'win32' }
}

export async function npmPack(destination) {
  const invocation = npmInvocation(['pack', '--json', '--pack-destination', destination])
  const result = await run(invocation.command, invocation.args, { cwd: repoRoot, shell: invocation.shell })
  if (result.code !== 0) throw new Error(`npm pack failed: ${result.stderr}`)
  const payload = JSON.parse(result.stdout)
  const entry = Array.isArray(payload) ? payload[0] : payload
  return { tarball: join(destination, entry.filename), files: entry.files.map((item) => item.path) }
}

export async function npmInstall(tarball, prefix) {
  const invocation = npmInvocation([
    'install', '--prefix', prefix, '--offline', '--ignore-scripts', '--no-audit', '--no-fund', tarball,
  ])
  const result = await run(invocation.command, invocation.args, { cwd: prefix, shell: invocation.shell })
  if (result.code !== 0) throw new Error(`npm install failed: ${result.stderr}`)
}

export function installedPackageDir(prefix) {
  return join(prefix, 'node_modules', '@yogioo', 'agent-tools')
}

// Locate the installed bin shim. Running it proves the npm bin wiring works.
// Use npm's PowerShell shim on Windows so spaced paths remain separate arguments.
export function installedBin(prefix) {
  const binDir = join(prefix, 'node_modules', '.bin')
  if (process.platform === 'win32') {
    const shim = join(binDir, 'agent-tools.ps1')
    return { command: 'pwsh', prefixArgs: ['-NoProfile', '-File', shim] }
  }
  return { command: join(binDir, 'agent-tools'), prefixArgs: [] }
}

export async function runInstalledBin(prefix, args, cwd) {
  const bin = installedBin(prefix)
  return run(bin.command, [...bin.prefixArgs, ...args], { cwd })
}
