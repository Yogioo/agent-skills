/**
 * Resolve npm-global CLI wrappers to a direct `node <js>` spawn on Windows.
 * Spawning `*.cmd` / `*.ps1` with piped stdio often yields EINVAL on modern Node.
 */
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const KNOWN_JS = {
  codex: ['@openai', 'codex', 'bin', 'codex.js'],
  pi: ['@earendil-works', 'pi-coding-agent', 'dist', 'cli.js'],
}

function appDataNpmJs(parts) {
  if (!process.env.APPDATA) return ''
  return join(process.env.APPDATA, 'npm', 'node_modules', ...parts)
}

/**
 * @param {string} bin
 * @param {{ knownName?: string }} [opts]
 * @returns {{ command: string, argsPrefix: string[], shell: boolean, display: string }}
 */
export function resolveBin(bin, opts = {}) {
  const raw = String(bin || '').trim() || 'codex'
  const display = raw
  const knownName = opts.knownName || ''

  if (/\.m?js$/i.test(raw)) {
    return {
      command: process.execPath,
      argsPrefix: [resolve(raw)],
      shell: false,
      display,
    }
  }

  if (process.platform === 'win32') {
    const hasSep = /[\\/]/.test(raw)
    const hasExt = /\.(cmd|exe|bat|ps1)$/i.test(raw)
    const bare = !hasSep && !hasExt
    const baseName = bare
      ? raw.toLowerCase()
      : raw
          .replace(/\\/g, '/')
          .split('/')
          .pop()
          .replace(/\.(cmd|exe|bat|ps1)$/i, '')
          .toLowerCase()

    const knownParts = KNOWN_JS[knownName] || KNOWN_JS[baseName]
    if (knownParts) {
      const guess = appDataNpmJs(knownParts)
      if (guess && existsSync(guess)) {
        return {
          command: process.execPath,
          argsPrefix: [guess],
          shell: false,
          display,
        }
      }
    }

    if (bare || /\.(cmd|bat|ps1)$/i.test(raw)) {
      const asCmd = bare ? `${raw}.cmd` : raw.replace(/\.ps1$/i, '.cmd')
      return {
        command: asCmd,
        argsPrefix: [],
        shell: true,
        display,
      }
    }
  }

  return {
    command: raw,
    argsPrefix: [],
    shell: false,
    display,
  }
}
