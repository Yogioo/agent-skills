// Adapted from skills/exec-review/scripts/runners/index.mjs.
// Self-contained registry + capability reporting. No AFK configuration.
import { createCodexRunner } from './codex.mjs'
import { createPiRunner } from './pi.mjs'
import { createAgentRunner } from './agent.mjs'

export const RUNNERS = ['codex', 'pi', 'agent']

/**
 * Session continuation capability:
 * - `create-or-resume`: given a reference, continue if it exists else create (pi)
 * - `resume`: only continue an existing session, never create (codex)
 * - `none`: no verified interface; the caller must rebuild context (agent)
 */
export const SESSION_MODES = ['create-or-resume', 'resume', 'none']

/**
 * Constructing a runner is pure (no spawn, no file reads).
 * @param {string} name
 * @param {object} [opts]
 */
export function createRunner(name, opts = {}) {
  const key = String(name || 'agent').toLowerCase()
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

/**
 * Ask a runner's session capability without building a turn.
 * @param {string} name
 * @returns {'create-or-resume' | 'resume' | 'none'}
 */
export function runnerSessionMode(name) {
  return createRunner(name).sessionMode || 'none'
}

/** Per-runner capability facts and enforcement limitations, for `capabilities`. */
export const CAPABILITIES = Object.freeze({
  pi: Object.freeze({
    name: 'pi',
    sessionMode: 'create-or-resume',
    sessionFlag: '--session-id',
    outputSchema: false,
    streamPartialOutput: false,
    sandboxModes: ['read-only', 'workspace-write'],
    limitations: [
      'read-only restricts tools to read/grep/find/ls and disables extensions/MCP; this is not a kernel sandbox',
      'no --output-schema; a requested schema is rejected, ask for JSON in the prompt instead',
    ],
  }),
  codex: Object.freeze({
    name: 'codex',
    sessionMode: 'resume',
    sessionFlag: 'exec resume',
    outputSchema: true,
    streamPartialOutput: false,
    sandboxModes: ['read-only', 'workspace-write', 'danger-full-access'],
    limitations: [
      'exec resume accepts neither -C nor -s nor --color; explicit sandbox overrides with resume are rejected',
      'resume can only continue an existing session, never create one',
    ],
  }),
  agent: Object.freeze({
    name: 'agent',
    sessionMode: 'none',
    sessionFlag: null,
    outputSchema: false,
    streamPartialOutput: true,
    sandboxModes: ['read-only', 'workspace-write', 'danger-full-access'],
    limitations: [
      'no verified resume interface; a requested session is rejected',
      'no --output-schema; a requested schema is rejected, ask for JSON in the prompt instead',
    ],
  }),
})

/**
 * @param {string} [name]
 * @returns {{ runners: object[] }}
 */
export function capabilities(name) {
  if (name == null || name === '') {
    return { runners: RUNNERS.map((key) => CAPABILITIES[key]) }
  }
  const key = String(name).toLowerCase()
  if (!CAPABILITIES[key]) {
    throw new Error(`未知 runner: ${name}（支持: ${RUNNERS.join(', ')}）`)
  }
  return { runners: [CAPABILITIES[key]] }
}
