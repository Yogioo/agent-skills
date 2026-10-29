/**
 * 看板顶上的控制面板：选仓库、按一下跑、按一下停、定时接单开关。
 *
 * 面板只做三件事：把表单变成一次 POST、把服务端状态画出来、把「下一次什么时候查」
 * 倒数出来。取卡/占卡/判定/回写全在 loop.mjs，这里一个字都不重复实现。
 */

import { apiJson } from '/auth.js'
import { minuteBucket, selectionGuard } from '/dom-guard.js'
import { openFile } from '/fileview.js'

const el = (id) => document.getElementById(id)

let view = null
let refView = null
let serverSkew = 0
let saveTimer = 0
let started = false
/** 看板进程被这个页面停掉 / 正在重启：之后不再轮询（服务端已经不在了），按钮也锁住。 */
let boardGone = false

/**
 * 跟服务端 `control.mjs` 的 ARCHIVE_BRANCH / KEPT_BRANCH 对齐。
 * 存档分支（失败现场 / 孤儿存档）只能看不能合；没推出去那条只拦自动合入，人手动合是恢复手段。
 */
const ARCHIVE_BRANCH = /^tapd-loop-(failed|orphan)\//
const KEPT_BRANCH = /^tapd-loop-unpushed\//

/** 点过「打开 Unity」的工位：启动要几分钟，这期间卡片显示「正在启动」（本地状态，刷新即丢）。 */
const unityPending = new Map()

/**
 * 刚点过「接活」开关、还没被服务端确认的工位：name → { paused, at }。
 *
 * 服务端一次 /api/stations 要把所有工位的 Unity 端点 + git 状态重新探一遍（实测 0.7~1.6 秒），
 * 而 3 秒轮询的 GET 往往比这次 POST 先回来。不记这个的话，勾完会先画成新状态、
 * 下一轮轮询又把旧状态画回去、再下一轮才变回来——看起来就是「点下去很迟钝」。
 */
const pendingPause = new Map()

function editing() {
  // 高级设置会被搬进弹窗（#mbody）里编辑，所以不能只看 #ctl 里有没有焦点：
  // 漏了这一条，用户正在弹窗里输入时 3 秒轮询会用服务端值把输入框冲掉。
  const boxes = [el('ctl'), el('advancedPanel')].filter(Boolean)
  const active = document.activeElement
  return Boolean(active && boxes.some((box) => box.contains(active)))
}

function form() {
  return {
    workdir: String(el('cWorkdirText')?.value || '').trim(),
    assignee: String(el('cAssignee')?.value || '').trim(),
    maxTasks: Number(el('cMaxTasks')?.value || 1),
    allowDirty: Boolean(el('cAllowDirty')?.checked),
    noWrite: Boolean(el('cNoWrite')?.checked),
    watch: {
      enabled: Boolean(el('cWatch')?.checked),
      pollSec: Number(el('cPollSec')?.value || 300),
    },
    autoPush: {
      enabled: Boolean(el('cAutoPush')?.checked),
      pollSec: Number(el('cAutoPushSec')?.value || 120),
    },
    autoMerge: {
      enabled: Boolean(el('cAutoMerge')?.checked),
      pollSec: Number(el('cAutoMergeSec')?.value || 120),
    },
  }
}

/**
 * 操作结果一律走右下角消息条（toast）。
 *
 * 以前是 hero 和「自动化」标题之间的一行 12px 灰字（#cMsg）：一条讲工位 c 的消息会画在
 * 「自动化」头上，看着像那一块的说明；不会消失、没图标、离点击的地方（工位卡片）隔了大半屏。
 * 401 那次就是被这个坑到的：服务端什么都没写，而页面上只多了一行灰字。
 *
 * 现在：ok/warn 自动消失，bad 常驻到点掉（错误必须能读到原因）；同一句话重复出现不堆叠。
 */
const TOAST_TTL = { ok: 4200, warn: 6500, dim: 4200 }
const TOAST_ICON = { ok: '✓', warn: '!', bad: '✕', dim: '·' }

function say(text, cls = 'dim') {
  const box = el('toasts')
  if (!box) return
  const kind = cls === 'bad' || cls === 'warn' || cls === 'ok' ? cls : 'dim'
  const body = String(text ?? '').trim()
  if (!body) return

  // 同一句话连点两下不堆两条：拿文本当 key，命中就重置计时并从底部冒一下。
  const key = `${kind}:${body}`
  let item = box.querySelector(`[data-key="${CSS.escape(key)}"]`)
  if (!item) {
    item = document.createElement('div')
    item.className = `toast ${kind}`
    item.dataset.key = key
    const icon = document.createElement('span')
    icon.className = 'ic'
    icon.textContent = TOAST_ICON[kind] || '·'
    const tx = document.createElement('span')
    tx.className = 'tx'
    tx.textContent = body
    const close = document.createElement('button')
    close.className = 'x'
    close.type = 'button'
    close.title = '关闭'
    close.textContent = '×'
    close.addEventListener('click', () => item.remove())
    item.append(icon, tx, close)
    box.appendChild(item)
    // 最多留 3 条：再多就把旧的挤掉，错误那条优先保留。
    while (box.children.length > 3) {
      const victim = [...box.children].find((node) => !node.classList.contains('bad')) || box.firstElementChild
      victim?.remove()
    }
  }
  clearTimeout(item._ttl)
  const ttl = TOAST_TTL[kind]
  if (ttl) item._ttl = setTimeout(() => item.remove(), ttl)
  item.classList.remove('in')
  void item.offsetWidth // 重播进入动画：重复的提示也要让人看到它又刷了一次
  item.classList.add('in')
}

function fill(s) {
  const config = s.config
  const workdirs = s.workdirs
  if (!config) return
  const select = el('cWorkdir')
  if (select) {
    const known = [...new Set([...(workdirs || []), config.workdir].filter(Boolean))]
    select.innerHTML = '<option value="">（选一个最近跑过的）</option>' +
      known.map((dir) => `<option value="${esc(dir)}">${esc(dir)}</option>`).join('')
    select.value = known.includes(config.workdir) ? config.workdir : ''
  }
  // 三个开关各自一段：开着蓝底 + 左侧亮条，关着整块压暗。
  // 用状态类而不是 CSS `:has()`（老一点的 Chromium 不一定支持）。
  // 必须放在 editing() 那个早退之前：勾选框自己就是焦点元素，点一下就会让 editing() 为真。
  for (const [id, on] of [
    ['cWatch', config.watch?.enabled],
    ['cAutoPush', config.autoPush?.enabled],
    ['cAutoMerge', config.autoMerge?.enabled],
  ]) {
    const seg = el(id)?.closest?.('.seg')
    if (seg) seg.classList.toggle('on', Boolean(on))
  }
  if (editing()) return
  if (el('cWorkdirText')) el('cWorkdirText').value = config.workdir || ''
  if (el('cAssignee')) {
    el('cAssignee').value = config.assignee || ''
    // 留空就跑机器级 config.json 里的处理人：把名字摆成占位符，别让人猜。
    el('cAssignee').placeholder = s.defaults?.assignee || 'TAPD 处理人'
  }
  if (el('cMaxTasks')) el('cMaxTasks').value = String(config.maxTasks ?? 1)
  if (el('cAllowDirty')) el('cAllowDirty').checked = Boolean(config.allowDirty)
  if (el('cNoWrite')) el('cNoWrite').checked = Boolean(config.noWrite)
  if (el('cWatch')) el('cWatch').checked = Boolean(config.watch?.enabled)
  if (el('cPollSec')) el('cPollSec').value = String(config.watch?.pollSec ?? 300)
  if (el('cAutoPush')) el('cAutoPush').checked = Boolean(config.autoPush?.enabled)
  if (el('cAutoPushSec')) el('cAutoPushSec').value = String(config.autoPush?.pollSec ?? 120)
  if (el('cAutoPushHint')) {
    const auto = s.autoPush || {}
    hint('cAutoPushHint', !auto.enabled ? ''
      : auto.fails > 0 ? `连续失败 ${auto.fails} 次${auto.nextAt > Date.now() ? `，${Math.ceil((auto.nextAt - Date.now()) / 60000)} 分钟后重试` : ''}`
        : auto.lastResult ? `上次：${auto.lastResult}` : '等着主树攒出没推的提交')
  }
  if (el('cAutoMerge')) el('cAutoMerge').checked = Boolean(config.autoMerge?.enabled)
  if (el('cAutoMergeSec')) el('cAutoMergeSec').value = String(config.autoMerge?.pollSec ?? 120)
  if (el('cAutoMergeHint')) {
    const auto = s.autoMerge || {}
    const now = Date.now()
    // 退避是按工位记的：只把「还没到时间」的那几棵报出来，人能看出是卡在哪一棵上。
    const cooling = (auto.stations || []).filter((one) => Number(one.nextAt) > now)
    hint('cAutoMergeHint', !auto.enabled ? ''
      : cooling.length
        ? cooling.map((one) => `${one.name}：${Math.ceil((Number(one.nextAt) - now) / 60000)} 分钟后再试`).join(' · ')
        : auto.lastResult ? `上次：${auto.lastResult}` : '等着工位攒出待合入的提交')
  }
}

function dur(ms) {
  const total = Math.max(0, Math.round(ms / 1000))
  if (total < 60) return `${total}s`
  const m = Math.floor(total / 60)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

function clockOf(t) {
  if (!t) return ''
  const d = new Date(Number(t))
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

function esc(text) {
  return String(text ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]))
}

/**
 * 写自动化小卡的状态句。CSS 只展示两行（路径/失败原因能很长），
 * 所以把全文同步到 title：鼠标停一下就能看完整句，不用去翻日志。
 */
function hint(id, text) {
  const box = el(id)
  if (!box) return
  const full = String(text ?? '')
  box.textContent = full
  if (full) box.title = full
  else box.removeAttribute('title')
}

/**
 * 前端版的「同一个路径」：只抹平斜杠方向和结尾分隔符。
 * loop 写进 progress.jsonl 的是反斜杠，工位表 / 面板里存的是正斜杠，直接 === 永远不等。
 * 浏览器里没有 path.resolve，也不需要：两边都是同一台机器上的绝对路径。
 */
function samePath(a, b) {
  const norm = (value) => {
    const text = String(value || '').replace(/[\\/]+/g, '/').replace(/\/+$/, '')
    return /^[A-Za-z]:\//.test(text) ? text.toLowerCase() : text
  }
  return Boolean(a) && Boolean(b) && norm(a) === norm(b)
}

function overlayPendingPause(s) {
  for (const station of Array.isArray(s?.stations) ? s.stations : []) {
    const pending = pendingPause.get(station.name)
    if (!pending) continue
    // 服务端已经对上了，或者等了太久（POST 失败/被其它实例改掉）：以服务端为准。
    if (Boolean(station.paused) === pending.paused || Date.now() - pending.at > 5000) {
      pendingPause.delete(station.name)
      continue
    }
    station.paused = pending.paused
  }
  return s
}

/** 就地改一个工位的接活状态，只重画工位卡片（不重画整页，避免把正在编辑的输入框冲掉）。 */
function applyPaused(name, paused) {
  pendingPause.set(name, { paused, at: Date.now() })
  const target = Array.isArray(view?.stations) ? view.stations.find((item) => item.name === name) : null
  if (!target) return
  target.paused = paused
  renderStations(view)
}

function renderRunning(s) {
  const box = el('cRunning')
  if (!box) return
  const runs = Array.isArray(s.runs) ? s.runs : (s.running ? [s.running] : [])
  if (!runs.length) {
    box.innerHTML = ''
    box.className = ''
    return
  }
  box.className = 'runline'
  const stationOf = (workdir) => (Array.isArray(s.stations) ? s.stations : [])
    .find((station) => samePath(station.path, workdir))
  box.innerHTML = runs.map((running) => {
    const elapsed = Date.now() + serverSkew - Number(running.startedAt || Date.now())
    // 不显示仓库绝对路径：看板是给人远程看的，本机路径对他没意义（开发机是黑箱）。
    const who = stationOf(running.workdir)?.name || '一批任务'
    const what = running.cardTitle || running.card || ''
    return `<div>${esc(who)} · 已跑 ${esc(dur(elapsed))}${what ? ' · ' + esc(what) : ''}</div>`
  }).join('')
}

/**
 * 工位卡片：给人看的版本。默认视图只回答三件事——谁能接活、谁在干活、谁需要处理。
 * 分支名 / 上游 / 绝对路径这些不进卡片正文（放 title），出错时给的是「怎么办」而不是「发生了什么」。
 */
/**
 * 一条 job 是不是「在主树上干活」。
 * 合入（merge / merge-resume）和解冲突（resolve）也占主树（develop + 那块 Unity），
 * 所以判主树忙、判上次失败都不能只认 `main-*`。
 */
function isMainWork(job) {
  const kind = String(job?.kind || '')
  return kind.startsWith('main-') || kind === 'merge' || kind === 'merge-resume' || kind === 'resolve'
}

/** 失败行的人话标题：`合入 b · 自动` / `验证并推送` / `解冲突`。 */
function failTitle(job) {
  const kind = String(job?.kind || '')
  const name = String(job?.name || '')
  if (kind === 'merge' || kind === 'merge-resume') return `合入 ${name}`.trim()
  if (kind === 'main-push') return '验证并推送'
  if (kind === 'main-verify') return '只验证'
  if (kind === 'resolve') return '解冲突'
  return '主树任务'
}

/**
 * 主树卡片。以前看板上只有工位卡片，主树的事（合进去了没推、Unity 没开所以 verify 卡在
 * 验证门、卡在 cherry-pick 冲突）只能翻日志才发现。跟工位卡片同一套皮肤和语义：
 * 蓝 = 在忙、红 = 需要处理（包括「有提交没推」）、灰 = 干净。
 */
function renderMain(s) {
  const box = el('cMain')
  if (!box) return
  const main = s.main
  if (!main || !main.path) {
    box.innerHTML = ''
    return
  }
  const jobs = (Array.isArray(s.jobs) ? s.jobs : [])
    .filter((item) => isMainWork(item))
  // 只看真在跑的。进程没了的（interrupted）不算在跑：否则看板重启时正在跑的 collect
  // 会让这张卡永远写着「验证中」、按钮全置灰，看起来像卡死。它们走下面的 interruptedLine。
  const job = jobs.find((item) => item.status === 'running')
  const busy = Boolean(job)
  // 主树上最后一次跑完的长任务：它要是红的，卡片得把「怎么红的」说出来，
  // 而不是让你去 200 行日志里找。后面成功的会把它顶掉，所以不会永远挂着一条旧的。
  const lastFailed = !busy && jobs.filter((item) => item.status === 'failed')
    .sort((a, b) => Number(b.endedAt || 0) - Number(a.endedAt || 0))[0]
  const lastOk = jobs.filter((item) => item.status === 'done')
    .sort((a, b) => Number(b.endedAt || 0) - Number(a.endedAt || 0))[0]
  const showFail = lastFailed && Number(lastFailed.endedAt || 0) > Number(lastOk?.endedAt || 0) ? lastFailed : null
  const trouble = !main.exists ? '目录不见了'
    : !main.isRepo ? '不是 git 仓库'
      : main.conflict ? 'cherry-pick 冲突中'
        : ''
  const unpushed = Number(main.ahead) || 0
  const behind = Number(main.behind) || 0

  const badge = busy
    ? `<span class="badge run">${esc(job.kind === 'main-push' ? '验证并推送中' : '验证中')}</span>`
    : trouble ? '<span class="badge bad">需要处理</span>'
      : unpushed > 0 ? `<span class="badge bad">${esc(String(unpushed))} 个提交没推</span>`
        : behind > 0 ? `<span class="badge run">落后 ${esc(String(behind))}</span>`
          : '<span class="badge ok">与远端一致</span>'

  // 状态 chips：一行看完主树什么状况，异常那颗自己变红。
  // 自动推送/自动合入的开关和上次结果在上面的「自动化」栏里，这里不重复；
  // 领先/落后上游也不重复——上面那个徽标已经是这个信息。
  const chip = (text, tone = '', tip = '') => `<span class="chip ${tone}"${tip ? ` title="${esc(tip)}"` : ''}>${text}</span>`
  const chips = []
  chips.push(chip(esc(main.branch || '?') + (main.upstream ? ' ⟵ ' + esc(main.upstream) : '（没配上游）'), 'dim',
    main.upstream ? `本地分支 ${main.branch}，上游 ${main.upstream}` : `${main.branch} 没配上游，推送前同步会跳过`))
  if (trouble) chips.push(chip(esc(trouble), 'bad'))
  else {
    chips.push(main.dirty
      ? chip('工作区有未提交改动', 'bad', '合入/推送都要求工作区干净：点「清理改动」，或者自己提交掉')
      : chip('工作区干净', 'ok'))
    chips.push(main.unity === 'on'
      ? chip('Unity 在线', 'ok', '验证门能连上这棵树的 puer-exec 端点')
      : main.unity === 'booting'
        ? chip('Unity 没控制端点', 'run', 'Editor 进程在，但没写 endpoint.json：多半不是带 -unityPuerExecControl 开的')
        : chip('Unity 没开', 'bad', '验证门要连本树的 Unity；没开就只能停在推送前'))
  }

  // 失败一律用人话：上一行可能是绿的（git 已经同步），但这条任务是红的，并且带原因 + 日志入口。
  const failLine = showFail
    ? `<span class="fail">✕ ${esc(failTitle(showFail))}：${esc(showFail.summary || `失败（exit ${showFail.code}）`)}</span>`
    : ''
  // 没收到退出的任务：多半是看板重启时 collect 还在跑（子进程 detach 了，收尸的那个
  // child.once('exit') 跟着看板没了）。它可能成功也可能失败，所以只说“去日志看”，
  // 不冒充结果。比让它永远画着「验证中」诚实得多。
  // 只要「比最近一次真正收过尾的任务还新」的那一条：后面又有活干完就不提醒旧的了。
  const lastEnded = Math.max(Number(lastFailed?.endedAt || 0), Number(lastOk?.endedAt || 0))
  const interrupted = !busy ? jobs.filter((item) => item.status === 'interrupted' && Number(item.startedAt || 0) > lastEnded)
    .sort((a, b) => Number(b.startedAt || 0) - Number(a.startedAt || 0))[0] : null
  const interruptedLine = interrupted
    ? `<span class="warn">⚠ 上次${esc(failTitle(interrupted))}没收到退出（看板重启过？）：结果以日志为准</span>`
    : ''

  // 每个按钮都得能自己解释：这个面板上很多动作会真改 git / 真推共享分支，光靠名字看不懂。
  const TIP = {
    mpush: `跑 collect --resume：导表 → 验证门（编译 + 与本批改动相关的测试）→ git push origin/${main.target || 'develop'} → 回写 TAPD。主树与远端一致时按它等于空跑一次验证。`,
    mverify: '只跑验证门（导表 + 编译 + 测试），不动 git、不推送、也不回写 TAPD。想知道现在到底绿不绿时用。',
    munity: '用 -unityPuerExecControl 启动本树的 Unity Editor。验证门要连它的控制端点；首次导入约 4.5 分钟。',
    mprobe: 'ping 一次本树 Unity 的控制端点（/health），区分「文件在但连不上」和真在线。',
    mclean: 'git restore 掉主树里没提交的改动（未跟踪文件不动）。合入/推送都要求工作区干净时用它解围。',
    mbackfill: '提交已经在主树/远端、但 TAPD 那条评论没写成时用它：按 cherry-pick 尾巴找回卡片补一条，已经回写过的不会重发。',
    mlog: '打开这条任务日志的尾部：失败原因、验证输出、跑了哪些测试都在里面。',
  }
  const btn = (attr, label, tip, primary) => `<button ${attr} title="${esc(tip)}"${primary ? ' class="primary"' : ''}>${label}</button>`
  // 有东西可推才把「验证并推送」点亮：主树与远端一致时它是空跑（导表 + 全套测试约 2 分钟）。
  // 补回写的优先级反过来：上一次回写没写成（writeBack.ok === false）时它才是有用的那一下。
  const backfillUrgent = Boolean(showFail?.writeBack && showFail.writeBack.ok === false)
  const actions = busy
    ? `<button disabled title="主树正在跑长任务（合入/解冲突/验证/推送），等它结束">${esc(job.kind === 'main-push' ? '验证并推送中…' : '验证中…')}</button>`
    : btn('data-mpush="1"', `验证并推送 ${esc(main.target || 'develop')}`, TIP.mpush, unpushed > 0) +
      btn('data-mverify="1"', '只验证', TIP.mverify) +
      (main.unity === 'off'
        ? btn('data-munity="1"', '打开 Unity', TIP.munity)
        : btn('data-mprobe="1"', '检查端点', TIP.mprobe)) +
      (main.dirty ? btn('data-mclean="1"', '清理改动', TIP.mclean) : '') +
      btn('data-mbackfill="1"', '补回写 TAPD', TIP.mbackfill, backfillUrgent) +
      (showFail?.log ? btn(`data-mlog="${esc(showFail.log)}"`, '看日志', TIP.mlog) : '') +
      (!showFail?.log && interrupted?.log ? btn(`data-mlog="${esc(interrupted.log)}"`, '看上次日志', TIP.mlog) : '')

  // 上次回写的结果：只报「对上卡片」的那几条。没对上卡片的提交（不是工单提交、或没有
  // cherry-pick 尾巴）单独算个数——以前会把它们渲染成「卡片 ⚠ ?」，等于在页面上放乱码。
  const last = s.lastMerge
  const lastResults = Array.isArray(last?.results) ? last.results : []
  const flowedRows = lastResults.filter((one) => one.cardId)
  const unmatchedRows = lastResults.length - flowedRows.length
  let lastText = ''
  if (lastResults.length) {
    const when = new Date(Number(last?.at) || 0)
    const stamp = when.toDateString() === new Date().toDateString() ? when.toLocaleTimeString() : when.toLocaleString()
    // 只报这次真写进去的；全是「已经回写过」时不重复念旧账。最多点 4 张。
    const fresh = flowedRows.filter((one) => !one.skipped)
    const shown = (fresh.length ? fresh : flowedRows).slice(0, 4)
    const body = shown.length
      ? shown.map((one) => {
        // 19 位 id 对人眼就是随机数：给个短标签 + TAPD 链接，完了自己点进去看。
        const label = `#${String(one.cardId).slice(-6)}`
        const link = `<a href="https://www.tapd.cn/prong/stories/view/${esc(one.cardId)}" target="_blank" rel="noreferrer" title="在 TAPD 打开需求 ${esc(one.cardId)}">${esc(label)}</a>`
        const moved = one.status ? ` → ${esc(one.status)}` : ''
        // 「已经回写过」这种内部措辞不铺在界面上，抽成一个可悬停的符号。
        const redo = one.skipped ? `<span class="dim" title="${esc(one.skipped)}"> ↺</span>` : ''
        const warn = one.ok ? '' : '<span title="这条回写没成功，原因在下面的失败行/日志里"> ⚠</span>'
        return link + moved + redo + warn
      }).join('、')
      : '没有对上卡片的提交'
    lastText = `上次回写 ${stamp} · ${body}` + (unmatchedRows ? ` · 另有 ${unmatchedRows} 个提交没对上卡片` : '')
  }

  const tone = busy ? 'run' : trouble || unpushed > 0 || showFail ? 'bad' : ''
  box.innerHTML = '<div class="cards">' +
    `<div class="card ${tone}" title="${esc(main.branch ? '主树 ' + main.branch : '主树')}">` +
    `<div class="card-top"><span class="card-name">主树</span>${badge}</div>` +
    `<div class="card-body">` +
      `<div class="chips">${chips.join('')}</div>` +
      (failLine ? `<div>${failLine}</div>` : '') +
      (interruptedLine ? `<div>${interruptedLine}</div>` : '') +
      (lastText ? `<div class="dim">${lastText}</div>` : '') +
    `</div>` +
    `<div class="card-actions">${actions}</div>` +
    '</div></div>'

  const run = (action) => {
    stationAction(action, { workdir: s.config?.workdir || '' })
      .catch(() => {})
  }
  box.querySelector('[data-mpush]')?.addEventListener('click', () => run('mainpush'))
  box.querySelector('[data-mverify]')?.addEventListener('click', () => run('mainverify'))
  box.querySelector('[data-munity]')?.addEventListener('click', () => run('mainunity'))
  box.querySelector('[data-mclean]')?.addEventListener('click', () => {
    if (!window.confirm('把主树里没提交的改动恢复成 HEAD？（未跟踪文件不动，推送/合入需要干净工作区）')) return
    stationAction('mainclean', { workdir: main.path, confirm: true }).catch(() => {})
  })
  // 提交早就合进去/推上去了，但 TAPD 那次没写成时用这个补上（按 cherry-pick 尾巴找卡片，记过的不重发）。
  box.querySelector('[data-mbackfill]')?.addEventListener('click', () => {
    stationAction('mainbackfill', { workdir: main.path }).catch(() => {})
  })
  box.querySelector('[data-mlog]')?.addEventListener('click', (event) => {
    openFile(event.currentTarget.getAttribute('data-mlog'))
  })
  box.querySelector('[data-mprobe]')?.addEventListener('click', () => {
    apiJson('api/stations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'mainprobe', path: main.path }),
    })
      .then((res) => {
        const d = res.data || {}
        if (res.ok && d.ok) say(`主树端点通了：端口 ${d.port} · pid ${d.pid}`, 'ok')
        else say(`主树端点：${d.error || '连不上'}`, 'bad')
        return poll()
      })
      .catch(() => {})
  })
}

function renderStations(s) {
  const box = el('cStations')
  if (!box) return
  const stations = Array.isArray(s.stations) ? s.stations : []
  // 只画还在跑的：done / failed 的 job 不该再占卡片（以前 resolve 用看板 pid
  // 占位，alive 恒真，、合入完了还挂着一张「正在删除」）。
  const jobs = (Array.isArray(s.jobs) ? s.jobs : [])
    .filter((job) => job.status === 'running')

  const cards = stations.map((station) => {
    // 判「在干活」不能看 card：刚点「接一单」时批次已经起来了，卡片要等 TAPD 查完才有 id。
    // 只看 card 会把正在跑的工位当成空闲，于是给它画「合入 N」和「接一单」。
    const running = station.busy ?? !station.idle
    const unityOff = station.unity === 'off'
    const trouble = !station.exists ? '目录不见了'
      : !station.isRepo ? '不是一个 git 仓库'
        : station.dirty ? '有没提交的改动'
          : unityOff ? 'Unity 没开'
            : ''
    const pendingSince = unityPending.get(station.name)
    const starting = Boolean(pendingSince) && Date.now() - pendingSince < 10 * 60_000
    // booting：Unity 进程在、控制端点还没出来（首次导入）。这不是错误，是等。
    const booting = !trouble && (starting || station.unity === 'booting')
    const elapsed = Math.max(0, Number(s.now || Date.now()) - Number(station.startedAt || s.now || Date.now()))
    // 暂停是人在页面上关的，不是工位坏了：它只影响「调度器还派不派卡」，不影响手上那张。
    const paused = Boolean(station.paused)
    const badge = running ? `<span class="badge run">干活中 · ${esc(dur(elapsed))}</span>`
      : paused ? '<span class="badge dim">已暂停</span>'
        : trouble ? '<span class="badge bad">需要处理</span>'
          : booting ? '<span class="badge run">Unity 启动中</span>'
            : '<span class="badge ok">空闲</span>'
    // 在跑就先报在跑：批次跑卡时工作区必然是脏的，不能因此画成「需要处理 / 清理改动」——
    // 那等于请人点一个会把 agent 活干掉的按钮。
    // 在跑就先把运行状态报出来：卡片名优先用标题，19 位 id 在人眼里跟随机数一样。
    const cardLabel = running ? (station.cardTitle || station.card || '') : ''
    const pending = Number(station.pending) > 0
    // 停在存档分支上时报「有 N 个提交待合入」是误导：那 N 个是失败现场的快照，不是待办。
    const archived = ARCHIVE_BRANCH.test(station.branch)
    const kept = KEPT_BRANCH.test(station.branch)
    let body
    if (running) {
      const tail = paused ? '跑完不会再派新卡' : '跑完自动回到空闲'
      body = cardLabel
        ? `<span class="t">${esc(cardLabel)}</span><br>${tail}`
        : `正在接单，还没分到卡片<br>${tail}`
    } else if (paused) {
      body = '暂停中：调度器不会再派卡给它<br>把左上角的「接活」勾上就接回去了'
    } else if (trouble) {
      body = unityOff
        ? '验证要连本树的 Unity，现在没开<br>点下面的按钮打开它'
        : `${esc(trouble)}` + (station.behind ? ` · 落后 ${esc(String(station.behind))}` : '') + '<br>清一下就能接着干'
    } else if (booting) {
      body = '首次导入约 4.5 分钟。超过 10 分钟还这样，点「检查端点」看看是不是没带控制开关'
    } else if (archived) {
      body = `停在存档分支 ${esc(station.branch)} 上<br>失败现场，只给人看：先切回工作分支再合`
    } else if (kept) {
      body = `${esc(station.branch)} 上 ${esc(String(station.pending))} 个提交没推出去<br>确认要合就点「合入」，合完会补推 + 回写`
    } else if (pending) {
      body = `有 ${esc(String(station.pending))} 个提交待合入主树`
    } else {
      body = station.behind ? `落后最新 ${esc(String(station.behind))} 个提交，开工前会自动更新` : '可以接活'
    }
    const STIP = {
      srun: '在这个工位上开一批：自动从 TAPD 拉一张标了 ready-for-agent 的卡，跑完自动回写。',
      smerge: `把这个工位分支上 ${station.pending} 个未合入提交 cherry-pick 进主树，然后导表 → 验证门 → 推送 → 回写 TAPD。冲突会停下来等人（表格冲突必须手合）。`,
      sdel: '删掉这棵 worktree。还有未合入提交、或有批次在跑时会被拦住。',
      slive: '接活开关：勾上 = 调度器会把就绪卡派给它；取消 = 暂停，不再派新卡（正在跑的那一张照常跑完，工具从不杀进程）。',
      sunity: '用 -unityPuerExecControl 启动这个工位的 Unity Editor（验证门要连它，首次导入约 4.5 分钟）。',
      sprobe: 'ping 一次这个工位的 Unity 控制端点（/health），区分「文件在但连不上」和真在线。',
      sclean: 'git restore 掉这个工位里没提交的改动（未跟踪文件不动）。',
    }
    // 接活开关（Toggle），放在卡片左上角、工位名左边，不是按钮也不在底部动作行。
    //
    // 旧版这里是个「跑完这张就停」，靠写 stop 文件；但停止文件只在 loop.mjs 的「卡与卡之间」
    // 被读一次，而看板派卡永远是一张一批（--card 会把 maxTasks 强制成 1），所以那个标记
    // 从头到尾没人读——按钮看着像停了一个工位，实际什么都没发生（start 还会把它删掉）。
    // 真正想表达的是「别再给它派卡」，那就落一个持久标记，调度器直接跳过它。
    //
    // 再后来那版是「不再接活 / 继续接活」两个态拼一个按钮，藏在底部动作行：双否定读着绕，
    // 而且动作行只占下方一小块，一眼看不出这个工位到底还接不接活。现在是一个勾选框，
    // 就贴在工位名前面：勾上 = 会派卡，取消 = 暂停。
    const liveToggle = (paused) =>
      `<label class="toggle${paused ? '' : ' on'}" title="${esc(STIP.slive)}">` +
      `<input type="checkbox" data-spause="${esc(station.name)}"${paused ? '' : ' checked'}>接活</label>`
    // 这个开关只在「会自动派卡」时有意义：服务端只有 tick() 的候选过滤看 station.paused
    // （自动接单定时器 + 顶上那个「现在接一单」）。手动点卡片上的「接一单」不看它。
    //
    // 所以：自动接单关着 + 这个工位没被暂停 → 不显示，默认视图干净点；
    // 已经被暂停的工位必须继续显示，否则关了自动接单之后这个状态就看不见、也改不回来
    // （下次开自动接单时它会莫名不接活，那才是最坑的）。
    const autoWatch = Boolean(s?.config?.watch?.enabled)
    const showToggle = autoWatch || paused
    const buttons = []
    // 正在跑的工位不放动作按钮（会打断 agent）；接活开关在标题行，不受影响。
    if (!running) {
      if (trouble) {
        if (unityOff) buttons.push(`<button class="primary" data-sunity="${esc(station.name)}" title="${esc(STIP.sunity)}">打开 Unity</button>`)
        else if (station.dirty) buttons.push(`<button class="primary" data-sclean="${esc(station.name)}" title="${esc(STIP.sclean)}">清理改动</button>`)
        buttons.push(`<button data-sdel="${esc(station.name)}" title="${esc(STIP.sdel)}"${station.idle ? '' : ' disabled'}>${unityOff || station.dirty ? '删掉' : '删掉这个工位'}</button>`)
      } else if (booting) {
        buttons.push(`<button data-sprobe="${esc(station.name)}" title="${esc(STIP.sprobe)}">检查端点</button>`)
      } else if (paused) {
        // 暂停的工位：开关在标题行，这里只留还能干的（合入、删）。
        if (pending && !archived) buttons.push(`<button data-smerge="${esc(station.name)}" title="${esc(STIP.smerge)}">合入 ${esc(String(station.pending))}</button>`)
        buttons.push(`<button data-sdel="${esc(station.name)}" title="${esc(STIP.sdel)}">删掉</button>`)
      } else {
        if (pending && !archived) buttons.push(`<button class="primary" data-smerge="${esc(station.name)}" title="${esc(STIP.smerge)}">合入 ${esc(String(station.pending))}</button>`)
        buttons.push(`<button class="primary" data-srun="${esc(station.name)}" title="${esc(STIP.srun)}">接一单</button>`)
        buttons.push(`<button data-sdel="${esc(station.name)}" title="${esc(STIP.sdel)}">删掉</button>`)
      }
    }
    const actions = buttons.join('')
    // 框颜色：在跑优先。在跑的时候工作区必然是脏的（agent 正在改文件），trouble 里那条
    // 「有没提交的改动」不是问题，不能因此把框画成红的——那会让人以为工位坏了。
    const tone = running ? 'run' : trouble ? 'bad' : ''
    // 悬停只给卡片号：开发机是黑箱，本机绝对路径对远程看板的人没有意义。
    const hover = station.card ? `卡片 ${station.card}` : ''
    return `<div class="card ${tone}" title="${esc(hover)}">` +
      `<div class="card-top"><span class="card-left">${showToggle ? liveToggle(paused) : ''}<span class="card-name">${esc(station.name)}</span></span>${badge}</div>` +
      `<div class="card-body">${body}</div>` +
      (actions ? `<div class="card-actions">${actions}</div>` : '') +
      '</div>'
  }).join('')

  // 正在建/删/合入/解冲突的工位也占一张卡，否则点完按钮页面看着像没反应。
  const JOB_TEXT = {
    create: ['正在准备', '第一次准备要几分钟，好了会自动出现'],
    remove: ['正在删除', '删完会自动从工位表里消失'],
    merge: ['正在合入', 'pick → 导表 → verify → push，跑完自动回写 TAPD'],
    resolve: ['AI 解冲突中', '解完自动 continue，然后续跑合入'],
    'merge-resume': ['合入续跑中', '导表 → verify → push'],
  }
  const jobCards = jobs.map((job) => {
    const [badge, body] = JOB_TEXT[job.kind] || ['处理中', '']
    return `<div class="card run"><div class="card-top"><span class="card-name">${esc(job.name)}</span>` +
      `<span class="badge run">${esc(badge)}</span></div>` +
      `<div class="card-body">${esc(body)}</div>` +
      `<div class="card-actions">${job.log ? `<button data-joblog="${esc(job.log)}">看日志</button>` : ''}</div></div>`
  }).join('')

  box.innerHTML = cards || jobCards ? `<div class="cards">${cards}${jobCards}</div>` : ''

  // Unity 已经起来后就把「正在启动」清掉（或者超过 10 分钟也清：多半是启失败了）。
  for (const station of stations) {
    if (station.unity === 'on') unityPending.delete(station.name)
    else {
      const since = unityPending.get(station.name)
      if (since && Date.now() - since >= 10 * 60_000) unityPending.delete(station.name)
    }
  }

  // innerHTML 重建会丢监听器，所以每次都重新挂。
  const find = (name) => stations.find((station) => station.name === name)
  const findJob = (id) => jobs.find((job) => job.id === id)
  for (const btn of box.querySelectorAll('button[data-sunity]')) {
    btn.onclick = () => { openUnity(find(btn.getAttribute('data-sunity'))).catch(() => {}) }
  }
  for (const btn of box.querySelectorAll('button[data-sprobe]')) {
    btn.onclick = () => { probeStation(find(btn.getAttribute('data-sprobe'))).catch(() => {}) }
  }
  for (const btn of box.querySelectorAll('button[data-sclean]')) {
    btn.onclick = () => { cleanStation(find(btn.getAttribute('data-sclean'))).catch(() => {}) }
  }
  for (const btn of box.querySelectorAll('button[data-smerge]')) {
    btn.onclick = () => { mergeStation(find(btn.getAttribute('data-smerge'))).catch(() => {}) }
  }
  for (const btn of box.querySelectorAll('button[data-srun]')) {
    btn.onclick = () => { runStation(find(btn.getAttribute('data-srun'))).catch(() => {}) }
  }
  // 接活开关：勾选状态就是目标状态，取消勾选 = 暂停。服务端写失败时下一次 poll 会把
  // 勾选框画回服务的真实状态（不在这里自己回滚，免得两处各写一套）。
  for (const input of box.querySelectorAll('input[data-spause]')) {
    input.onchange = () => {
      pauseStation(find(input.getAttribute('data-spause')), !input.checked).catch(() => {})
    }
  }
  for (const btn of box.querySelectorAll('button[data-sdel]')) {
    btn.onclick = () => { removeStation(find(btn.getAttribute('data-sdel'))).catch(() => {}) }
  }
  for (const btn of box.querySelectorAll('button[data-joblog]')) {
    // 日志不再是“把绝对路径打到提示里”，而是一个按钮 → 弹窗看尾部。
    btn.onclick = () => openFile(btn.getAttribute('data-joblog'))
  }
}

/** 顶上那一行：几个工位、几个空闲、几个在干活、自动接单开着没。 */
function renderSummary(s) {
  const box = el('cSummary')
  if (!box) return
  const stations = Array.isArray(s.stations) ? s.stations : []
  const auto = Boolean(s.config?.watch?.enabled)
  if (el('cAuto')) {
    el('cAuto').textContent = auto ? '暂停自动接单' : '开始自动接单'
    el('cAuto').className = auto ? '' : 'primary'
    el('cAuto').title = auto ? '暂停后不会再派新活，在跑的不受影响' : '空闲工位会自动接 TAPD 上标了 ready-for-agent 的卡'
  }
  if (!stations.length) {
    box.innerHTML = '<b>还没有工位</b> · 展开下面的「高级设置」建一个，或直接填项目路径单工位跑'
    return
  }
  const running = stations.filter((station) => station.busy || station.card).length
  // 暂停优先于「需要处理」：暂停是人的决定，一个暂停且脏的工位不该被算成毛病。
  const pausedCount = stations.filter((station) => station.paused && !station.busy && !station.card).length
  const trouble = stations.filter((station) => !station.usable && !station.busy && !station.card && !station.paused).length
  const idle = stations.length - running - trouble - pausedCount
  const parts = [`<b>${stations.length}</b> 个工位`]
  if (idle) parts.push(`<span class="ok">${idle} 空闲</span>`)
  if (running) parts.push(`<span class="state-run">${running} 干活中</span>`)
  if (pausedCount) parts.push(`<span class="dim">${pausedCount} 已暂停</span>`)
  if (trouble) parts.push(`<span class="bad">${trouble} 需要处理</span>`)
  // 「自动接单关着」不在这里说：下面那条「自动化」栏的勾选框就是它的状态，同一句不念两遍。
  box.innerHTML = parts.join(' · ')
}

function renderQueue(s) {
  const box = el('cQueueBox')
  if (!box) return
  const q = s.queue
  if (!q) {
    box.innerHTML = ''
    return
  }
  const head = q.ok
    ? `<span class="ok">可接 ${q.ready.length} 张</span>` +
      (q.rejected.length ? ` · <span class="dim">另有 ${q.rejected.length} 张被状态挡着</span>` : '') +
      ` · <span class="dim">${esc(clockOf(q.at))} 查的</span>`
    : `<span class="bad">拉不到 TAPD 队列</span> · ${esc(q.error)}`
  const rows = q.ok && q.ready.length
    ? q.ready.map((card) => '<div class="qrow"><span class="qid">' + esc(card.id) + '</span>' +
      '<span class="qtitle" title="' + esc(card.title) + '">' + esc(card.title) + '</span>' +
      '<span class="dim">' + esc(card.priorityLabel || '') + '</span>' +
      '<button data-card="' + esc(card.id) + '">接这张</button></div>').join('')
    : ''
  const rejected = q.ok && q.rejected.length
    ? '<details class="qrej"><summary>被状态挡住的 ' + q.rejected.length + ' 张</summary>' +
      q.rejected.map((card) => '<div class="qrow dim"><span class="qid">' + esc(card.id) + '</span>' +
        '<span class="qtitle">' + esc(card.title) + '</span><span>' + esc(card.reason || card.statusLabel) + '</span><span></span></div>').join('') +
      '</details>'
    : ''
  box.innerHTML = '<div class="qhead">' + head + '</div>' + rows + rejected
  for (const btn of box.querySelectorAll('button[data-card]')) {
    btn.onclick = () => run(btn.getAttribute('data-card'))
  }
}

function renderShare(s) {
  const box = el('cShare')
  if (!box) return
  // 只有真的出网才值得分享：loopback 链接发给别人打不开。
  if (!s.board?.lan) {
    box.innerHTML = ''
    return
  }
  const share = s.board.shareWithKey
  box.innerHTML = '<span>分享给同事</span><input id="cShareUrl" readonly value="' + esc(share) + '" spellcheck="false">' +
    '<button id="cShareCopy" title="复制带密钥的分享链接：同网段的人打开就能点按钮真跑（接单/合入/推送）">复制</button>' +
    (s.board.authRequired ? '<span class="dim">局域网可访问 · 链接里带密钥，能点按钮真跑</span>' : '')
  el('cShareCopy').onclick = () => {
    const input = el('cShareUrl')
    input.select()
    try {
      navigator.clipboard.writeText(input.value)
      say('链接已复制（里面带了访问密钥）', 'ok')
    } catch {
      say('复制失败，手动选中复制', 'warn')
    }
  }
}

function renderRef() {
  const box = el('cRefBox')
  if (!box) return
  if (!refView) {
    box.innerHTML = ''
    return
  }
  if (!refView.ok) {
    box.innerHTML = '<div class="bad">' + esc(refView.error || '认不出这张卡') + '</div>'
    return
  }
  const card = refView.card || {}
  const blocked = card.blockedReason || ''
  const labels = (card.labels || []).join(' ')
  box.innerHTML =
    '<div class="rtitle">' + esc(card.title || '(无标题)') + '</div>' +
    '<div class="rmeta">' + esc(refView.id) + ' · ' + esc(card.statusLabel || '') +
    (card.priorityLabel ? ' · ' + esc(card.priorityLabel) : '') +
    (labels ? ' · 标签 ' + esc(labels) : ' · 没有标签') +
    (refView.guessed ? ' · <span class="warn">按最长的数字串猜的 id，确认一下</span>' : '') +
    (card.url ? ' · <a href="' + esc(card.url) + '" target="_blank" rel="noreferrer">在 TAPD 打开</a>' : '') + '</div>' +
    '<div class="' + (blocked ? 'bad' : 'ok') + '">' + (blocked ? '不能接：' + esc(blocked) : '可以接（开跑会占卡、加 afk-claimed，跑完写评论）') + '</div>'
}

/**
 * 主树停在 cherry-pick 冲突里时，顶一条横幅：冲突文件 + 「让 AI 解冲突」。
 * 表格冲突不给一键（必须人工用 xlsx-cell-diff overlay 合）。
 */
function renderConflict(s) {
  const box = el('cConflict')
  if (!box) return
  const c = s.conflict
  if (!c || !(c.files || []).length) {
    box.innerHTML = ''
    return
  }
  const xlsx = c.xlsx || []
  box.innerHTML = '<div class="card bad" style="max-width:none;margin:0 0 12px">' +
    '<div class="card-top"><span class="card-name">合入冲突</span>' +
    `<span class="badge bad">${c.files.length} 个文件</span></div>` +
    `<div class="card-body">${c.files.map(esc).join('<br>')}` +
    (xlsx.length
      ? `<br><span class="bad">表格冲突要人工用 xlsx-cell-diff 合：${xlsx.map(esc).join('、')}</span>`
      : '<br><span class="bad">自动解冲突没成功</span>（AI 解完但仍剩冲突）。可以重试或手工解') +
    '</div>' +
    '<div class="card-actions">' +
    (xlsx.length ? '' : '<button class="primary" data-resolve>让 AI 解冲突</button>') +
    '<button data-resolvecmd>复制手工命令</button></div></div>'
  box.querySelector('[data-resolve]')?.addEventListener('click', () => { resolveConflict().catch(() => {}) })
  box.querySelector('[data-resolvecmd]')?.addEventListener('click', () => {
    const cmd = 'git status && git add <冲突文件> && git cherry-pick --continue && node Tools/Worktree/collect.mjs --resume'
    try {
      navigator.clipboard.writeText(cmd)
      say('手工命令已复制', 'ok')
    } catch {
      say(cmd, 'dim')
    }
  })
}

async function resolveConflict() {
  const ok = window.confirm(
    '重试让 AI 解主树的 cherry-pick 冲突？\n\n' +
    '（正常点「合入」就会自动解，只有自动解失败时才需要点这里）\n' +
    '只允许改冲突文件；解完自动 continue → 导表 → verify → push → 回写 TAPD。'
  )
  if (!ok) return
  say('正在起 agent 解冲突…', 'dim')
  const res = await apiJson('api/stations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'resolve', workdir: form().workdir }),
  })
  if (!res.ok) say(res.data?.error || `起不来（HTTP ${res.status}）`, 'bad')
  else say(`已起 agent 解冲突（${(res.data.conflicted || []).length} 个文件），解完会自动续跑合入`, 'ok')
  await poll()
}

/**
 * 控制面板重画入口。
 *
 * 每 3 秒整块 innerHTML 重写会把用户选中的文本冲掉（DOM 节点一销毁，浏览器就丢选区），
 * 表现是「选中的字过一会儿自己取消选中」。所以交给 selectionGuard：
 * 数据没变就不画；数据变了但用户正在面板里选字，就等选区清掉再补画。
 */
const paintControlIfSafe = selectionGuard(() => el('ctl'))

function render(s) {
  paintControlIfSafe(() => paintControl(s), () => controlSignature(s))
}

/**
 * 面板的数据指纹：相同就不重画。
 * 里面的 startedAt 换成「分钟数」，这样「干活中 · 20m」这类相对时间每分钟能刷一次，
 * 又不会因为每轮轮询里 now 变了 3 秒就重画一次。
 */
function controlSignature(s) {
  const now = Number(s.now || Date.now())
  const withMinutes = (item) => ({
    ...item,
    startedAt: item.startedAt ? Math.floor((now - Number(item.startedAt)) / 60_000) : 0,
  })
  return JSON.stringify({
    t: minuteBucket(now),
    config: s.config,
    main: s.main,
    stations: (s.stations || []).map(withMinutes),
    runs: (s.runs || []).map(withMinutes),
    jobs: (s.jobs || []).map(withMinutes),
    queue: s.queue,
    board: s.board,
    autoPush: s.autoPush,
    autoMerge: s.autoMerge,
    lastMerge: s.lastMerge,
    lastBatch: s.lastBatch,
  })
}

function paintControl(s) {
  view = overlayPendingPause(s)
  serverSkew = Number(s.now || Date.now()) - Date.now()
  fill(s)
  renderSummary(s)
  renderConflict(s)
  renderStations(s)
  renderMain(s)
  renderRunning(s)
  renderQueue(s)
  renderShare(s)
  // 多工位：按「当前选中的这个工位有没有批次」决定按钮，而不是全机有没有。
  // loop 记的 workdir 是反斜杠、面板里的可能是正斜杠，直接比会把「判断不了」当成空闲。
  const runs = Array.isArray(s.runs) ? s.runs : (s.running ? [s.running] : [])
  const busyHere = runs.some((item) => samePath(item.workdir, s.config.workdir))
  if (el('cRun')) el('cRun').disabled = busyHere
  if (el('cRefRun')) el('cRefRun').disabled = busyHere || !s.config.workdir
  if (el('cQueue')) el('cQueue').disabled = !s.config.workdir
  // 停止文件只对「主树上那个多卡批次」有意义：loop.mjs 在卡与卡之间才读它，
  // 工位批次永远一张一批，写了也读不到。所以只在主树自己有批次时才能点。
  // 想让某个工位别再领卡：把它卡片上的「接活」开关取消勾选（落的是 station.paused）。
  if (el('cStop')) {
    const mainBatch = runs.find((item) => samePath(item.workdir, s.config.workdir))
    el('cStop').disabled = !mainBatch
    el('cStop').title = mainBatch
      ? '写停止标记：主树上这批跑完当前卡就不再接下一张（不杀进程）'
      : '只对主树上的多卡批次有用；工位批次是一张一批，要停工位请取消它卡片上「接活」开关的勾选'
  }
  paintCountdown()
}

function paintCountdown() {
  const box = el('cNext')
  if (!box) return
  const s = view
  if (!s) {
    hint('cNext', '')
    return
  }
  const w = s.watch
  const stations = Array.isArray(s.stations) ? s.stations : []
  const idle = stations.filter((station) => station.idle && station.usable).length
  if (!w.enabled) {
    // 关着的时候只说工位情况：那个勾选框本身就写着「没开」，不用再念一遍。
    hint('cNext', stations.length ? `空闲 ${idle}/${stations.length}` : '')
    return
  }
  if (w.draining) {
    hint('cNext', '正在查 TAPD…')
    return
  }
  const left = Number(w.nextAt || 0) - (Date.now() + serverSkew)
  const tail = (stations.length ? ` · 空闲 ${idle}/${stations.length}` : '') +
    (w.lastCheckAt ? ` · 上次 ${clockOf(w.lastCheckAt)} 可接 ${w.lastReady} 张` : '')
  const err = w.lastError ? ` · ${w.lastError}` : ''
  box.className = w.lastError ? 'ab-hint warn' : 'ab-hint dim'
  hint('cNext', (left > 0 ? `${Math.ceil(left / 1000)}s 后看一次` : '马上看') + tail + err)
}

async function poll() {
  if (boardGone) return
  const res = await apiJson('api/control')
  if (res.ok && res.data) render(res.data)
}

function scheduleSave() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => { save().catch(() => {}) }, 500)
}

async function save() {
  clearTimeout(saveTimer)
  const res = await apiJson('api/control', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(form()),
  })
  if (!res.ok) {
    say(res.data?.error || `保存失败（HTTP ${res.status}）`, 'bad')
    return null
  }
  say('设置已保存', 'ok')
  // 立刻把服务端状态拉回来：开关刚打开时，倒数标签得马上变成「下次 xx 秒」，
  // 不能等下一轮 3 秒轮询，否则看着像没生效。
  await poll()
  return res.data.config
}

async function queue(refresh) {
  const res = await apiJson(`api/queue${refresh ? '?refresh=1' : ''}`)
  if (!res.ok) {
    say(res.data?.error || `拉队列失败（HTTP ${res.status}）`, 'bad')
  } else {
    say(`就绪 ${res.data.queue?.ready?.length ?? 0} 张`, 'ok')
  }
  await poll()
}

async function run(card) {
  await save()
  const res = await apiJson('api/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...form(), card: card || '' }),
  })
  if (!res.ok) {
    say(res.data?.error || `起不来（HTTP ${res.status}）`, 'bad')
  } else {
    const where = res.data.batch?.workdir || form().workdir
    say(`已开跑${card ? `（只跑 ${card}）` : ''}：${where}`, 'ok')
  }
  await poll()
}

async function peek() {
  const ref = String(el('cRef')?.value || '').trim()
  if (!ref) {
    say('先贴一个 TAPD 链接或需求 id', 'warn')
    return
  }
  say('正在查这张卡…', 'dim')
  const res = await apiJson(`api/card-link?ref=${encodeURIComponent(ref)}&workdir=${encodeURIComponent(form().workdir)}`)
  refView = res.data?.ok ? res.data : { ok: false, error: res.data?.error || `查不到（HTTP ${res.status}）` }
  renderRef()
  say(res.ok ? '查到了，看清楚再点「接这张开跑」' : '这张卡现在接不了，原因见下', res.ok ? 'ok' : 'bad')
}

async function runRef() {
  const ref = String(el('cRef')?.value || '').trim()
  if (!ref) {
    say('先贴一个 TAPD 链接或需求 id', 'warn')
    return
  }
  await save()
  say('正在确认这张卡…', 'dim')
  const res = await apiJson('api/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...form(), ref }),
  })
  if (!res.ok) {
    // 卡本身的状态问题（已经有机器标签、状态不接）也走这里：把原因摆出来，别让人猜。
    refView = res.data?.card ? { ok: true, id: res.data.card.id || '', card: res.data.card } : refView
    renderRef()
    say(res.data?.error || `起不来（HTTP ${res.status}）`, 'bad')
  } else {
    const where = res.data.batch?.workdir || form().workdir
    say(`已开跑指定工单 ${res.data.batch?.card || ''}：${where}`, 'ok')
  }
  await poll()
}

async function stop() {
  const res = await apiJson('api/stop', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(form()),
  })
  if (!res.ok) {
    say(res.data?.error || `停止失败（HTTP ${res.status}）`, 'bad')
  } else {
    say(`已置停止标记：${res.data.file || ''}（下一张卡之前停，不杀当前卡）`, 'warn')
  }
  await poll()
}

/**
 * 停掉看板进程本身。
 *
 * 跟「本批跑完就停」不是一回事：那个只写一个停止文件给 loop.mjs 在卡与卡之间读；
 * 这个是把整个网页的后端干掉，刷新页面也回不来，要用 start-board.mjs 再起一次
 * （地址和密钥不变：密钥存在 board-key 里，端口在 board.json 里）。
 */
async function boardStop() {
  if (!window.confirm('停掉看板进程？\n\n网页会立刻失去连接，之后要跑 start-board.mjs 才会再起来。\n正在跑的批次 / 合入不受影响（它们本来就 detach 着）。')) return
  const res = await apiJson('api/board', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'stop' }),
  })
  if (!res.ok) {
    say(res.data?.error || `停不了（HTTP ${res.status}）`, 'bad')
    return
  }
  markBoardGone('看板已停。要用 start-board.mjs 再起（地址不变）。')
}

/**
 * 重启看板进程：服务端先回包、再拉起一个「等我这具尸体凉了再起」的新进程，然后自己退出。
 * 页面这边只管等它回来，回来就整页刷新（新进程的配置可能变了）。
 */
async function boardRestart() {
  if (!window.confirm('重启看板进程？\n\n端口和分享链接不变，页面会自己等它回来再刷新。\n正在跑的批次不受影响。')) return
  const res = await apiJson('api/board', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'restart' }),
  })
  if (!res.ok) {
    say(res.data?.error || `重启不了（HTTP ${res.status}）`, 'bad')
    return
  }
  markBoardGone('看板正在重启，等它回来…')
  if (await waitBoardBack(60_000)) location.reload()
  else say('重启后 60 秒还没连上：看一眼 ~/.tapd-loop/board.log，或跑 start-board.mjs --status 查。', 'bad')
}

/** 先把页面标成「后端没了」：轮询停掉、两个按钮锁住、顶部说清现在是哪一步。 */
function markBoardGone(text) {
  boardGone = true
  const meta = el('meta')
  if (meta) meta.textContent = text
  for (const id of ['cBoardStop', 'cBoardRestart']) {
    const button = el(id)
    if (!button) continue
    button.disabled = true
    button.title = text
  }
  say(text, 'warn')
}

/** 等看板回来：直接打 /healthz（不要密钥），探到就把决定权交回给调用方。 */
function waitBoardBack(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  return new Promise((done) => {
    const tick = async () => {
      try {
        const res = await fetch(`healthz?t=${Date.now()}`, { cache: 'no-store' })
        if (res.ok) {
          const data = await res.json()
          if (data?.app === 'tapd-loop') return done(true)
        }
      } catch {
        // 还在起来，下一轮再看
      }
      if (Date.now() > deadline) return done(false)
      setTimeout(tick, 700)
    }
    // 先等一拍：服务端是「回包 → 300ms 后退出 → 新进程起」，立刻探测只会打到自己
    setTimeout(tick, 900)
  })
}

/** job.kind → 人话。工位和主树共用一套。 */
const JOB_LABEL = {
  create: '建树',
  remove: '删树',
  merge: '合入',
  'merge-resume': '续合入',
  'main-push': '主树验证并推送',
  'main-verify': '主树验证',
  resolve: '解冲突',
}

async function stationAction(action, payload) {
  const res = await apiJson('api/stations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...payload, action }),
  })
  if (!res.ok) say(res.data?.error || `失败（HTTP ${res.status}）`, 'bad')
  else if (res.data?.error) say(res.data.error, 'warn')
  else if (Array.isArray(res.data?.results)) {
    const flows = res.data.results.filter((one) => one.cardId)
    say(flows.length
      ? '回写：' + flows.map((one) => `卡片 ${one.cardId}${one.status ? '→' + one.status : ''}${one.skipped ? `（${one.skipped}）` : ''}`).join('、')
      : (res.data.note || '没有可回写的提交'), flows.length ? 'ok' : 'warn')
  }
  else if (res.data?.job) say(`已开始：${JOB_LABEL[res.data.job.kind] || res.data.job.kind} ${res.data.job.name || ''}（几分钟；卡片上的「看日志」就地打开）`, 'ok')
  else say('已更新', 'ok')
  await poll()
}

async function runStation(station) {
  if (!station) return
  const res = await apiJson('api/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...form(), workdir: station.path, card: '' }),
  })
  if (!res.ok) say(res.data?.error || `起不来（HTTP ${res.status}）`, 'bad')
  else say(`已开跑：${station.name}`, 'ok')
  await poll()
}

/**
 * 接活开关 = 把「调度器派不派卡给它」落成一个持久标记（存进 stations 表）。
 *
 * 不是写停止文件：那个文件只在 loop.mjs 的卡与卡之间被读一次，而看板派卡是
 * 一张一批（--card 强制 maxTasks=1），所以永远不会被读到——旧版那个按钮等于没点。
 */
async function pauseStation(station, paused) {
  if (!station) return
  const was = Boolean(station.paused)
  // 乐观更新：先画成新状态再发请求。等 1 秒多才变会让人觉得「点了没反应」（以前确实如此）。
  applyPaused(station.name, paused)
  const res = await apiJson('api/stations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'pause', name: station.name, paused }),
  })
  if (!res.ok) {
    applyPaused(station.name, was)
    say(`接活开关没生效（HTTP ${res.status}）：${res.data?.error || '服务端拒绝'}`, 'bad')
    return
  }
  say(paused
    ? `${station.name} 已停止接活：不会再派新卡给它${station.busy || !station.idle ? '（手上那张会跑完）' : ''}`
    : `${station.name} 已接活：空闲时会重新领卡`, paused ? 'warn' : 'ok')
  // 不在这里 await poll()：那一趟要 1~1.5 秒（它会把所有工位重探一遍），
  // 而 3 秒定时轮询本来就会把真实状态拉回来。
}

async function removeStation(station) {
  if (!station) return
  const ok = window.confirm(`真的删掉工位「${station.name}」？\n\n会 git worktree remove + 删目录。有未合入提交时服务端会拒。`)
  if (!ok) return
  await stationAction('remove', { name: station.name, workdir: form().workdir, confirm: true })
}

async function toggleAuto() {
  const next = !Boolean(view?.config?.watch?.enabled)
  if (el('cWatch')) el('cWatch').checked = next
  clearTimeout(saveTimer)
  const res = await apiJson('api/control', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(form()),
  })
  if (!res.ok) say(res.data?.error || `没保存上（HTTP ${res.status}）`, 'bad')
  else say(next ? '自动接单已开：有空位就会自己接活' : '自动接单已关（在跑的不受影响）', next ? 'ok' : 'warn')
  await poll()
}

async function openUnity(station) {
  if (!station) return
  unityPending.set(station.name, Date.now())
  say(`正在打开 ${station.name} 的 Unity…（首次约 4.5 分钟，好了卡片会自己变空闲）`, 'dim')
  const res = await apiJson('api/unity', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: station.name }),
  })
  if (!res.ok) {
    unityPending.delete(station.name)
    say(res.data?.error || `打不开（HTTP ${res.status}）`, 'bad')
  } else {
    say(`已启动 ${station.name} 的 Unity（pid ${res.data.pid}）· 首次约 4.5 分钟`, 'ok')
  }
  await poll()
}

async function mergeStation(station) {
  if (!station) return
  const ok = window.confirm(
    `把 ${station.name} 的 ${station.pending} 个提交合入主树？\n\n` +
    '会跑：cherry-pick → 导表 → verify → push develop。\n' +
    '冲突会停在那里等人处理（表格冲突要手合）。\n\n' +
    '合入成功后会自动给对应卡片评论并改状态。'
  )
  if (!ok) return
  const res = await apiJson('api/stations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'merge', name: station.name, workdir: form().workdir }),
  })
  if (!res.ok) say(res.data?.error || `合入起不来（HTTP ${res.status}）`, 'bad')
  else if (res.data?.pending === 0) say(res.data.note || '没有未合入提交', 'dim')
  else say(`已开始合入 ${station.name}（几分钟；卡片上的「看日志」就地打开）`, 'ok')
  await poll()
}

async function cleanStation(station) {
  if (!station) return
  const ok = window.confirm(
    `丢掉 ${station.name} 上未提交的改动？\n\n` +
    '只会丢【已跟踪文件】的改动，未跟踪文件不动。\n' +
    '如果是 Unity 第一次打开产生的生成物，清掉是安全的。'
  )
  if (!ok) return
  const res = await apiJson('api/stations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'clean', name: station.name, confirm: true }),
  })
  if (!res.ok) say(res.data?.error || `清理失败（HTTP ${res.status}）`, 'bad')
  else if (!res.data.cleaned) say('本来就没改动', 'dim')
  else say(`已清理 ${res.data.cleaned} 个改动${res.data.left ? `，还剩 ${res.data.left} 个` : ''}`, 'ok')
  await poll()
}

async function probeStation(station) {
  if (!station) return
  say(`正在连 ${station.name} 的 Unity 端点…`, 'dim')
  const res = await apiJson('api/unity', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'probe', name: station.name }),
  })
  if (res.ok) say(`${station.name} 的 Unity 就绪：端口 ${res.data.port} · pid ${res.data.pid}`, 'ok')
  else say(`${station.name}：${res.data?.error || '连不上'}`, 'bad')
  await poll()
}

async function dispatchNow() {
  say('派一轮…', 'dim')
  const res = await apiJson('api/dispatch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  })
  const tick = res.data?.tick || {}
  const started = Array.isArray(tick.started) ? tick.started : []
  const failed = started.filter((item) => item.ok === false)
  const assignee = String(tick.assignee || '').trim()

  if (!res.ok) say(res.data?.error || `派单失败（HTTP ${res.status}）`, 'bad')
  else if (tick.skipped) {
    say(`没派：${tick.skipped === 'no-idle' ? '没有空闲工位' : tick.skipped === 'no-station' ? '还没登记工位' : tick.skipped}`
      + (res.data?.watch?.lastError ? ` · ${res.data.watch.lastError}` : ''), 'warn')
  } else if (failed.length) {
    // 以前这里只数 started.length，失败也报「派出 1 张」——看着派了，实际什么都没跑。
    say(`派单失败：${failed.map((item) => `${item.station} ← ${item.error || '起不来'}`).join('；')}`, 'bad')
  } else if (!started.length) {
    const hint = (tick.ready ?? 0) === 0 && assignee ? `（当前处理人「${assignee}」下没有就绪卡，处理人写错了？）` : ''
    say(`没派：就绪 ${tick.ready ?? 0} 张 · 空闲 ${tick.idle ?? 0} 个${hint}`, 'warn')
  } else {
    say(`已派 ${started.length} 张：${started.map((item) => `${item.station} ← ${item.card}`).join('，')}`, 'ok')
    // 批次可能几秒就以 empty-queue / blocked 退出（处理人写错、卡片状态被改、工作区脏）。
    // 派完立刻看一次：工位上没有批次在跑，就把原因和日志摆出来，别让人对着"已派"发呆。
    watchDispatchSettled(started)
  }
  await poll()
}

/** 派单后 5 秒复查：该工位没跑起来就说是为什么（日志路径由服务端带回来）。 */
function watchDispatchSettled(started) {
  const stations = started.map((item) => item.station).filter(Boolean)
  setTimeout(async () => {
    try {
      const res = await apiJson('api/control')
      if (!res.ok) return
      const runs = Array.isArray(res.data?.runs) ? res.data.runs : []
      const running = new Set(runs.map((run) => String(run.workdir || '').toLowerCase()))
      const viewStations = Array.isArray(res.data?.stations) ? res.data.stations : []
      for (const item of started) {
        const station = viewStations.find((s) => s.name === item.station)
        if (!station) continue
        if (running.has(String(station.path || '').toLowerCase())) continue
        const tail = item.log ? `日志：${item.log}` : ''
        say(`${item.station} 没跑起来（批次已退出，多半是 empty-queue / blocked）。${tail}`, 'bad')
      }
    } catch {
      // 复查失败就算了：主提示已经报过「已派」
    }
  }, 5000)
}

export function mountControl() {
  if (started || !el('ctl')) return
  started = true

  el('cWorkdir')?.addEventListener('change', () => {
    const value = el('cWorkdir').value
    if (!value) return
    el('cWorkdirText').value = value
    save().catch(() => {})
  })
  for (const field of ['cWorkdirText', 'cAssignee', 'cMaxTasks', 'cAllowDirty', 'cNoWrite', 'cWatch', 'cPollSec', 'cAutoPush', 'cAutoPushSec', 'cAutoMerge', 'cAutoMergeSec']) {
    el(field)?.addEventListener('input', () => scheduleSave())
    el(field)?.addEventListener('change', () => scheduleSave())
  }
  // 勾完立刻亮/暗，不等到下一轮 poll（保存有 500ms 防抖，等回来会显得没反应）。
  for (const id of ['cWatch', 'cAutoPush', 'cAutoMerge']) {
    el(id)?.addEventListener('change', () => {
      const box = el(id)
      box?.closest?.('.seg')?.classList?.toggle('on', Boolean(box.checked))
    })
  }
  el('cRun')?.addEventListener('click', () => { run('').catch(() => {}) })
  el('cRefPeek')?.addEventListener('click', () => { peek().catch(() => {}) })
  el('cRefRun')?.addEventListener('click', () => { runRef().catch(() => {}) })
  el('cRef')?.addEventListener('input', () => {
    // 改了链接就把上一张的预览作废，免得对着旧结果点开跑。
    if (refView) {
      refView = null
      renderRef()
    }
  })
  el('cRef')?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    peek().catch(() => {})
  })
  el('cQueue')?.addEventListener('click', () => { queue(true).catch(() => {}) })
  el('cStop')?.addEventListener('click', () => { stop().catch(() => {}) })
  // 这两个动的是看板进程本身，不是 loop 批次：走 /api/board（serve.mjs 里自己实现）。
  el('cBoardStop')?.addEventListener('click', () => { boardStop().catch(() => {}) })
  el('cBoardRestart')?.addEventListener('click', () => { boardRestart().catch(() => {}) })
  el('cAuto')?.addEventListener('click', () => { toggleAuto().catch(() => {}) })
  el('cPickOne')?.addEventListener('click', () => { dispatchNow().catch(() => {}) })
  el('cStationCreate')?.addEventListener('click', () => {
    const name = String(el('cStationName')?.value || '').trim()
    if (!name) {
      say('工位名要填：1~24 位字母数字/下划线/短横线', 'warn')
      return
    }
    stationAction('create', { name, workdir: form().workdir }).catch(() => {})
  })
  el('cStationRegister')?.addEventListener('click', () => {
    const name = String(el('cStationName')?.value || '').trim()
    const path = String(el('cStationPath')?.value || '').trim()
    if (!name || !path) {
      say('登记已有工位要同时填名字和绝对路径', 'warn')
      return
    }
    stationAction('register', { name, path }).catch(() => {})
  })

  poll().catch(() => {})
  setInterval(() => { poll().catch(() => {}) }, 3000)
  setInterval(paintCountdown, 1000)
}
