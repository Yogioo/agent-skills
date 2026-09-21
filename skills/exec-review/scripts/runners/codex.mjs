import { spawnStreamTurn } from './spawn-agent-turn.mjs'

/**
 * @param {{ bin?: string, model?: string, thinking?: string, sandbox?: string }} opts
 */
export function createCodexRunner(opts = {}) {
  const bin = opts.bin || process.env.CODEX_BIN || process.env.EXEC_REVIEW_BIN || 'codex'
  const defaultModel = opts.model || ''
  const defaultThinking = opts.thinking || ''
  const defaultSandbox = opts.sandbox || 'workspace-write'

  return {
    name: 'codex',
    bin,
    /** codex 的 `exec resume` 只能续已有的 session，不能建。 */
    sessionMode: 'resume',
    /**
     * @param {object} turn
     * @param {string} turn.workdir
     * @param {string} turn.prompt
     * @param {string} turn.outFile
     * @param {string} turn.logFile
     * @param {string} [turn.session] session reference；只能续已有的，不能建
     * @param {string} [turn.eventsFile]
     * @param {string} [turn.schemaFile]
     * @param {string} [turn.sandbox]
     * @param {string} [turn.model]
     * @param {string} [turn.thinking]
     * @param {'executor'|'reviewer'} [turn.role]
     * @param {boolean} [turn.dryRun]
     * @param {AbortSignal} [turn.signal]
     */
    runTurn(turn) {
      const sandbox = turn.sandbox || defaultSandbox
      const model = turn.model || defaultModel
      const thinking = turn.thinking || defaultThinking
      // 两条路各自带自己的 flag。resume 不接受 -C / -s / --color：
      // 工作目录由 spawn 的 cwd 负责；续会话路径上没有沙箱开关（可用 --dangerously-bypass-…，本轮不用）。
      const args = turn.session
        ? ['exec', 'resume', String(turn.session), '-o', turn.outFile, '--json']
        : ['exec', '-C', turn.workdir, '-s', sandbox, '-o', turn.outFile, '--json', '--color', 'never']
      if (turn.schemaFile) args.push('--output-schema', turn.schemaFile)
      if (model) args.push('-m', model)
      if (thinking) args.push('-c', `model_reasoning_effort=${thinking}`)
      // prompt 一律走 stdin；`-` 表示从 stdin 读，两条路都接受
      args.push('-')

      return spawnStreamTurn({
        bin,
        knownName: 'codex',
        runner: 'codex',
        workdir: turn.workdir,
        args,
        stdinText: turn.prompt,
        outFile: turn.outFile,
        logFile: turn.logFile,
        eventsFile: turn.eventsFile,
        writeOutFile: false,
        dryRun: turn.dryRun,
        signal: turn.signal,
      })
    },
  }
}
