/**
 * 运行中 agent 回合的登记簿：`<AFK home>/runs/<runId>.json`。
 *
 * 一个 run 一个文件，文件名带 workdir 摘要与 pid，所以多项目、多 agent 同时跑
 * 也不会互相覆盖。写入走「临时文件 + rename」，读到的永远是完整 JSON。
 *
 * 活着的判定只看 pid（复用 lease.mjs 的实现）：进程没了就标 `stale`，绝不因为
 * 文件还在就说「在跑」。
 *
 * 注意：这个模块不 import skills/ 下的任何东西 —— 运行时包必须能独立安装
 * （tests/run-runtime/standalone.test.mjs 会把它单独拷出去跑）。AFK home 的解析
 * 规则与 skills/afk-run/scripts/afk-home.mjs 保持一致，但这里自带一份。
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { isProcessAlive } from './lease.mjs'

/** AFK 根目录：`AFK_HOME` 覆盖，默认 `~/.afk`。 */
export function afkHomeRoot() {
  if (process.env.AFK_HOME) return resolve(process.env.AFK_HOME)
  return join(homedir(), '.afk')
}

/** 注册表目录；`AFK_HOME` 变了目录就跟着变，测试可以完全隔离。 */
export function runsDir() {
  return join(afkHomeRoot(), 'runs')
}

/** workdir 的稳定摘要（与 afk-home.mjs 的 projectUidFromWorkdir 同规则）。 */
export function workdirUid(workdir) {
  const abs = resolve(workdir).replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `${d.toUpperCase()}:`)
  return createHash('sha256').update(abs).digest('hex').slice(0, 8)
}

/** runId 里同时带 workdir 摘要与 pid：同项目并发、跨项目并发都不会撞。 */
export function runIdFor(workdir, pid = process.pid) {
  return `${workdirUid(workdir)}-${Number(pid)}`
}

function recordPath(runId) {
  return join(runsDir(), `${runId}.json`)
}

/**
 * 一条记录是否还活着 —— 只看 pid。列表和详情必须共用这一个判定，
 * 否则会出现「列表说陈旧、详情说在跑」这种自相矛盾。
 * @param {{pid?:number}} record
 * @returns {boolean}
 */
export function isRunAlive(record) {
  const pid = Number(record?.pid)
  return Number.isInteger(pid) && pid > 0 && isProcessAlive(pid)
}

/**
 * 登记一次 run。调用方必须在 finally 里 unregister，否则会留下陈旧记录。
 * @param {{workdir:string, outDir:string, progressFile?:string, labels?:string[],
 *   runner?:string, note?:string, pid?:number, now?:number}} input
 * @returns {{runId:string, file:string, record:object}}
 */
export function registerRun(input) {
  const pid = Number(input.pid || process.pid)
  const runId = runIdFor(input.workdir, pid)
  const record = {
    runId,
    pid,
    workdir: resolve(input.workdir),
    outDir: resolve(input.outDir),
    progressFile: input.progressFile ? resolve(input.progressFile) : resolve(join(input.outDir, 'progress.jsonl')),
    labels: Array.isArray(input.labels) ? input.labels.map(String) : [],
    runner: input.runner ? String(input.runner) : undefined,
    note: input.note ? String(input.note).slice(0, 200) : undefined,
    startedAt: Number(input.now || Date.now()),
  }
  mkdirSync(runsDir(), { recursive: true })
  const file = recordPath(runId)
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(record)}\n`, 'utf8')
  renameSync(tmp, file)
  return { runId, file, record }
}

/** 注销：只删自己的记录。找不到也算成功（幂等）。 */
export function unregisterRun(runId) {
  const file = recordPath(runId)
  if (!existsSync(file)) return { runId, removed: false }
  rmSync(file, { force: true })
  return { runId, removed: true }
}

/** 读一条记录；坏 JSON 返回 `{record:null, error}` 而不是抛。 */
export function readRun(runId) {
  const file = recordPath(runId)
  if (!existsSync(file)) return { runId, record: null, error: 'not-found' }
  try {
    return { runId, record: JSON.parse(readFileSync(file, 'utf8')), error: null }
  } catch (err) {
    return { runId, record: null, error: `malformed: ${err.message}` }
  }
}

/**
 * 列出全部 run，活着的在前、按开始时间倒序。
 * `stale` 表示「文件还在、进程已死」—— 必须显式标出来，不谎报在跑。
 * @param {{now?:number, includeStale?:boolean}} [opts]
 */
export function listRuns(opts = {}) {
  const { now = Date.now(), includeStale = true } = opts
  const dir = runsDir()
  if (!existsSync(dir)) return { dir, runs: [], stale: 0, malformed: 0 }
  const runs = []
  let stale = 0
  let malformed = 0
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    const runId = name.slice(0, -'.json'.length)
    const { record, error } = readRun(runId)
    if (!record) {
      malformed++
      continue
    }
    const alive = isRunAlive(record)
    if (!alive) {
      stale++
      if (!includeStale) continue
    }
    runs.push({ ...record, alive, elapsedMs: Math.max(0, now - Number(record.startedAt || now)) })
  }
  runs.sort((a, b) => Number(a.alive === b.alive ? 0 : a.alive ? -1 : 1) || b.startedAt - a.startedAt)
  return { dir, runs, stale, malformed }
}

/** 清掉进程已死的记录；活着的一个都不动。 */
export function pruneStale() {
  const { runs, dir } = listRuns({ includeStale: true })
  const removed = []
  for (const run of runs) {
    if (run.alive) continue
    rmSync(join(dir, `${run.runId}.json`), { force: true })
    removed.push(run.runId)
  }
  return { removed }
}
