/**
 * AFK 用户级配置：~/.afk/<项目名_UID>/config.json 覆盖 ~/.afk/config.json。
 *
 * 单文件分区：`task`（watch/run 共用）、`watch`、`run`、`execReview` 各归其主，
 * 同一字段只出现一次。每个技能只读自己的分区 + `task`。
 *
 * UID = workdir 规范化绝对路径的 sha256 前 8 位，避免同名目录撞车。
 * 目录名可为自定义标签：`<label>_<uid>`；加载时按 UID 匹配。
 * AFK_HOME 可覆盖根目录（测试/自定义）。
 */

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function afkHomeRoot() {
  if (process.env.AFK_HOME) return resolve(process.env.AFK_HOME)
  return join(homedir(), '.afk')
}

/** 规范化路径：realpath + 统一分隔符 + Windows 盘符大写，保证 UID 稳定。 */
export function normalizeWorkdirPath(workdir) {
  let abs = resolve(workdir)
  try {
    abs = realpathSync(abs)
  } catch {
    // 目录尚未创建时仍用 resolve 结果
  }
  return abs.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `${d.toUpperCase()}:`)
}

export function projectUidFromWorkdir(workdir) {
  if (!workdir) return ''
  return createHash('sha256').update(normalizeWorkdirPath(workdir)).digest('hex').slice(0, 8)
}

export function sanitizeProjectLabel(name) {
  const cleaned = String(name || '')
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
    .replace(/\.+$/g, '')
    .replace(/^-+|-+$/g, '')
  return cleaned || 'project'
}

/** 默认标签 = workdir 目录名（经 sanitize）。 */
export function projectLabelFromWorkdir(workdir) {
  if (!workdir) return ''
  return sanitizeProjectLabel(basename(resolve(workdir)))
}

/**
 * 配置目录键：`<label>_<uid>`。
 * @param {string} workdir
 * @param {string} [label] 自定义标签；默认目录名
 */
export function projectKeyFromWorkdir(workdir, label = '') {
  if (!workdir) return ''
  const uid = projectUidFromWorkdir(workdir)
  const name = sanitizeProjectLabel(label || projectLabelFromWorkdir(workdir))
  return `${name}_${uid}`
}

/** @deprecated 使用 projectKeyFromWorkdir */
export function projectNameFromWorkdir(workdir) {
  return projectKeyFromWorkdir(workdir)
}

/**
 * 解析项目配置目录：优先 `<label>_<uid>`；若标签被改过，则扫 ~/.afk/*_<uid>。
 * @returns {{ dir: string, projectKey: string, uid: string, label: string }}
 */
export function resolveProjectConfigDir(workdir) {
  const uid = projectUidFromWorkdir(workdir)
  const label = projectLabelFromWorkdir(workdir)
  const defaultKey = projectKeyFromWorkdir(workdir)
  const home = afkHomeRoot()
  const defaultDir = join(home, defaultKey)

  if (!uid) {
    return { dir: defaultDir, projectKey: defaultKey, uid, label }
  }

  if (existsSync(defaultDir)) {
    return { dir: defaultDir, projectKey: defaultKey, uid, label }
  }

  if (!existsSync(home)) {
    return { dir: defaultDir, projectKey: defaultKey, uid, label }
  }

  let matches = []
  try {
    matches = readdirSync(home, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.endsWith(`_${uid}`))
      .map((d) => d.name)
  } catch {
    matches = []
  }

  if (matches.length === 1) {
    const projectKey = matches[0]
    return {
      dir: join(home, projectKey),
      projectKey,
      uid,
      label: projectKey.slice(0, -(uid.length + 1)),
    }
  }
  if (matches.length > 1) {
    const preferred = matches.includes(defaultKey) ? defaultKey : matches.sort()[0]
    return {
      dir: join(home, preferred),
      projectKey: preferred,
      uid,
      label: preferred.slice(0, -(uid.length + 1)),
    }
  }

  return { dir: defaultDir, projectKey: defaultKey, uid, label }
}

/** 读并解析 JSON；不存在或格式错误都抛错，由调用方决定怎么报。 */
export function readJsonFile(file) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (err) {
    throw new Error(`配置文件不存在或不可读: ${file}（${err.code || err.message}）`)
  }
  try {
    return JSON.parse(text)
  } catch (err) {
    throw new Error(`无法解析配置 ${file}: ${err.message}`)
  }
}

export const AFK_CONFIG_FILENAME = 'config.json'

/** 配置分区：`task` 由 watch/run 共用，其余各归其主。 */
export const AFK_SECTIONS = ['task', 'watch', 'run', 'execReview']

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

/** 递归合并普通对象；数组与标量按后者覆盖。 */
export function deepMerge(...objs) {
  const out = {}
  for (const obj of objs) {
    if (!isPlainObject(obj)) continue
    for (const [key, value] of Object.entries(obj)) {
      out[key] =
        isPlainObject(value) && isPlainObject(out[key]) ? deepMerge(out[key], value) : value
    }
  }
  return out
}

/**
 * 解析要加载的配置文件列表（先全局后项目；显式 --config 则只读该文件）。
 * @returns {{ files: string[], projectKey: string, projectName: string, uid: string, layers: object[] }}
 */
export function resolveAfkConfigFiles(workdir, configPath = '') {
  const project = resolveProjectConfigDir(workdir)
  const base = {
    projectKey: project.projectKey,
    projectName: project.projectKey,
    uid: project.uid,
  }
  if (configPath) {
    const file = resolve(configPath)
    return { ...base, files: [file], layers: [readJsonFile(file)] }
  }
  const home = afkHomeRoot()
  const files = []
  const globalFile = join(home, AFK_CONFIG_FILENAME)
  if (existsSync(globalFile)) files.push(globalFile)
  const projectFile = join(project.dir, AFK_CONFIG_FILENAME)
  if (existsSync(projectFile)) files.push(projectFile)
  return { ...base, files, layers: files.map(readJsonFile) }
}

/** 从各层取出指定分区并递归合并：项目层覆盖全局层，层内的嵌套对象也合并。 */
export function sectionsFrom(layers, names) {
  const out = {}
  for (const name of names) {
    out[name] = deepMerge(...layers.map((layer) => (isPlainObject(layer) ? layer[name] : undefined)))
  }
  return out
}

/**
 * 读配置并返回指定分区。
 * @returns {{ sections: object, files: string[], layers: object[], projectKey: string, uid: string }}
 */
export function resolveAfkSections(workdir, names, configPath = '') {
  const base = resolveAfkConfigFiles(workdir, configPath)
  return { ...base, sections: sectionsFrom(base.layers, names) }
}

/**
 * 同 resolveAfkSections，但**没有配置文件就直接报错**（不做内置兜底）。
 * AFK 系列一律要求先跑 afk-init（或显式 --config），避免静默地用错任务源 / runner。
 */
export function requireAfkSections(workdir, names, configPath = '') {
  const resolved = resolveAfkSections(workdir, names, configPath)
  if (resolved.files.length) return resolved
  const home = afkHomeRoot()
  const project = resolveProjectConfigDir(workdir)
  const err = new Error(
    [
      '未找到 AFK 配置，已查：',
      `  ${join(home, AFK_CONFIG_FILENAME)}`,
      `  ${join(project.dir, AFK_CONFIG_FILENAME)}`,
      '生成： node <afk-init>/scripts/init-project.mjs --workdir <目录> --source <beads|gh|tapd>',
      '或指定： --config <一份 config.json>',
    ].join('\n'),
  )
  err.code = 'AFK_CONFIG_MISSING'
  throw err
}

function printCliHelp() {
  process.stdout.write(`Usage:
  node afk-home.mjs --project-key <workdir> [--label <name>]
  node afk-home.mjs --project-uid <workdir>
  node afk-home.mjs --afk-home
`)
}

/** CLI：供 afk-init/scripts/init-project.mjs 等调用，保证与 runtime 同一套键算法。 */
export function runAfkHomeCli(argv = process.argv.slice(2)) {
  if (argv.includes('-h') || argv.includes('--help') || argv.length === 0) {
    printCliHelp()
    return 0
  }
  if (argv[0] === '--afk-home') {
    process.stdout.write(afkHomeRoot() + '\n')
    return 0
  }
  if (argv[0] === '--project-uid') {
    const workdir = argv[1]
    if (!workdir) {
      printCliHelp()
      return 2
    }
    process.stdout.write(projectUidFromWorkdir(workdir) + '\n')
    return 0
  }
  if (argv[0] === '--project-key') {
    const workdir = argv[1]
    if (!workdir) {
      printCliHelp()
      return 2
    }
    let label = ''
    const labelIdx = argv.indexOf('--label')
    if (labelIdx >= 0) label = argv[labelIdx + 1] || ''
    process.stdout.write(projectKeyFromWorkdir(workdir, label) + '\n')
    return 0
  }
  printCliHelp()
  return 2
}

const isMain =
  process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])
if (isMain) {
  process.exitCode = runAfkHomeCli()
}
