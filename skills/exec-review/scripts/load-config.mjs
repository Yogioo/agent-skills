import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RUNNERS } from './runners/index.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const DEFAULT_CONFIG_PATH = resolve(__dirname, '..', 'config.json')

const EMPTY_ROLE = {
  runner: '',
  bin: '',
  model: '',
  provider: '',
  thinking: '',
}

/**
 * @param {string} [path]
 */
export function loadConfigFile(path = DEFAULT_CONFIG_PATH) {
  const file = resolve(path)
  if (!existsSync(file)) {
    return { path: file, missing: true, data: {} }
  }
  let data
  try {
    data = JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    throw new Error(`无法解析配置 ${file}: ${err.message || err}`)
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`配置必须是 JSON 对象: ${file}`)
  }
  return { path: file, missing: false, data }
}

function asString(v) {
  if (v == null) return ''
  return String(v).trim()
}

function pickRole(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  return {
    runner: asString(src.runner).toLowerCase(),
    bin: asString(src.bin),
    model: asString(src.model),
    provider: asString(src.provider),
    thinking: asString(src.thinking),
  }
}

function firstNonEmpty(...vals) {
  for (const v of vals) {
    if (v != null && String(v).trim() !== '') return String(v).trim()
  }
  return ''
}

function asBool(v, def) {
  if (v == null) return def
  const s = String(v).toLowerCase()
  if (s === '0' || s === 'false' || s === 'no' || s === 'off') return false
  if (s === '1' || s === 'true' || s === 'yes' || s === 'on') return true
  return def
}

function assertRunner(name, label) {
  const key = String(name || '').toLowerCase()
  if (!RUNNERS.includes(key)) {
    throw new Error(`未知 ${label} runner: ${name}（支持: ${RUNNERS.join(', ')}）`)
  }
  return key
}

/**
 * Merge CLI + env + config into concrete executor/reviewer settings.
 * @param {object} args parseArgs output
 * @param {{ path?: string, data?: object }} [loaded]
 */
export function resolveSettings(args, loaded) {
  const cfg = loaded?.data || {}
  const cfgExec = pickRole(cfg.executor)
  const cfgReview = pickRole(cfg.reviewer)
  const topRunner = asString(cfg.runner).toLowerCase() || 'codex'

  const sharedRunnerCli = asString(args.runner).toLowerCase()
  const sharedModelCli = asString(args.model)
  const sharedProviderCli = asString(args.provider)
  const sharedThinkingCli = asString(args.thinking)
  const sharedBinCli = asString(args.bin) || asString(args.codexBin)

  const roleFrom = (role, roleArgs) => {
    const cfgRole = role === 'executor' ? cfgExec : cfgReview
    const envPrefix =
      role === 'executor' ? 'EXEC_REVIEW_EXECUTOR_' : 'EXEC_REVIEW_REVIEWER_'

    const runner = assertRunner(
      firstNonEmpty(
        roleArgs.runner,
        sharedRunnerCli,
        process.env[`${envPrefix}RUNNER`],
        process.env.EXEC_REVIEW_RUNNER,
        cfgRole.runner,
        topRunner,
        'codex',
      ),
      role,
    )

    const model = firstNonEmpty(
      roleArgs.model,
      sharedModelCli,
      process.env[`${envPrefix}MODEL`],
      process.env.EXEC_REVIEW_MODEL,
      cfgRole.model,
      // do not fall back to CODEX_MODEL/PI_MODEL here: empty means "CLI default"
    )

    const provider = firstNonEmpty(
      roleArgs.provider,
      sharedProviderCli,
      process.env[`${envPrefix}PROVIDER`],
      process.env.EXEC_REVIEW_PROVIDER_NAME,
      process.env.PI_PROVIDER,
      cfgRole.provider,
    )

    const thinking = firstNonEmpty(
      roleArgs.thinking,
      sharedThinkingCli,
      process.env[`${envPrefix}THINKING`],
      process.env.EXEC_REVIEW_THINKING,
      cfgRole.thinking,
    )

    let bin = firstNonEmpty(
      roleArgs.bin,
      sharedBinCli,
      process.env[`${envPrefix}BIN`],
      process.env.EXEC_REVIEW_BIN,
      cfgRole.bin,
    )
    if (!bin) {
      bin =
        runner === 'pi'
          ? process.env.PI_BIN || 'pi'
          : process.env.CODEX_BIN || 'codex'
    }

    return { runner, bin, model, provider, thinking }
  }

  const executor = roleFrom('executor', {
    runner: args.executorRunner,
    bin: args.executorBin,
    model: args.executorModel,
    provider: args.executorProvider,
    thinking: args.executorThinking,
  })
  const reviewer = roleFrom('reviewer', {
    runner: args.reviewerRunner,
    bin: args.reviewerBin,
    model: args.reviewerModel,
    provider: args.reviewerProvider,
    thinking: args.reviewerThinking,
  })

  const sandbox =
    firstNonEmpty(args.sandbox, process.env.EXEC_REVIEW_SANDBOX, cfg.sandbox) ||
    'workspace-write'

  const approve =
    args.approve === false
      ? false
      : cfg.approve === false
        ? false
        : true

  const serve =
    args.serve === false ? false : asBool(process.env.EXEC_REVIEW_SERVE, cfg.serve !== false)

  const port = Math.max(
    0,
    Number(
      firstNonEmpty(
        args.port != null && args.port !== '' ? String(args.port) : '',
        process.env.EXEC_REVIEW_PORT,
        cfg.port != null ? String(cfg.port) : '',
      ),
    ) || 0,
  )

  const returnLevel = Math.max(
    0,
    Number(
      firstNonEmpty(
        args.returnLevel != null && args.returnLevel !== '' ? String(args.returnLevel) : '',
        process.env.EXEC_REVIEW_RETURN_LEVEL,
        cfg.returnLevel != null ? String(cfg.returnLevel) : '',
      ),
    ) || 0,
  )

  const heartbeatMs = Math.max(
    1000,
    Number(
      firstNonEmpty(
        args.heartbeatMs != null && args.heartbeatMs !== '' ? String(args.heartbeatMs) : '',
        process.env.EXEC_REVIEW_HEARTBEAT_MS,
        cfg.heartbeatMs != null ? String(cfg.heartbeatMs) : '',
      ),
    ) || 10000,
  )

  const openBrowser =
    args.open === false
      ? false
      : asBool(process.env.EXEC_REVIEW_OPEN_BROWSER, cfg.openBrowser !== false)

  return {
    configPath: loaded?.path || DEFAULT_CONFIG_PATH,
    sandbox,
    approve,
    serve,
    port,
    returnLevel,
    heartbeatMs,
    openBrowser,
    executor,
    reviewer,
  }
}

export { EMPTY_ROLE, DEFAULT_CONFIG_PATH as configPathFromSkill }
