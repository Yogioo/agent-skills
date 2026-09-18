import { RUNNERS } from './runners/index.mjs'
import { resolveAfkSections } from '../../afk-run/scripts/afk-home.mjs'

const EMPTY_ROLE = {
  runner: '',
  bin: '',
  model: '',
  provider: '',
  thinking: '',
}

/**
 * 读 `~/.afk/config.json` 的 `execReview` 分区（项目层覆盖全局层；`--config` 则只读该文件）。
 * 没有配置文件时返回空数据，由内置默认兜底。
 * @param {string} workdir
 * @param {string} [configPath]
 * @returns {{ path: string, files: string[], missing: boolean, data: object }}
 */
export function loadExecReviewConfig(workdir, configPath = '') {
  const { sections, files } = resolveAfkSections(workdir, ['execReview'], configPath)
  return {
    files,
    path: files.length ? files[files.length - 1] : '',
    missing: files.length === 0,
    data: sections.execReview || {},
  }
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
      if (runner === 'pi') bin = process.env.PI_BIN || 'pi'
      else if (runner === 'agent') {
        bin = process.env.AGENT_BIN || process.env.CURSOR_AGENT_BIN || 'agent'
      } else bin = process.env.CODEX_BIN || 'codex'
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
    'danger-full-access'

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

  const timeout = Math.max(
    0,
    Number(
      firstNonEmpty(
        args.timeout != null && args.timeout !== '' ? String(args.timeout) : '',
        process.env.EXEC_REVIEW_TIMEOUT,
        cfg.timeout != null ? String(cfg.timeout) : '',
      ),
    ) || 0,
  )

  const openBrowser =
    args.open === false
      ? false
      : asBool(process.env.EXEC_REVIEW_OPEN_BROWSER, cfg.openBrowser !== false)

  const gitCommit = asBool(
    args.gitCommit,
    asBool(process.env.EXEC_REVIEW_GIT_COMMIT, asBool(cfg.gitCommit, true)),
  )

  // review 默认关闭；CLI `--review true` 或 config/env 可开
  const review = asBool(
    args.review,
    asBool(process.env.EXEC_REVIEW_REVIEW, asBool(cfg.review, false)),
  )

  const structuredContext = asBool(
    args.structuredContext,
    asBool(process.env.EXEC_REVIEW_STRUCTURED_CONTEXT, asBool(cfg.structuredContext, true)),
  )

  const streamPartialOutput = asBool(
    args.streamPartialOutput,
    asBool(process.env.EXEC_REVIEW_STREAM_PARTIAL_OUTPUT, asBool(cfg.streamPartialOutput, false)),
  )

  return {
    configFiles: loaded?.files || [],
    sandbox,
    approve,
    gitCommit,
    review,
    structuredContext,
    streamPartialOutput,
    serve,
    port,
    returnLevel,
    heartbeatMs,
    timeout,
    openBrowser,
    executor,
    reviewer,
  }
}

export { EMPTY_ROLE }
