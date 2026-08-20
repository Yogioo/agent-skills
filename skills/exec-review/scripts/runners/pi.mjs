import { spawnTurn } from './spawn-turn.mjs'

/**
 * @param {{
 *   bin?: string,
 *   model?: string,
 *   provider?: string,
 *   thinking?: string,
 *   sandbox?: string,
 *   approve?: boolean,
 * }} opts
 */
export function createPiRunner(opts = {}) {
  const bin = opts.bin || process.env.PI_BIN || process.env.EXEC_REVIEW_BIN || 'pi'
  const defaultModel = opts.model || ''
  const defaultProvider = opts.provider || ''
  const defaultThinking = opts.thinking || ''
  const defaultSandbox = opts.sandbox || 'workspace-write'
  const approve = opts.approve !== false

  return {
    name: 'pi',
    bin,
    /**
     * @param {object} turn
     * @param {string} turn.workdir
     * @param {string} turn.prompt
     * @param {string} turn.promptFile path to the already-written prompt file
     * @param {string} turn.outFile
     * @param {string} turn.logFile
     * @param {string} [turn.schemaFile] ignored (pi has no output-schema); prompts already demand JSON
     * @param {string} [turn.sandbox]
     * @param {string} [turn.model]
     * @param {string} [turn.provider]
     * @param {string} [turn.thinking]
     * @param {'executor'|'reviewer'} [turn.role]
     * @param {boolean} [turn.dryRun]
     */
    runTurn(turn) {
      const sandbox = turn.sandbox || defaultSandbox
      const model = turn.model || defaultModel
      const provider = turn.provider || defaultProvider
      const thinking = turn.thinking || defaultThinking
      const args = ['-p', '--no-session', '--mode', 'text']

      if (approve) args.push('--approve')
      else args.push('--no-approve')

      if (provider) args.push('--provider', provider)
      if (model) args.push('--model', model)
      if (thinking) args.push('--thinking', thinking)

      // Map sandbox hint → tool policy. Reviewer / read-only: no write/edit.
      const readOnly = sandbox === 'read-only' || turn.role === 'reviewer'
      if (readOnly) {
        args.push('--exclude-tools', 'write,edit')
      }

      // Prefer @file so long prompts avoid Windows command-line limits.
      if (turn.promptFile) {
        args.push(`@${turn.promptFile}`)
      } else {
        args.push(turn.prompt)
      }

      return spawnTurn({
        bin,
        knownName: 'pi',
        workdir: turn.workdir,
        args,
        outFile: turn.outFile,
        logFile: turn.logFile,
        dryRun: turn.dryRun,
        stdoutIsOutput: true,
      })
    },
  }
}
