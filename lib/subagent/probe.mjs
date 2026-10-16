// 可用性实测。角色表能证明「这个模型 id 存在」，证明不了「它真能跑」。
//
// 实测反证：opencode-go/grok-4.7 和 openrouter/anthropic/claude-opus-5.5 都在
// `pi --list-models` 里，凭据也在 auth.json 里，真跑一个 read-only turn 却都是 403
// （没订阅 / 风控）。所以「可用」必须是一次真跑，而不是一份清单。
//
// 复用 runArms：一次探测就是一个极便宜的 arm。
import { runArms, resolveProvider, summarize } from './turns.mjs'
import { parseSlug } from './roles.mjs'

/** 探测只需证明路由与凭据，不需要质量，所以提示词定了，档位也压到最低。 */
export const PROBE_PROMPT = 'Reply with exactly: PROBE-OK\n'

/** 探测默认用的思考档位。与质量无关，只是为了省钱。 */
export const PROBE_THINKING = 'low'

/**
 * 把候选值去重成待探测目标。同一个 (provider, model) 只探一次，因为可用性与
 * 档位无关（档位由子进程夹紧，不决定能否路由）。
 * @param {object} input
 * @param {string[]} [input.values] 角色表取值，如 `opencode-go/grok-4.7-xhigh`
 * @param {Array<{provider?: string, model: string}>} [input.candidates] 显式候选
 * @param {Array<{provider: string, model: string}>} [input.models] 模型清单
 * @param {string} [input.runner='pi']
 * @param {string} [input.thinking=PROBE_THINKING]
 * @returns {{targets: Array<object>, unresolved: Array<object>}}
 */
export function planProbes(input = {}) {
  const { values = [], candidates = [], models = [], runner = 'pi', thinking = PROBE_THINKING } = input
  const targets = []
  const unresolved = []
  const seen = new Set()
  const add = (provider, model, source) => {
    if (!model) return
    const key = `${runner}|${provider || ''}|${model}`
    if (seen.has(key)) return
    seen.add(key)
    targets.push({ label: `${provider ? `${provider}-` : ''}${model}`.replace(/[^A-Za-z0-9._-]+/g, '-'), runner, provider, model, thinking, source })
  }
  for (const raw of values) {
    const parsed = parseSlug(raw)
    if (parsed.alias) continue
    const resolved = resolveProvider({ model: parsed.model, models })
    if (!resolved.provider) {
      unresolved.push({ value: raw, model: parsed.model, reason: resolved.candidates ? 'ambiguous' : 'unknown' })
      continue
    }
    add(resolved.provider, resolved.model, 'role')
  }
  for (const candidate of candidates) {
    const parsed = parseSlug(candidate.model)
    const resolved = resolveProvider({ model: parsed.model, provider: candidate.provider, models })
    if (!resolved.provider) {
      unresolved.push({ value: candidate.model, model: parsed.model, reason: resolved.candidates ? 'ambiguous' : 'unknown' })
      continue
    }
    add(resolved.provider, resolved.model, 'flag')
  }
  return { targets, unresolved }
}

/**
 * 真跑一遍每个目标，用 status 判定可用性。
 * @param {object} input
 * @param {Array<object>} input.targets planProbes 的输出
 * @param {string} input.outDir 新建目录
 * @param {number} [input.concurrency=4]
 * @param {string} [input.workdir]
 * @param {number} [input.timeoutMs]
 * @param {string} [input.bin]
 * @param {Function} [input.runTurn] 注入用，测试里替掉 spawn
 */
export async function runProbes(input) {
  const { targets, outDir, concurrency = 4, workdir, timeoutMs, bin, runTurn } = input
  const arms = targets.map((target) => ({
    label: target.label,
    role: '(probe)',
    runner: target.runner,
    provider: target.provider,
    model: target.model,
    thinking: target.thinking,
    sandbox: 'read-only',
    workdir,
    prompt: PROBE_PROMPT,
  }))
  const results = await runArms({ arms, outDir, concurrency, timeoutMs, bin, runTurn })
  const report = results.map((record, index) => ({
    label: record.label,
    runner: record.runner,
    provider: record.provider,
    model: record.model,
    thinking: record.thinking,
    source: targets[index] ? targets[index].source : 'unknown',
    status: record.status,
    stopReason: record.stopReason,
    errorMessage: record.errorMessage,
    chars: record.chars,
    tokens: record.tokens,
    outputFile: record.outputFile,
  }))
  return {
    probes: report,
    usable: report.filter((item) => item.status === 'ok'),
    unusable: report.filter((item) => item.status !== 'ok'),
    summary: summarize(results),
  }
}
