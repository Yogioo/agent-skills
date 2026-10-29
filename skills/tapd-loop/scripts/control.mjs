import { createTapd } from './tapd.mjs'
import { runTurn } from './turn.mjs'
import { appendTrace } from './trace-index.mjs'

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

import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  appendFileSync, copyFileSync,
  closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
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

/**
 * 机器自己造的分支：合入入口必须认得它们。
 *
 *   tapd-loop-failed/<卡>    失败现场快照（提交说明里就写着「未完成，勿合入」）
 *   tapd-loop-orphan/<卡>    被强杀 / 断电的批次留下的脏工作区，开工前存下来的
 *   tapd-loop-unpushed/<卡>  已经提交、但推送前挂了，从当前分支挪出去的
 *
 * 前两种是「只给人看」的存档，自动和手动合入都不该碰。第三种是「合入再推」这条路
 * 正常要用的东西，所以只拦自动（人点「合入」正是它的恢复手段）。
 */
const ARCHIVE_BRANCH = /^tapd-loop-(failed|orphan)\//
const KEPT_BRANCH = /^tapd-loop-unpushed\//
// 多工位并行后 run 目录攒得快：窗口太小会把还在跑的批次挤出扫描范围，判成「没人在跑」，
// 于是同一个工位被开第二批。8 够单工位用，多工位必须放大。
const PROBE_DIRS = 64
/** 工位名会变成目录名（<主树>-wt-<名字>）和分支名（feat/<名字>），只放行 shell-safe 的字符。 */
const STATION_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,23}$/

/** 长任务（建树 / 删树）的日志落在 <home>/board-batches/ 下，和批次日志放一起。 */
const STATION_JOB_TIMEOUT_MS = 60 * 60_000
/**
 * 看板重启后，「进程看不到了」不等于「活干完了」：collect 是 detached 起的，
 * 看板死了它还在动主树。宽限期内照样把它当「主树忙」。
 * 15 分钟：一次合入/推送最慢也就三五分钟，留出余量给解冲突。
 */
const ORPHAN_JOB_GRACE_MS = 15 * 60_000

export const DEFAULTS = {
  workdir: '',
  assignee: '',
  maxTasks: 1,
  allowDirty: false,
  noWrite: false,
  watch: { enabled: false, pollSec: 300 },
  /** 主树自动验证并推送：主树有没推的提交、Unity 在线、没冲突时就自己跑 collect --resume。 */
  autoPush: { enabled: false, pollSec: 120 },
  /**
   * 主树自动合入工位提交：有工位攒了未合入提交、主树干净、Unity 在线时，自己跑
   * collect.mjs（pick → 导表 → verify → push → 回写 TAPD）。默认关：它会往共享分支写东西。
   */
  autoMerge: { enabled: false, pollSec: 120 },
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
    // paused 是「调度器别再给它派卡」，不是「工位坏了」：不参与 usable 判定。
    out.push({ name, path, note: String(item?.note || '').slice(0, 200), paused: Boolean(item?.paused) })
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
    autoPush: {
      enabled: Boolean(base.autoPush?.enabled),
      pollSec: clampInt(base.autoPush?.pollSec, MIN_POLL_SEC, MAX_POLL_SEC, DEFAULTS.autoPush.pollSec),
    },
    autoMerge: {
      enabled: Boolean(base.autoMerge?.enabled),
      pollSec: clampInt(base.autoMerge?.pollSec, MIN_POLL_SEC, MAX_POLL_SEC, DEFAULTS.autoMerge.pollSec),
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
  if (input.autoPush && typeof input.autoPush === 'object') {
    if ('enabled' in input.autoPush) out.autoPush.enabled = Boolean(input.autoPush.enabled)
    if ('pollSec' in input.autoPush) out.autoPush.pollSec = clampInt(input.autoPush.pollSec, MIN_POLL_SEC, MAX_POLL_SEC, out.autoPush.pollSec)
  }
  if (input.autoMerge && typeof input.autoMerge === 'object') {
    if ('enabled' in input.autoMerge) out.autoMerge.enabled = Boolean(input.autoMerge.enabled)
    if ('pollSec' in input.autoMerge) out.autoMerge.pollSec = clampInt(input.autoMerge.pollSec, MIN_POLL_SEC, MAX_POLL_SEC, out.autoMerge.pollSec)
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

/**
 * 两个路径是不是同一个目录。
 * 工位表里存的是 ``C:/projects/...-wt-a``（正斜杠），而 loop 的 progress.jsonl 里记的是
 * ``C:\\projects\\...-wt-a``（反斜杠）。直接 ``===`` 永远不相等，后果是「跑着的工位看着空闲」
 * （于是画「接一单」），更糟的是 remove / clean / merge 的「有批次在跑」闸门也会漏。
 */
function samePath(a, b) {
  if (!a || !b) return false
  const fold = (value) => {
    let text
    try {
      text = resolve(String(value))
    } catch {
      text = String(value)
    }
    text = text.replace(/[\\/]+$/, '')
    return process.platform === 'win32' ? text.toLowerCase() : text
  }
  return fold(a) === fold(b)
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
 * git 的异步版：轮询/看板状态路径必须用它。
 *
 * execFileSync 会把 Node 的事件循环整整卡住（3 个工位 × 5 条 git ≈ 450ms，再加主树 ≈ 600~1000ms）。
 * 而看板每 3 秒就要算一次状态、走 GET /api/control —— 这段时间里别人点「接活」，POST 只能排队，
 * 实测被挡 0.6~1 秒，表现就是「点下去很迟钝」。异步 spawn 不占线程，请求之间互不阻塞。
 */
async function gitOutAsync(cwd, args) {
  return await new Promise((done) => {
    execFile('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 20_000 }, (err, stdout) => {
      done(err ? '' : String(stdout || '').trim())
    })
  })
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

/** 拼一条 shell 命令行：shell:true + 参数数组会触发 DEP0190，而这里的参数都只有英文名。 */
function shellLine(parts) {
  return parts.map((part) => {
    const text = String(part)
    return /[\s"']/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }).join(' ')
}

/** agent-tools 在哪。Windows 上是 .cmd，直接 spawn('agent-tools') 会 ENOENT。 */
function resolveAgentTools() {
  const candidates = [process.env.TAPD_LOOP_AGENT_TOOLS || '', 'agent-tools.cmd', 'agent-tools']
  for (const file of candidates) {
    if (!file) continue
    // shell 一定要开：.cmd/.bat 在 Node 20+ 不能直接 spawn。探活只关心「能不能跑起来」。
    const probe = spawnSync(shellLine([file, 'xlsx-cell-diff', '--help']), {
      encoding: 'utf8', timeout: 30_000, windowsHide: true, shell: true,
    })
    if (!probe.error && probe.status !== null) return file
  }
  return ''
}

/**
 * 表格冲突自动叠：按「显示值」三方合并，只有同一格两边都改才算真冲突。
 *
 * git 对 xlsx 这种二进制只会判「整份冲突」，可配置表绝大多数冲突是两边改的格不重叠 ——
 * 那是有确定答案的（两边的改动都留下），没道理逼人开 Excel 手工合、更不该手工改二进制。
 * 三方版本从索引里取：:1: 共同祖先 / :2: 主树（local，模板侧）/ :3: 被合入的提交（remote）。
 *
 * 返回 { merged: [文件], left: [{ file, reason }] }。left 非空 = 真冲突（同一格两边都改）
 * 或结构变了（sheet/行/列增删），这两种必须人来定。
 */
export function mergeXlsxConflicts(main, files) {
  const merged = []
  const left = []
  const tool = resolveAgentTools()
  if (!tool) {
    return { merged, left: files.map((file) => ({ file, reason: '找不到 agent-tools（xlsx-cell-diff 在里面）' })) }
  }
  let dir = ''
  try {
    dir = mkdtempSync(join(tmpdir(), 'tapd-loop-xlsx-'))
  } catch (err) {
    return { merged, left: files.map((file) => ({ file, reason: `建临时目录失败：${err.message}` })) }
  }
  files.forEach((file, index) => {
    const base = `base-${index}.xlsx`
    const local = `local-${index}.xlsx`
    const remote = `remote-${index}.xlsx`
    const out = `out-${index}.xlsx`
    try {
      // 二进制不能走 gitOut（它按 utf8 解码），直接取 Buffer。
      for (const [stage, dest] of [[1, base], [2, local], [3, remote]]) {
        const blob = execFileSync('git', ['show', `:${stage}:${file}`], {
          cwd: main, maxBuffer: 64 * 1024 * 1024, windowsHide: true,
        })
        writeFileSync(join(dir, dest), blob)
      }
    } catch (err) {
      left.push({ file, reason: `取三方版本失败：${String(err.message).split('\n')[0]}` })
      return
    }
    // 参数只用临时目录里的英文文件名、cwd 落在临时目录：路径里的中文/#/空格不会进命令行。
    const res = spawnSync(shellLine([tool, 'xlsx-cell-diff', 'merge', '--base', base, '--local', local, '--remote', remote, '--out', out]), {
      cwd: dir, encoding: 'utf8', timeout: 180_000, windowsHide: true, shell: true,
    })
    if (res.status === 0) {
      try {
        copyFileSync(join(dir, out), join(main, file))
        merged.push(file)
      } catch (err) {
        left.push({ file, reason: `叠加结果写回失败：${err.message}` })
      }
      return
    }
    // 4 = 还有显示值冲突（同一格两边都改）；5 = 结构变了（增删 sheet/行/列）；3 = 读不出文件
    const reason = res.status === 4
      ? '同一格两边都改了'
      : res.status === 5
        ? 'sheet/行/列有增删'
        : `xlsx-cell-diff 退出 ${res.status ?? res.signal}`
    const tail = `${res.stdout || ''}${res.stderr || ''}`.trim().split('\n').filter(Boolean).slice(-2).join(' ')
    left.push({ file, reason: tail ? `${reason}：${tail}` : reason })
  })
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // 临时目录清不掉不影响结果
  }
  return { merged, left }
}

/**
 * 这笔提交的成果是不是已经在 base 里了（按内容比，不看 SHA / patch-id）。
 * 空提交算「已经在里面」——没东西可合。
 * 路径必须用 -z 取：带中文/# 的路径不加 -z 会被双引号包住，paths" 匹配不到文件，
 * git diff 就“没差异”，于是真的待合入也会被判成已合入（静默少算）。
 */
function contentAlreadyIn(main, base, sha) {
  const paths = gitOut(main, ['show', '--name-only', '-z', '--format=', sha])
    .split('\0').filter(Boolean)
  if (!paths.length) return true
  return gitRun(main, ['diff', '--quiet', base, sha, '--', ...paths])
}

async function contentAlreadyInAsync(main, base, sha) {
  const paths = (await gitOutAsync(main, ['show', '--name-only', '-z', '--format=', sha]))
    .split('\0').filter(Boolean)
  if (!paths.length) return true
  return await gitRunAsync(main, ['diff', '--quiet', base, sha, '--', ...paths])
}

/** 只关心成败的 git 命令（异步版：页面轮询不能卡事件循环）。 */
async function gitRunAsync(cwd, args) {
  return await new Promise((done) => {
    execFile('git', args, { cwd, windowsHide: true, timeout: 20_000 }, (err) => done(!err))
  })
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
    const tail = tailText(file, TAIL_BYTES)
    if (tail.includes('"loop_end"')) continue
    if (!pidAlive(Number(start.pid))) continue
    const card = cardFromTail(tail)
    out.push({
      kind: 'run',
      runId: name,
      workdir: String(start.workdir || ''),
      pid: Number(start.pid) || 0,
      startedAt: Number(start.t) || 0,
      maxTasks: Number(start.maxTasks) || 0,
      // 刚开跑时还没有卡（card_start 要等 TAPD 查完），所以这两个字段可以是空的。
      card: card.id,
      cardTitle: card.title || cardTitleFromRun(runsRoot, name, card.id),
    })
  }
  return out
}

/**
 * 从 progress 尾部找这批正在跑哪张卡。
 * 先看最后一条 heartbeat：它每 15 秒写一次，card 为空就表示两张卡之间（或还没接到卡），
 * 这时不要倒着找出上一张 card_done 的 id，否则「跑完一张、下一张还没接」会显示成上一张。
 */
function cardFromTail(tail) {
  const none = { id: '', title: '' }
  if (!tail) return none
  const events = []
  for (const line of tail.split('\n')) {
    if (!line.startsWith('{')) continue
    try {
      events.push(JSON.parse(line))
    } catch {
      // 尾巴第一行多半被截断了，跳过
    }
  }
  let id = ''
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i].event === 'heartbeat') { id = String(events[i].card || ''); break }
    if (events[i].event === 'card_done' || events[i].event === 'card_failed') return none
  }
  if (!id) {
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const candidate = String(events[i].id || events[i].card || '')
      if (/^\d{10,}$/.test(candidate)) { id = candidate; break }
    }
  }
  // 标题：心跳（新版本带 title）优先，退一步找这张卡的 card_start。
  // 卡片名给看板显示用，比 19 位 id 好认。
  let title = ''
  if (id) {
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i]
      if (String(event.card || event.id || '') !== id) continue
      if (event.title) { title = String(event.title); break }
    }
  }
  return { id, title }
}

/**
 * 标题的退路：长跑的心跳早就把 card_start 挤出尾部 8KB 了（老版本心跳不带 title），
 * 这时直接读这张卡开工时落盘的 card.json / card.md。标题一批之内不会变，读到就记住。
 */
const titleCache = new Map()
function cardTitleFromRun(runsRoot, runId, cardId) {
  if (!runId || !cardId) return ''
  const key = `${runId}/${cardId}`
  if (titleCache.has(key)) return titleCache.get(key)
  const dir = join(runsRoot, runId, cardId)
  let title = ''
  try {
    const saved = JSON.parse(readFileSync(join(dir, 'card.json'), 'utf8'))
    title = String(saved?.card?.title || saved?.detail?.title || '')
  } catch {
    // 没有 card.json 就看 card.md 的 H1
  }
  if (!title) {
    try {
      const line = readFileSync(join(dir, 'card.md'), 'utf8').split('\n').find((text) => text.startsWith('# '))
      if (line) title = line.slice(2).trim()
    } catch {
      // 卡还没落盘：下次再读
    }
  }
  if (title) titleCache.set(key, title)
  return title
}

/** 某个工位上有没有活批次。不传 workdir 就是全机（老语义）。 */function probeRun(runsRoot, workdir = '') {
  return allRuns(runsRoot).find((run) => !workdir || samePath(run.workdir, workdir)) || null
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
 * 从日志尾巴里抓一句「到底怎么失败的」。
 *
 * 卡片上只写 `exit 1` 等于没说，但 `[失败] …` 那一行往往也只是总结——真正的错
 * （连不上哪个端点、哪个用例红了）collect 会缩进打在它上面。所以拼两段：
 *   「缩进的具体原因」·「[失败] 那一句的第一句」
 * 找不到就步步降级（只剩 `[失败]` / 最后一行非空 / 明说日志没内容）。
 */
export function failSummary(log, code = 0) {
  const tidy = (text) => String(text || '').replace(/\s+/g, ' ').trim()
  const tail = tailText(log, 8000)
  if (!tail) return code ? `命令退出 ${code}，日志一字没有` : ''
  const lines = tail.split('\n')
  const hits = [...tail.matchAll(/\[失败\][^\n]*(?:\n[ \t]+[^\n]*)*/g)]
  const block = hits.length ? hits[hits.length - 1] : null

  // 往上找 `[失败]` 前那段缩进块的**第一行**：它才是具体原因，最后一行常是「留给 Agent 的指示」。
  let detail = ''
  if (block && block.index != null) {
    const before = tail.slice(0, block.index).split('\n')
    let i = before.length - 1
    while (i >= 0 && !before[i].trim()) i -= 1
    if (i >= 0 && /^[ \t]+\S/.test(before[i])) {
      while (i - 1 >= 0 && /^[ \t]+\S/.test(before[i - 1])) i -= 1
      detail = clip(tidy(before[i]), 130)
    }
  }

  const raw = block ? block[0] : (lines.filter((line) => line.trim()).pop() || '')
  const head = tidy(String(raw).replace(/^\[失败\]\s*/, ''))
  // 只要第一句：后面是「怎么办」（重跑/别 reset），卡片上放不下。
  const sentence = clip(tidy(head.split(/[。；]/)[0] || ''), 110)
  const text = [detail, sentence].filter(Boolean).join(' · ')
  if (text) return text
  return code ? `命令退出 ${code}，日志里没写原因` : ''
}

/**
 * 给 bash 的 Windows 路径必须转正斜杠。
 * 反斜杠在 bash 里是转义字符：`bash "C:\a\b.sh"` 实际收到的是 `C:ab.sh`，
 * 报 “No such file or directory” 然后 exit 1，而 stdout/stderr 可能一行都不剩。
 */
function shPath(p) {
  return String(p || '').replace(/\\/g, '/')
}

/** `'C:/a b/c.log'` —— bash 单引号字符串（路径里的单引号自己转义）。 */
function shQuote(text) {
  return `'${String(text || '').replace(/'/g, `'\\''`)}'`
}

/** 长任务的退出码标记：和日志同名，加 `.exit`。看板死了也能靠它收尾。 */
export function exitMarkerPath(log) {
  return `${log}.exit`
}

/**
 * 长任务的 bash 命令行。
 *
 * 除了把输出写进日志，还要把**退出码写进 `<log>.exit`**：收尾的 `child.once('exit')` 活在
 * 看板进程里，看板一重启/被杀就再也收不到——以前留下的 job 会永远停在 running，页面
 * 一直画着「验证中」。有了这个标记，看板下次起来能自己把结果认回来（见 listJobs）。
 *
 * 必须套一层子 shell：每个 `script` 一带头就是 `exec`（exec 会把自己换成 node），
 * 直接跟在后面写标记根本轮不到执行。
 */
export function jobCommand(log, script) {
  const out = shQuote(shPath(log))
  return `exec > ${out} 2>&1; ( ${script} ); code=$?; echo $code > ${shQuote(exitMarkerPath(shPath(log)))}; exit $code`
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
    /** 主树自动推送的现场：上次开跑时间、连续失败数、下次最早什么时候再试。 */
    autoPush: { at: 0, nextAt: 0, fails: 0, lastJobId: '', lastResult: '', lastError: '' },
    /**
     * 主树自动合入的现场：全局的下次探测时间 + 每个工位自己的退避。
     * 退避按工位分开记是因为「a 的验证红」不该把 b 也冻住：两棵树互不相干。
     */
    autoMerge: { at: 0, nextAt: 0, lastStation: '', lastJobId: '', lastResult: '', lastError: '', stations: {} },
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
    return (workdir ? all.find((item) => samePath(item.workdir, workdir)) : all[0]) || null
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

  async function status() {
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
      stations: await stationStateAsync(config),
      // 主树自己也是一张卡：分支、领先/落后 origin、脏不脏、Unity 开没开。
      main: mainState(config.workdir),
      lastMerge: raw().lastMerge || null,
      jobs: listJobs(),
      lastBatch: memory.lastBatch || raw().lastBatch || null,
      // 主树自动验证并推送的现场：开关、退避、上次结果。
      autoPush: {
        enabled: Boolean(config.autoPush?.enabled),
        pollSec: Number(config.autoPush?.pollSec) || DEFAULTS.autoPush.pollSec,
        lastAt: Number(memory.autoPush.at) || 0,
        nextAt: Number(memory.autoPush.nextAt) || 0,
        fails: Number(memory.autoPush.fails) || 0,
        lastJobId: memory.autoPush.lastJobId || '',
        lastResult: memory.autoPush.lastResult || '',
        lastError: memory.autoPush.lastError || '',
      },
      // 主树自动合入的现场：开关、每个工位的退避、上次合的是哪棵树。
      autoMerge: {
        enabled: Boolean(config.autoMerge?.enabled),
        pollSec: Number(config.autoMerge?.pollSec) || DEFAULTS.autoMerge.pollSec,
        lastAt: Number(memory.autoMerge.at) || 0,
        nextAt: Number(memory.autoMerge.nextAt) || 0,
        lastStation: memory.autoMerge.lastStation || '',
        lastJobId: memory.autoMerge.lastJobId || '',
        lastResult: memory.autoMerge.lastResult || '',
        lastError: memory.autoMerge.lastError || '',
        stations: Object.entries(memory.autoMerge.stations || {}).map(([name, slot]) => ({
          name,
          fails: Number(slot?.fails) || 0,
          nextAt: Number(slot?.nextAt) || 0,
          lastResult: String(slot?.lastResult || ''),
        })),
      },
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
    if (!refresh && cached && samePath(cached.workdir, target) && Date.now() - cached.at < 20_000) return Promise.resolve(cached)
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
    // 报错不带本机绝对路径：看板是远程用的，开发机是黑箱，路径只会增加噪音。
    if (!existsSync(workdir)) return { ok: false, error: '主树工作目录不存在（去「高级设置」里改「项目（主树）」）' }
    if (!gitOut(workdir, ['rev-parse', '--git-dir'])) return { ok: false, error: '这个主树工作目录不是 git 仓库' }
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
        errors.push('有一个登记过的工作目录不存在了')
        continue
      }
      const file = stopFilePath(workdir)
      try {
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, `${new Date().toISOString()}\n`, 'utf8')
        files.push(file)
      } catch (err) {
        errors.push(`工位建树失败：${err.message}`)
      }
    }
    if (!files.length) return { ok: false, error: `写停止文件失败：${errors.join('；')}` }
    return { ok: true, file: files[0], files, errors, running: busy() }
  }

  /**
   * 工位状态：名字、路径、分支、有没有活批次、可不可用、落后主分支多少、工作区脏不脏。
   * 注册表为空时退化成「只有 workdir 这一个工位」，老行为不变。
   */
  function stationList(config) {
    return config.stations.length
      ? config.stations
      : (config.workdir ? [{ name: 'main', path: config.workdir, note: '' }] : [])
  }

  /** 一个工位要探的现场（同步版：给建树/合入这些本来就要等的动作路径用）。 */
  function probeStationSync(path, mainDir) {
    const exists = existsSync(path)
    const isRepo = exists ? Boolean(gitOut(path, ['rev-parse', '--git-dir'])) : false
    const branch = isRepo ? gitOut(path, ['rev-parse', '--abbrev-ref', 'HEAD']) : ''
    const dirty = isRepo ? Boolean(gitOut(path, ['status', '--porcelain', '--untracked-files=no'])) : false
    const upstream = isRepo && branch ? gitOut(path, ['rev-parse', '--abbrev-ref', '@{u}']) : ''
    const behind = upstream ? Number(gitOut(path, ['rev-list', '--count', 'HEAD..@{u}']) || '0') || 0 : 0
    const unity = exists && isRepo ? unityState(path) : 'off'
    // 这个工位有多少提交还没进主树（卡片据此给「合入」按钮）。主树未知或就是本树时按 0。
    const pending = isRepo && branch && mainDir && resolve(mainDir) !== resolve(path)
      ? pendingCount(mainDir, branch)
      : 0
    return { exists, isRepo, branch, dirty, upstream, behind, unity, pending }
  }

  /** 同上，异步版：git 全部并行发出去（一轮 ≈ 一个 git 的耗时），而且不卡事件循环。 */
  async function probeStationAsync(path, mainDir) {
    const exists = existsSync(path)
    const isRepo = exists ? Boolean(await gitOutAsync(path, ['rev-parse', '--git-dir'])) : false
    if (!isRepo) {
      return { exists, isRepo: false, branch: '', dirty: false, upstream: '', behind: 0, unity: 'off', pending: 0 }
    }
    const [branch, statusOut, upstream] = await Promise.all([
      gitOutAsync(path, ['rev-parse', '--abbrev-ref', 'HEAD']),
      gitOutAsync(path, ['status', '--porcelain', '--untracked-files=no']),
      gitOutAsync(path, ['rev-parse', '--abbrev-ref', '@{u}']),
    ])
    const needPending = Boolean(branch) && Boolean(mainDir) && resolve(mainDir) !== resolve(path)
    const [behindOut, pending] = await Promise.all([
      upstream ? gitOutAsync(path, ['rev-list', '--count', 'HEAD..@{u}']) : '',
      needPending ? pendingCountAsync(mainDir, branch) : 0,
    ])
    return {
      exists, isRepo, branch, dirty: Boolean(statusOut), upstream,
      behind: Number(behindOut || '0') || 0,
      unity: unityState(path),
      pending: Number(pending) || 0,
    }
  }

  /** 把「探到的现场」+「这一批在不在跑」拼成页面要的工位对象。同步/异步共用，免得两处走形。 */
  function shapeStation(station, probe, batch) {
    return {
      name: station.name,
      path: station.path,
      note: station.note || '',
      // 暂停的工位不接新卡，但它自己没毛病：usable / trouble 都不看这个字段。
      paused: Boolean(station.paused),
      ...probe,
      // busy 是「这个工位上有一批在跑」。它跟 card 不等价：刚点「接一单」时批次已经起来了，
      // 但卡片要等 TAPD 查完才有 id，card 一段时间里是空的。页面据此判断能不能再开一批。
      busy: Boolean(batch),
      idle: !batch,
      // 可用 = 目录在 + 是 git 仓库 + 工作区没改已跟踪文件 + Unity 在线（端点能用）
      usable: probe.exists && probe.isRepo && !probe.dirty && probe.unity === 'on',
      card: batch ? String(batch.card || '') : '',
      cardTitle: batch ? String(batch.cardTitle || '') : '',
      runId: batch ? String(batch.runId || '') : '',
      pid: batch ? Number(batch.pid) || 0 : 0,
      startedAt: batch ? Number(batch.startedAt) || 0 : 0,
    }
  }

  function stationState(config = read()) {
    const list = stationList(config)
    const mainDir = String(config.workdir || '').trim()
    const active = runningAll()
    return list.map((station) => shapeStation(
      station,
      probeStationSync(station.path, mainDir),
      active.find((item) => samePath(item.workdir, station.path)) || null,
    ))
  }

  /** 看板状态专用：不阻塞事件循环，几个工位并行探。 */
  async function stationStateAsync(config = read()) {
    const list = stationList(config)
    const mainDir = String(config.workdir || '').trim()
    const active = runningAll()
    return await Promise.all(list.map(async (station) => shapeStation(
      station,
      await probeStationAsync(station.path, mainDir),
      active.find((item) => samePath(item.workdir, station.path)) || null,
    )))
  }

  /**
   * 建树 / 删树 / 合入 / 解冲突这些长任务。只有 running 的才看 pid 判活。
   *
   * 进程没了但记录还写着 running 的：先看日志旁边的 `.exit` 标记（子进程自己写的退出码），
   * 有就按它收尾——这就是「看板重启时 collect 还在跑」能自愈的原因。没有标记才叫
   * `interrupted`（真的是被杀/断电），页面会提示去看日志。
   */
  function listJobs() {
    const saved = raw()
    const jobs = Array.isArray(saved.jobs) ? saved.jobs : []
    let changed = false
    const mapped = jobs.map((job) => {
      // 只有 running 才用 pid 判活。否则 resolve 这种用看板 pid 占位的 job 会永远 alive，
      // 完成了也不从页面消失（pin 到 done 之后还会被前端当「还在跑」画出来）。
      const running = job.status === 'running'
      const alive = running && job.pid ? pidAlive(Number(job.pid)) : false
      if (!running || alive) return { ...job, alive, status: job.status }

      const recovered = recoveredJob(job)
      if (recovered) {
        changed = true
        return { ...job, ...recovered, alive: false }
      }
      return { ...job, alive: false, status: 'interrupted' }
    })
    if (changed) {
      const current = raw()
      writeJson(controlFile, { ...current, jobs: mapped })
    }
    return mapped
  }

  /**
   * 从 `.exit` 标记把一条「父进程没了」的 job 认回来。
   *
   * 只能恢复状态和退出码，恢复不了 `onSettled`（那是个闭包）：合入的 TAPD 回写本来
   * 就是 collect 自己做的，看板这条只是兼一层，所以不补；真没写成的用「补回写 TAPD」按钮。
   */
  function recoveredJob(job) {
    const marker = exitMarkerPath(String(job.log || ''))
    if (!job.log || !existsSync(marker)) return null
    let code = NaN
    try { code = Number(String(readFileSync(marker, 'utf8')).trim()) } catch { return null }
    if (!Number.isFinite(code)) return null
    let endedAt = Date.now()
    try { endedAt = statSync(marker).mtimeMs || endedAt } catch { /* 拿不到就用现在 */ }
    const status = code === 0 ? 'done' : 'failed'
    const summary = code === 0 ? '' : (failSummary(String(job.log), code) || `失败（exit ${code}）`)
    return { status, code, endedAt, ...(summary ? { summary } : {}), recovered: true }
  }

  function addStation({ name, path, note = '' }) {
    const current = read()
    write({ stations: normalizeStations([...current.stations, { name, path, note }]) })
  }

  function dropStation(name) {
    const current = read()
    write({ stations: current.stations.filter((station) => station.name !== name) })
  }

  /**
   * 暂停/恢复一个工位：只管「调度器还派不派新卡给它」。
   *
   * 和 `stop()`（写 stop 文件）不是一件事：停止文件是给 loop.mjs 在卡与卡之间读的，
   * 而看板派卡是一张一批（`--card` 会把 maxTasks 强制成 1），所以停止人永远读不到。
   * 真想让一个工位别再领新活，就落这个持久标记。
   * 在跑的那一张不受影响：要打断它只能去工位里杀进程，本工具从不干这个。
   */
  function pauseStation(input = {}) {
    const name = String(input.name || '').trim()
    if (!name) return { ok: false, error: '没说哪个工位' }
    const current = read()
    if (!current.stations.some((station) => station.name === name)) {
      return { ok: false, error: `没有叫「${name}」的工位` }
    }
    const paused = Boolean(input.paused)
    write({ stations: current.stations.map((station) => (station.name === name ? { ...station, paused } : station)) })
    const saved = read().stations.find((station) => station.name === name) || null
    return { ok: true, name, paused, station: saved }
  }

  /** 登记一个已经存在的工位（不想重跑建树脚本时用）。 */
  function registerStation(input = {}) {
    const name = String(input.name || '').trim()
    const path = String(input.path || '').trim()
    if (!STATION_NAME_RE.test(name)) return { ok: false, error: '工位名只能 1~24 位字母数字/下划线/短横线' }
    if (!path || !isAbsolute(path)) return { ok: false, error: '工位路径要写绝对路径' }
    if (!existsSync(path)) return { ok: false, error: '这个路径不存在' }
    if (!gitOut(path, ['rev-parse', '--git-dir'])) return { ok: false, error: '这个路径不是 git 仓库' }
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
  function spawnJob({ kind, name, path, workdir, script, onDone, onConflict, onSettled }) {
    mkdirSync(batchDir, { recursive: true })
    const log = join(batchDir, `station-${kind}-${name}-${stamp()}.log`)
    // 命令行带退出码标记：看板重启后靠它把这次的结果认回来（见 exitMarkerPath）。
    const cmdline = jobCommand(log, script)
    // 上一轮留下但永远没标记的旧码（同名日志不会重，但重新收尾时别读到脏值）。
    try { rmSync(exitMarkerPath(log), { force: true }) } catch { /* 读不到就算了 */ }
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
    // 追溯旁路：job 开始/结束都进全局索引，否则「某天做了哪几次合入/推送」只能翻 board-batches 目录。
    appendTrace(home, {
      t: job.startedAt,
      kind: 'job_start',
      station: String(name || ''),
      note: String(kind || ''),
      job: job.id,
      log: job.log,
    })

    // spawn 失败（找不到可执行文件、权限）不会进 exit，必须在这里收尸，
    // 否则 job 永远停在 running，页面一直显示「正在准备」。
    let settled = false
    const settle = (status, code, error) => {
      if (settled) return
      settled = true
      // 失败时先把日志里那句话抓出来：卡片/提示都要用人话，不能只留一个 exit N。
      const failedNow = status !== 'done' || Number(code) !== 0
      const summary = failedNow ? (failSummary(log, code) || String(error || '')) : ''
      // onSettled 不分成败都会跑：合入可能在 verify 那一步退出非 0，可提交已经 cherry-pick
      // 进本地 develop 了。以前只在 code 0 才回写 TAPD，于是「合进去了、工单没流转、也没推」。
      let writeBack = null
      if (onSettled) {
        try {
          writeBack = onSettled(status, code, summary)
        } catch {
          // 回写炸了不影响 job 已记下的结果
        }
      }
      const done = raw()
      writeJson(controlFile, {
        ...done,
        jobs: (Array.isArray(done.jobs) ? done.jobs : [])
          .map((item) => (item.id === job.id
            ? { ...item, status, code, endedAt: Date.now(), ...(error ? { error } : {}), ...(summary ? { summary } : {}), ...(writeBack ? { writeBack } : {}) }
            : item)),
      })
      appendTrace(home, {
        t: Date.now(),
        kind: status === 'done' ? 'job_done' : 'job_failed',
        station: String(name || ''),
        note: String(summary || kind || '').slice(0, 120),
        job: job.id,
        exit: Number(code),
        log: job.log,
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
      // 退出码 3 = 环境未就绪（典型：这棵树的 Unity 端点不在线）。这不是代码问题，
      // 记成 pending 而不是 failed：页面上应该写「等环境」，而不是一片红让人去查代码。
      settle(code === 0 ? 'done' : code === 3 ? 'pending' : 'failed', code ?? -1)
    })
    child.unref()
    emit()
    return { ok: true, job }
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
    if (!existsSync(main)) return { ok: false, error: '主树目录不存在' }
    const script = join(main, 'Tools', 'Worktree', 'new-worktree.sh')
    if (!existsSync(script)) return { ok: false, error: '主树里没有建树脚本 Tools/Worktree/new-worktree.sh' }
    const path = String(input.path || '').trim() || defaultStationPath(main, name)
    if (existsSync(path)) return { ok: false, error: '这个工位目录已经存在（要复用就用「登记已有工位」）' }
    if (runningAll().some((item) => samePath(item.workdir, path))) return { ok: false, error: '这个路径上还有批次在跑' }
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
    const live = runningAll().find((item) => samePath(item.workdir, station.path))
    if (live) return { ok: false, error: `${name} 上还有批次在跑（${live.runId || live.pid}），先停再删` }
    const branch = gitOut(station.path, ['rev-parse', '--abbrev-ref', 'HEAD'])
    const mainDir = main && existsSync(main) ? main : dirname(station.path)
    const pending = branch && branch !== 'HEAD' ? pendingCount(mainDir, branch) : 0
    if (pending > 0) {
      return { ok: false, error: `${name} 的分支 ${branch} 还有 ${pending} 个提交没合进主树：先跑 Tools/Worktree/collect.mjs 再删` }
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
    const live = runningAll().find((item) => samePath(item.workdir, hit.path))
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
    return launchUnity(station.path, name)
  }

  /** 主树的 Unity：主树 verify 要连的就是它，合入时最容易因为它没开而卡在验证门。 */
  function openMainUnity(input = {}) {
    const main = String(input.workdir || read().workdir || '').trim()
    if (!main) return { ok: false, error: '先选主树工作目录' }
    if (!existsSync(main)) return { ok: false, error: '主树工作目录不存在' }
    // 主树常见的坑不是「没开」，而是「开了但没带 -unityPuerExecControl」，
    // 文件层面跟 booting 一模一样。这时直接拉第二个 Unity 会抢锁，只能让人先关掉那个。
    if (unityState(main) === 'booting') {
      return {
        ok: false,
        error: '主树的 Unity 开着，但没有控制端点：要么在它的菜单里点 Tools/UnityPuerExec/Activate CLI Control (this session)，要么关掉它再点这个按钮重开',
      }
    }
    return launchUnity(main, '主树')
  }

  /** 真正拉起 Unity：工位和主树共用（参数就是树的根目录 + 给人看的名字）。 */
  function launchUnity(path, label) {
    if (!existsSync(path)) return { ok: false, error: `${label}的目录不存在` }
    const state = unityState(path)
    if (state === 'on') return { ok: false, error: `${label} 的 Unity 已经开着，控制端点也在` }
    if (state === 'booting') return { ok: false, error: `${label} 的 Unity 正在启动（首次导入约 4.5 分钟），等它起来再点` }

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
    if (!existsSync(exe)) return { ok: false, error: `找不到 Unity ${version}（这台机器没装这个版本）` }

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
    if (!existsSync(path)) return { ok: false, error: `${name} 的工位目录不存在` }
    const live = runningAll().find((item) => samePath(item.workdir, path))
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
    // 也不能只跟主树本地 HEAD 比：工位开工前会 pull --rebase，别人刚推到 origin 的提交先落到
    // 工位分支上，而主树本地还没 pull —— 只比 HEAD 就会把「上游已经有的提交」算成待合入
    // （点完「接一单」立刻冒出「合入 1」，其实这一单一个字都还没提交）。
    // 所以主树上游与本地 HEAD 都算基准，两边都判「没进主树」才算真待合入。
    const bases = [...new Set([upstreamOf(main), 'HEAD'].filter(Boolean))]
    let pending = null
    for (const base of bases) {
      // 两边树一模一样 = 分支上没有任何主树没有的内容，直接判 0。
      if (gitRun(main, ['diff', '--quiet', base, branch])) return 0
      const out = gitOut(main, ['cherry', base, branch])
      const plus = (out ? out.split('\n') : [])
        .filter((line) => line.startsWith('+'))
        .map((line) => line.slice(1).trim())
      // git cherry 只认 patch-id：合入走 cherry-pick（SHA 变了，已存在的文件改动还会被跳过），
      // 同一份成果永远报 `+`。所以每题再看「它改过的那些路径在主树里是不是已经一样」，
      // 一样就当已合入，否则卡片会一直挂着一个点进去只能跑空的「合入 1」。
      const real = new Set(plus.filter((sha) => !contentAlreadyIn(main, base, sha)))
      pending = pending ? new Set([...pending].filter((sha) => real.has(sha))) : real
      if (!pending.size) return 0
    }
    return pending ? pending.size : 0
  }

  /** 异步版 pendingCount（同一套「主树上游 + 本地 HEAD 两个基准取交集」逻辑）。 */
  async function pendingCountAsync(main, branch) {
    if (!main || !branch) return 0
    const upstream = await gitOutAsync(main, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
    const bases = [...new Set([upstream, 'HEAD'].filter(Boolean))]
    let pending = null
    for (const base of bases) {
      if (await gitRunAsync(main, ['diff', '--quiet', base, branch])) return 0
      const out = await gitOutAsync(main, ['cherry', base, branch])
      const plus = (out ? out.split('\n') : [])
        .filter((line) => line.startsWith('+'))
        .map((line) => line.slice(1).trim())
      const real = new Set()
      for (const sha of plus) {
        if (!(await contentAlreadyInAsync(main, base, sha))) real.add(sha)
      }
      pending = pending ? new Set([...pending].filter((sha) => real.has(sha))) : real
      if (!pending.size) return 0
    }
    return pending ? pending.size : 0
  }

  /** 主树当前分支的上游（如 origin/develop）。没配上游时返回空字符串。 */
  function upstreamOf(main) {
    return gitOut(main, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']) || ''
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
  /**
   * 提交 sha → 卡片 id。
   *
   * 只看批次的 progress.jsonl（`<run>/progress.jsonl`，一行一个事件）：card_done 那行同时带 id
   * 和 commit。以前这里去读 `<run>/<card>/progress.jsonl` —— 那个文件根本不存在（卡片目录里
   * 只有 events.jsonl / pi.json…），于是合入后永远「找不到对应卡片」，工单也就永远不流转。
   */
  function cardIdByCommit(sha) {
    const needle = String(sha || '').trim().toLowerCase().slice(0, 10)
    if (needle.length < 7) return ''
    let runs = []
    try {
      runs = readdirSync(runsRoot).filter((name) => name.startsWith('run-')).sort().reverse().slice(0, 60)
    } catch {
      return ''
    }
    for (const run of runs) {
      let text = ''
      try {
        text = readFileSync(join(runsRoot, run, 'progress.jsonl'), 'utf8')
      } catch {
        continue
      }
      if (!text.toLowerCase().includes(needle)) continue
      const hit = [...text.matchAll(/"event":"card_done"[^\n]*?"id":"(\d+)"[^\n]*?"commit":"([0-9a-f]+)"/g)]
        .find((m) => m[2].toLowerCase().startsWith(needle))
      if (hit) return hit[1]
    }
    return ''
  }

  /**
   * 提交标题里带的 7 位工单号 → 完整卡片 id。
   * 外层循环约定的提交格式就是 `type:1005129 描述`，后 7 位即卡号后 7 位。
   * 拿它当「card_done 没写下来」时的备胎：进程被杀（没有 card_done）、或事后手工补的提交。
   */
  function cardIdByTicket(ticket) {
    const need = String(ticket || '').trim()
    if (!/^\d{7}$/.test(need)) return ''
    let runs = []
    try {
      runs = readdirSync(runsRoot).filter((name) => name.startsWith('run-')).sort().reverse().slice(0, 60)
    } catch {
      return ''
    }
    for (const run of runs) {
      let text = ''
      try {
        text = readFileSync(join(runsRoot, run, 'progress.jsonl'), 'utf8')
      } catch {
        continue
      }
      const hit = [...text.matchAll(/"event":"card_start"[^\n]*?"id":"(\d+)"/g)]
        .map((m) => m[1])
        .find((id) => id.endsWith(need))
      if (hit) return hit
    }
    return ''
  }

  /** 已经回写过的工位提交（origin sha）。重复跑合入/补回写时靠它去重，不重复评论。 */
  function flowedShas() {
    return new Set((Array.isArray(raw().flowed) ? raw().flowed : []).map(String))
  }

  /**
   * 把一批主树提交回写到 TAPD：评论 +（配了 run.doneStatus 时）状态流转 + 处理人交回创建人。
   * writeBackMerged 和补回写（backfillMain）共用这一段。
   */
  function flowBlocks({ main, blocks, via = '', branch = '', after = '' }) {
    const cfg = loopConfig(main)
    const doneStatus = String(cfg?.run?.doneStatus || cfg?.task?.doneStatus || '').trim()
    const target = String(cfg?.run?.targetBranch || 'develop')
    const tapd = tapdClient(main)
    const already = flowedShas()
    const results = []
    const flowed = []

    for (const block of blocks) {
      const [sha, ...rest] = String(block || '').split('\t')
      if (!sha) continue
      const body = rest.join('\t')
      const origin = (/cherry picked from commit ([0-9a-f]{7,40})/.exec(body) || [])[1] || sha
      let cardId = cardIdByCommit(origin)
      if (!cardId) {
        // 备胎：提交标题里的 7 位工单号（`art:1005133 …`）——进程被杀时 card_done 没写下来，
        // 合入记录里就只剩标题这一条线索。
        const subject = String(body).split('\n')[0]
        const ticket = (/^[a-z]+:\s*(\d{7})\b/i.exec(subject) || [])[1]
        if (ticket) cardId = cardIdByTicket(ticket)
      }
      if (!cardId) {
        results.push({ sha: sha.slice(0, 10), origin: origin.slice(0, 10), ok: false, reason: '找不到对应卡片（run 记录里没有这个 commit）' })
        continue
      }
      if (already.has(origin.toLowerCase())) {
        results.push({ cardId, sha: sha.slice(0, 10), origin: origin.slice(0, 10), ok: true, skipped: '已经回写过' })
        continue
      }
      const note = (via
        ? `[tapd-loop] 已推送到 ${target}（${via}）`
        : `[tapd-loop] 已合入主树：${branch || target} → ${target}`) +
        // 只报合入后的提交号：工位那个原始 sha 只活在本仓库对象库里，cherry-pick 后已经
        // 不代表任何能查到的东西，写在工单上只会让人拿着查不到的 hash 去对代码。
        `，合并后提交 ${String(after || sha).slice(0, 10)}。` +
        (doneStatus ? `

状态流转：${doneStatus}，处理人已交回创建人` : '')
      const one = { cardId, sha: sha.slice(0, 10), origin: origin.slice(0, 10), ok: true }
      try {
        tapd.addComment(cardId, note)
        // 追溯旁路：「卡片 → 主树提交」的关联就记在这里（TAPD 评论只报新 sha，不写工位 sha）。
        appendTrace(home, {
          t: Date.now(),
          kind: 'merged',
          card: cardId,
          sha: String(after || sha).slice(0, 10),
          note: `${branch || target} → ${target}${via ? '（推送）' : ''}`,
        })
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
      if (one.ok) flowed.push(origin.toLowerCase())
      results.push(one)
    }

    try {
      const current = raw()
      const keep = [...new Set([...(Array.isArray(current.flowed) ? current.flowed : []), ...flowed])].slice(-300)
      writeJson(controlFile, { ...current, flowed: keep })
    } catch {
      // 记不上流水不影响已经写进 TAPD 的东西
    }
    return results
  }

  /**
   * 合入后回写 TAPD：每一条被 cherry-pick 进来的提交，带 `-x` 会写回原始 sha，
   * 用它在 run 记录里找回卡片，评论 + （配了 run.doneStatus 时）改状态。
   */
  function writeBackMerged({ stationName, branch, main, before, via = '' }) {
    const after = gitOut(main, ['rev-parse', 'HEAD'])
    if (!before || !after || before === after) {
      return { ok: false, error: '主树 HEAD 没变，没有可回写的提交' }
    }
    const logText = gitOut(main, ['log', '--format=%H%x09%B%x00', `${before}..${after}`])
    const blocks = logText.split('\u0000').map((block) => block.trim()).filter(Boolean)
    const results = flowBlocks({ main, blocks, via, branch, after })

    try {
      writeJson(controlFile, {
        ...raw(),
        lastMerge: { station: stationName, branch, before, after, at: Date.now(), results },
      })
    } catch {
      // 记不上 lastMerge 不影响已经写进 TAPD 的东西
    }
    emit()
    return { ok: results.length > 0 && results.every((item) => item.ok), results }
  }

  /**
   * 补回写：提交已经在主树/远端了（HEAD 没变，`before..after` 是空的），但 TAPD 那次没写成。
   * 典型就是这次：collect 停在 verify、后来手动/自动推上去，结果 push 成功的那次拿不到
   * 「合入前」的基线，回写就整段跳过了。这里从主树最近 N 个提交里找带 cherry-pick 尾巴的，
   * 对上卡片、且没回写过的就补一条，并记进 flowed 去重。
   */
  function backfillMain(input = {}) {
    const config = read()
    const main = String(input.workdir || config.workdir || '').trim()
    if (!main || !existsSync(main)) return { ok: false, error: '先选主树工作目录' }
    if (!gitOut(main, ['rev-parse', '--git-dir'])) return { ok: false, error: '主树工作目录不是 git 仓库' }
    const limit = Math.min(100, Math.max(1, Number(input.limit) || 20))
    const logText = gitOut(main, ['log', `-n${limit}`, '--format=%H%x09%B%x00'])
    const blocks = logText.split('\u0000').map((block) => block.trim()).filter(Boolean)
    const picked = blocks.filter((block) => /cherry picked from commit [0-9a-f]{7,40}/.test(block))
    if (!picked.length) return { ok: true, note: `最近 ${limit} 个提交里没有合入痕迹（cherry-pick）`, results: [] }
    const head = gitOut(main, ['rev-parse', 'HEAD'])
    const results = flowBlocks({ main, blocks: picked, via: '补回写', after: head })
    try {
      writeJson(controlFile, { ...raw(), lastMerge: { station: '(主树)', branch: '', before: '', after: head, at: Date.now(), results } })
    } catch {
      // 同上
    }
    emit()
    return { ok: results.every((item) => item.ok), results }
  }


  /**
   * 合入工位：跑主树的 Tools/Worktree/collect.mjs（pick → 导表 → verify → push），
   * 跑完回写 TAPD。跟其他长任务一样走 job，页面轮询看进度。
   */
  /**
   * 主树（develop）自己的状态。看板上以前只有工位卡片、没有主树，于是
   * 「合进去了但没推」「主树 Unity 没开导致 verify 卡在验证门」这类事只能翻日志才能发现。
   */
  function mainState(workdir = '') {
    const config = read()
    const main = String(workdir || config.workdir || '').trim()
    const base = {
      path: main,
      exists: Boolean(main) && existsSync(main),
      isRepo: false,
      branch: '',
      upstream: '',
      ahead: 0,
      behind: 0,
      dirty: false,
      unity: 'off',
      conflict: false,
      target: String(loopConfig(main)?.run?.targetBranch || 'develop'),
    }
    if (!base.exists) return base
    if (!gitOut(main, ['rev-parse', '--git-dir'])) return { ...base, exists: true }
    const branch = gitOut(main, ['rev-parse', '--abbrev-ref', 'HEAD']) || ''
    const upstream = gitOut(main, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']) || ''
    let ahead = 0
    let behind = 0
    if (upstream) {
      // 对本地 remote-tracking ref 算的：没 fetch 过就是上次 fetch 时的数字（页面会注明）。
      const counts = gitOut(main, ['rev-list', '--left-right', '--count', `${upstream}...HEAD`]).split(/\s+/)
      behind = Number(counts[0]) || 0
      ahead = Number(counts[1]) || 0
    }
    return {
      ...base,
      exists: true,
      isRepo: true,
      branch,
      upstream,
      ahead,
      behind,
      dirty: Boolean(gitOut(main, ['status', '--porcelain', '--untracked-files=no'])),
      unity: unityState(main),
      conflict: Boolean(conflictState(main)),
    }
  }

  /**
   * 主树「验证并推送」：合入时 verify 没过（典型：主树 Unity 没开）会停在 push 之前，
   * 提交已经在本地 develop 上，只是没推、也没回写 TAPD。collect --resume 就是为这种现场
   * 准备的：跳过 pick，只做导表 → verify → push，成功后按落地的提交回写 TAPD。
   *
   * byAuto = 自动推的：失败要记进退避，不然一个真红的验证门会被每 2 分钟拉起来重跑一次。
   */
  function pushMain(input = {}) {
    const config = read()
    const main = String(input.workdir || config.workdir || '').trim()
    if (!main || !existsSync(main)) return { ok: false, error: '先选主树工作目录' }
    if (!gitOut(main, ['rev-parse', '--git-dir'])) return { ok: false, error: '主树工作目录不是 git 仓库' }
    if (conflictState(main)) return { ok: false, error: '主树还停在 cherry-pick 冲突里，先解冲突' }
    const script = join(main, 'Tools', 'Worktree', 'collect.mjs')
    if (!existsSync(script)) return { ok: false, error: '主树里没有 Tools/Worktree/collect.mjs（合入脚本）' }
    const target = String(loopConfig(main)?.run?.targetBranch || 'develop')
    const before = gitOut(main, ['rev-parse', '--verify', `origin/${target}`]) || ''
    const byAuto = Boolean(input.auto)
    return spawnJob({
      kind: 'main-push',
      name: byAuto ? '(主树·自动)' : '(主树)',
      path: main,
      workdir: main,
      script: `exec '${shPath(process.execPath)}' '${shPath(script)}' --resume`,
      onSettled: (status, code, summary) => {
        const back = writeBackMerged({
          stationName: '(主树)',
          branch: target,
          main,
          before,
          via: byAuto ? '自动补推' : '合入时验证没跑完，之后补推',
        })
        // 自动模式的退避：2 → 4 → 8 → 16 → 30 分钟。手动点的不改退避（人自己盯着）。
        if (byAuto) {
          if (status === 'done') {
            memory.autoPush.fails = 0
            memory.autoPush.lastResult = '已推送'
            memory.autoPush.nextAt = 0
          } else {
            memory.autoPush.fails = (memory.autoPush.fails || 0) + 1
            // 有那句人话就用它（验证门红了 / 端点连不上 / 推送被拒…），退避提示才有信息量。
            // pending 是「环境没就绪」，别写成失败让人误以为代码坏了。
            memory.autoPush.lastResult = status === 'pending'
              ? `等环境就绪：${summary ? clip(summary, 110) : 'Unity 端点不在线'}`
              : summary ? `失败：${clip(summary, 120)}` : `失败（exit ${code}）`
            const waitMin = Math.min(30, 2 ** Math.max(0, memory.autoPush.fails - 1))
            memory.autoPush.nextAt = Date.now() + waitMin * 60_000
          }
        }
        return back
      },
    })
  }

  /**
   * 主树自动验证并推送：人不用盯着「verify 失败 → 补 Unity → 再点一次」。
   *
   * 只做“该做且现在能做成”的那一次：主树领先 origin、没冲突、工作区干净、Unity 端点在线、
   * 没有别的主树任务在跑。失败按 2/4/8/16/30 分钟退避，成功自动清零。
   * 每次 tick 只试一次，不排队：挂不上的东西排着队只会越跑越乱。
   */
  function autoPushTick() {
    const config = read()
    if (!config.autoPush?.enabled) {
      memory.autoPush.nextAt = 0
      return { skipped: 'off' }
    }
    const main = String(config.workdir || '').trim()
    if (!main) return { skipped: 'no-workdir' }
    if (mainBusy()) return { skipped: 'busy' }
    const state = mainState(main)
    if (!state.exists || !state.isRepo) return { skipped: 'no-main' }
    if (state.conflict) return { skipped: 'conflict' }
    if (state.dirty) return { skipped: 'dirty' }
    if (Number(state.ahead) <= 0) {
      // 已经都推上去了：把失败记忆清掉，下次再攒出一批提交时不用等退避。
      if (memory.autoPush.fails) {
        memory.autoPush.fails = 0
        memory.autoPush.lastResult = ''
      }
      memory.autoPush.nextAt = 0
      return { skipped: 'clean' }
    }
    // verify 要连本树的 Unity：端点不在，开了也是 exit 2，不如等着。
    if (state.unity !== 'on') return { skipped: 'no-unity' }
    if (Date.now() < Number(memory.autoPush.nextAt || 0)) {
      return { skipped: 'backoff', nextInMs: Number(memory.autoPush.nextAt) - Date.now() }
    }

    const started = pushMain({ workdir: main, auto: true })
    if (!started.ok) {
      memory.autoPush.lastError = String(started.error || '')
      memory.autoPush.nextAt = Date.now() + 60_000
      return { skipped: 'start-failed', error: started.error || '' }
    }
    memory.autoPush.at = Date.now()
    memory.autoPush.lastJobId = started.job?.id || ''
    memory.autoPush.lastError = ''
    memory.autoPush.nextAt = Date.now() + Math.max(60, Number(config.autoPush.pollSec) || 120) * 1000
    emit()
    return { started: true, job: started.job?.id || '', ahead: Number(state.ahead) || 0 }
  }

  /**
   * 主树上的长任务（合入 / 解冲突 / 验证 / 推送）是不是还在跑。
   *
   * 进程没了的（`interrupted`）不算忙：那是「看板重启过、命令早就结束了但没人收尸」的旧记录。
   * 拿它当挡箭牌会把自动合入/自动推送永远卡住，而真正的活干完了本来也不会有人来找它。
   */
  function mainBusy() {
    const now = Date.now()
    return listJobs().some((job) => {
      const kind = String(job.kind || '')
      const mine = kind.startsWith('main-') || kind === 'merge' || kind === 'merge-resume' || kind === 'resolve'
      if (!mine) return false
      if (job.alive === true || (job.status === 'running' && !job.pid)) return true
      // 记录还写着 running、但 pid 已经看不到了：多半是「看板重启时它还在跑」。
      // 那个子进程是 detached 的，可能真的还在 pick/verify/push develop——宽限期内照样算忙，
      // 否则自动推送和自动合入会同时再起一个 collect 撞上去（实测撞过一次：两个 collect
      // 同时 pick + verify + push 同一个 develop）。过了宽限期就当它早结束了，不无限挡路。
      return job.status === 'interrupted' && now - Number(job.startedAt || 0) < ORPHAN_JOB_GRACE_MS
    })
  }

  /**
   * 记一次自动合入的结果。退避按工位各记各的：1 → 2 → 4 → 8 → 16 → 30 分钟（跟自动推送同一套）。
   *
   * soft = 「不是这棵树不行，只是现在做不了」（冲突且已经有人去解了）：不涨失败数，只等 2 分钟。
   * waitMin 用于必须人来的情况（表格冲突 / 解冲突起不来），一次拉满 30 分钟，别把主树反复占上。
   */
  function autoMergeRecord(name, { ok = false, soft = false, code = 0, error = '', merged = 0, waitMin = 0 } = {}) {
    const key = String(name || '')
    if (!key) return
    const slot = { fails: 0, nextAt: 0, at: 0, lastResult: '', ...(memory.autoMerge.stations[key] || {}) }
    slot.at = Date.now()
    if (ok) {
      slot.fails = 0
      slot.nextAt = 0
      slot.lastResult = merged ? `已合入 ${merged} 个提交` : '已合入'
      memory.autoMerge.lastError = ''
    } else {
      if (!soft) slot.fails = (Number(slot.fails) || 0) + 1
      // 「失败」两个字只留给真失败：code 0 以外的退出码和起不来的错误都写具体原因。
      const plain = error ? clip(error, 120) : (code ? `失败（exit ${code}）` : '失败')
      const wait = waitMin || (soft ? 2 : Math.min(30, 2 ** Math.max(0, (Number(slot.fails) || 1) - 1)))
      slot.nextAt = slot.at + wait * 60_000
      slot.lastResult = `${plain}，${wait} 分钟后再试`
      memory.autoMerge.lastError = String(error || '')
    }
    memory.autoMerge.stations[key] = slot
    memory.autoMerge.at = slot.at
    memory.autoMerge.lastStation = key
    memory.autoMerge.lastResult = `${key}：${slot.lastResult}`
    emit()
  }

  /**
   * 主树自动合入工位提交：人不用盯着「这棵树攒了提交 → 点合入 → 等 verify → 点验证并推送」。
   *
   * 只做“该做且现在能做成”的那一次，门槛全是硬的：
   *   - 主树没有别的任务在跑（collect 要独占 develop，verify 要独占主树的 Unity）
   *   - 主树干净、没停在 cherry-pick 中间态、Unity 端点在线
   *   - 自动推送开着时，主树自己还有没推的提交就先让那边推完：验证门要是红的，
   *     在上面再叠一张卡只会把问题糊成一团
   *   - 挑一个「空闲 + 有未合入提交 + 不在自己的退避里」的工位
   *
   * 一次只合一个：两个工位同时 pick 会互相踩，而且 verify 只有一块 Unity。
   * 打开它就等于「工位提交 → develop 远端 → TAPD 回写」全无人值守，所以默认关。
   */
  function autoMergeTick() {
    const config = read()
    if (!config.autoMerge?.enabled) {
      memory.autoMerge.nextAt = 0
      return { skipped: 'off' }
    }
    const main = String(config.workdir || '').trim()
    if (!main) return { skipped: 'no-workdir' }
    // 忙的时候不推进探测指针：一次合入结束就能立刻接下一棵树，不用干等一个 pollSec。
    if (mainBusy()) return { skipped: 'busy' }
    const now = Date.now()
    if (now < Number(memory.autoMerge.nextAt || 0)) {
      return { skipped: 'scheduled', nextInMs: Number(memory.autoMerge.nextAt) - now }
    }
    // 从这里往下每一步都要敲 git：探测频率收在一个 pollSec 上，别跟着看板 5 秒跳一次。
    const pollMs = Math.max(MIN_POLL_SEC, Number(config.autoMerge.pollSec) || DEFAULTS.autoMerge.pollSec) * 1000
    memory.autoMerge.nextAt = now + pollMs

    const state = mainState(main)
    if (!state.exists || !state.isRepo) return { skipped: 'no-main' }
    if (state.conflict) return { skipped: 'conflict' }
    if (state.dirty) return { skipped: 'dirty' }
    // verify 要连本树的 Unity：端点不在，合进去也只会停在推送前，白占一次主树。
    if (state.unity !== 'on') return { skipped: 'no-unity' }
    if (config.autoPush?.enabled && Number(state.ahead) > 0) return { skipped: 'ahead', ahead: Number(state.ahead) }

    const all = stationState(config)
      .filter((station) => Boolean(station.idle) && station.exists && station.isRepo && Number(station.pending) > 0)
    // 停在存档分支上的工位直接不算候选：让它进候选就是每轮都失败一次、退避拉到 30 分钟，
    // 而页面只会写「a：30 分钟后再试」——看着像代码有问题，实际上是它压根不该合。
    const parked = all.filter((station) => ARCHIVE_BRANCH.test(station.branch) || KEPT_BRANCH.test(station.branch))
    const candidates = all.filter((station) => !parked.includes(station))
    if (!candidates.length && parked.length) {
      memory.autoMerge.lastResult = `${parked.map((one) => `${one.name}（${one.branch}）`).join('、')} 停在存档分支上，自动合入不碰：要合先在工位里切回工作分支`
      return { skipped: 'archive-branch', parked: parked.map((one) => ({ name: one.name, branch: one.branch })) }
    }
    const ready = candidates.find((station) => now >= Number(memory.autoMerge.stations[station.name]?.nextAt || 0))
    if (!ready) return { skipped: candidates.length ? 'station-backoff' : 'clean', pending: candidates.length }

    const started = mergeStation({ name: ready.name, workdir: main, auto: true })
    if (!started.ok) {
      autoMergeRecord(ready.name, { error: String(started.error || '合入没起来') })
      return { skipped: 'start-failed', error: started.error || '' }
    }
    memory.autoMerge.lastJobId = started.job?.id || ''
    memory.autoMerge.lastStation = ready.name
    memory.autoMerge.lastError = ''
    emit()
    return { started: true, station: ready.name, job: started.job?.id || '', pending: ready.pending }
  }

  /**
   * 主树工作区恢复干净（只动已跟踪文件，不碰未跟踪）。
   * 合入/推送都要求工作区干净；而主树的 Unity 一开，常会把几个 .meta / 生成物重写一遍，
   * 于是「自动推送」被一条脏改动永远挡住。这一步就是给它解围的，代价是丢掉没提交的改动。
   */
  function cleanMain(input = {}) {
    const config = read()
    const main = String(input.workdir || config.workdir || '').trim()
    if (!main || !existsSync(main)) return { ok: false, error: '先选主树工作目录' }
    if (!input.confirm) return { ok: false, error: '这会把主树里没提交的改动丢掉，需要 confirm' }
    if (runningAll().some((item) => samePath(item.workdir, main))) {
      return { ok: false, error: '主树上还有一批在跑，等它跑完再说' }
    }
    if (mainBusy()) return { ok: false, error: '主树还有任务在跑（合入/解冲突/验证/推送），等它结束' }
    const dirty = gitOut(main, ['status', '--porcelain', '--untracked-files=no']).split('\n').map((line) => line.trim()).filter(Boolean)
    if (!dirty.length) return { ok: true, note: '主树本来就是干净的', paths: [] }
    const ok = gitRun(main, ['restore', '--', '.'])
    if (!ok) return { ok: false, error: 'git restore 失败，去主树手动处理', paths: dirty }
    emit()
    return { ok: true, restored: dirty.length, paths: dirty.slice(0, 20) }
  }

  /** 只跑主树的验证门（想看现在到底绿不绿，但不想动 git）。 */
  function verifyMain(input = {}) {
    const config = read()
    const main = String(input.workdir || config.workdir || '').trim()
    if (!main || !existsSync(main)) return { ok: false, error: '先选主树工作目录' }
    const script = join(main, '.workflow', 'verify', 'verify_unity.mjs')
    if (!existsSync(script)) return { ok: false, error: '主树里没有 .workflow/verify/verify_unity.mjs（验证门脚本）' }
    const target = String(loopConfig(main)?.run?.targetBranch || 'develop')
    const base = gitOut(main, ['rev-parse', '--verify', `origin/${target}`]) || 'HEAD'
    return spawnJob({
      kind: 'main-verify',
      name: '(主树)',
      path: main,
      workdir: main,
      script: `exec '${shPath(process.execPath)}' '${shPath(script)}' --base '${base}'`,
    })
  }

  function mergeStation(input = {}) {
    const config = read()
    const name = String(input.name || '').trim()
    const station = config.stations.find((item) => item.name === name)
    if (!station) return { ok: false, error: `没有叫 ${name} 的工位` }
    const main = String(input.workdir || config.workdir || '').trim()
    if (!main) return { ok: false, error: '先选主树工作目录' }
    // auto = 自动合入（autoMergeTick 起的）。它要多做两件事：把结果记进退避，
    // 以及回写 TAPD 时注明这次是自动合进去的。
    const byAuto = Boolean(input.auto)
    const live = runningAll().find((item) => samePath(item.workdir, station.path))
    if (live) return { ok: false, error: `${name} 上还有批次在跑，等它跑完再合入` }

    const branch = gitOut(station.path, ['rev-parse', '--abbrev-ref', 'HEAD'])
    if (!branch || branch === 'HEAD') return { ok: false, error: `${name} 读不到当前分支（detached？）` }
    // 合入源一直是「工位当前 HEAD」。一旦有人为了接着干活把工位切到失败现场分支上，
    // 自动合入就会去合一条明写着「未完成，勿合入」的快照——2026-10-28 17:18 那次就是：
    // 17:18:02 切到 tapd-loop-failed/<卡>，17:18:18 定时器醒了，去 pick 那个存档分支，
    // 白跑一趟还只报一句 cherry-pick empty。所以存档类分支在入口就拒，不再指望事后看懂日志。
    if (ARCHIVE_BRANCH.test(branch)) {
      const kind = /^tapd-loop-failed\//.test(branch) ? '失败现场' : '孤儿存档'
      return {
        ok: false,
        error: `${name} 现在停在${kind}分支 ${branch} 上，那不是待合入的分支（存档只给人看）。先切回它的工作分支再合：git -C "${station.path}" switch <feat/…>`,
      }
    }
    if (byAuto && KEPT_BRANCH.test(branch)) {
      return {
        ok: false,
        error: `${name} 停在 ${branch}（提交过但没推出去的存档分支），自动合入不碰它：确认要合就手动点「合入」，或者先切回工作分支`,
      }
    }
    const pending = pendingCount(main, branch)
    if (!pending) return { ok: true, pending: 0, note: `${branch} 上没有未合入提交` }
    if (gitOut(main, ['status', '--porcelain', '--untracked-files=no'])) {
      return { ok: false, error: '主树有未提交改动，collect 会被挡住：先处理干净' }
    }

    const script = join(main, 'Tools', 'Worktree', 'collect.mjs')
    if (!existsSync(script)) return { ok: false, error: '主树里没有 Tools/Worktree/collect.mjs（合入脚本）' }
    const before = gitOut(main, ['rev-parse', 'HEAD'])

    return spawnJob({
      kind: 'merge',
      name: byAuto ? `${name} · 自动` : name,
      path: station.path,
      workdir: main,
      // --resolve：冲突不 abort，保留现场（退出码 2）。
      // code 2 时 spawnJob 自动调 onConflict → 起 agent 解 → continue → collect --resume。
      script: `exec '${shPath(process.execPath)}' '${shPath(script)}' '${branch}' --resolve`,
      // 用 onSettled 而不是 onDone：verify 挂了也会 exit != 0，但提交已经落地。
      // 回写按「主树 HEAD 动了没」判（writeBackMerged 自己会查），不看退出码。
      onSettled: (status, code, summary) => {
        const back = writeBackMerged({ stationName: name, branch, main, before, via: byAuto ? '自动合入' : '' })
        // 合入成功 = 内容已经在主树里了。分支留着只会让卡片一直显示「待合入」（cherry-pick 换了 SHA、
        // patch-id 对不上），下一次还要白 pick 一遍。顺手把工位归位到 origin/<target>。
        if (status === 'done') recycleStation(station, main, branch)
        if (byAuto) {
          if (status === 'done') autoMergeRecord(name, { ok: true, merged: (back?.results || []).length })
          // 冲突不算「这个工位不行」：现场已经交给解冲突的 agent，只等 2 分钟别抢在它前面。
          else if (code === 2) autoMergeRecord(name, { soft: true, error: '冲突，交给解冲突 agent' })
          else if (code === 3) autoMergeRecord(name, { soft: true, error: summary || '环境未就绪（Unity 端点不在线）' })
          else autoMergeRecord(name, { code, error: summary })
        }
        return back
      },
      onConflict: () => {
        const started = resolveMerge({ name, workdir: main })
        // 起不来的典型原因：表格真冲突（同一格两边都改 / 行增删）、或主树根本不在
        // cherry-pick 中间态。这是要人来的，算一次失败并把退避拉满 30 分钟，
        // 别每 2 分钟把同一个冲突再撞一遍、把日志刷满天。
        if (byAuto && !started?.ok) autoMergeRecord(name, { error: String(started?.error || '解冲突没起来'), waitMin: 30 })
        return started
      },
    })
  }

  /**
   * 合入成功后把工位分支归位到 origin/<target>。
   *
   * 为什么必要：collect 走的是 cherry-pick（SHA 会变，而且「文件已经存在」的改动会被跳过），
   * 合完那一笔的 patch-id 跟工位分支上的原提交对不上，`git cherry` 就一直报 `+`，
   * 卡片挂着「有 1 个提交待合入」—— 点进去只会跑出一句「整批都是空提交」。
   *
   * 只做安全的那种：工位工作区得干净，分支不能是存档类（失败现场 / 未推送存档）。
   */
  function recycleStation(station, main, branch) {
    const path = String(station?.path || '').trim()
    if (!path || !branch) return { ok: false, error: '没有工位路径 / 分支，跳过归位' }
    if (ARCHIVE_BRANCH.test(branch) || KEPT_BRANCH.test(branch)) return { ok: false, error: `${branch} 是存档分支，不动它` }
    if (gitOut(path, ['status', '--porcelain', '--untracked-files=no'])) return { ok: false, error: '工位上有未提交改动，先不归位' }
    const target = String(loopConfig(main)?.run?.targetBranch || 'develop')
    if (!gitRun(path, ['fetch', 'origin'])) return { ok: false, error: 'git fetch 失败，归位没做' }
    if (!gitRun(path, ['reset', '--hard', `origin/${target}`])) return { ok: false, error: 'git reset --hard 失败' }
    const at = gitOut(path, ['rev-parse', '--short', 'HEAD'])
    appendTrace(home, {
      t: Date.now(),
      kind: 'station_recycle',
      station: String(station?.name || ''),
      note: `${branch} → origin/${target} @ ${at}`,
    })
    return { ok: true, at }
  }

  /** 主树是不是停在 cherry-pick 中间态；返回冲突文件和其中的表格。 */
  function conflictState(main) {
    const own = resolve(main, gitOut(main, ['rev-parse', '--git-dir']) || '.git')
    if (!existsSync(join(own, 'CHERRY_PICK_HEAD'))) return null
    // -z：git 会给带中文/#/空白的路径加双引号，按行切再 `\.xlsx$` 就永远不中（表格门禁静默失效）。
    const files = gitOut(main, ['diff', '--name-only', '--diff-filter=U', '-z'])
      .split('\0')
      .map((file) => file.trim())
      .filter(Boolean)
    return { files, xlsx: files.filter((file) => /\.(xlsx|xlsm)$/i.test(file)) }
  }

  /**
   * 解冲突：表格先按显示值三方叠（xlsx-cell-diff），剩下的文本冲突交给 agent，
   * 解完自动续跑 collect --resume。
   *
   * 两条约束：
   *   - 只允许改「冲突文件」—— brief 里写明，且解完后重新检查 UU 清单
   *   - 表格只在「同一格两边都改」或「sheet/行/列增删」时才拦下来给人，其余自动合
   */
  function resolveMerge(input = {}) {
    const config = read()
    const name = String(input.name || '').trim()
    const main = String(input.workdir || config.workdir || '').trim()
    if (!main) return { ok: false, error: '先选主树工作目录' }
    const station = config.stations.find((item) => item.name === name)
    const conflict = conflictState(main)
    if (!conflict) return { ok: false, error: '主树不在 cherry-pick 中间态，没有要解的冲突' }

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
    appendTrace(home, {
      t: job.startedAt,
      kind: 'job_start',
      station: String(name || ''),
      note: String(job.kind || 'resolve'),
      job: job.id,
      log: job.log,
    })
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
      // 表格先自动叠：xlsx 是二进制，git 必然判「整份冲突」，但配置表绝大多数是两边改的格
      // 不重叠，那有确定答案（两边改动都留下）。只有同一格两边都改、或 sheet/行/列增删，
      // 才算真冲突，拦下来给人。
      const tables = conflict.xlsx || []
      if (tables.length) {
        const report = mergeXlsxConflicts(main, tables)
        appendFileSync(job.log, [
          '[表格自动合并]',
          ...report.merged.map((file) => `  ✓ ${file}`),
          ...report.left.map((item) => `  ✗ ${item.file}：${item.reason}`),
          '',
        ].join('\n'), 'utf8')
        for (const file of report.merged) gitRun(main, ['add', '--', file])
        if (report.left.length) {
          throw new Error(`表格冲突里有真冲突，得人来定：${report.left.map((item) => `${item.file}（${item.reason}）`).join('；')}`)
        }
      }

      // 表格叠完可能就没冲突了，那就别白起一轮 agent。
      const pending = conflictState(main)
      if (pending?.files.length) {
        const brief = join(dir, 'brief.md')
        writeFileSync(brief, [
          `主树 develop 在 cherry-pick 工位 ${name || ''} 的提交时冲突了。`,
          '',
          '冲突文件（只有这些可以改，别动其他文件）：',
          ...pending.files.map((file) => `- ${file}`),
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

        const leftText = conflictState(main)
        if (leftText) throw new Error(`还有未解冲突：${leftText.files.join('、')}`)
      }

      // agent 不一定记得 --continue，这里补一次（纯表格自动合时也一样）。
      const own = resolve(main, gitOut(main, ['rev-parse', '--git-dir']) || '.git')
      if (existsSync(join(own, 'CHERRY_PICK_HEAD'))) {
        if (!gitRun(main, ['cherry-pick', '--continue', '--no-edit'])) {
          throw new Error('冲突解完了，但 git cherry-pick --continue 失败')
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
        // 续跑成功也算合入完成，工位一样要归位（否则卡片会继续显示待合入）。
        onDone: () => {
          writeBackMerged({ stationName: name || '(主树)', branch, main, before })
          const station = raw().stations.find((item) => item.name === name)
          if (station) recycleStation(station, main, branch)
        },
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
    const station = name ? config.stations.find((item) => item.name === name) : null
    // 主树的端点也要能查：合入时 verify 就是因为它连不上而 exit 2。
    const path = String(input.path || '').trim() || (station ? station.path : String(config.workdir || '').trim())
    if (name && !station) return { ok: false, error: `没有叫 ${name} 的工位` }
    if (!path) return { ok: false, error: '没给目标：要么写工位名，要么给树路径' }
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
      return { ok: false, state, error: `端点文件读不出来：${err.message}` }
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
    // 暂停的工位不进候选：人在页面上关的，不是它自己不可用。
    const idle = stations.filter((station) => station.idle && station.usable && !station.paused)
    if (!idle.length) {
      // 全满或全都不可用：别等完整轮询间隔，工位一空就能接上。
      memory.nextAt = Date.now() + Math.min(30, config.watch.pollSec) * 1000
      if (stations.length && !stations.every((s) => s.usable && !s.paused)) {
        const why = (s) => (!s.exists ? '目录不在'
          : !s.isRepo ? '不是仓库'
            // 暂停放在脏/Unity 前面：这是人自己关的，不是毛病。
            : s.paused ? '已暂停'
              : s.dirty ? '工作区脏'
                : s.unity === 'off' ? 'Unity 没开'
                  : s.unity === 'booting' ? 'Unity 正在启动'
                    : '不可用')
        memory.lastError = `没有可用工位：${stations.filter((s) => !s.usable || s.paused).map((s) => `${s.name}(${why(s)})`).join('、')}`
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
      if (!free.length) return { checked: true, ready: (listed.ready || []).length, idle: idle.length, started: [], assignee: config.assignee || '' }

      const take = Math.min(idle.length, free.length)
      const started = []
      for (let i = 0; i < take; i += 1) {
        const station = idle[i]
        const card = free[i]
        const result = start({ ...config, workdir: station.path, card: String(card.id) })
        if (result.ok) {
          memory.dispatched.push({ card: String(card.id), station: station.name, pid: result.batch?.pid || 0, at: Date.now() })
          // 带上日志路径：批次可能几秒就以 empty-queue 退出（处理人写错、状态不对），
          // 页面要靠这条路径当场把人指到日志上，而不是让人自己去翻 runs/。
          started.push({ station: station.name, card: String(card.id), ok: true, pid: result.batch?.pid || 0, log: result.batch?.log || '' })
        } else {
          memory.lastError = `${station.name}: ${result.error}`
          started.push({ station: station.name, card: String(card.id), ok: false, error: result.error })
        }
      }
      return { checked: true, ready: (listed.ready || []).length, idle: idle.length, started, assignee: config.assignee || '' }
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
    pauseStation,
    mergeStation,
    resolveMerge,
    openUnity,
    openMainUnity,
    pushMain,
    verifyMain,
    backfillMain,
    cleanMain,
    autoPushTick,
    autoMergeTick,
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
    match: samePath(queue.workdir, workdir),
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
