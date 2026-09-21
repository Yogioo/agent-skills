import { spawnAgentStreamTurn } from './spawn-agent-turn.mjs'

/**
 * Map exec-review sandbox hints → Cursor `agent` CLI flags.
 * @param {string} sandbox
 * @returns {{ mode?: string, sandbox?: string }}
 */
export function mapAgentSandbox(sandbox) {
  const key = String(sandbox || '').toLowerCase()
  if (key === 'read-only') return { mode: 'ask' }
  if (key === 'danger-full-access') return { sandbox: 'disabled' }
  // workspace-write and unknown → keep sandbox on
  return { sandbox: 'enabled' }
}

/**
 * Fold thinking into Cursor model bracket params when model is set.
 * e.g. composer-2.5 + high → composer-2.5[effort=high]
 * @param {string} model
 * @param {string} thinking
 */
export function applyThinkingToModel(model, thinking) {
  const m = String(model || '').trim()
  const t = String(thinking || '').trim()
  if (!t || !m) return m
  const bracket = m.match(/^([^[\]]+)\[(.*)\]\s*$/)
  if (bracket) {
    const base = bracket[1].trim()
    const params = bracket[2].trim()
    if (/\beffort\s*=/.test(params)) return m
    const next = params ? `${params},effort=${t}` : `effort=${t}`
    return `${base}[${next}]`
  }
  return `${m}[effort=${t}]`
}

/**
 * Prefer a short file pointer over inlining huge prompts (Windows cmdline limit).
 * @param {{ prompt?: string, promptFile?: string }} turn
 */
export function buildAgentPromptArg(turn) {
  if (turn.promptFile) {
    const p = String(turn.promptFile).replace(/\\/g, '/')
    return [
      `Open and follow every instruction in this file exactly: ${p}`,
      'When finished, your final message must be only the JSON object required by those instructions (no extra prose).',
    ].join('\n')
  }
  return String(turn.prompt || '')
}

/**
 * Build argv after the binary (for tests / dry-run inspection).
 * @param {object} turn
 * @param {object} defaults
 */
export function buildAgentArgs(turn, defaults = {}) {
  const approve = defaults.approve !== false
  const sandboxHint = turn.sandbox || defaults.sandbox || 'workspace-write'
  const model = applyThinkingToModel(
    turn.model || defaults.model || '',
    turn.thinking || defaults.thinking || '',
  )
  const mapped = mapAgentSandbox(sandboxHint)

  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--workspace',
    turn.workdir,
    '--trust',
  ]

  if (approve) {
    args.push('--force')
    args.push('--approve-mcps')
  }

  if (mapped.mode) args.push('--mode', mapped.mode)
  if (mapped.sandbox) args.push('--sandbox', mapped.sandbox)
  if (model) args.push('--model', model)
  if (defaults.streamPartialOutput) args.push('--stream-partial-output')

  args.push(buildAgentPromptArg(turn))
  return args
}

/**
 * Cursor Agent CLI runner (`agent` / cursor-agent).
 * @param {{
 *   bin?: string,
 *   model?: string,
 *   thinking?: string,
 *   sandbox?: string,
 *   approve?: boolean,
 *   streamPartialOutput?: boolean,
 * }} opts
 */
export function createAgentRunner(opts = {}) {
  const bin =
    opts.bin || process.env.AGENT_BIN || process.env.CURSOR_AGENT_BIN || process.env.EXEC_REVIEW_BIN || 'agent'
  const defaultModel = opts.model || ''
  const defaultThinking = opts.thinking || ''
  const defaultSandbox = opts.sandbox || 'workspace-write'
  const approve = opts.approve !== false
  const streamPartialOutput = opts.streamPartialOutput === true

  return {
    name: 'agent',
    bin,
    /**
     * 没有已验证的续会话接口（Cursor CLI 未安装，无法核对）。
     * 调用方要续会话时应当自己降级成「拿需求本子重建上下文」，而不是以为接着聊了。
     */
    sessionMode: 'none',
    /**
     * @param {object} turn
     * @param {string} turn.workdir
     * @param {string} turn.prompt
     * @param {string} [turn.promptFile]
     * @param {string} turn.outFile
     * @param {string} turn.logFile
     * @param {string} [turn.session] 不支持；给了就报错，不静默忽略
     * @param {string} [turn.eventsFile]
     * @param {string} [turn.schemaFile] ignored (no --output-schema); prompts demand JSON
     * @param {string} [turn.sandbox]
     * @param {string} [turn.model]
     * @param {string} [turn.thinking]
     * @param {'executor'|'reviewer'} [turn.role]
     * @param {boolean} [turn.dryRun]
     * @param {AbortSignal} [turn.signal]
     */
    runTurn(turn) {
      // 静默忽略会让人以为会话续上了。宁可响亮地失败，由调用方决定怎么降级。
      if (turn.session) {
        throw new Error(
          'agent runner 不支持续会话（Cursor CLI 的 resume 接口未验证）。' +
            '请改用支持续会话的 runner，或让调用方按「重建上下文」降级。',
        )
      }
      const args = buildAgentArgs(turn, {
        model: defaultModel,
        thinking: defaultThinking,
        sandbox: defaultSandbox,
        approve,
        streamPartialOutput,
      })

      return spawnAgentStreamTurn({
        bin,
        knownName: 'agent',
        workdir: turn.workdir,
        args,
        outFile: turn.outFile,
        logFile: turn.logFile,
        eventsFile: turn.eventsFile,
        dryRun: turn.dryRun,
        signal: turn.signal,
      })
    },
  }
}
