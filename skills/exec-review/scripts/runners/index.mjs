import { createCodexRunner } from './codex.mjs'
import { createPiRunner } from './pi.mjs'

export const RUNNERS = ['codex', 'pi']

/**
 * @param {string} name
 * @param {object} [opts]
 */
export function createRunner(name, opts = {}) {
  const key = String(name || 'codex').toLowerCase()
  switch (key) {
    case 'codex':
      return createCodexRunner(opts)
    case 'pi':
      return createPiRunner(opts)
    default:
      throw new Error(`未知 runner: ${name}（支持: ${RUNNERS.join(', ')}）`)
  }
}

export { createCodexRunner, createPiRunner }
