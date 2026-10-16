// 臂的解析、provider 归属、结果判定与有界并发扇出。
//
// 这个文件里最值钱的一条经验：agent-run 的 exitCode 是**子进程**的退出码，
// 不是这一轮的结果。实测 grok 上游 503、重试三次全挂，agent-run 照样报
// exitCode 0。所以 status 一律从 events.jsonl 与 output.txt 判，exitCode 只上报不采信。
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { runAgentTurn } from '../agent-run/run-agent-turn.mjs'

/** 判定结果时用到的 stopReason：这些都不算成功。 */
const ERROR_STOP_REASONS = new Set(['error', 'aborted', 'length'])

/**
 * 解析 `pi --list-models` 的表格输出。表头与分隔列都跳过。
 * @param {string} text
 * @returns {Array<{provider: string, model: string}>}
 */
export function parseModelList(text) {
  const models = []
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || /^provider\s/i.test(line)) continue
    const [provider, model] = line.split(/\s+/)
    if (!provider || !model) continue
    models.push({ provider, model })
  }
  return models
}

/**
 * 决定这一臂用哪个 provider。角色表里只有模型 id，没有 provider，而同一个 id
 * 可能挂在多个 provider 下，所以猜就是错。唯一匹配才自动定，多个匹配要求显式指定。
 * @param {object} input
 * @param {string|undefined} input.model
 * @param {string|undefined} input.provider
 * @param {Array<{provider: string, model: string}>} [input.models]
 * @returns {{provider?: string, source: 'flag'|'models-unique'|'unknown', candidates?: string[]}}
 */
export function resolveProvider(input) {
  const { model, provider, models = [] } = input
  if (provider) return { provider, source: 'flag' }
  if (!model) return { source: 'unknown' }
  const matches = [...new Set(models.filter((entry) => entry.model === model).map((entry) => entry.provider))]
  if (matches.length === 1) return { provider: matches[0], source: 'models-unique' }
  if (matches.length > 1) return { source: 'unknown', candidates: matches }
  return { source: 'unknown' }
}

/**
 * 从 events.jsonl 里取最后一次用量、stopReason 与 outcome。不同 runner 的收尾记录
 * 形状不同（pi 给 turn_end 消息，agent 给 result），所以两种都认。
 * @param {string} eventsText
 */
function readTurnFacts(eventsText) {
  let stopReason
  let errorMessage
  let usage
  let model
  let provider
  let thinking
  let outcomeText
  let outcomeFailed = false
  let hasOutcome = false
  for (const raw of String(eventsText ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '') continue
    let record
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    if (record.kind === 'outcome') {
      hasOutcome = true
      if (typeof record.text === 'string' && record.text !== '') outcomeText = record.text
      const payload = record.payload || {}
      const subtype = String(payload.subtype || '')
      if (subtype && subtype !== 'success') outcomeFailed = true
      if (payload.is_error === true) outcomeFailed = true
      continue
    }
    const payload = record.payload || record
    const message = payload.message || (Array.isArray(payload.messages) ? payload.messages.at(-1) : undefined)
    if (!message || typeof message !== 'object') continue
    if (message.stopReason !== undefined) stopReason = message.stopReason
    if (message.errorMessage !== undefined) errorMessage = message.errorMessage
    if (message.usage) usage = message.usage
    if (message.model) model = message.model
    if (message.provider) provider = message.provider
    if (message.thinkingLevel) thinking = message.thinkingLevel
  }
  return { stopReason, errorMessage, usage, model, provider, thinking, outcomeText, outcomeFailed, hasOutcome }
}

/**
 * 判定一轮的结果。不看 exitCode。
 * @param {object} input
 * @param {string} input.eventsText
 * @param {string} input.outputText
 * @param {{timedOut?: boolean, aborted?: boolean, exitCode?: number}} [input.facts]
 * @returns {{status: 'ok'|'empty'|'error'|'timeout'|'aborted', stopReason?: string,
 *   errorMessage?: string, chars: number, textSource: 'output'|'events'|'none',
 *   tokens?: number, cost?: number, model?: string, provider?: string, thinking?: string}}
 */
export function classifyTurn(input) {
  const { eventsText, outputText, facts = {} } = input
  const turn = readTurnFacts(eventsText)
  const fromOutput = String(outputText ?? '')
  // output.txt 是调用方真正会读的那份；两处不一致时要能看出来。
  const text = fromOutput !== '' ? fromOutput : turn.outcomeText || ''
  const textSource = fromOutput !== '' ? 'output' : turn.outcomeText ? 'events' : 'none'
  const base = {
    stopReason: turn.stopReason,
    errorMessage: turn.errorMessage,
    chars: text.length,
    textSource,
    tokens: turn.usage ? turn.usage.totalTokens : undefined,
    cost: turn.usage && turn.usage.cost ? turn.usage.cost.total : undefined,
    model: turn.model,
    provider: turn.provider,
    thinking: turn.thinking,
  }
  if (facts.timedOut) return { ...base, status: 'timeout' }
  if (facts.aborted || turn.stopReason === 'aborted') return { ...base, status: 'aborted' }
  if (turn.stopReason && ERROR_STOP_REASONS.has(turn.stopReason)) return { ...base, status: 'error' }
  if (turn.errorMessage || turn.outcomeFailed) return { ...base, status: 'error' }
  // 既没有收尾记录也没有一个字：子进程死了，这是失败，不是空产出。
  if (turn.stopReason === undefined && !turn.hasOutcome && textSource === 'none') {
    return { ...base, status: 'error' }
  }
  if (text.trim() === '') return { ...base, status: 'empty' }
  return { ...base, status: 'ok' }
}

/**
 * 跑一臂。
 * @param {object} arm 已解析的臂：label/runner/workdir/promptFile|prompt/model/...
 * @param {object} context
 * @param {string} context.outDir 本臂的独占目录（必须还不存在）
 * @param {number} [context.timeoutMs]
 * @param {string} [context.bin]
 * @param {AbortSignal} [context.signal]
 * @param {Function} [context.runTurn] 可注入，方便测试
 */
async function runOneArm(arm, context) {
  const { outDir, timeoutMs, bin, signal, runTurn = runAgentTurn } = context
  mkdirSync(outDir)
  const outputFile = join(outDir, 'output.txt')
  const eventsFile = join(outDir, 'events.jsonl')
  const logFile = join(outDir, 'log.txt')
  const facts = await runTurn({
    runner: arm.runner,
    bin,
    workdir: arm.workdir,
    prompt: arm.prompt,
    promptFile: arm.promptFile,
    outFile: outputFile,
    eventsFile,
    logFile,
    model: arm.model,
    provider: arm.provider,
    thinking: arm.thinking,
    sandbox: arm.sandbox,
    timeoutMs,
    signal,
  })
  const readIfPresent = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : '')
  const verdict = classifyTurn({
    eventsText: readIfPresent(eventsFile),
    outputText: readIfPresent(outputFile),
    facts,
  })
  return {
    label: arm.label,
    role: arm.role,
    runner: facts.runner,
    provider: verdict.provider || arm.provider,
    model: verdict.model || arm.model,
    thinking: verdict.thinking || arm.thinking,
    sandbox: arm.sandbox,
    status: verdict.status,
    stopReason: verdict.stopReason,
    errorMessage: verdict.errorMessage,
    timedOut: facts.timedOut === true,
    aborted: facts.aborted === true,
    exitCode: facts.exitCode,
    tokens: verdict.tokens,
    cost: verdict.cost,
    chars: verdict.chars,
    outputFile,
    eventsFile,
    logFile,
  }
}

/**
 * 有界并发跑完所有臂，按输入顺序返回结果。
 * @param {object} input
 * @param {Array<object>} input.arms
 * @param {string} input.outDir 新建的根目录；每臂占 `<outDir>/<label>/`
 * @param {number} [input.concurrency=1]
 * @param {number} [input.timeoutMs]
 * @param {string} [input.bin]
 * @param {AbortSignal} [input.signal]
 * @param {Function} [input.runTurn]
 */
export async function runArms(input) {
  const { arms, outDir, concurrency = 1, timeoutMs, bin, signal, runTurn } = input
  const labels = new Set()
  for (const arm of arms) {
    if (labels.has(arm.label)) throw new Error(`臂名重复: ${arm.label}（臂名要做目录名）`)
    labels.add(arm.label)
  }
  mkdirSync(outDir)
  const results = new Array(arms.length)
  const limit = Math.max(1, Math.min(Number(concurrency) || 1, arms.length))
  let next = 0
  const worker = async () => {
    for (;;) {
      const index = next++
      if (index >= arms.length) return
      const arm = arms[index]
      results[index] = await runOneArm(arm, {
        outDir: join(outDir, arm.label),
        timeoutMs,
        bin,
        signal,
        runTurn,
      })
    }
  }
  await Promise.all(Array.from({ length: limit }, worker))
  return results
}

/**
 * 汇总一批臂的结果。`ok` 才算过，其余都算没过。
 * @param {Array<{status: string}>} results
 */
export function summarize(results) {
  const summary = { arms: results.length, ok: 0, empty: 0, error: 0, timeout: 0, aborted: 0 }
  for (const result of results) {
    if (result.status === 'ok') summary.ok++
    else if (Object.hasOwn(summary, result.status)) summary[result.status]++
    else summary.error++
  }
  return summary
}
