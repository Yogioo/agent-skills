import { createTapd } from './tapd.mjs'
import { runTurn } from './turn.mjs'

/**
 * 看板的控制面：按一下就跑、按一下停、定时查看 TAPD 并自动接单。
 *
 * 看板原来是只读的（把 ~/.tapd-loop/runs 摊开给人看）。这里补上「操作」，但只做
 * 三件确定性的事，不重写外循环：
 *
 *   - spawn 官方入口 loop.mjs，参数就是 CLI 那套（--workdir / --max-tasks / --card）
 *   - 记状态到 <home>/board-control.json，让页面刷新、看板重启后仍然知道谁在跑
 *   - 定时轮询只是「隔 pollSec 跑一次 loop.mjs --list，有就绪卡就开工」
 *
 * 边界：
 *   - 一次只允许一批。判活看 progress.jsonl 里的 pid，所以命令行起的批次也算，
 *     网页和 CLI 不会在同一个仓库上撞车。
 *   - 工作区不干净就不开工（除非显式 allowDirty），跟 `tapd_loop` 工具同一套规矩。
 *   - 定时器活在 serve.mjs 里：看板不开就没有定时接单。这是刻意的，省得又多一个
 *     「看不见的常驻进程在偷偷跑卡」。
 */

import { execFile, execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  appendFileSync,
  closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

export const CONTROL_FILE = 'board-control.json'
export const KEY_FILE = 'board-key'
/** 批次的 stdout/stderr 落在 <home>/board-batches/batch-<时间戳>.log。 */
export const BATCH_DIR = 'board-batches'

const MAX_TASKS_CAP = 20
const MIN_POLL_SEC = 30
const MAX_POLL_SEC = 24 * 60 * 60
const LIST_TIMEOUT_MS = 90_000
const TAIL_BYTES = 8 * 1024
// 多工位并行后 run 目录攒得快：窗口太小会把还在跑的批次挤出扫描范围，判成「没人在跑」，
// 于是同一个工位被开第二批。8 够单工位用，多工位必须放大。
const PROBE_DIRS = 64
/** 工位名会变成目录名（<主树>-wt-<名字>）和分支名（feat/<名字>），只放行 shell-safe 的字符。 */
const STATION_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,23}$/

/** 长任务（建树 / 删树）的日志落在 <home>/board-batches/ 下，和批次日志放一起。 */
const STATION_JOB_TIMEOUT_MS = 60 * 60_000

export const DEFAULTS = {
  workdir: '',
  assignee: '',
  maxTasks: 1,
  allowDirty: false,
  noWrite: false,
  watch: { enabled: false, pollSec: 300 },
  /** 工位注册表。空 = 老的单工位行为（只认 workdir 那一个）。 */
  stations: [],
}

const LOOPBACK = new Set(['', '127.0.0.1', 'localhost', '::1', '[::1]'])

/** 只有绑在 loopback 上才不要求密钥：出网就一定要。 */
export function isLoopbackHost(host) {
  return LOOPBACK.has(String(host || '').trim().toLowerCase())
}

/**
 * 看板密钥。文件一旦写下来就不再改：已经发出去的链接不能因为重启失效。
 * 它不是「安全认证」，是「别让同网段随手点开的人替你把卡接了」。
 */
export function ensureKey(home) {
  const file = join(home, KEY_FILE)
  if (existsSync(file)) {
    const saved = readFileSync(file, 'utf8').trim()
    if (saved) return saved
  }
  const key = randomBytes(12).toString('base64url')
  mkdirSync(home, { recursive: true })
  writeFileSync(file, `${key}\n`, { encoding: 'utf8', mode: 0o600 })
  return key
}

/** 定长比较：长度不同也走完整轮，别按字符提前返回。 */
export function sameKey(a, b) {
  const left = String(a || '')
  const right = String(b || '')
  if (!right) return false
  const size = Math.max(left.length, right.length)
  let diff = left.length === right.length ? 0 : 1
  for (let i = 0; i < size; i += 1) diff |= (left.charCodeAt(i) || 0) ^ (right.charCodeAt(i) || 0)
  return diff === 0
}

function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/**
 * 工位注册表只认 { name, path }：name 白名单校验，path 必须是绝对路径，按路径去重。
 * 从浏览器来的东西，名字会变成目录名和分支名，所以一个字符都不能放过。
 */
function normalizeStations(list) {
  const seen = new Set()
  const out = []
  for (const item of Array.isArray(list) ? list : []) {
    const name = String(item?.name || '').trim()
    const path = String(item?.path || '').trim()
    if (!STATION_NAME_RE.test(name) || !path || !isAbsolute(path)) continue
    const key = path.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ name, path, note: String(item?.note || '').slice(0, 200) })
  }
  return out
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
}

/**
 * 只认白名单字段，其余一律丢掉：这是从浏览器来的输入，不能拿它改运行配置。
 * 间隔和批量都有上下限，页面填错了就退回旧值，而不是把轮询打成死循环。
 */
export function sanitizeControl(input = {}, base = DEFAULTS) {
  const out = {
    workdir: String(base.workdir || ''),
    assignee: String(base.assignee || ''),
    maxTasks: clampInt(base.maxTasks, 1, MAX_TASKS_CAP, DEFAULTS.maxTasks),
    allowDirty: Boolean(base.allowDirty),
    noWrite: Boolean(base.noWrite),
    watch: {
      enabled: Boolean(base.watch?.enabled),
      pollSec: clampInt(base.watch?.pollSec, MIN_POLL_SEC, MAX_POLL_SEC, DEFAULTS.watch.pollSec),
    },
    stations: normalizeStations(base.stations),
  }
  if (!input || typeof input !== 'object') return out
  if ('workdir' in input) out.workdir = String(input.workdir || '').trim()
  if ('assignee' in input) out.assignee = String(input.assignee || '').trim()
  if ('maxTasks' in input) out.maxTasks = clampInt(input.maxTasks, 1, MAX_TASKS_CAP, out.maxTasks)
  if ('allowDirty' in input) out.allowDirty = Boolean(input.allowDirty)
  if ('noWrite' in input) out.noWrite = Boolean(input.noWrite)
  if (input.watch && typeof input.watch === 'object') {
    if ('enabled' in input.watch) out.watch.enabled = Boolean(input.watch.enabled)
    if ('pollSec' in input.watch) out.watch.pollSec = clampInt(input.watch.pollSec, MIN_POLL_SEC, MAX_POLL_SEC, out.watch.pollSec)
  }
  if ('stations' in input) out.stations = normalizeStations(input.stations)
  return out
}

/** 一次批次的命令行。纯函数，测试直接钉住参数。 */
export function batchArgs(config, opts = {}) {
  const args = ['--workdir', String(config.workdir || ''), '--max-tasks', String(clampInt(config.maxTasks, 1, MAX_TASKS_CAP, 1))]
  if (config.assignee) args.push('--assignee', String(config.assignee))
  if (opts.card) args.push('--card', String(opts.card))
  if (config.allowDirty) args.push('--allow-dirty')
  if (config.noWrite) args.push('--no-write')
  // 看板本来就在跑（批次是从它这里发起的），别再让它去起一个。
  args.push('--no-board')
  return args
}

/**
 * 从人贴进来的东西里认出需求 id。
 *
 * 认三种写法（都不认识才报错）：
 *   - 纯数字 id（19 位，TAPD 的长 id）
 *   - `.../story/detail/<id>`、`.../prong/stories/view/<id>`
 *   - 带尾巴的复制品（`?page=1`、锚点、中文标题一起粘进来）→ 取最长的一段数字
 *
 * 为什么兜底取「最长」：workspace id 是 8 位、需求 id 是 19 位，同一串里后者一定更长。
 */
export function parseCardRef(input) {
  const text = String(input || '').trim()
  if (!text) return { ok: false, error: '先贴一个 TAPD 链接或需求 id' }
  if (/^\d{6,}$/.test(text)) return { ok: true, id: text, ref: text, workspaceId: '', guessed: false }
  const direct = /(?:story\/detail|stories\/view)\/(\d{6,})/i.exec(text)
  const workspace = /(?:tapd_fe\/|\/)(\d{6,})\/(?:story|prong|bugtrace|task|testcase)/i.exec(text)
  if (direct) {
    return { ok: true, id: direct[1], ref: text, workspaceId: workspace ? workspace[1] : '', guessed: false }
  }
  const runs = text.match(/\d{6,}/g) || []
  if (runs.length) {
    const id = [...runs].sort((a, b) => b.length - a.length)[0]
    return { ok: true, id, ref: text, workspaceId: '', guessed: true }
  }
  return {
    ok: false,
    error: `认不出这是哪张卡：${clip(text, 80)}（贴 TAPD 的需求链接，或直接填 19 位需求 id）`,
  }
}

/** 停止文件跟 loop.mjs 的默认值一致：<git-dir>/tapd-loop-stop，每棵 worktree 一份。 */
export function stopFilePath(workdir) {
  const dir = gitOut(workdir, ['rev-parse', '--git-dir'])
  if (!dir) return join(workdir, 'tapd-loop-stop')
  return join(isAbsolute(dir) ? dir : resolve(workdir, dir), 'tapd-loop-stop')
}

function gitOut(cwd, args) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      timeout: 20_000,
    }).trim()
  } catch {
    return ''
  }
}

/** 只关心成败的 git 命令（restore 这类没有输出）。 */
function gitRun(cwd, args) {
  try {
    execFileSync('git', args, { cwd, stdio: 'ignore', windowsHide: true, timeout: 120_000 })
    return true
  } catch {
    return false
  }
}

/**
 * 最近几个 run 目录的头尾各读一小段，判断「现在有没有一批在跑」。
 * 不整份读 progress.jsonl：长跑能有几百 KB，而这里每几秒就要问一次。
 */
/**
 * 扫最近的 run 目录，返回**所有**还活着的批次（pid 在、没写 loop_end）。
 * 多工位并行后「有没有人在跑」不再是一个布尔：每个工位各问各的，调度器还要知道全部。
 */
function allRuns(runsRoot, limit = PROBE_DIRS) {
  let names = []
  try {
    names = readdirSync(runsRoot)
      .filter((name) => name.startsWith('run-'))
      .map((name) => ({ name, at: statSync(join(runsRoot, name)).mtimeMs }))
      .sort((a, b) => b.at - a.at)
      .slice(0, limit)
      .map((entry) => entry.name)
  } catch {
    return []
  }
  const out = []
  for (const name of names) {
    const file = join(runsRoot, name, 'progress.jsonl')
    if (!existsSync(file)) continue
    const start = firstJsonLine(file)
    if (!start || start.event !== 'loop_start') continue
    if (tailText(file, TAIL_BYTES).includes('"loop_end"')) continue
    if (!pidAlive(Number(start.pid))) continue
    out.push({
      kind: 'run',
      runId: name,
      workdir: String(start.workdir || ''),
      pid: Number(start.pid) || 0,
      startedAt: Number(start.t) || 0,
      maxTasks: Number(start.maxTasks) || 0,
    })
  }
  return out
}

/** 某个工位上有没有活批次。不传 workdir 就是全机（老语义）。 */
function probeRun(runsRoot, workdir = '') {
  return allRuns(runsRoot).find((run) => !workdir || run.workdir === workdir) || null
}

function firstJsonLine(file) {
  let fd
  try {
    fd = openSync(file, 'r')
    const buffer = Buffer.alloc(8192)
    const size = readSync(fd, buffer, 0, buffer.length, 0)
    const line = buffer.subarray(0, size).toString('utf8').split('\n')[0]
    return line && line.startsWith('{') ? JSON.parse(line) : null
  } catch {
    return null
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function tailText(file, limit) {
  let fd
  try {
    fd = openSync(file, 'r')
    const size = statSync(file).size
    const start = Math.max(0, size - limit)
    const buffer = Buffer.alloc(Math.max(1, Math.min(limit, size)))
    const read = readSync(fd, buffer, 0, buffer.length, start)
    return buffer.subarray(0, read).toString('utf8')
  } catch {
    return ''
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function pidAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace('T', '').slice(0, 14)
}

/** 从批次日志尾巴里把 loop.mjs 那行 JSON 摘要捞出来（它前面可能还有别的输出）。 */
export function lastSummary(log) {
  const lines = tailText(log, TAIL_BYTES).split('\n').map((line) => line.trim()).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].startsWith('{')) continue
    try {
      return JSON.parse(lines[i])
    } catch {
      continue
    }
  }
  return null
}

export function logTail(log, limit = 4000) {
  return tailText(log, limit)
}

/**
 * @param {{home:string, runsRoot:string, loopScript:string, spawnCmd?:string[]}} opts
 *   spawnCmd 只给测试用：默认 `[process.execPath, loopScript]`。
 */
export function createControl(opts) {
  const home = opts.home
  const runsRoot = opts.runsRoot
  const controlFile = join(home, CONTROL_FILE)
  const batchDir = join(home, BATCH_DIR)
  const baseCmd = opts.spawnCmd || [process.execPath, opts.loopScript]
  const listeners = new Set()

  // 内存里只放「这一个看板进程自己知道的事」：队列缓存和定时器指针。
  // 重启之后靠 pid 判活 + progress.jsonl 重新长出来，不持久化。
  const memory = {
    queue: null,
    probing: false,
    nextAt: 0,
    lastCheckAt: 0,
    lastReady: 0,
    lastError: '',
    workdirsAt: 0,
    workdirs: [],
    lastBatch: null,
    /** 本 tick 刚派出去的卡（spawn 到 progress.jsonl 出现之间有空窗，靠这个防重复派）。 */
    dispatched: [],
  }

  function raw() {
    return readJson(controlFile) || {}
  }

  function read() {
    return sanitizeControl(raw(), DEFAULTS)
  }

  /** 写配置时逐字保留 batches / jobs / lastBatch：它们是状态，不是可编辑字段。 */
  function write(input, base) {
    const current = raw()
    const next = sanitizeControl(input, base || sanitizeControl(current, DEFAULTS))
    const batches = Array.isArray(current.batches) ? current.batches : (current.batch ? [current.batch] : [])
    writeJson(controlFile, {
      ...next,
      ...(batches.length ? { batches } : {}),
      ...(Array.isArray(current.jobs) && current.jobs.length ? { jobs: current.jobs } : {}),
      ...(current.lastBatch ? { lastBatch: current.lastBatch } : {}),
    })
    return next
  }

  function emit() {
    for (const listener of listeners) {
      try {
        listener()
      } catch {
        // 监听器坏了不影响状态
      }
    }
  }

  /** 看板自己 spawn 的批次。旧版只有一个 `batch` 字段，读的时候兼容成数组。 */
  function ownBatches() {
    const saved = raw()
    const list = Array.isArray(saved.batches) ? saved.batches : (saved.batch ? [saved.batch] : [])
    return list
      .filter((item) => item && item.pid)
      .map((item) => ({ ...item, kind: 'batch', ...(pidAlive(Number(item.pid)) ? {} : { dead: true }) }))
  }

  /** 所有活批次：run 目录里探到的 + 自己 spawn 的，按 workdir+pid 去重。 */
  function runningAll() {
    const seen = new Set()
    const out = []
    for (const item of [...allRuns(runsRoot), ...ownBatches()]) {
      if (item.dead) continue
      const key = `${item.workdir}|${item.pid}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(item)
    }
    return out
  }

  /** 某个工位上的活批次；不传 workdir 就是全机第一个。 */
  function busy(workdir = '') {
    const all = runningAll()
    return (workdir ? all.find((item) => item.workdir === workdir) : all[0]) || null
  }

  /** 工作目录候选：最近跑过的那几个，页面的下拉框就是它。 */
  function workdirs() {
    const now = Date.now()
    if (memory.workdirs.length && now - memory.workdirsAt < 10_000) return memory.workdirs
    let names = []
    try {
      names = readdirSync(runsRoot)
        .filter((name) => name.startsWith('run-'))
        .map((name) => ({ name, at: statSync(join(runsRoot, name)).mtimeMs }))
        .sort((a, b) => b.at - a.at)
        .slice(0, 40)
        .map((entry) => entry.name)
    } catch {
      names = []
    }
    const seen = new Set()
    for (const name of names) {
      const workdir = String(firstJsonLine(join(runsRoot, name, 'progress.jsonl'))?.workdir || '')
      if (!workdir) continue
      seen.add(workdir)
      if (seen.size >= 8) break
    }
    memory.workdirs = [...seen]
    memory.workdirsAt = now
    return memory.workdirs
  }

  function machineDefaults() {
    const saved = readJson(join(home, 'config.json')) || {}
    return {
      assignee: String(saved?.task?.assignee || ''),
      pollSec: Number(saved?.run?.pollSec) || 0,
    }
  }

  function status() {
    const config = read()
    // 进程在、但看板重启过：死记录没人收尸，第一次问就把它清掉。
    const live = new Set(runningAll().map((item) => item.pid))
    const own = ownBatches()
    if (own.some((item) => item.dead && !live.has(item.pid))) {
      writeJson(controlFile, { ...raw(), batches: own.filter((item) => !item.dead), batch: undefined })
    }
    const running = runningAll()
    const stopFile = config.workdir ? stopFilePath(config.workdir) : ''
    return {
      config,
      // running 保持单值（老页面在读）；runs 是全部，多工位时页面看这个。
      running: running[0] || null,
      runs: running,
      stations: stationState(config),
      jobs: listJobs(),
      lastBatch: memory.lastBatch || raw().lastBatch || null,
      watch: {
        enabled: config.watch.enabled,
        pollSec: config.watch.pollSec,
        draining: memory.probing,
        // 刚打开开关或刚改完间隔时 nextAt 是 0：下一 tick 立刻查一次，不用干等。
        nextAt: config.watch.enabled ? memory.nextAt || 0 : 0,
        lastCheckAt: memory.lastCheckAt || 0,
        lastReady: memory.lastReady || 0,
        lastError: memory.lastError || '',
      },
      // 主树是否停在 cherry-pick 冲突里（卡片据此给「让 AI 解冲突」）。
      conflict: (() => {
        const main = String(config.workdir || '').trim()
        if (!main || !existsSync(main)) return null
        return conflictState(main)
      })(),
      queue: memory.queue ? summarizeQueue(memory.queue, config.workdir) : null,
      workdirs: workdirs(),
      // 机器级配置里已经写好的值：面板留空时按它走（空 = 沿用 CLI 的解析结果，
      // 而不是把值抄进 board-control.json 变成第二个真相）。
      defaults: machineDefaults(),
      stopFile: { path: stopFile, present: Boolean(stopFile) && existsSync(stopFile) },
      limits: { maxTasks: MAX_TASKS_CAP, minPollSec: MIN_POLL_SEC, maxPollSec: MAX_POLL_SEC },
      now: Date.now(),
    }
  }

  /** 跑一次 loop.mjs 的只读子命令（--list / --show）。异步的：TAPD 慢时不能把看板卡住。 */
  function execLoop(extra, workdir) {
    const [cmd, ...head] = baseCmd
    return new Promise((done) => {
      execFile(cmd, [...head, ...extra], {
        cwd: workdir && existsSync(workdir) ? workdir : dirname(controlFile),
        encoding: 'utf8',
        timeout: LIST_TIMEOUT_MS,
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
      }, (err, stdout, stderr) => {
        if (err) {
          done({ ok: false, error: clip(stderr || stdout || err.message, 800) })
          return
        }
        try {
          done({ ok: true, json: JSON.parse(stdout) })
        } catch {
          done({ ok: false, error: `输出不是 JSON：${clip(stdout, 400)}` })
        }
      })
    })
  }

  /** 就绪队列。 */
  function list({ workdir, assignee }) {
    const extra = ['--workdir', workdir, '--list']
    if (assignee) extra.push('--assignee', assignee)
    return execLoop(extra, workdir).then((result) => result.ok
      ? {
        ok: true,
        error: '',
        ready: Array.isArray(result.json.ready) ? result.json.ready : [],
        rejected: Array.isArray(result.json.rejected) ? result.json.rejected : [],
        allowedStatuses: result.json.allowedStatuses || [],
      }
      : { ok: false, error: result.error, ready: [], rejected: [] })
  }

  /**
   * 看一张卡：链接/id 先解析，再让 loop.mjs --show 去 TAPD 问一句「现在什么状态、能不能接」。
   * 只读，不占卡；确认完再开跑，省得为一个打错的 id 起一个注定跳过的批次。
   */
  function peek({ workdir, ref }) {
    const parsed = parseCardRef(ref)
    if (!parsed.ok) return Promise.resolve(parsed)
    const target = String(workdir || '').trim() || read().workdir
    return execLoop(['--show', parsed.id], target).then((result) => {
      if (!result.ok) return { ...parsed, ok: false, error: result.error }
      return { ...parsed, card: result.json }
    })
  }

  /** 就绪队列。缓存跟着 workdir 走：换了仓库就不能还显示上一个仓库的卡。 */
  function queueFor(workdir, { refresh = false } = {}) {
    const target = String(workdir || '').trim()
    if (!target) return Promise.resolve({ ok: false, error: '先选工作目录', ready: [], rejected: [] })
    const cached = memory.queue
    if (!refresh && cached && cached.workdir === target && Date.now() - cached.at < 20_000) return Promise.resolve(cached)
    return list({ workdir: target, assignee: read().assignee }).then((result) => {
      memory.queue = { ...result, workdir: target, at: Date.now() }
      return memory.queue
    })
  }

  /**
   * 起一批。前置检查就一个目的：别 spawn 一个注定失败的进程，然后让人等二十分钟
   * 才发现工作区是脏的。
   */
  function start(input = {}) {
    const config = sanitizeControl(input, read())
    let card = input.card ? String(input.card).trim() : ''
    if (input.ref != null && String(input.ref).trim()) {
      const parsed = parseCardRef(input.ref)
      if (!parsed.ok) return { ok: false, error: parsed.error }
      card = parsed.id
    }
    if (!config.workdir) return { ok: false, error: '先选工作目录' }
    if (!isAbsolute(config.workdir)) return { ok: false, error: `工作目录要写绝对路径：${config.workdir}` }
    const workdir = resolve(config.workdir)
    if (!existsSync(workdir)) return { ok: false, error: `工作目录不存在：${workdir}` }
    if (!gitOut(workdir, ['rev-parse', '--git-dir'])) return { ok: false, error: `不是 git 仓库：${workdir}` }
    const running = busy(workdir)
    if (running) {
      return { ok: false, error: `这个工位已经有一批在跑（${running.runId || running.pid}），等它跑完或先点停止`, running }
    }
    if (!config.allowDirty && gitOut(workdir, ['status', '--porcelain'])) {
      return { ok: false, error: '工作区不干净。先处理后重跑，或者勾上「允许脏工作区」（脏改动会被算进本卡提交）' }
    }

    // 指定一张卡时永远只跑一张：loop.mjs 的 --card 是「每一轮都去找这张」，
    // maxTasks 大于 1 只会在第二轮把同一张卡重新拉出来再跳过一次。
    const merged = { ...config, workdir, ...(card ? { maxTasks: 1 } : {}) }
    // 停止标记是「下一张之前停」的一次性开关，而按了开始就说明人不打算停了。
    // 不清的话下一次点开跑会在第一张卡之前直接退出，看着像坏了。
    rmSync(stopFilePath(workdir), { force: true })

    mkdirSync(batchDir, { recursive: true })
    const log = join(batchDir, `batch-${stamp()}.log`)
    const args = [...baseCmd.slice(1), ...batchArgs(merged, { card })]
    const fd = openSync(log, 'a')
    let child
    try {
      child = spawn(baseCmd[0], args, {
        cwd: workdir,
        // detached：一批能跑二十几分钟，看板重启/关窗口不该把它带走。
        detached: true,
        windowsHide: true,
        stdio: ['ignore', fd, fd],
      })
    } catch (err) {
      closeSync(fd)
      return { ok: false, error: `起不来：${err.message}` }
    }
    closeSync(fd)
    child.once('error', () => {})

    const batch = {
      pid: child.pid,
      workdir,
      card,
      maxTasks: merged.maxTasks,
      startedAt: Date.now(),
      log,
      argv: args,
    }
    const before = raw()
    const previous = (Array.isArray(before.batches) ? before.batches : (before.batch ? [before.batch] : []))
      .filter((item) => item && item.pid && pidAlive(Number(item.pid)))
    // 不要把 merged 写回顶层：多工位时 merged.workdir 是派生出来的工位路径，
    // 写回去会把面板选中的主树改掉。这里只记批次。
    writeJson(controlFile, { ...before, batch: undefined, batches: [...previous, batch] })
    child.once('exit', (code, signal) => {
      const finished = raw()
      const lastBatch = { ...batch, endedAt: Date.now(), code: code ?? -1, signal: signal || '', summary: lastSummary(log) }
      memory.lastBatch = lastBatch
      writeJson(controlFile, {
        ...finished,
        batch: undefined,
        batches: (Array.isArray(finished.batches) ? finished.batches : []).filter((item) => item?.pid !== batch.pid),
        lastBatch,
      })
      // 跑完顺手把队列刷一遍：被接走的卡应该从「就绪」里消失。只在页面已经问过队列时才刷，
      // 免得没人看页面的时候也去打 TAPD。
      if (memory.queue) queueFor(batch.workdir, { refresh: true }).catch(() => {})
      emit()
    })
    child.unref()
    emit()
    return { ok: true, batch, config: merged }
  }

  /**
   * 停：只写停止文件，不杀当前卡。语义跟 CLI 的 `--stop` 完全一致。
   * 多工位后要能指定停哪个：{ workdir } 停一个，{ all: true } 停全部活批次 + 所有已注册工位。
   * 默认（什么都不传）停当前面板选中的那个，和以前一样。
   */
  function stop(input = {}) {
    const config = sanitizeControl(input, read())
    const targets = new Set()
    if (input.all) {
      for (const item of runningAll()) if (item.workdir) targets.add(String(item.workdir))
      for (const station of config.stations) targets.add(station.path)
      if (config.workdir) targets.add(config.workdir)
    } else if (input.workdir && String(input.workdir).trim()) {
      targets.add(String(input.workdir).trim())
    } else {
      targets.add(busy()?.workdir || config.workdir)
    }
    targets.delete('')
    targets.delete(undefined)
    if (!targets.size) return { ok: false, error: '不知道要停哪个仓库：先选工作目录或指定工位' }

    const files = []
    const errors = []
    for (const workdir of targets) {
      if (!existsSync(workdir)) {
        errors.push(`${workdir}: 目录不存在`)
        continue
      }
      const file = stopFilePath(workdir)
      try {
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, `${new Date().toISOString()}\n`, 'utf8')
        files.push(file)
      } catch (err) {
        errors.push(`${workdir}: ${err.message}`)
      }
    }
    if (!files.length) return { ok: false, error: `写停止文件失败：${errors.join('；')}` }
    return { ok: true, file: files[0], files, errors, running: busy() }
  }

  /**
   * 工位状态：名字、路径、分支、有没有活批次、可不可用、落后主分支多少、工作区脏不脏。
   * 注册表为空时退化成「只有 workdir 这一个工位」，老行为不变。
   */
  function stationState(config = read()) {
    const list = config.stations.length
      ? config.stations
      : (config.workdir ? [{ name: 'main', path: config.workdir, note: '' }] : [])
    const active = runningAll()
    return list.map((station) => {
      const path = station.path
      const exists = existsSync(path)
      const isRepo = exists ? Boolean(gitOut(path, ['rev-parse', '--git-dir'])) : false
      const branch = isRepo ? gitOut(path, ['rev-parse', '--abbrev-ref', 'HEAD']) : ''
      const dirty = isRepo ? Boolean(gitOut(path, ['status', '--porcelain', '--untracked-files=no'])) : false
      const upstream = isRepo && branch ? gitOut(path, ['rev-parse', '--abbrev-ref', '@{u}']) : ''
      const behind = upstream ? Number(gitOut(path, ['rev-list', '--count', `HEAD..@{u}`]) || '0') || 0 : 0
      const unity = exists && isRepo ? unityState(path) : 'off'
      const batch = active.find((item) => item.workdir === path) || null
      // 这个工位有多少提交还没进主树（卡片据此给「合入」按钮）。
      // 主树未知或就是本树时按 0。
      const mainDir = String(config.workdir || '').trim()
      const pending = isRepo && branch && mainDir && resolve(mainDir) !== resolve(path)
        ? pendingCount(mainDir, branch)
        : 0
      return {
        name: station.name,
        path,
        note: station.note || '',
        exists,
        isRepo,
        branch,
        upstream,
        behind,
        dirty,
        unity,
        pending,
        idle: !batch,
        // 可用 = 目录在 + 是 git 仓库 + 工作区没改已跟踪文件 + Unity 在线（端点能用）
        usable: exists && isRepo && !dirty && unity === 'on',
        card: batch ? String(batch.card || '') : '',
        runId: batch ? String(batch.runId || '') : '',
        pid: batch ? Number(batch.pid) || 0 : 0,
        startedAt: batch ? Number(batch.startedAt) || 0 : 0,
      }
    })
  }

  /** 建树 / 删树 / 合入 / 解冲突这些长任务。只有 running 的才看 pid 判活。 */
  function listJobs() {
    const saved = raw()
    const jobs = Array.isArray(saved.jobs) ? saved.jobs : []
    return jobs.map((job) => {
      // 只有 running 才用 pid 判活。否则 resolve 这种用看板 pid 占位的 job 会永远 alive，
      // 完成了也不从页面消失（pin 到 done 之后还会被前端当「还在跑」画出来）。
      const running = job.status === 'running'
      const alive = running && job.pid ? pidAlive(Number(job.pid)) : false
      const status = running && !alive ? 'unknown' : job.status
      return { ...job, alive, status }
    })
  }

  function addStation({ name, path, note = '' }) {
    const current = read()
    write({ stations: normalizeStations([...current.stations, { name, path, note }]) })
  }

  function dropStation(name) {
    const current = read()
    write({ stations: current.stations.filter((station) => station.name !== name) })
  }

  /** 登记一个已经存在的工位（不想重跑建树脚本时用）。 */
  function registerStation(input = {}) {
    const name = String(input.name || '').trim()
    const path = String(input.path || '').trim()
    if (!STATION_NAME_RE.test(name)) return { ok: false, error: '工位名只能 1~24 位字母数字/下划线/短横线' }
    if (!path || !isAbsolute(path)) return { ok: false, error: '工位路径要写绝对路径' }
    if (!existsSync(path)) return { ok: false, error: `目录不存在：${path}` }
    if (!gitOut(path, ['rev-parse', '--git-dir'])) return { ok: false, error: `不是 git 仓库：${path}` }
    const current = read()
    if (current.stations.some((station) => station.name === name)) return { ok: false, error: `已经有叫 ${name} 的工位` }
    if (current.stations.some((station) => station.path.toLowerCase() === path.toLowerCase())) {
      return { ok: false, error: '这个路径已经登记过了' }
    }
    addStation({ name, path })
    return { ok: true, stations: read().stations }
  }

  /**
   * 后台跑一个长命令，状态记进 jobs。页面轮询看进度。
   *
   * 输出重定向交给 bash 自己（`exec > log 2>&1`），不用 Node 的 fd 继承：
   * 实测 Windows 上 `stdio: ['ignore', fd, fd]` + detached 会把子进程的输出全丢掉
   * （进程 code 1、日志 0 字节，而同样的命令用 pipe 就正常）。自己重定向还有个好处：
   * 看板重启/退出后，子进程继续写自己的文件。
   */
  function spawnJob({ kind, name, path, workdir, script, onDone, onConflict }) {
    mkdirSync(batchDir, { recursive: true })
    const log = join(batchDir, `station-${kind}-${name}-${stamp()}.log`)
    const cmdline = `exec > '${shPath(log)}' 2>&1; ${script}`
    const bash = resolveBash()
    let child
    try {
      child = spawn(bash, ['-c', cmdline], { cwd: workdir, detached: true, windowsHide: true, stdio: 'ignore' })
    } catch (err) {
      return { ok: false, error: `起不来：${err.message}` }
    }
    child.once('error', () => {})
    const job = {
      id: `job-${stamp()}-${child.pid || 0}`,
      kind,
      name,
      path,
      workdir,
      pid: child.pid || 0,
      startedAt: Date.now(),
      status: 'running',
      log,
    }
    const current = raw()
    const jobs = (Array.isArray(current.jobs) ? current.jobs : [])
      .filter((item) => item && (item.status === 'running' ? pidAlive(Number(item.pid)) : true))
      .slice(-9)
    writeJson(controlFile, { ...current, jobs: [...jobs, job] })

    // spawn 失败（找不到可执行文件、权限）不会进 exit，必须在这里收尸，
    // 否则 job 永远停在 running，页面一直显示「正在准备」。
    let settled = false
    const settle = (status, code, error) => {
      if (settled) return
      settled = true
      const done = raw()
      writeJson(controlFile, {
        ...done,
        jobs: (Array.isArray(done.jobs) ? done.jobs : [])
          .map((item) => (item.id === job.id
            ? { ...item, status, code, endedAt: Date.now(), ...(error ? { error } : {}) }
            : item)),
      })
      if (status === 'done' && onDone) {
        try {
          onDone()
        } catch {
          // onDone 炸了不影响 job 已记下的结果
        }
      }
      // code 2 = collect --resolve 遇到冲突、现场已保留：自动起 agent 解，不用人再点。
      if (code === 2 && onConflict) {
        try {
          onConflict()
        } catch (err) {
          appendFileSync(log, `\n[自动解冲突失败] ${err.message}\n`, 'utf8')
        }
      }
      emit()
    }

    child.once('error', (err) => {
      try {
        appendFileSync(log, `[spawn 失败] ${err.message}\n`, 'utf8')
      } catch {
        // 日志写不进去也不能把错误吞掉：下面会把 message 记进 job
      }
      settle('failed', -1, err.message)
    })
    child.once('exit', (code) => {
      // 退出码非 0 且日志一字没有：把「到底跑了什么」写进日志，否则只能靠猜。
      if (code !== 0) {
        try {
          if (statSync(log).size === 0) {
            appendFileSync(log, `[诊断] 命令没有产生任何输出（code ${code}）\n  bash: ${bash}\n  cmdline: ${cmdline}\n`, 'utf8')
          }
        } catch {
          // 诊断写不进去就算了
        }
      }
      settle(code === 0 ? 'done' : 'failed', code ?? -1)
    })
    child.unref()
    emit()
    return { ok: true, job }
  }

/**
 * 给 bash 的 Windows 路径必须转正斜杠。
 * 反斜杠在 bash 里是转义字符：`bash "C:\a\b.sh"` 实际收到的是 `C:ab.sh`，
 * 报 “No such file or directory” 然后 exit 1，而 stdout/stderr 可能一行都不剩。
 */
function shPath(p) {
  return String(p || '').replace(/\\/g, '/')
}

/**
 * Windows 上自己找 bash。PATH 里 `C:\Windows\System32\bash.exe`（WSL）和
 * `%LOCALAPPDATA%\Microsoft\WindowsApps\bash.exe` 都可能排在 GitBash 前面，
 * 而它们跑不了 Windows 路径的 sh 脚本。默认直接拿 Git for Windows 的绝对路径。
 */
function resolveBash() {
  const candidates = [
    process.env.TAPD_LOOP_BASH || '',
    'C:/Program Files/Git/bin/bash.exe',
    'C:/Program Files (x86)/Git/bin/bash.exe',
    'C:/Program Files/Git/usr/bin/bash.exe',
  ].filter(Boolean)
  for (const file of candidates) if (existsSync(file)) return file
  return 'bash'
}

/**
 * 建树脚本约定的目录：<主树的兄弟目录>/<主树名>-wt-<名字>（见 Tools/Worktree/new-worktree.sh）。 */
  function defaultStationPath(main, name) {
    return join(dirname(main), `${basename(main)}-wt-${name}`)
  }

  /**
   * Unity 在不在线。验证门（verify_unity.mjs）靠本树的 puer-exec 端点，Unity 没开就必然 exit 2，
   * 所以「Unity 没开」的工位等于不可用——接单只会白跑一张卡再判失败。
   *
   * 三态（同步、廉价，页面每 3 秒问一次）：
   *   off     ── Temp/UnityLockfile 不存在或没被独占
   *   booting ── 进程开着，但 endpoint.json 还没写出来（首次导入约 4.5 分钟）
   *   on      ── 端点文件在，CLI 能连
   *
   * booting 和「开着但没带 -unityPuerExecControl」在文件层面一模一样，
   * 区分不了就归 booting，让用户点「检查端点」去确认（真 ping 一次 /health）。
   */
  function unityState(treePath) {
    const lock = join(treePath, 'Temp', 'UnityLockfile')
    let running = false
    if (existsSync(lock)) {
      try {
        closeSync(openSync(lock, 'r+'))
      } catch {
        running = true
      }
    }
    if (!running) return 'off'
    return existsSync(join(treePath, 'Temp', 'UnityPuerExec', 'endpoint.json')) ? 'on' : 'booting'
  }

  /**
   * 新建工位：后台跑主树的建树脚本（几分钟，首次 Unity 导入在开 Editor 时才发生）。
   * 成功（退出码 0）后自动登记进工位表。
   */
  function createStation(input = {}) {
    const config = read()
    const name = String(input.name || '').trim()
    if (!STATION_NAME_RE.test(name)) return { ok: false, error: `工位名只能 1~24 位字母数字/下划线/短横线：${name || '(空)'}` }
    if (config.stations.some((station) => station.name === name)) return { ok: false, error: `已经有叫 ${name} 的工位` }
    const main = String(input.workdir || config.workdir || '').trim()
    if (!main) return { ok: false, error: '先选主树工作目录（建树脚本在主树里）' }
    if (!existsSync(main)) return { ok: false, error: `主树不存在：${main}` }
    const script = join(main, 'Tools', 'Worktree', 'new-worktree.sh')
    if (!existsSync(script)) return { ok: false, error: `主树里没有建树脚本：${script}` }
    const path = String(input.path || '').trim() || defaultStationPath(main, name)
    if (existsSync(path)) return { ok: false, error: `目录已存在：${path}（要复用就用「登记已有工位」）` }
    if (runningAll().some((item) => String(item.workdir) === path)) return { ok: false, error: '这个路径上还有批次在跑' }
    return spawnJob({
      kind: 'create',
      name,
      path,
      workdir: main,
      // 路径必须转正斜杠（反斜杠会被 bash 当转义吃掉）。
      script: `exec '${shPath(script)}' '${name}'`,
      onDone: () => addStation({ name, path }),
    })
  }

  /**
   * 删除工位（从磁盘删，不只是从表里移除）。
   * 三道闸门：主树不能删、活批次不能删、分支还有未合入提交不能删。
   * 第二道防「边跑边删」，第三道防「活还没搬进 develop 就删了」——共享 .git 里的对象
   * 靠分支活，分支一删，提交过几周就被 gc 清掉。
   */
  function removeStation(input = {}) {
    const config = read()
    const name = String(input.name || '').trim()
    if (input.path && !name) return forgetStation(input)
    const station = config.stations.find((item) => item.name === name)
    if (!station) return { ok: false, error: `没有叫 ${name} 的工位` }
    const main = String(input.workdir || config.workdir || '').trim()
    if (main && resolve(station.path).toLowerCase() === resolve(main).toLowerCase()) {
      return { ok: false, error: '这是主树，不能当工位删' }
    }
    const live = runningAll().find((item) => item.workdir === station.path)
    if (live) return { ok: false, error: `${name} 上还有批次在跑（${live.runId || live.pid}），先停再删` }
    const branch = gitOut(station.path, ['rev-parse', '--abbrev-ref', 'HEAD'])
    const mainDir = main && existsSync(main) ? main : dirname(station.path)
    const pending = branch ? Number(gitOut(mainDir, ['rev-list', '--count', `develop..${branch}`]) || '0') || 0 : 0
    if (pending > 0) {
      return { ok: false, error: `${name} 的分支 ${branch} 还有 ${pending} 个提交没合进 develop：先跑 Tools/Worktree/collect.mjs 再删` }
    }
    if (!input.confirm) {
      return { ok: false, error: `真要删 ${station.path}（分支 ${branch}）就带 confirm: true 再调一次` }
    }
    return spawnJob({
      kind: 'remove',
      name,
      path: station.path,
      workdir: mainDir,
      // junction / 硬链接不会被 git worktree remove 清掉，rm -rf 兜底（文档 §7）。
      script: `git worktree remove --force '${shPath(station.path)}' 2>/dev/null; rm -rf '${shPath(station.path)}'`,
      onDone: () => dropStation(name),
    })
  }

  /** 只从工位表里移除，不碰磁盘（工位其实已经被手动删掉了时用）。 */
  function forgetStation(input = {}) {
    const config = read()
    const name = String(input.name || '').trim()
    const path = String(input.path || '').trim()
    const hit = config.stations.find((item) => item.name === name || (path && item.path.toLowerCase() === path.toLowerCase()))
    if (!hit) return { ok: false, error: '工位表里没有这一项' }
    const live = runningAll().find((item) => item.workdir === hit.path)
    if (live) return { ok: false, error: `${hit.name} 上还有批次在跑，先停再移除` }
    dropStation(hit.name)
    return { ok: true, stations: read().stations }
  }

  /**
   * 打开本工位的 Unity（带 puer-exec 控制开关）。
   * 首次导入约 4.5 分钟，开了之后 stationState 的 unity 会变成 'on'，卡片自己变空闲。
   */
  function openUnity(input = {}) {
    const config = read()
    const name = String(input.name || '').trim()
    const station = config.stations.find((item) => item.name === name)
    if (!station) return { ok: false, error: `没有叫 ${name} 的工位` }
    const path = station.path
    if (!existsSync(path)) return { ok: false, error: `目录不存在：${path}` }
    const state = unityState(path)
    if (state === 'on') return { ok: false, error: `${name} 的 Unity 已经开着，控制端点也在` }
    if (state === 'booting') return { ok: false, error: `${name} 的 Unity 正在启动（首次导入约 4.5 分钟），等它起来再点` }

    // 版本从工程文件读，别写死。
    let version = ''
    try {
      const text = readFileSync(join(path, 'ProjectSettings', 'ProjectVersion.txt'), 'utf8')
      version = (text.match(/m_EditorVersion:\s*(\S+)/) || [])[1] || ''
    } catch {
      version = ''
    }
    if (!version) return { ok: false, error: '读不到 Unity 版本（ProjectSettings/ProjectVersion.txt）' }
    const exe = `C:/Program Files/Unity ${version}/Editor/Unity.exe`
    if (!existsSync(exe)) return { ok: false, error: `找不到 Unity：${exe}` }

    const log = join(path, 'Temp', 'UnityPuerExec', 'Editor.log')
    mkdirSync(dirname(log), { recursive: true })
    let child
    try {
      child = spawn(exe, ['-projectPath', path, '-unityPuerExecControl', '-logFile', log], {
        cwd: path,
        detached: true,
        windowsHide: true,
        stdio: 'ignore',
      })
    } catch (err) {
      return { ok: false, error: `起不来：${err.message}` }
    }
    child.once('error', () => {})
    child.unref()
    return {
      ok: true,
      pid: child.pid || 0,
      version,
      log,
      note: '首次导入约 4.5 分钟；好了卡片会自己变成空闲',
    }
  }

  /**
   * 丢掉工位上未提交的改动（已跟踪文件恢复到 HEAD）。
   *
   * 用途：新树第一次开 Unity 会把 Spine / EditorSetting 那批生成物重写一遍，
   * git diff 是空的（只是 stat/size 变了）但 status 报脏，脏工作区开不了工。
   *
   * 危险：它真的会丢东西（agent 没提交的改动一起没）。所以：有活批次直接拒，
   * 不带 confirm 不执行，未跟踪文件不碰（只 git restore -- .，不 git clean）。
   */
  function cleanStation(input = {}) {
    const config = read()
    const name = String(input.name || '').trim()
    const station = config.stations.find((item) => item.name === name)
    if (!station) return { ok: false, error: `没有叫 ${name} 的工位` }
    const path = station.path
    if (!existsSync(path)) return { ok: false, error: `目录不存在：${path}` }
    const live = runningAll().find((item) => item.workdir === path)
    if (live) return { ok: false, error: `${name} 上还有批次在跑，不能清理` }

    const dirty = gitOut(path, ['status', '--porcelain', '--untracked-files=no'])
    const count = dirty ? dirty.split('\n').filter(Boolean).length : 0
    if (!count) return { ok: true, cleaned: 0, note: '工作区本来就是干净的' }
    if (!input.confirm) {
      return { ok: false, error: `要丢撈 ${name} 上 ${count} 个未提交改动，带 confirm: true 再调一次` }
    }
    if (!gitRun(path, ['restore', '--', '.'])) return { ok: false, error: '清理失败（git restore 报错）' }
    const left = gitOut(path, ['status', '--porcelain', '--untracked-files=no'])
    return { ok: true, cleaned: count, left: left ? left.split('\n').filter(Boolean).length : 0 }
  }

  /**
   * 工位分支上「真正还没进主树」的提交数。
   * 不能用 rev-list HEAD..branch：cherry-pick 后 sha 变了，rev-list 会把已经合入的提交再算一遍。
   * git cherry 按 patch 等价性判断，`+` 开头才是真没合入、`-` 是已有等价补丁。
   */
  function pendingCount(main, branch) {
    if (!main || !branch) return 0
    const out = gitOut(main, ['cherry', 'HEAD', branch])
    return out ? out.split('\n').filter((line) => line.startsWith('+')).length : 0
  }

  /** 仓库级 tapd-loop.json（run.doneStatus 这类只对某个仓库生效的配置）。 */
  function loopConfig(main) {
    const common = gitOut(main, ['rev-parse', '--git-common-dir'])
    if (!common) return {}
    const file = join(isAbsolute(common) ? common : resolve(main, common), 'tapd-loop.json')
    return readJson(file) || {}
  }

  /** 造一个 tapd-cli 客户端（任务配置沿用机器级 config.json）。 */
  function tapdClient(main) {
    const saved = readJson(join(home, 'config.json')) || {}
    return createTapd({
      cwd: main,
      workspaceId: String(saved?.task?.workspaceId || ''),
      assignee: String(saved?.task?.assignee || ''),
      commentAuthor: String(saved?.task?.commentAuthor || ''),
      labels: saved?.task?.labels || {},
    })
  }

  /** 提交 sha → 卡片 id：从跑过的 run 记录里查（card_done 事件带 commit）。 */
  function cardIdByCommit(sha) {
    const needle = String(sha || '').trim().toLowerCase().slice(0, 10)
    if (needle.length < 7) return ''
    let runs = []
    try {
      runs = readdirSync(runsRoot).filter((name) => name.startsWith('run-')).sort().reverse().slice(0, 40)
    } catch {
      return ''
    }
    for (const run of runs) {
      let cards = []
      try {
        cards = readdirSync(join(runsRoot, run))
      } catch {
        continue
      }
      for (const card of cards) {
        const file = join(runsRoot, run, card, 'progress.jsonl')
        if (!existsSync(file)) continue
        let text = ''
        try {
          text = readFileSync(file, 'utf8')
        } catch {
          continue
        }
        if (!text.toLowerCase().includes(needle)) continue
        const commits = [...text.matchAll(/"event":"card_done"[^\n]*?"commit":"([0-9a-f]+)"/g)].map((m) => m[1])
        if (commits.some((commit) => commit.toLowerCase().startsWith(needle))) return card
      }
    }
    return ''
  }

  /**
   * 合入后回写 TAPD：每一条被 cherry-pick 进来的提交，带 `-x` 会写回原始 sha，
   * 用它在 run 记录里找回卡片，评论 + （配了 run.doneStatus 时）改状态。
   */
  function writeBackMerged({ stationName, branch, main, before }) {
    const after = gitOut(main, ['rev-parse', 'HEAD'])
    if (!before || !after || before === after) {
      return { ok: false, error: '主树 HEAD 没变，没有可回写的提交' }
    }
    const raw = gitOut(main, ['log', `--format=%H%x09%B%x00`, `${before}..${after}`])
    const blocks = raw.split('\u0000').map((block) => block.trim()).filter(Boolean)
    const cfg = loopConfig(main)
    const doneStatus = String(cfg?.run?.doneStatus || cfg?.task?.doneStatus || '').trim()
    const tapd = tapdClient(main)
    const results = []

    for (const block of blocks) {
      const [sha, ...rest] = block.split('\t')
      if (!sha) continue
      const body = rest.join('\t')
      const origin = (/cherry picked from commit ([0-9a-f]{7,40})/.exec(body) || [])[1] || sha
      const cardId = cardIdByCommit(origin)
      if (!cardId) {
        results.push({ sha: sha.slice(0, 10), origin: origin.slice(0, 10), ok: false, reason: '找不到对应卡片' })
        continue
      }
      const note = `[tapd-loop] 已合入主树：${branch} → ${String(cfg?.run?.targetBranch || 'develop')}，` +
        `合并后提交 ${after.slice(0, 10)}（工位原始提交 ${origin.slice(0, 10)}）。` +
        (doneStatus ? `\n\n状态流转：${doneStatus}，处理人已交回创建人` : '')
      const one = { cardId, sha: sha.slice(0, 10), origin: origin.slice(0, 10), ok: true }
      try {
        tapd.addComment(cardId, note)
      } catch (err) {
        one.ok = false
        one.commentError = err.message
      }
      if (doneStatus) {
        try {
          const moved = tapd.setStatus(cardId, doneStatus)
          one.status = moved.label || doneStatus
          one.statusSkipped = moved.skipped || ''
        } catch (err) {
          one.ok = false
          one.statusError = err.message
        }
      } else {
        one.statusSkipped = '没配 run.doneStatus'
      }
      // 验收是创建人的事：状态流转的同时把处理人也交回去，否则卡会停在 agent 名上没人管。
      try {
        const handed = tapd.handToCreator(cardId)
        one.owner = handed.owner || ''
        one.ownerSkipped = handed.skipped || ''
      } catch (err) {
        one.ok = false
        one.ownerError = err.message
      }
      results.push(one)
    }

    try {
      const done = raw().jobs || []
      writeJson(controlFile, {
        ...raw(),
        lastMerge: { station: stationName, branch, before, after, at: Date.now(), results },
      })
      void done
    } catch {
      // 记不上 lastMerge 不影响已经写进 TAPD 的东西
    }
    emit()
    return { ok: results.every((item) => item.ok), results }
  }

  /**
   * 合入工位：跑主树的 Tools/Worktree/collect.mjs（pick → 导表 → verify → push），
   * 跑完回写 TAPD。跟其他长任务一样走 job，页面轮询看进度。
   */
  function mergeStation(input = {}) {
    const config = read()
    const name = String(input.name || '').trim()
    const station = config.stations.find((item) => item.name === name)
    if (!station) return { ok: false, error: `没有叫 ${name} 的工位` }
    const main = String(input.workdir || config.workdir || '').trim()
    if (!main) return { ok: false, error: '先选主树工作目录' }
    const live = runningAll().find((item) => item.workdir === station.path)
    if (live) return { ok: false, error: `${name} 上还有批次在跑，等它跑完再合入` }

    const branch = gitOut(station.path, ['rev-parse', '--abbrev-ref', 'HEAD'])
    if (!branch || branch === 'HEAD') return { ok: false, error: `${name} 读不到当前分支（detached？）` }
    const pending = pendingCount(main, branch)
    if (!pending) return { ok: true, pending: 0, note: `${branch} 上没有未合入提交` }
    if (gitOut(main, ['status', '--porcelain', '--untracked-files=no'])) {
      return { ok: false, error: '主树有未提交改动，collect 会被挡住：先处理干净' }
    }

    const script = join(main, 'Tools', 'Worktree', 'collect.mjs')
    if (!existsSync(script)) return { ok: false, error: `主树没有合入脚本：${script}` }
    const before = gitOut(main, ['rev-parse', 'HEAD'])

    return spawnJob({
      kind: 'merge',
      name,
      path: station.path,
      workdir: main,
      // --resolve：冲突不 abort，保留现场（退出码 2）。
      // code 2 时 spawnJob 自动调 onConflict → 起 agent 解 → continue → collect --resume。
      script: `exec '${shPath(process.execPath)}' '${shPath(script)}' '${branch}' --resolve`,
      onDone: () => writeBackMerged({ stationName: name, branch, main, before }),
      onConflict: () => resolveMerge({ name, workdir: main }),
    })
  }

  /** 主树是不是停在 cherry-pick 中间态；返回冲突文件和其中不可自动解的表格。 */
  function conflictState(main) {
    const own = resolve(main, gitOut(main, ['rev-parse', '--git-dir']) || '.git')
    if (!existsSync(join(own, 'CHERRY_PICK_HEAD'))) return null
    const files = gitOut(main, ['diff', '--name-only', '--diff-filter=U'])
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    return { files, xlsx: files.filter((file) => /\.(xlsx|xlsm)$/i.test(file)) }
  }

  /**
   * 起一个 agent 按 digitdoor-git-pull-rebase 技能解冲突，解完自动续跑 collect --resume。
   *
   * 两个硬约束：
   *   - 只允许改「冲突文件」—— brief 里写明，且解完后重新检查 UU 清单
   *   - 表格冲突（xlsx/xlsm）直接拒，必须人工用 xlsx-cell-diff overlay 合（自动会丢行）
   */
  function resolveMerge(input = {}) {
    const config = read()
    const name = String(input.name || '').trim()
    const main = String(input.workdir || config.workdir || '').trim()
    if (!main) return { ok: false, error: '先选主树工作目录' }
    const station = config.stations.find((item) => item.name === name)
    const conflict = conflictState(main)
    if (!conflict) return { ok: false, error: '主树不在 cherry-pick 中间态，没有要解的冲突' }
    if (conflict.xlsx.length) {
      return { ok: false, error: `这批是表格冲突，必须人工用 xlsx-cell-diff 合：${conflict.xlsx.join('、')}` }
    }

    const dir = join(batchDir, `resolve-${stamp()}`)
    mkdirSync(dir, { recursive: true })
    const log = join(dir, 'agent.log')
    const job = {
      id: `job-${stamp()}-resolve`,
      kind: 'resolve',
      name: name || '(主树)',
      path: main,
      workdir: main,
      // 这个 job 是一条异步 Promise（起 agent），没有子进程 pid。
      // 用看板自己的 pid 占位：只要看板还活着就算 running，看板重启后自然消失（异步任务也真没了）。
      pid: process.pid,
      startedAt: Date.now(),
      status: 'running',
      log,
    }
    const current = raw()
    const jobs = (Array.isArray(current.jobs) ? current.jobs : [])
      .filter((item) => (item.status === 'running' ? pidAlive(Number(item.pid)) : true))
      .slice(-9)
    writeJson(controlFile, { ...current, jobs: [...jobs, job] })
    emit()

    const branch = station ? gitOut(station.path, ['rev-parse', '--abbrev-ref', 'HEAD']) : ''
    const target = String(loopConfig(main)?.run?.targetBranch || 'develop')
    const before = gitOut(main, ['rev-parse', `origin/${target}`])
    void runResolver({ name, main, conflict, dir, job, branch, before }).catch(() => {})

    return { ok: true, job, conflicted: conflict.files }
  }

  async function runResolver({ name, main, conflict, dir, job, branch, before }) {
    const settle = (status, extra = {}) => {
      const done = raw()
      writeJson(controlFile, {
        ...done,
        jobs: (done.jobs || []).map((item) => (item.id === job.id ? { ...item, status, endedAt: Date.now(), ...extra } : item)),
      })
      emit()
    }

    try {
      const brief = join(dir, 'brief.md')
      writeFileSync(brief, [
        `主树 develop 在 cherry-pick 工位 ${name || ''} 的提交时冲突了。`,
        '',
        '冲突文件（只有这些可以改，别动其他文件）：',
        ...conflict.files.map((file) => `- ${file}`),
        '',
        '按技能流程做：',
        '1. 逐个读冲突文件，理解双方意图（<<<<<<< = 主树已有，>>>>>>> = 工位带来的）',
        '2. 双方改动互不冲突就保留双方；真冲突就合出一个语义正确的实现，不要丢掉任何一方的行为',
        '3. 解完 `git add` 这些文件，然后 `git cherry-pick --continue`（不要 push）',
        '4. 最后输出一行 `RESOLVED: <一句话总结改了什么>`',
      ].join('\n'), 'utf8')

      const skillDir = join(main, '.agents', 'skills', 'digitdoor-git-pull-rebase')
      const result = await runTurn({
        workdir: main,
        promptFile: brief,
        outDir: dir,
        skillPath: existsSync(skillDir) ? skillDir : '',
        sessionId: `resolve-${name || 'main'}-${Date.now()}`,
        timeoutMs: 30 * 60_000,
      })
      if (result.timedOut) throw new Error('agent 解冲突超时（30 分钟）：看 agent.log')

      const left = conflictState(main)
      if (left) throw new Error(`还有未解冲突：${left.files.join('、')}`)

      // agent 不一定记得 --continue，这里补一次。
      const own = resolve(main, gitOut(main, ['rev-parse', '--git-dir']) || '.git')
      if (existsSync(join(own, 'CHERRY_PICK_HEAD'))) {
        if (!gitRun(main, ['cherry-pick', '--continue', '--no-edit'])) {
          throw new Error('agent 解完了，但 git cherry-pick --continue 失败')
        }
      }

      // 续跑：导表 → verify → push，成功后回写 TAPD。
      const collect = join(main, 'Tools', 'Worktree', 'collect.mjs')
      const resumed = spawnJob({
        kind: 'merge-resume',
        name: name || '(主树)',
        path: main,
        workdir: main,
        script: `exec '${shPath(process.execPath)}' '${shPath(collect)}' --resume`,
        onDone: () => writeBackMerged({ stationName: name || '(主树)', branch, main, before }),
      })
      settle('done', { resumed: resumed.ok, resumedJob: resumed.job?.id || '' })
    } catch (err) {
      settle('failed', { error: err.message })
    }
  }

  /**
   * 真的去 ping 一次控制端点（/health）。卡片上的 on/booting 是看文件的猜测，这个是实况，
   * 用来区分「还在导入」和「开着但没带控制开关 / 已经卡死」。
   */
  async function probeUnity(input = {}) {
    const config = read()
    const name = String(input.name || '').trim()
    const station = config.stations.find((item) => item.name === name)
    if (!station) return { ok: false, error: `没有叫 ${name} 的工位` }
    const path = station.path
    const state = unityState(path)
    if (state === 'off') return { ok: false, state, error: 'Unity 没开（Temp/UnityLockfile 没被占）' }

    const endpointFile = join(path, 'Temp', 'UnityPuerExec', 'endpoint.json')
    if (!existsSync(endpointFile)) {
      return {
        ok: false,
        state,
        error: '控制端点文件还没出来：Unity 还在导入，或者它不是带 -unityPuerExecControl 启动的',
      }
    }
    let info = {}
    try {
      info = JSON.parse(readFileSync(endpointFile, 'utf8'))
    } catch (err) {
      return { ok: false, state, error: `endpoint.json 读不出来：${err.message}` }
    }
    const base = `http://127.0.0.1:${info.port}`
    try {
      const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(3000) })
      const body = await res.json().catch(() => ({}))
      return {
        ok: Boolean(body.ok),
        state,
        port: info.port,
        pid: info.unity_pid,
        status: String(body.status || ''),
        error: body.ok ? '' : `端点回了 ${res.status}`,
      }
    } catch (err) {
      return { ok: false, state, port: info.port, error: `连不上 ${base}：${err.message}` }
    }
  }

  /**
   * 调度器的一次 tick：判断空位 → 查工单 → 把卡派给空闲工位 → 各工位开工。
   *
   * 与老「定时接单」的区别：老逻辑是「有一批在跑就跳过」，多工位并行下那是死锁；
   * 现在问的是「还有几个空位」，有几个就派几张。
   *
   * 派卡去重靠两道：本 tick 内从队列里扣掉已派的；跨 tick 靠活批次带的 card 字段。
   * TAPD 的 afk-claimed 是跨机互斥，loop.mjs 自己还会再验一次。
   */
  async function tick(opts = {}) {
    const config = read()
    if (!config.watch.enabled && !opts.force) {
      memory.nextAt = 0
      return { skipped: 'off' }
    }
    if (memory.probing) return { skipped: 'probing' }
    if (!config.workdir) {
      memory.lastError = '调度器要先选主树工作目录'
      memory.nextAt = Date.now() + 30_000
      return { skipped: 'no-workdir' }
    }
    if (!opts.force && Date.now() < memory.nextAt) return { skipped: 'waiting' }

    const stations = stationState(config)
    const idle = stations.filter((station) => station.idle && station.usable)
    if (!idle.length) {
      // 全满或全都不可用：别等完整轮询间隔，工位一空就能接上。
      memory.nextAt = Date.now() + Math.min(30, config.watch.pollSec) * 1000
      if (stations.length && !stations.every((s) => s.usable)) {
        const why = (s) => (!s.exists ? '目录不在'
          : !s.isRepo ? '不是仓库'
            : s.dirty ? '工作区脏'
              : s.unity === 'off' ? 'Unity 没开'
                : s.unity === 'booting' ? 'Unity 正在启动'
                  : '不可用')
        memory.lastError = `没有可用工位：${stations.filter((s) => !s.usable).map((s) => `${s.name}(${why(s)})`).join('、')}`
      }
      return { skipped: stations.length ? 'no-idle' : 'no-station', stations: stations.length }
    }

    memory.probing = true
    memory.nextAt = Date.now() + config.watch.pollSec * 1000
    try {
      const listed = await queueFor(config.workdir, { refresh: true })
      memory.lastCheckAt = Date.now()
      memory.lastReady = listed.ok ? listed.ready.length : 0
      memory.lastError = listed.ok ? '' : listed.error
      if (!listed.ok) return { checked: true, ready: 0, error: listed.error || '' }

      const taken = new Set(runningAll().map((item) => String(item.card || '')).filter(Boolean))
      const cutoff = Date.now() - 30 * 60_000
      memory.dispatched = memory.dispatched.filter((item) => item.at >= cutoff)
      for (const item of memory.dispatched) taken.add(item.card)

      const free = (listed.ready || []).filter((card) => !taken.has(String(card.id || '')))
      if (!free.length) return { checked: true, ready: (listed.ready || []).length, idle: idle.length, started: [] }

      const take = Math.min(idle.length, free.length)
      const started = []
      for (let i = 0; i < take; i += 1) {
        const station = idle[i]
        const card = free[i]
        const result = start({ ...config, workdir: station.path, card: String(card.id) })
        if (result.ok) {
          memory.dispatched.push({ card: String(card.id), station: station.name, pid: result.batch?.pid || 0, at: Date.now() })
          started.push({ station: station.name, card: String(card.id), ok: true })
        } else {
          memory.lastError = `${station.name}: ${result.error}`
          started.push({ station: station.name, card: String(card.id), ok: false, error: result.error })
        }
      }
      return { checked: true, ready: (listed.ready || []).length, idle: idle.length, started }
    } finally {
      memory.probing = false
      if (!memory.nextAt || memory.nextAt < Date.now()) memory.nextAt = Date.now() + config.watch.pollSec * 1000
      emit()
    }
  }

  return {
    home,
    runsRoot,
    controlFile,
    key: () => ensureKey(home),
    status,
    read,
    write,
    start,
    stop,
    tick,
    queueFor,
    list,
    peek,
    busy,
    runningAll,
    stationState,
    listJobs,
    createStation,
    removeStation,
    registerStation,
    forgetStation,
    mergeStation,
    resolveMerge,
    openUnity,
    probeUnity,
    cleanStation,
    onChange: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

function summarizeQueue(queue, workdir) {
  return {
    workdir: queue.workdir,
    match: queue.workdir === workdir,
    ok: Boolean(queue.ok),
    error: queue.error || '',
    at: queue.at,
    ready: (queue.ready || []).map((card) => ({
      id: String(card.id || ''),
      title: String(card.title || ''),
      statusLabel: String(card.statusLabel || ''),
      priorityLabel: String(card.priorityLabel || ''),
      labels: card.labels || [],
    })),
    rejected: (queue.rejected || []).map((card) => ({
      id: String(card.id || ''),
      title: String(card.title || ''),
      statusLabel: String(card.statusLabel || ''),
      reason: String(card.reason || ''),
    })),
    allowedStatuses: queue.allowedStatuses || [],
  }
}

function clip(text, max) {
  const one = String(text || '').replace(/\s+$/, '')
  return one.length > max ? `${one.slice(0, max)}…` : one
}
