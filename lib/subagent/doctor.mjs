// 角色表的体检。纯函数：输入表文本与模型清单，输出 findings。不写文件，不改表。
//
// 这一层的存在理由：pstack 的 `/setup-pstack` 会「把每个角色写进去」，但写完没人核。
// 打错的模型 id、退役的角色名、同义重复的行都会静静地留着，直到某次扇出真跑起来
// 才发现有几臂挂了。检查必须跑在真跑之前，而且要拿 runner 真正用的那份模型清单去核。
import { BUDGET_EFFORT, CANONICAL_ROLES, EFFORT_LADDER, parseSlug } from './roles.mjs'
import { resolveProvider } from './turns.mjs'

const effortRank = (effort) => EFFORT_LADDER.indexOf(effort)

const finding = (level, code, message, extra = {}) => ({ level, code, message, ...extra })

/**
 * 体检一张角色表。
 * @param {object} input
 * @param {{budget: string|null, entries: Array<{names: string[], values: string[]}>}} input.table
 * @param {Array<{provider: string, model: string}>} input.models
 * @param {string} [input.runner='pi']
 * @param {string|null} [input.rolesFile]
 * @param {string|null} [input.modelsSource]
 * @param {string} [input.modelsError] 模型清单拉不回来时的原因
 * @param {string[]} [input.parseErrors] 表本身的坏行
 * @returns {object}
 */
export function diagnose(input) {
  const { table, models = [], runner = 'pi', rolesFile = null, modelsSource = null, modelsError, parseErrors = [] } = input
  const findings = []
  const budgetLabel = table.budget || null
  const budgetEffort = budgetLabel ? BUDGET_EFFORT[budgetLabel] : undefined

  for (const message of parseErrors) {
    findings.push(finding('error', 'bad-line', `表里有读不了的行：${message}`))
  }

  if (!budgetLabel) {
    findings.push(finding('warning', 'no-budget', '表里没有 `# budget:` 行，无法核对各角色的 effort 是否符合预算。'))
  } else if (!budgetEffort) {
    findings.push(
      finding('warning', 'unknown-budget', `预算标签 “${budgetLabel}” 不认识；应为 ${Object.keys(BUDGET_EFFORT).join(' / ')} 之一。`),
    )
  }

  // 没有模型清单就不能下任何结论。宁可报错，也不要假绿。
  const modelsKnown = models.length > 0
  if (!modelsKnown) {
    findings.push(
      finding('error', 'no-model-list', modelsError || `拿不到 ${runner} 的模型清单，无法核对任何模型 id。`),
    )
  }

  // 角色名：重复的行是死行，规范名之外的是退役或拼错。
  const firstSeen = new Map()
  table.entries.forEach((entry, index) => {
    for (const name of entry.names) {
      const key = name.toLowerCase()
      if (firstSeen.has(key)) {
        findings.push(
          finding('warning', 'duplicate-role', `角色 “${name}” 在第 ${firstSeen.get(key) + 1} 行已经定义过，本行是死行。`, {
            role: name,
          }),
        )
      } else {
        firstSeen.set(key, index)
      }
      if (!CANONICAL_ROLES.includes(key)) {
        findings.push(
          finding('warning', 'unknown-role', `“${name}” 不在 pstack 的规范角色里，退役角色或拼错。`, { role: name }),
        )
      }
    }
  })

  // 逐个取值核对，用的解析链和真跑时完全一致。模型清单拿不到时就只校验与它无关的项，
  // 否则一次故障会派生出一堆“模型不存在”的假警报。
  const roles = table.entries.map((entry) => ({
    names: entry.names,
    values: entry.values.map((value) => {
      const parsed = parseSlug(value)
      const subject = entry.names.join(', ')
      if (parsed.alias) {
        return { value, alias: true, verified: modelsKnown, model: null, provider: null, thinking: undefined }
      }
      const resolved = modelsKnown ? resolveProvider({ model: parsed.model, models }) : null
      if (resolved && resolved.candidates) {
        // 真跑时多义会被拒绕（exit 2），所以这里是 error，不是提醒。
        findings.push(
          finding(
            'error',
            'ambiguous-provider',
            `${subject}：模型 “${parsed.model}” 在 ${resolved.candidates.join(', ')} 下都有，不写 provider 会被 fuzzy 匹配送到别的厂商。写成 <provider>/${parsed.model}。`,
            { role: subject, value, candidates: resolved.candidates },
          ),
        )
      } else if (resolved && resolved.source === 'unknown') {
        findings.push(
          finding('error', 'unknown-model', `${subject}：“${parsed.model}” 不在 ${runner} 的模型清单里。`, {
            role: subject,
            value,
          }),
        )
      }
      if (parsed.fast) {
        findings.push(
          finding('warning', 'fast-unsupported', `${subject}：“${value}” 带 -fast，${runner} 没有速度档，这一位会被丢掉。`, {
            role: subject,
            value,
          }),
        )
      }
      if (budgetEffort && parsed.thinking && effortRank(parsed.thinking) > effortRank(budgetEffort)) {
        findings.push(
          finding(
            'warning',
            'below-budget',
            `${subject}：“${value}” 的 effort 是 ${parsed.thinking}，低于 budget ${budgetLabel} 要求的 ${budgetEffort}。`,
            { role: subject, value },
          ),
        )
      }
      return {
        value,
        alias: false,
        verified: modelsKnown && resolved.source !== 'unknown',
        model: resolved ? (resolved.model ?? parsed.model) : parsed.model,
        provider: (resolved && resolved.provider) || null,
        providerSource: resolved ? resolved.source : 'unverified',
        thinking: parsed.thinking,
        fast: parsed.fast,
      }
    }),
  }))

  // 面板角色：同一条线上重复的模型等于没有扇出多样性。没有模型清单时无法判定归属，跳过。
  for (const entry of modelsKnown ? roles : []) {
    if (entry.values.length < 2) continue
    const seenTargets = new Set()
    for (const value of entry.values) {
      const target = value.alias ? 'alias' : `${value.provider || '?'}/${value.model}`
      if (seenTargets.has(target)) {
        findings.push(
          finding('warning', 'panel-duplicate', `${entry.names.join(', ')}：面板里有重复的 ${target}，扇出没有多样性。`, {
            role: entry.names.join(', '),
          }),
        )
      }
      seenTargets.add(target)
    }
    // provider 没定出来时，这一条是上游故障的重复噪音，不报。
    const real = entry.values.filter((value) => !value.alias)
    if (real.some((value) => !value.provider)) continue
    const providers = new Set(real.map((value) => value.provider))
    if (providers.size === 1 && real.length > 1) {
      findings.push(
        finding(
          'warning',
          'panel-same-provider',
          `${entry.names.join(', ')}：面板全在 ${[...providers][0]} 上，多模型面板的意义在于换厂商。`,
          { role: entry.names.join(', ') },
        ),
      )
    }
  }

  // 缺角色不算错：缺了就回落到技能默认值，只是要知道。
  const missingRoles = CANONICAL_ROLES.filter((role) => !firstSeen.has(role))
  if (missingRoles.length > 0) {
    findings.push(
      finding('info', 'missing-roles', `有 ${missingRoles.length} 个规范角色没在表里，这些会回落到技能默认模型。`, {
        roles: missingRoles,
      }),
    )
  }

  const errors = findings.filter((item) => item.level === 'error').length
  const warnings = findings.filter((item) => item.level === 'warning').length
  const infos = findings.filter((item) => item.level === 'info').length
  return {
    ok: errors === 0,
    runner,
    rolesFile,
    modelsSource,
    budget: budgetLabel ? { label: budgetLabel, effort: budgetEffort ?? null } : null,
    counts: { roles: roles.length, arms: roles.reduce((sum, entry) => sum + entry.values.length, 0), errors, warnings, infos },
    missingRoles,
    roles,
    findings,
  }
}

/** 体检报告的文本渲染，给不读 JSON 的人看。 */
export function formatFindings(report) {
  const lines = []
  const label = { error: '错误', warning: '警告', info: '提示' }
  for (const level of ['error', 'warning', 'info']) {
    for (const item of report.findings.filter((entry) => entry.level === level)) {
      lines.push(`[${label[level]}] ${item.code}: ${item.message}`)
    }
  }
  return lines
}
