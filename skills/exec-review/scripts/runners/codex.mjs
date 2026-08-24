import { spawnTurn } from './spawn-turn.mjs'

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
    /**
     * @param {object} turn
     * @param {string} turn.workdir
     * @param {string} turn.prompt
     * @param {string} turn.outFile
     * @param {string} turn.logFile
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
      const args = [
        'exec',
        '-C',
        turn.workdir,
        '-s',
        sandbox,
        '-o',
        turn.outFile,
        '--color',
        'never',
      ]
      if (turn.schemaFile) args.push('--output-schema', turn.schemaFile)
      if (model) args.push('-m', model)
      if (thinking) args.push('-c', `model_reasoning_effort=${thinking}`)
      args.push('-')

      return spawnTurn({
        bin,
        knownName: 'codex',
        workdir: turn.workdir,
        args,
        stdinText: turn.prompt,
        outFile: turn.outFile,
        logFile: turn.logFile,
        dryRun: turn.dryRun,
        signal: turn.signal,
        // Codex writes the final message to `-o`; stdout is event noise.
        stdoutIsOutput: false,
      })
    },
  }
}
