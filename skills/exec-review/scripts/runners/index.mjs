import { createCodexRunner } from './codex.mjs'
import { createPiRunner } from './pi.mjs'
import { createAgentRunner } from './agent.mjs'

export const RUNNERS = ['codex', 'pi', 'agent']

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
    case 'agent':
      return createAgentRunner(opts)
    default:
      throw new Error(`未知 runner: ${name}（支持: ${RUNNERS.join(', ')}）`)
  }
}

export { createCodexRunner, createPiRunner, createAgentRunner }
