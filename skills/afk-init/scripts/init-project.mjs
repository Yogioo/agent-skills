#!/usr/bin/env node
/**
 * 非交互写入 ~/.afk 配置（afk-init 技能脚本；需显式加载该技能后使用）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  afkHomeRoot,
  projectKeyFromWorkdir,
  projectUidFromWorkdir,
  resolveProjectConfigDir,
} from '../../afk-run/scripts/afk-home.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SKILL_ROOT = resolve(__dirname, '..')
const EXAMPLE = resolve(SKILL_ROOT, 'config.example.json')

function usage(code = 0) {
  process.stdout.write(`Usage:
  node init-project.mjs --workdir <dir> --source beads|gh|tapd [options]
  node init-project.mjs --scope global --source beads|gh|tapd [options]

Options:
  --scope project|global   default project (requires --workdir)
  --label <name>           project folder label (default: workdir basename)
  --repo owner/name        GitHub repo (gh)
  --tapd-assignee <name>   TAPD 处理人（tapd，必填）
  --tapd-ready-label <l>   TAPD 队列标签（默认 ready-for-agent）
  --tapd-claimed-label <l> TAPD 认领标签（默认 afk-claimed）
  --tapd-delivered-label <l> TAPD 交付标签（默认 afk-delivered）
  --tapd-failed-label <l>  TAPD 失败标签（默认 afk-failed）
  --tapd-comment-author <name> TAPD 评论 author（默认沿用 tapd-cli）
  --force                  overwrite existing config.json
  --serve-open             serve.open = true
  --allow-dirty            task.allowDirty = true
  --dry-run                print plan only
`)
  process.exit(code)
}

function parseArgs(argv) {
  const out = {
    workdir: '',
    source: '',
    scope: 'project',
    label: '',
    repo: '',
    force: false,
    serveOpen: false,
    allowDirty: false,
    dryRun: false,
    tapd: {},
  }
  const next = (i) => {
    if (i + 1 >= argv.length) usage(2)
    return argv[i + 1]
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    switch (a) {
      case '-h':
      case '--help':
        usage(0)
        break
      case '--workdir':
        out.workdir = next(i)
        i++
        break
      case '--source':
        out.source = next(i)
        i++
        break
      case '--scope':
        out.scope = next(i)
        i++
        break
      case '--label':
        out.label = next(i)
        i++
        break
      case '--repo':
        out.repo = next(i)
        i++
        break
      case '--force':
        out.force = true
        break
      case '--serve-open':
        out.serveOpen = true
        break
      case '--allow-dirty':
        out.allowDirty = true
        break
      case '--dry-run':
        out.dryRun = true
        break
      case '--tapd-assignee':
        out.tapd.assignee = next(i)
        i++
        break
      case '--tapd-ready-label':
        out.tapd.readyLabel = next(i)
        i++
        break
      case '--tapd-claimed-label':
        out.tapd.claimedLabel = next(i)
        i++
        break
      case '--tapd-delivered-label':
        out.tapd.deliveredLabel = next(i)
        i++
        break
      case '--tapd-failed-label':
        out.tapd.failedLabel = next(i)
        i++
        break
      case '--tapd-comment-author':
        out.tapd.commentAuthor = next(i)
        i++
        break
      default:
        console.error(`未知参数: ${a}`)
        usage(2)
    }
  }
  return out
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function writeJson(path, data) {
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
}

function requireAtomicForSource(source) {
  return source === 'beads'
}

/** 把 example 的分区改写成一份 config.json。 */
function buildConfig(base, opts) {
  const cfg = structuredClone(base)
  const task = (cfg.task = cfg.task || {})
  const watch = (cfg.watch = cfg.watch || {})
  const run = (cfg.run = cfg.run || {})

  task.source = opts.source
  task.maxTasks = 1
  task.allowDirty = Boolean(opts.allowDirty)
  if (opts.repo) task.repo = opts.repo
  if (opts.source === 'tapd') {
    // 只覆盖显式传入的键；其余沿用 example 里的标签默认值。
    task.tapd = {
      ...(task.tapd || {}),
      ...Object.fromEntries(Object.entries(opts.tapd || {}).filter(([, v]) => v != null && v !== '')),
    }
  } else {
    // 别的任务源不该带着一块空的 tapd 配置。
    delete task.tapd
  }

  // requireAtomicClaim 只在 beads 为 true；gh/tapd 是 best-effort。
  watch.requireAtomicClaim = requireAtomicForSource(opts.source)
  watch.serve = { ...(watch.serve || {}), open: Boolean(opts.serveOpen) }
  run.serve = { ...(run.serve || {}), open: Boolean(opts.serveOpen) }
  return cfg
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.source || !['beads', 'gh', 'tapd'].includes(args.source)) {
    console.error('--source 必传且为 beads|gh|tapd')
    usage(2)
  }
  if (args.scope !== 'project' && args.scope !== 'global') {
    console.error('--scope 必须是 project 或 global')
    usage(2)
  }
  if (args.scope === 'project' && !args.workdir) {
    console.error('project 范围需要 --workdir')
    usage(2)
  }
  if (!existsSync(EXAMPLE)) {
    console.error('找不到 afk-init/config.example.json')
    process.exit(2)
  }

  const home = afkHomeRoot()
  let afkDir = home
  let projectKey = ''
  let uid = ''
  let workdir = ''

  if (args.scope === 'project') {
    workdir = resolve(args.workdir)
    if (!existsSync(workdir)) {
      console.error(`workdir 不存在: ${workdir}`)
      process.exit(2)
    }
    uid = projectUidFromWorkdir(workdir)
    projectKey = projectKeyFromWorkdir(workdir, args.label)
    // 若已有同 UID 自定义目录，复用（与 runtime 一致）
    const resolved = resolveProjectConfigDir(workdir)
    if (existsSync(join(resolved.dir, 'config.json'))) {
      afkDir = resolved.dir
      projectKey = resolved.projectKey
    } else {
      afkDir = join(home, projectKey)
    }
  }

  const configOut = join(afkDir, 'config.json')
  const metaOut = join(afkDir, 'meta.json')

  if (!args.dryRun && !args.force && existsSync(configOut)) {
    console.error(`已有配置: ${configOut}（加 --force 覆盖）`)
    process.exit(2)
  }

  const config = buildConfig(readJson(EXAMPLE), args)
  const requireAtomicClaim = config.watch.requireAtomicClaim
  // 旧版按技能分开的文件已不再加载
  const legacyFiles = ['run.json', 'watch.json'].filter((f) => existsSync(join(afkDir, f)))
  const meta = {
    workdir: workdir || '',
    projectKey,
    label: args.label || '',
    uid,
    scope: args.scope,
    source: args.source,
    requireAtomicClaim,
    updatedAt: new Date().toISOString(),
  }

  const summary = {
    scope: args.scope,
    source: args.source,
    requireAtomicClaim,
    afkHome: home,
    afkDir,
    projectKey,
    uid,
    workdir: workdir || null,
    files: { config: configOut, meta: args.scope === 'project' ? metaOut : null },
    legacyFiles,
  }

  if (args.dryRun) {
    process.stdout.write(JSON.stringify({ dryRun: true, ...summary, config, meta }, null, 2) + '\n')
    return
  }

  mkdirSync(afkDir, { recursive: true })
  writeJson(configOut, config)
  if (args.scope === 'project') writeJson(metaOut, meta)

  if (legacyFiles.length) {
    console.error(`注意：${afkDir} 下的 ${legacyFiles.join(' / ')} 已不再加载，请确认后删除。`)
  }

  process.stdout.write(JSON.stringify({ ok: true, ...summary }, null, 2) + '\n')
}

main()
