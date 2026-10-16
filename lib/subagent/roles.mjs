// pstack 角色表与 slug 解析。纯函数，无 IO，无 spawn。
//
// 角色表就是 pstack 的模型设置文件：Cursor 读
// `~/.cursor/rules/pstack-models.mdc`，其他 harness 读
// `~/.agents/pstack-models.md`。两者格式相同，只有 frontmatter 差别。
//
//   # budget: large (xhigh)
//   feature, refactoring: grok-4.7-xhigh-fast
//   interrogate reviewers: claude-opus-5-5-xhigh, grok-4.7-xhigh-fast

export const EFFORT_LADDER = ['max', 'xhigh', 'high', 'medium', 'low']

/** 别名表示「用父会话的模型」，不是真实 slug。 */
export const ROLE_ALIASES = ['auto', 'inherit-parent']

/**
 * pstack 的规范角色名，取自 setup-pstack 第 5 步写的表形。角色表里出现这之外的
 * 名字，要么是退役角色，要么是打错，doctor 会报出来。
 */
export const CANONICAL_ROLES = [
  'feature',
  'refactoring',
  'bug-fix',
  'perf-issue',
  'hillclimb',
  'judgment and prose',
  'hardest tasks',
  'how explorer',
  'how explainer',
  'why investigators',
  'why synthesizer',
  'reflect tooling',
  'reflect judgment',
  'reflect divergent',
  'reflect synthesizer',
  'arena runners',
  'arena cross-judge pool',
  'swarm workers',
  'architect runners',
  'interrogate reviewers',
]

/** `# budget:` 的标签到目标 effort。setup-pstack 第 3 步的对应关系。 */
export const BUDGET_EFFORT = { unlimited: 'max', large: 'xhigh', medium: 'high', small: 'medium' }

/**
 * 拆一个 pstack slug：effort 是最后一段，或 `-fast` 之前那段。
 * @param {string} raw
 * @returns {{slug: string, alias: boolean, model: string, thinking?: string, fast: boolean}}
 */
export function parseSlug(raw) {
  const slug = String(raw ?? '').trim()
  if (ROLE_ALIASES.includes(slug)) {
    return { slug, alias: true, model: '', thinking: undefined, fast: false }
  }
  const tokens = slug.split('-')
  let fast = false
  if (tokens.length > 1 && tokens.at(-1) === 'fast') {
    fast = true
    tokens.pop()
  }
  let thinking
  if (tokens.length > 1 && EFFORT_LADDER.includes(tokens.at(-1))) {
    thinking = tokens.pop()
  }
  return { slug, alias: false, model: tokens.join('-'), thinking, fast }
}

/**
 * 解析角色表文本。跳过 frontmatter、空行与注释，但把 `# budget:` 与
 * `# runner:` 留下（都是注释，pstack 不认也无害）。
 * @param {string} text
 * @returns {{budget: string|null, runner: string|null, entries: Array<{names: string[], values: string[]}>, errors: string[]}}
 */
export function parseRoleTable(text) {
  const errors = []
  const entries = []
  let budget = null
  let runner = null
  const lines = String(text ?? '').split(/\r?\n/)
  let inFrontmatter = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (line === '---') {
      inFrontmatter = !inFrontmatter
      continue
    }
    if (inFrontmatter || line === '') continue
    if (line.startsWith('#')) {
      const budgetMatch = line.match(/^#\s*budget:\s*(\S+)/)
      if (budgetMatch) budget = budgetMatch[1]
      const runnerMatch = line.match(/^#\s*runner:\s*(\S+)/)
      if (runnerMatch) runner = runnerMatch[1]
      continue
    }
    const colon = line.indexOf(':')
    if (colon < 0) {
      errors.push(`第 ${i + 1} 行不是 key: value：${line}`)
      continue
    }
    const names = line
      .slice(0, colon)
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean)
    const values = line
      .slice(colon + 1)
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
    if (names.length === 0) {
      errors.push(`第 ${i + 1} 行没有角色名：${line}`)
      continue
    }
    if (values.length === 0) {
      errors.push(`第 ${i + 1} 行没有取值：${line}`)
      continue
    }
    entries.push({ names, values })
  }
  return { budget, runner, entries, errors }
}

/**
 * 读一个角色的取值列表。面板角色返回多个，普通角色返回一个。
 * @param {{entries: Array<{names: string[], values: string[]}>}} table
 * @param {string} role
 * @returns {string[]|undefined}
 */
export function roleLookup(table, role) {
  const wanted = String(role ?? '').trim().toLowerCase()
  for (const entry of table.entries) {
    if (entry.names.some((name) => name.toLowerCase() === wanted)) return entry.values
  }
  return undefined
}

/** 角色表里所有名字，用于报错时列出候选。 */
export function roleNames(table) {
  return table.entries.flatMap((entry) => entry.names)
}

/**
 * 把「角色表取值 + 臂级覆盖」合成本臂最终要传给 runner 的四元组。
 * 覆盖优先级：显式参数 > 角色表 > 默认值。
 * @param {object} input
 * @param {string} input.role
 * @param {string[]|undefined} input.values 角色表给这个角色的取值
 * @param {number} [input.index=0] 面板角色取第几个（一个取值一个子代理）
 * @param {object} [input.override] 臂级覆盖：runner/provider/model/thinking/sandbox
 * @param {string} [input.defaultRunner='agent']
 * @returns {{role: string, slug: string|null, alias: boolean, fast: boolean,
 *   runner: string, provider?: string, model?: string, thinking?: string,
 *   sandbox?: string, sources: Record<string, string>}}
 */
export function resolveArm(input) {
  const { role, values, index = 0, override = {}, defaultRunner = 'agent' } = input
  const slug = values && values.length > 0 ? values[index % values.length] : null
  const parsed = slug ? parseSlug(slug) : { slug: null, alias: false, model: '', thinking: undefined, fast: false }
  const sources = {}
  const pick = (key, fromRole, fromOverride) => {
    if (fromOverride !== undefined && fromOverride !== '') {
      sources[key] = 'override'
      return fromOverride
    }
    if (fromRole !== undefined && fromRole !== '') {
      sources[key] = 'role'
      return fromRole
    }
    sources[key] = 'default'
    return undefined
  }
  // 别名（auto / inherit-parent）= 不指定模型，跑父会话的模型。
  const model = parsed.alias ? undefined : pick('model', parsed.model, override.model)
  if (parsed.alias) sources.model = 'alias'
  const thinking = pick('thinking', parsed.thinking, override.thinking)
  return {
    role,
    slug,
    alias: parsed.alias,
    fast: parsed.fast,
    runner: pick('runner', undefined, override.runner) || defaultRunner,
    provider: pick('provider', undefined, override.provider),
    model,
    thinking,
    sandbox: pick('sandbox', undefined, override.sandbox),
    sources,
  }
}
