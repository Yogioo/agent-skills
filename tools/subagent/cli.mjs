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

import { CAPABILITIES, RUNNERS, capabilities } from '../../lib/agent-run/runners/index.mjs'
import { resolveBin } from '../../lib/agent-run/runners/resolve-bin.mjs'
import {
  BUDGET_EFFORT,
  CANONICAL_ROLES,
  CANONICAL_ROLE_GROUPS,
  PROBE_THINKING,
  SAFE_ROLE_VALUE,
  diagnose,
  loadRoleTable,
  parseModelList,
  parseRoleTable,
  planProbes,
  renderRoleTable,
  resolveArm,
  resolveProvider,
  roleLookup,
  roleNames,
  runArms,
  runProbes,
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
  doctor [--roles-file <path>] [--models-file <file>] [--runner pi] [--bin <path>]

  init [--out <path>] [--budget large] [--runner pi] [--value inherit-parent] [--force]

  probe --out-dir <new-dir> [--role <name> ...] [--model <slug> ...]
        [--roles-file <path>] [--models-file <file>] [--runner pi] [--bin <path>]
        [--thinking low] [--concurrency 4] [--timeout <ms>] [--workdir <dir>]

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

doctor checks a role table against the runner's model list and pstack's
canonical role names. It only reads and reports. Exit: 0 no errors,
1 findings include errors, 2 invalid.

init writes a valid role table. Every role starts on inherit-parent, which runs
on the parent chat's model, so the table is usable before you know which models
this machine can reach. An existing --out needs --force.

probe runs one cheap read-only turn per distinct target and reports which ones
actually worked. Model ids existing in the model list is not evidence: a provider
with no subscription answers 403. With no --role and no --model it probes every
distinct value in the table. Exit: 0 every target ok, 1 some target not ok, 2 invalid.
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
    '--sandbox': 'sandbox',
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

function parseInit(rest) {
  const options = { command: 'init', budget: 'large', runner: 'pi', value: SAFE_ROLE_VALUE, force: false }
  const seen = new Set()
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]
    if (flag === '--force') {
      options.force = true
      continue
    }
    const key = { '--out': 'out', '--budget': 'budget', '--runner': 'runner', '--value': 'value' }[flag]
    if (!key) invalid(`Unknown option: ${flag}`)
    // 不能拿 options 自己判重：budget/runner/value 有默认值，永远存在。
    if (seen.has(key)) invalid(`Duplicate option: ${flag}`)
    seen.add(key)
    options[key] = takeValue(rest, i, flag)
    i++
  }
  if (!options.out) invalid('Missing --out')
  if (!BUDGET_EFFORT[options.budget]) {
    invalid(`未知 --budget ${options.budget}（可选：${Object.keys(BUDGET_EFFORT).join(' / ')}）`)
  }
  if (!RUNNERS.includes(options.runner)) invalid(`Invalid --runner: ${options.runner}`)
  return options
}

function parseProbe(rest) {
  const options = { command: 'probe', roles: [], models: [] }
  const allowed = {
    '--out-dir': 'outDir',
    '--roles-file': 'rolesFile',
    '--models-file': 'modelsFile',
    '--runner': 'runner',
    '--bin': 'bin',
    '--thinking': 'thinking',
    '--concurrency': 'concurrency',
    '--timeout': 'timeout',
    '--workdir': 'workdir',
    '--role': 'role',
    '--model': 'model',
  }
  for (let i = 0; i < rest.length; i++) {
    const key = allowed[rest[i]]
    if (!key) invalid(`Unknown option: ${rest[i]}`)
    const value = takeValue(rest, i, rest[i])
    if (key === 'role') options.roles.push(value)
    else if (key === 'model') options.models.push(value)
    else {
      if (Object.hasOwn(options, key)) invalid(`Duplicate option: ${rest[i]}`)
      options[key] = value
    }
    i++
  }
  if (!options.outDir) invalid('Missing --out-dir')
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

function parseArgs(argv) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return { command: 'help' }
  const [command, ...rest] = argv
  if (command === 'run') return parseRun(rest)
  if (command === 'plan') return parsePlan(rest)
  if (command === 'init') return parseInit(rest)
  if (command === 'probe') return parseProbe(rest)
  if (command === 'roles') {
    const options = parseFlags(rest, { '--roles-file': 'rolesFile' })
    return { command: 'roles', ...options }
  }
  if (command === 'models') {
    const options = parseFlags(rest, { '--runner': 'runner', '--bin': 'bin' })
    return { command: 'models', runner: options.runner || 'pi', bin: options.bin }
  }
  if (command === 'doctor') {
    const options = parseFlags(rest, {
      '--roles-file': 'rolesFile',
      '--models-file': 'modelsFile',
      '--runner': 'runner',
      '--bin': 'bin',
    })
    return { command: 'doctor', ...options }
  }
  invalid('Expected run, plan, roles, models or doctor; use --help')
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
  return { ...table, file: loaded.file, tried: loaded.tried }
}

/** Windows 上 npm 装的是 .cmd/.ps1 壳，直接 spawn 会 EINVAL；用仓库已有的解析器。 */
function runBin(bin, args) {
  const resolved = resolveBin(bin, { knownName: bin })
  return spawnSync(resolved.command, [...(resolved.argsPrefix || []), ...args], {
    encoding: 'utf8',
    windowsHide: true,
    shell: resolved.shell === true,
  })
}

function loadModels(options, runner = options.runner) {
  if (options.modelsFile) {
    if (!existsSync(options.modelsFile)) invalid(`--models-file is not readable: ${options.modelsFile}`)
    return { models: parseModelList(readFileSync(options.modelsFile, 'utf8')), source: options.modelsFile }
  }
  if (runner !== 'pi') return { models: [], source: null }
  const bin = options.bin || 'pi'
  const result = runBin(bin, ['--list-models'])
  if (result.error || result.status !== 0) return { models: [], source: null, error: `无法运行 ${bin} --list-models` }
  return { models: parseModelList(result.stdout || ''), source: `${bin} --list-models` }
}

/**
 * provider 只能猜错，不能猜；sandbox 拼错会静默放权，所以两个都必须在起臂前挡掉。
 * 实测：`--sandbox red-only` 本来会落到 runner 的默认放权模式。
 */
function finalizeArm(arm, models) {
  const caps = CAPABILITIES[arm.runner]
  if (!caps) invalid(`未知 runner: ${arm.runner}`)
  if (arm.sandbox !== undefined && !caps.sandboxModes.includes(arm.sandbox)) {
    invalid(`runner ${arm.runner} 不支持 --sandbox ${arm.sandbox}（可选：${caps.sandboxModes.join(' / ')}）`)
  }
  if (arm.provider && arm.runner !== 'pi') invalid(`runner ${arm.runner} 不支持 --provider（只有 pi 有）`)
  if (arm.runner !== 'pi' || !arm.model) return arm
  const resolved = resolveProvider({ model: arm.model, provider: arm.provider, models })
  if (resolved.candidates) {
    invalid(
      `模型 ${arm.model} 同时挂在 ${resolved.candidates.join(', ')} 下，请写成 <provider>/${arm.model} 或显式指定 --provider`,
    )
  }
  return { ...arm, provider: resolved.provider, model: resolved.model ?? arm.model, providerSource: resolved.source }
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
  return [finalizeArm(arm, models)]
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
    return finalizeArm(arm, models)
  })
  return { arms, concurrency: manifest.concurrency }
}

async function run(options) {
  const outDir = resolve(options.outDir)
  requireNewPath(outDir, '--out-dir')
  const table = readTable(options)
  const defaultRunner = options.runner || table.runner || 'pi'
  const loaded = loadModels(options, defaultRunner)
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
  const defaultRunner = options.runner || table.runner || 'pi'
  const loaded = loadModels(options, defaultRunner)
  const arms = options.roles.flatMap((role) =>
    expandRole(role, { runner: options.runner, sandbox: options.sandbox }, table, defaultRunner).map((arm) =>
      finalizeArm(arm, loaded.models),
    ),
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
    result: {
      rolesFile: table.file,
      budget: table.budget,
      runner: table.runner || null,
      count: table.entries.length,
      entries: table.entries,
      errors: table.errors,
    },
    exitCode: 0,
  }
}

/** 只读体检。exit 1 表示有 error 级发现。 */
function doctor(options) {
  const table = readTable(options)
  const defaultRunner = options.runner || table.runner || 'pi'
  const loaded = loadModels(options, defaultRunner)
  const report = diagnose({
    table,
    models: loaded.models,
    runner: defaultRunner,
    rolesFile: table.file,
    modelsSource: loaded.source,
    modelsError: loaded.error,
    parseErrors: table.errors,
    triedPaths: table.tried,
  })
  return { result: { ...report, formatFailures: report.findings.filter((item) => item.level !== 'info').length }, exitCode: report.ok ? 0 : 1 }
}

function listModels(options) {
  const bin = options.bin || 'pi'
  const result = runBin(bin, ['--list-models'])
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

/** 写一张开箱合法的表：所有角色先钉在父会话模型上。 */
function init(options) {
  const out = resolve(options.out)
  if (existsSync(out) && !options.force) invalid(`--out 已存在：${out}（要覆盖就加 --force）`)
  writeFileSync(out, renderRoleTable({ budget: options.budget, runner: options.runner, value: options.value }), 'utf8')
  return {
    result: {
      out,
      budget: options.budget,
      runner: options.runner,
      value: options.value,
      lines: CANONICAL_ROLE_GROUPS.length,
      roles: CANONICAL_ROLES.length,
    },
    exitCode: 0,
  }
}

/**
 * 实测哪些模型真能跑。没有 --role 也没有 --model 时，探表里所有去重后的真实目标。
 */
async function probe(options) {
  const outDir = resolve(options.outDir)
  requireNewPath(outDir, '--out-dir')
  const defaultRunner = options.runner || 'pi'
  const loaded = loadModels(options, defaultRunner)
  const values = []
  const candidates = options.models.map((model) => ({ model }))
  let table = null
  if (options.roles.length > 0 || options.models.length === 0) {
    table = readTable(options)
    if (options.roles.length > 0) {
      for (const role of options.roles) {
        const resolved = roleLookup(table, role)
        if (!resolved) {
          const names = roleNames(table)
          invalid(`角色表里没有 “${role}”；候选：${names.length ? names.join(', ') : '(表里没有任何角色)'}`)
        }
        values.push(...resolved)
      }
    } else {
      for (const entry of table.entries) values.push(...entry.values)
    }
  }
  const { targets, unresolved } = planProbes({
    values,
    candidates,
    models: loaded.models,
    runner: defaultRunner,
    thinking: options.thinking || PROBE_THINKING,
  })
  if (targets.length === 0) {
    return {
      result: {
        ok: unresolved.length === 0,
        outDir,
        reportFile: null,
        rolesFile: table ? table.file : null,
        modelsSource: loaded.source,
        runner: defaultRunner,
        note:
          unresolved.length > 0
            ? '没有可探测的目标：候选都没能在模型清单里定出 provider。'
            : '没有可探测的目标：表里全是 inherit-parent，它们跟着父会话模型走。',
        unresolved,
        probes: [],
        usable: [],
        unusable: [],
      },
      exitCode: unresolved.length === 0 ? 0 : 1,
    }
  }
  const outcome = await runProbes({
    targets,
    outDir,
    concurrency: options.concurrency || 4,
    workdir: options.workdir ? resolve(options.workdir) : process.cwd(),
    timeoutMs: options.timeout,
    bin: options.bin,
  })
  const reportFile = join(outDir, 'report.jsonl')
  writeFileSync(reportFile, `${outcome.probes.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8')
  const ok = outcome.unusable.length === 0 && unresolved.length === 0
  return {
    result: {
      ok,
      outDir,
      reportFile,
      rolesFile: table ? table.file : null,
      modelsSource: loaded.source,
      runner: defaultRunner,
      counts: { ...outcome.summary, unresolved: unresolved.length },
      unresolved,
      probes: outcome.probes,
      usable: outcome.usable,
      unusable: outcome.unusable,
    },
    exitCode: ok ? 0 : 1,
  }
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
    const outcome = await (async () => {
      switch (options.command) {
        case 'run':
          return run(options)
        case 'probe':
          return probe(options)
        case 'plan':
          return plan(options)
        case 'roles':
          return listRoles(options)
        case 'doctor':
          return doctor(options)
        case 'init':
          return init(options)
        default:
          return listModels(options)
      }
    })()
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
