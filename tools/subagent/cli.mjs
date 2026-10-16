#!/usr/bin/env node
// 按 pstack 角色表起一个或多个 agent turn。
//
// 这一层只做三件事：读角色表、把角色解析成 (runner, provider, model, thinking)、
// 有界并发地把臂跑完并按真实证据判定结果。它不决定任务是否合格，也不提交。
import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { realpathSync, writeFileSync } from 'node:fs'

import { RUNNERS, capabilities } from '../../lib/agent-run/runners/index.mjs'
import {
  loadRoleTable,
  parseModelList,
  parseRoleTable,
  resolveArm,
  resolveProvider,
  roleLookup,
  roleNames,
  runArms,
  summarize,
} from '../../lib/subagent/index.mjs'

const USAGE = `subagent - run one or more agent turns from a pstack role table

  run --role <name> --prompt-file <file> --out-dir <new-dir>
      [--roles-file <path>] [--runner pi|codex|agent] [--provider <id>]
      [--model <id>] [--thinking <level>] [--sandbox <mode>]
      [--workdir <dir>] [--timeout <ms>] [--bin <path>] [--models-file <file>]

  run --manifest <arms.json> --out-dir <new-dir> [--concurrency <n>]
      [same options as above; the manifest wins for every key it sets]

  plan --role <name> [--role <name> ...] [--roles-file <path>] [--runner ...]
       [--models-file <file>] [--workdir <dir>]

  roles  [--roles-file <path>]
  models --runner pi [--bin <path>]

Role table defaults to ~/.agents/pstack-models.md, then
~/.cursor/rules/pstack-models.mdc. A value in the table is a pstack slug:
the effort token is the last one, or the one before a trailing -fast.
auto and inherit-parent mean "run on the parent model".

# runner: <pi|codex|agent> may be declared as a comment in the table. The
default runner is pi (that is where pstack needs this most); name the runner
per arm in the manifest for a cross-vendor panel.

--provider is resolved from the runner's model list when exactly one provider
serves that model id. An ambiguous id is rejected, never guessed.

--out-dir must be new. Each arm gets <out-dir>/<label>/. The run prints one JSON
object with per-arm facts and a status of ok, empty, error, timeout or aborted.
status comes from events.jsonl and output.txt; the child exit code is reported
but never decides status. Exit: 0 all arms ok, 1 some arm not ok, 2 invalid.
`

const STATUS_ORDER = ['ok', 'empty', 'error', 'timeout', 'aborted']

class UsageError extends Error {
  constructor(message) {
    super(message)
    this.exitCode = 2
  }
}

function invalid(message) {
  throw new UsageError(message)
}

function takeValue(rest, i, flag) {
  const value = rest[i + 1]
  if (value === undefined || value.startsWith('--')) invalid(`Missing value for ${flag}`)
  return value
}

const RUN_FLAGS = {
  '--role': 'role',
  '--prompt-file': 'promptFile',
  '--out-dir': 'outDir',
  '--roles-file': 'rolesFile',
  '--runner': 'runner',
  '--provider': 'provider',
  '--model': 'model',
  '--thinking': 'thinking',
  '--sandbox': 'sandbox',
  '--workdir': 'workdir',
  '--timeout': 'timeout',
  '--bin': 'bin',
  '--models-file': 'modelsFile',
  '--manifest': 'manifest',
  '--concurrency': 'concurrency',
  '--label': 'label',
}

function parseFlags(rest, allowed) {
  const options = {}
  for (let i = 0; i < rest.length; i++) {
    const key = allowed[rest[i]]
    if (!key) invalid(`Unknown option: ${rest[i]}`)
    if (Object.hasOwn(options, key)) invalid(`Duplicate option: ${rest[i]}`)
    options[key] = takeValue(rest, i, rest[i])
    i++
  }
  return options
}

function parseRun(rest) {
  const options = { command: 'run', approve: true }
  const parsed = parseFlags(rest, RUN_FLAGS)
  for (const [key, value] of Object.entries(parsed)) if (value !== undefined) options[key] = value
  if (!options.outDir) invalid('Missing --out-dir')
  if (!options.manifest) {
    if (!options.role && !options.model && !options.thinking && !options.provider) {
      invalid('Missing --role (or name a model directly with --model / --thinking / --provider)')
    }
    if (!options.promptFile) invalid('Missing --prompt-file (or use --manifest)')
  }
  if (options.manifest && (options.role || options.promptFile)) {
    invalid('--manifest owns --role and --prompt-file; pass overrides there instead')
  }
  // 重复的 --role 是合法的（面板角色一个取值一臂），所以单独收集。
  options.roles = []
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--role') options.roles.push(takeValue(rest, i, '--role'))
  }
  if (options.runner !== undefined && !RUNNERS.includes(options.runner)) {
    invalid(`Invalid --runner: ${options.runner}`)
  }
  for (const key of ['timeout', 'concurrency']) {
    if (options[key] === undefined) continue
    const value = Number(options[key])
    if (!Number.isInteger(value) || value <= 0) invalid(`--${key} must be a positive integer`)
    options[key] = value
  }
  return options
}

function parsePlan(rest) {
  const options = { command: 'plan', roles: [] }
  const allowed = {
    '--role': 'role',
    '--roles-file': 'rolesFile',
    '--runner': 'runner',
    '--workdir': 'workdir',
    '--models-file': 'modelsFile',
    '--bin': 'bin',
  }
  for (let i = 0; i < rest.length; i++) {
    const key = allowed[rest[i]]
    if (!key) invalid(`Unknown option: ${rest[i]}`)
    const value = takeValue(rest, i, rest[i])
    if (key === 'role') options.roles.push(value)
    else options[key] = value
    i++
  }
  if (options.roles.length === 0) invalid('Missing --role')
  if (options.runner !== undefined && !RUNNERS.includes(options.runner)) {
    invalid(`Invalid --runner: ${options.runner}`)
  }
  return options
}

function parseArgs(argv) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return { command: 'help' }
  const [command, ...rest] = argv
  if (command === 'run') return parseRun(rest)
  if (command === 'plan') return parsePlan(rest)
  if (command === 'roles') {
    const options = parseFlags(rest, { '--roles-file': 'rolesFile' })
    return { command: 'roles', ...options }
  }
  if (command === 'models') {
    const options = parseFlags(rest, { '--runner': 'runner', '--bin': 'bin' })
    return { command: 'models', runner: options.runner || 'pi', bin: options.bin }
  }
  invalid('Expected run, plan, roles or models; use --help')
}

const LABEL_PATTERN = /^[A-Za-z0-9._-]+$/

function checkLabel(label) {
  if (!LABEL_PATTERN.test(label)) invalid(`臂名只能含字母、数字、. _ -：${label}`)
  return label
}

function requireNewPath(path, label) {
  if (existsSync(path)) invalid(`${label} already exists: ${path}`)
}

function readTable(options) {
  const loaded = loadRoleTable({ file: options.rolesFile })
  if (options.rolesFile && !loaded.file) invalid(`找不到角色表：${options.rolesFile}`)
  const table = parseRoleTable(loaded.text)
  return { ...table, file: loaded.file }
}

function loadModels(options) {
  if (options.modelsFile) {
    if (!existsSync(options.modelsFile)) invalid(`--models-file is not readable: ${options.modelsFile}`)
    return { models: parseModelList(readFileSync(options.modelsFile, 'utf8')), source: options.modelsFile }
  }
  if (options.runner !== 'pi') return { models: [], source: null }
  const bin = options.bin || 'pi'
  const result = spawnSync(bin, ['--list-models'], { encoding: 'utf8', windowsHide: true })
  if (result.error || result.status !== 0) return { models: [], source: null, error: `无法运行 ${bin} --list-models` }
  return { models: parseModelList(result.stdout || ''), source: `${bin} --list-models` }
}

/** provider 只能猜错，不能猜。pi 以外不传 provider；pi 里多义就必须显式指定。 */
function applyProvider(arm, models) {
  if (arm.provider && arm.runner !== 'pi') invalid(`runner ${arm.runner} 不支持 --provider（只有 pi 有）`)
  if (arm.runner !== 'pi' || !arm.model) return arm
  const resolved = resolveProvider({ model: arm.model, provider: arm.provider, models })
  if (resolved.candidates) {
    invalid(`模型 ${arm.model} 同时挂在 ${resolved.candidates.join(', ')} 下，请显式指定 --provider`)
  }
  return { ...arm, provider: resolved.provider, providerSource: resolved.source }
}

function resolveOneRole(role, index, override, table, defaultRunner) {
  const values = roleLookup(table, role)
  if (!values) {
    const names = roleNames(table)
    invalid(`角色表里没有 “${role}”；候选：${names.length ? names.join(', ') : '(表里没有任何角色)'}`)
  }
  return resolveArm({ role, values, index, override, defaultRunner })
}

/** 面板角色一个取值一臂，所以展开后才知道扇出到底多大。 */
function expandRole(role, override, table, defaultRunner) {
  const values = roleLookup(table, role)
  if (!values) {
    const names = roleNames(table)
    invalid(`角色表里没有 “${role}”；候选：${names.length ? names.join(', ') : '(表里没有任何角色)'}`)
  }
  return values.map((_, index) => resolveArm({ role, values, index, override, defaultRunner }))
}

function sanitizeLabel(text) {
  return String(text).trim().replace(/[^A-Za-z0-9._-]+/g, '-')
}

/** 命令行直给一臂。多个 --role 交给 manifest，避免和 --prompt-file 配对不明。 */
function buildSingleArm(options, table, models, override, defaultRunner) {
  if (options.roles.length > 1) invalid('多个 --role 请用 --manifest：一臂一个 prompt 文件')
  let arm
  if (options.roles.length === 1) {
    arm = resolveOneRole(options.roles[0], 0, override, table, defaultRunner)
  } else {
    // 没有角色表也能用：直接给模型旋钮，不依赖 pstack。
    if (!override.model && !override.thinking && !override.provider) {
      invalid('没有 --role 时，至少要给 --model、--thinking 或 --provider 之一')
    }
    arm = resolveArm({ role: '(inline)', values: undefined, override, defaultRunner })
  }
  arm.promptFile = resolve(options.promptFile)
  arm.workdir = resolve(options.workdir || process.cwd())
  arm.label = checkLabel(options.label || sanitizeLabel(options.roles[0] || 'inline'))
  return [applyProvider(arm, models)]
}

/** manifest 模式：一臂一个 label 与 prompt，面板角色按取值顺序分派。 */
function buildManifestArms(options, table, models, override, defaultRunner) {
  const manifestPath = resolve(options.manifest)
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    invalid(`--manifest 不可读或不是 JSON：${error.message}`)
  }
  if (!Array.isArray(manifest.arms) || manifest.arms.length === 0) {
    invalid('--manifest 需要一个非空的 arms 数组')
  }
  const base = dirname(manifestPath)
  const perRoleIndex = new Map()
  const arms = manifest.arms.map((raw, i) => {
    const role = raw.role || manifest.role || '(inline)'
    const index = perRoleIndex.get(role) || 0
    perRoleIndex.set(role, index + 1)
    const armOverride = {
      runner: raw.runner || manifest.runner || override.runner,
      provider: raw.provider || manifest.provider || override.provider,
      model: raw.model || manifest.model || override.model,
      thinking: raw.thinking || manifest.thinking || override.thinking,
      sandbox: raw.sandbox || manifest.sandbox || override.sandbox,
    }
    const arm =
      role === '(inline)'
        ? resolveArm({ role, values: undefined, override: armOverride, defaultRunner })
        : resolveOneRole(role, index, armOverride, table, defaultRunner)
    if (role === '(inline)' && !armOverride.model && !armOverride.thinking && !armOverride.provider) {
      invalid(`arms[${i}] 既没有 role，也没有 model / thinking / provider`)
    }
    const promptFile = raw.promptFile || raw.prompt_file
    if (!promptFile && !raw.prompt) invalid(`arms[${i}] 既没有 promptFile 也没有 prompt`)
    arm.promptFile = promptFile ? resolve(base, promptFile) : undefined
    arm.prompt = raw.prompt
    arm.workdir = resolve(raw.workdir || manifest.workdir || options.workdir || process.cwd())
    arm.label = checkLabel(raw.label || `${sanitizeLabel(role)}-${i + 1}`)
    return applyProvider(arm, models)
  })
  return { arms, concurrency: manifest.concurrency }
}

async function run(options) {
  const outDir = resolve(options.outDir)
  requireNewPath(outDir, '--out-dir')
  const table = readTable(options)
  const loaded = loadModels(options)
  const defaultRunner = options.runner || table.runner || 'pi'
  const override = {
    runner: options.runner,
    provider: options.provider,
    model: options.model,
    thinking: options.thinking,
    sandbox: options.sandbox,
  }
  const built = options.manifest
    ? buildManifestArms(options, table, loaded.models, override, defaultRunner)
    : { arms: buildSingleArm(options, table, loaded.models, override, defaultRunner), concurrency: undefined }
  const concurrency = options.concurrency || built.concurrency || 1
  const results = await runArms({
    arms: built.arms,
    outDir,
    concurrency,
    timeoutMs: options.timeout,
    bin: options.bin,
  })
  const reportFile = join(outDir, 'report.jsonl')
  writeFileSync(reportFile, `${results.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8')
  const summary = summarize(results)
  return {
    result: {
      outDir,
      reportFile,
      rolesFile: table.file,
      runner: defaultRunner,
      modelsSource: loaded.source,
      concurrency,
      ...summary,
      arms: results.map((record) => ({
        label: record.label,
        role: record.role,
        runner: record.runner,
        provider: record.provider,
        model: record.model,
        thinking: record.thinking,
        status: record.status,
        stopReason: record.stopReason,
        chars: record.chars,
        tokens: record.tokens,
        outputFile: record.outputFile,
      })),
    },
    exitCode: summary.ok === results.length ? 0 : 1,
  }
}

function plan(options) {
  const table = readTable(options)
  const loaded = loadModels(options)
  const defaultRunner = options.runner || table.runner || 'pi'
  const arms = options.roles.flatMap((role) =>
    expandRole(role, { runner: options.runner }, table, defaultRunner).map((arm) => applyProvider(arm, loaded.models)),
  )
  return {
    result: {
      rolesFile: table.file,
      budget: table.budget,
      runner: defaultRunner,
      modelsSource: loaded.source,
      arms: arms.map((arm) => ({
        role: arm.role,
        slug: arm.slug,
        alias: arm.alias,
        runner: arm.runner,
        provider: arm.provider,
        providerSource: arm.providerSource,
        model: arm.model,
        thinking: arm.thinking,
        fast: arm.fast,
        sources: arm.sources,
      })),
    },
    exitCode: 0,
  }
}

function listRoles(options) {
  const table = readTable(options)
  return {
    result: { rolesFile: table.file, budget: table.budget, count: table.entries.length, entries: table.entries, errors: table.errors },
    exitCode: 0,
  }
}

function listModels(options) {
  const bin = options.bin || 'pi'
  const result = spawnSync(bin, ['--list-models'], { encoding: 'utf8', windowsHide: true })
  if (result.error) {
    const error = new Error(`无法运行 ${bin} --list-models：${result.error.message}`)
    error.exitCode = 1
    throw error
  }
  if (result.status !== 0) {
    const error = new Error(`${bin} --list-models 退出 ${result.status}：${(result.stderr || '').trim()}`)
    error.exitCode = 1
    throw error
  }
  const models = parseModelList(result.stdout || '')
  return { result: { runner: options.runner, count: models.length, models }, exitCode: 0 }
}

export async function runCli(argv, io = {}) {
  const stdout = io.stdout || ((text) => process.stdout.write(text))
  const stderr = io.stderr || ((text) => process.stderr.write(text))
  try {
    const options = parseArgs(argv)
    if (options.command === 'help') {
      stdout(USAGE)
      return 0
    }
    const outcome =
      options.command === 'run'
        ? await run(options)
        : options.command === 'plan'
          ? plan(options)
          : options.command === 'roles'
            ? listRoles(options)
            : listModels(options)
    stdout(`${JSON.stringify(outcome.result)}\n`)
    return outcome.exitCode
  } catch (error) {
    stderr(`${JSON.stringify({ status: 'error', error: error.message })}\n`)
    return error.exitCode || 1
  }
}

let invokedDirectly = false
try {
  invokedDirectly =
    Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
} catch {
  /* An importing host may use a non-file argv[1]. */
}
if (invokedDirectly) {
  process.exitCode = await runCli(process.argv.slice(2))
}
