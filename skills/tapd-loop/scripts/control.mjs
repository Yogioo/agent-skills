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
import { dirname, isAbsolute, join, resolve } from 'node:path'

export const CONTROL_FILE = 'board-control.json'
export const KEY_FILE = 'board-key'
/** 批次的 stdout/stderr 落在 <home>/board-batches/batch-<时间戳>.log。 */
export const BATCH_DIR = 'board-batches'

const MAX_TASKS_CAP = 20
const MIN_POLL_SEC = 30
const MAX_POLL_SEC = 24 * 60 * 60
const LIST_TIMEOUT_MS = 90_000
const TAIL_BYTES = 8 * 1024
const PROBE_DIRS = 8

export const DEFAULTS = {
  workdir: '',
  assignee: '',
  maxTasks: 1,
  allowDirty: false,
  noWrite: false,
  watch: { enabled: false, pollSec: 300 },
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
function probeRun(runsRoot) {
  let names = []
  try {
    names = readdirSync(runsRoot)
      .filter((name) => name.startsWith('run-'))
      .map((name) => ({ name, at: statSync(join(runsRoot, name)).mtimeMs }))
      .sort((a, b) => b.at - a.at)
      .slice(0, PROBE_DIRS)
      .map((entry) => entry.name)
  } catch {
    return null
  }
  for (const name of names) {
    const file = join(runsRoot, name, 'progress.jsonl')
    if (!existsSync(file)) continue
    const start = firstJsonLine(file)
    if (!start || start.event !== 'loop_start') continue
    if (tailText(file, TAIL_BYTES).includes('"loop_end"')) continue
    if (!pidAlive(Number(start.pid))) continue
    return {
      kind: 'run',
      runId: name,
      workdir: String(start.workdir || ''),
      pid: Number(start.pid) || 0,
      startedAt: Number(start.t) || 0,
      maxTasks: Number(start.maxTasks) || 0,
    }
  }
  return null
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
  }

  function raw() {
    return readJson(controlFile) || {}
  }

  function read() {
    return sanitizeControl(raw(), DEFAULTS)
  }

  /** 写配置时逐字保留 batch / lastBatch：它们是状态，不是可编辑字段。 */
  function write(input, base) {
    const current = raw()
    const next = sanitizeControl(input, base || sanitizeControl(current, DEFAULTS))
    writeJson(controlFile, {
      ...next,
      ...(current.batch ? { batch: current.batch } : {}),
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

  function ownBatch() {
    const saved = raw().batch
    if (!saved || !saved.pid) return null
    return pidAlive(Number(saved.pid)) ? { ...saved, kind: 'batch' } : { ...saved, kind: 'batch', dead: true }
  }

  function busy() {
    return probeRun(runsRoot) || ownBatch()
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
    const stale = ownBatch()
    // 批次进程在、但看板重启过：这时没人收尸，第一次问就把死记录清掉。
    if (stale?.dead) writeJson(controlFile, { ...raw(), batch: null })
    const running = probeRun(runsRoot) || (stale && !stale.dead ? stale : null)
    const stopFile = config.workdir ? stopFilePath(config.workdir) : ''
    return {
      config,
      running,
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
    const running = busy()
    if (running && !running.dead) {
      return { ok: false, error: `已经有一批在跑（${running.runId || running.pid}），等它跑完或先点停止`, running }
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
    writeJson(controlFile, { ...raw(), ...merged, watch: merged.watch, batch })
    child.once('exit', (code, signal) => {
      const finished = raw()
      const lastBatch = { ...batch, endedAt: Date.now(), code: code ?? -1, signal: signal || '', summary: lastSummary(log) }
      memory.lastBatch = lastBatch
      writeJson(controlFile, { ...finished, batch: finished.batch?.pid === batch.pid ? null : finished.batch, lastBatch })
      // 跑完顺手把队列刷一遍：被接走的卡应该从「就绪」里消失。只在页面已经问过队列时才刷，
      // 免得没人看页面的时候也去打 TAPD。
      if (memory.queue) queueFor(batch.workdir, { refresh: true }).catch(() => {})
      emit()
    })
    child.unref()
    emit()
    return { ok: true, batch, config: merged }
  }

  /** 停：只写停止文件，不杀当前卡。语义跟 CLI 的 `--stop` 完全一致。 */
  function stop(input = {}) {
    const config = sanitizeControl(input, read())
    const running = busy()
    const workdir = running && !running.dead ? String(running.workdir || '') : config.workdir
    if (!workdir) return { ok: false, error: '不知道要停哪个仓库：先选工作目录' }
    const file = stopFilePath(workdir)
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, `${new Date().toISOString()}\n`, 'utf8')
    } catch (err) {
      return { ok: false, error: `写停止文件失败：${err.message}` }
    }
    return { ok: true, file, running: running && !running.dead ? running : null }
  }

  /**
   * 定时接单的一次 tick：开关关着就什么都不做；有一批在跑就不查（查了也开不了工）；
   * 不到点就不查。查到就绪卡才开工，没卡只更新「上次查到几张」。
   */
  async function tick() {
    const config = read()
    if (!config.watch.enabled) {
      memory.nextAt = 0
      return { skipped: 'off' }
    }
    if (memory.probing) return { skipped: 'probing' }
    const running = busy()
    if (running && !running.dead) {
      memory.nextAt = Date.now() + 10_000
      return { skipped: 'busy' }
    }
    if (!config.workdir) {
      memory.lastError = '定时接单要先选工作目录'
      memory.nextAt = Date.now() + 30_000
      return { skipped: 'no-workdir' }
    }
    if (Date.now() < memory.nextAt) return { skipped: 'waiting' }

    memory.probing = true
    memory.nextAt = Date.now() + config.watch.pollSec * 1000
    try {
      const listed = await queueFor(config.workdir, { refresh: true })
      memory.lastCheckAt = Date.now()
      memory.lastReady = listed.ok ? listed.ready.length : 0
      memory.lastError = listed.ok ? '' : listed.error
      if (!listed.ok || !listed.ready.length) return { checked: true, ready: 0, error: listed.error || '' }
      const started = start({ ...config, card: '' })
      // 开工失败也要写进 lastError：不然页面只会看到「上次查到 1 张」，然后一直不动。
      if (!started.ok) memory.lastError = started.error
      return { checked: true, ready: listed.ready.length, started }
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
