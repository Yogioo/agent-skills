import { createCodexRunner } from './codex.mjs'
import { createPiRunner } from './pi.mjs'
import { createAgentRunner } from './agent.mjs'

export const RUNNERS = ['codex', 'pi', 'agent']

/**
 * 续会话能力（见 references/runners.md「续会话」）：
 * - `create-or-resume`：给一个 session reference，有就续、没有就建（pi）
 * - `resume`：只能续已有的 session，不能建（codex）
 * - `none`：没有已知的续会话接口，调用方自己降级成「重建上下文」
 */
export const SESSION_MODES = ['create-or-resume', 'resume', 'none']

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

/**
 * 问一个 runner 能不能续会话，不用先造一个 turn。
 * 构造 runner 是纯的（不 spawn、不读文件），所以这里直接构造来问。
 * @param {string} name
 * @returns {'create-or-resume' | 'resume' | 'none'}
 */
export function runnerSessionMode(name) {
  return createRunner(name).sessionMode || 'none'
}
