/**
 * AFK home 提示词覆盖（prompt overlay）。
 *
 * 每个执行环境可在 AFK home 里放**固定名字**的 markdown 来定制 exec-review 的角色提示词：
 *
 *   - `standards.md`        — 非空时注入执行端与审查端（全局先、项目后）
 *   - `<role>.append.md`    — 追加到对应角色（全局先、项目后）
 *   - `<role>.prompt.md`    — 整段替换该角色基础提示词（项目盖全局盖内置）
 *
 * `<role>` ∈ {executor, reviewer}。缺失、空、纯空白的文件视为「没有」，不产生空段。
 *
 * 组装（每角色）：base → standards → append → 渲染任务变量 → 强制 footer。
 * 强制 footer（JSON 结论契约 + git 分工）由本模块注入，整段替换的自定义 prompt 也省略不掉。
 *
 * 只由 exec-review 使用：watcher / 执行批次不感知提示词（ADR-0001）。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afkHomeRoot, resolveProjectConfigDir } from '../../afk-run/scripts/afk-home.mjs'

const OVERLAY_ROLES = ['executor', 'reviewer']

/** AFK home 里固定名字的覆盖文件（不加配置键，约定优于配置）。 */
export const OVERLAY_FILENAMES = {
  standards: 'standards.md',
  append: { executor: 'executor.append.md', reviewer: 'reviewer.append.md' },
  prompt: { executor: 'executor.prompt.md', reviewer: 'reviewer.prompt.md' },
}

/** 替换 `{{KEY}}`；vars 里没有的键替换成空串。 */
function renderTemplate(template, vars) {
  return String(template || '').replace(/\{\{(\w+)\}\}/g, (_, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : '',
  )
}

/** 覆盖层根目录：全局在前、项目在后（与 config.json 的分层一致）。 */
function overlayDirs(workdir) {
  const dirs = [{ scope: 'global', dir: afkHomeRoot() }]
  const project = resolveProjectConfigDir(workdir)
  if (project.dir && project.dir !== dirs[0].dir) dirs.push({ scope: 'project', dir: project.dir })
  return dirs
}

/** 读一个覆盖文件；不存在 / 读不动 / 纯空白都返回 ''。 */
function readOverlay(file) {
  if (!existsSync(file)) return ''
  try {
    const text = readFileSync(file, 'utf8').trim()
    return text || ''
  } catch {
    return ''
  }
}

/** 某一层（全局或项目）里的一个固定覆盖文件。 */
function readOverlayFile(dir, filename) {
  const file = join(dir, filename)
  return { file, text: readOverlay(file) }
}

/**
 * 加载全局 + 项目两层覆盖。
 * `standards` / `append` 按全局 → 项目顺序只留非空；`prompt` 取最后出现的非空（项目盖全局）。
 * @param {string} workdir
 */
export function loadPromptOverlays(workdir) {
  const dirs = overlayDirs(workdir)
  const layer = (filename) =>
    dirs
      .map(({ scope, dir }) => ({ scope, ...readOverlayFile(dir, filename) }))
      .filter((item) => item.text)

  const role = (name) => ({
    append: layer(OVERLAY_FILENAMES.append[name]),
    prompt: layer(OVERLAY_FILENAMES.prompt[name]).pop() || null,
  })

  return {
    standards: layer(OVERLAY_FILENAMES.standards),
    roles: Object.fromEntries(OVERLAY_ROLES.map((name) => [name, role(name)])),
  }
}

function section(heading, items) {
  return [`## ${heading}`, '', items.map((item) => item.text).join('\n\n')].join('\n')
}

/** standards + 角色 append 组成的覆盖段落；没有非空覆盖时返回 ''。 */
function overlaySections(role, overlays) {
  const blocks = []
  if (overlays.standards?.length) {
    blocks.push(section('附加标准（AFK home `standards.md`）', overlays.standards))
  }
  const append = overlays.roles?.[role]?.append || []
  if (append.length) {
    blocks.push(section(`角色附加说明（AFK home \`${OVERLAY_FILENAMES.append[role]}\`）`, append))
  }
  return blocks.join('\n\n')
}

/**
 * 强制 footer 的 git 侧：执行端提交规则 / 审查端 BASE_HEAD + Seal（非 git 时可能为空）。
 * 组合进 `# 契约（技能强制注入）`，内置模板与整段替换的自定义 prompt 共用同一份文案。
 */
const GIT_FOOTER = {
  executor: '{{COMMIT_RULE}}',
  reviewer: '{{GIT_REVIEW_CONTEXT}}',
}

/** 强制 footer 的结论契约（outcome / review JSON 格式）。 */
const REPLY_FOOTER = {
  executor: `# Commit

输出 JSON 前完成 commit（规则见上）。

# 最终回复

最终消息**整段**必须是一个 JSON 对象（不要用 Markdown 代码围栏），形如：

\`\`\`json
{"status":"done|no_change|blocked|empty","taskId":"{{TASK_ID}}","note":"可选短说明"}
\`\`\`

- \`done\` — 已实现并改了文件
- \`no_change\` — 无需改代码；不要为了凑数乱改。若需求已由现有代码/提交满足，在 \`note\` 里写明可核实的提交号，loop 据此关单；否则转人工确认
- \`blocked\` — 做不完；在 \`note\` 说明原因
- \`empty\` — 没有可做的事；不要发明工作`,

  reviewer: `# 最终回复

最终消息**整段**必须是一个 JSON 对象（不要用 Markdown 代码围栏）：

\`\`\`json
{"status":"clean|refined","note":"可选短说明"}
\`\`\`

- \`clean\` — 无需改动
- \`refined\` — 你已直接改进

结论保持简短。`,
}

/** 某角色的强制 footer 段落（git 契约可能为空；两者均由代码注入）。 */
function mandatoryFooter(role, vars) {
  const render = (tpl) => renderTemplate(tpl, vars).replace(/\n{3,}/g, '\n\n').trim()
  const blocks = []
  const git = render(GIT_FOOTER[role] || '')
  if (git) blocks.push(`# 契约（技能强制注入）\n\n${git}`)
  const reply = render(REPLY_FOOTER[role] || '')
  if (reply) blocks.push(reply)
  return blocks
}

/**
 * 组装某角色的最终提示词。
 * @param {'executor'|'reviewer'} role
 * @param {{ builtin: string, vars: object, overlays: object }} params
 *   builtin = 技能内置模板；vars = 任务变量（含 COMMIT_RULE / GIT_REVIEW_CONTEXT / TASK_ID）
 * @returns {{ text: string, base: 'builtin'|'custom', promptFile: string }}
 */
export function assembleRolePrompt(role, { builtin, vars = {}, overlays }) {
  const prompt = overlays?.roles?.[role]?.prompt || null
  const blocks = [renderTemplate(prompt ? prompt.text : builtin, vars).trim()]

  const sections = overlaySections(role, overlays || {})
  if (sections) blocks.push(sections)
  blocks.push(...mandatoryFooter(role, vars))

  return {
    text: `${blocks.filter(Boolean).join('\n\n')}\n`,
    base: prompt ? 'custom' : 'builtin',
    promptFile: prompt?.file || '',
  }
}

/** 本次真正用到的覆盖文件（按注入顺序），用于日志审计。 */
export function overlaySources(overlays) {
  const files = (overlays?.standards || []).map((item) => item.file)
  for (const role of OVERLAY_ROLES) {
    const entry = overlays?.roles?.[role]
    if (entry?.prompt) files.push(entry.prompt.file)
    files.push(...(entry?.append || []).map((item) => item.file))
  }
  return files
}
