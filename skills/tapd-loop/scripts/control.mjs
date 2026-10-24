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
      const batch = active.find((item) => item.workdir === path) || null
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
        idle: !batch,
        // 可用 = 目录在 + 是 git 仓库 + 工作区没改已跟踪文件（脏工作区开工必然失败）
        usable: exists && isRepo && !dirty,
        card: batch ? String(batch.card || '') : '',
        runId: batch ? String(batch.runId || '') : '',
        pid: batch ? Number(batch.pid) || 0 : 0,
        startedAt: batch ? Number(batch.startedAt) || 0 : 0,
      }
    })
  }

  /** 建树 / 删树的长任务。活着的按 pid 判，跑完的看退出码。 */
  function listJobs() {
    const saved = raw()
    const jobs = Array.isArray(saved.jobs) ? saved.jobs : []
    return jobs.map((job) => {
      const alive = job.pid ? pidAlive(Number(job.pid)) : false
      const status = job.status === 'running' && !alive ? 'unknown' : job.status
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

  /** 后台跑一个长命令，状态记进 jobs。页面轮询看进度，日志落在 board-batches/。 */
  function spawnJob({ kind, name, path, workdir, cmd, argv, onDone }) {
    mkdirSync(batchDir, { recursive: true })
    const log = join(batchDir, `station-${kind}-${name}-${stamp()}.log`)
    const fd = openSync(log, 'a')
    let child
    try {
      child = spawn(cmd, argv, { cwd: workdir, detached: true, windowsHide: true, stdio: ['ignore', fd, fd] })
    } catch (err) {
      closeSync(fd)
      return { ok: false, error: `起不来：${err.message}` }
    }
    closeSync(fd)
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
    child.once('exit', (code) => {
      const done = raw()
      const status = code === 0 ? 'done' : 'failed'
      writeJson(controlFile, {
        ...done,
        jobs: (Array.isArray(done.jobs) ? done.jobs : [])
          .map((item) => (item.id === job.id ? { ...item, status, code: code ?? -1, endedAt: Date.now() } : item)),
      })
      // 只有成功才动注册表：失败了让人先看日志，不要把半成品登记进工位表。
      if (code === 0 && onDone) {
        try {
          onDone()
        } catch {
          // onDone 炸了不影响 job 已记下的结果
        }
      }
      emit()
    })
    child.unref()
    emit()
    return { ok: true, job }
  }

  /** 建树脚本约定的目录：<主树的兄弟目录>/<主树名>-wt-<名字>（见 Tools/Worktree/new-worktree.sh）。 */
  function defaultStationPath(main, name) {
    return join(dirname(main), `${basename(main)}-wt-${name}`)
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
      cmd: 'bash',
      argv: [script, name],
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
      cmd: 'bash',
      argv: ['-c', `git worktree remove --force '${station.path}' 2>/dev/null; rm -rf '${station.path}'`],
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
        memory.lastError = `没有可用工位：${stations.filter((s) => !s.usable).map((s) => `${s.name}(${!s.exists ? '目录不在' : !s.isRepo ? '不是仓库' : '工作区脏'})`).join('、')}`
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
