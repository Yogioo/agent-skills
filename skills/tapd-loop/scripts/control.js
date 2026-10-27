/**
 * 看板顶上的控制面板：选仓库、按一下跑、按一下停、定时接单开关。
 *
 * 面板只做三件事：把表单变成一次 POST、把服务端状态画出来、把「下一次什么时候查」
 * 倒数出来。取卡/占卡/判定/回写全在 loop.mjs，这里一个字都不重复实现。
 */

import { apiJson } from '/auth.js'
import { openFile } from '/fileview.js'

const el = (id) => document.getElementById(id)

let view = null
let refView = null
let serverSkew = 0
let msg = { text: '', cls: 'dim' }
let saveTimer = 0
let started = false

/** 点过「打开 Unity」的工位：启动要几分钟，这期间卡片显示「正在启动」（本地状态，刷新即丢）。 */
const unityPending = new Map()

function editing() {
  const box = el('ctl')
  return Boolean(box && document.activeElement && box.contains(document.activeElement))
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

function say(text, cls = 'dim') {
  msg = { text, cls }
  paintMsg()
}

function paintMsg() {
  const box = el('cMsg')
  if (!box) return
  box.className = msg.cls
  box.textContent = msg.text
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
    el('cAutoPushHint').textContent = !auto.enabled ? ''
      : auto.fails > 0 ? `连续失败 ${auto.fails} 次${auto.nextAt > Date.now() ? `，${Math.ceil((auto.nextAt - Date.now()) / 60000)} 分钟后重试` : ''}`
        : auto.lastResult ? `上次：${auto.lastResult}` : '等着主树攒出没推的提交'
  }
  if (el('cAutoMerge')) el('cAutoMerge').checked = Boolean(config.autoMerge?.enabled)
  if (el('cAutoMergeSec')) el('cAutoMergeSec').value = String(config.autoMerge?.pollSec ?? 120)
  if (el('cAutoMergeHint')) {
    const auto = s.autoMerge || {}
    const now = Date.now()
    // 退避是按工位记的：只把「还没到时间」的那几棵报出来，人能看出是卡在哪一棵上。
    const cooling = (auto.stations || []).filter((one) => Number(one.nextAt) > now)
    el('cAutoMergeHint').textContent = !auto.enabled ? ''
      : cooling.length
        ? cooling.map((one) => `${one.name}：${Math.ceil((Number(one.nextAt) - now) / 60000)} 分钟后再试`).join(' · ')
        : auto.lastResult ? `上次：${auto.lastResult}` : '等着工位攒出待合入的提交'
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
  const job = jobs.find((item) => item.status === 'running' || item.status === 'unknown')
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
      (showFail?.log ? btn(`data-mlog="${esc(showFail.log)}"`, '看日志', TIP.mlog) : '')

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
    .filter((job) => job.status === 'running' || job.status === 'unknown')

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
    const badge = running ? `<span class="badge run">干活中 · ${esc(dur(elapsed))}</span>`
      : trouble ? '<span class="badge bad">需要处理</span>'
        : booting ? '<span class="badge run">Unity 启动中</span>'
          : '<span class="badge ok">空闲</span>'
    // 在跑就先报在跑：批次跑卡时工作区必然是脏的，不能因此画成「需要处理 / 清理改动」——
    // 那等于请人点一个会把 agent 活干掉的按钮。
    // 在跑就先把运行状态报出来：卡片名优先用标题，19 位 id 在人眼里跟随机数一样。
    const cardLabel = running ? (station.cardTitle || station.card || '') : ''
    const body = running
      ? (cardLabel
        ? `<span class="t">${esc(cardLabel)}</span><br>跑完自动回到空闲`
        : '正在接单，还没分到卡片<br>跑完自动回到空闲')
      : trouble
        ? (unityOff ? '验证要连本树的 Unity，现在没开<br>点下面的按钮打开它'
          : `${esc(trouble)}` + (station.behind ? ` · 落后 ${esc(String(station.behind))}` : '') + '<br>清一下就能接着干')
        : booting
          ? '首次导入约 4.5 分钟。超过 10 分钟还这样，点「检查端点」看看是不是没带控制开关'
          : (Number(station.pending) > 0
            ? `有 ${esc(String(station.pending))} 个提交待合入主树`
            : (station.behind ? `落后最新 ${esc(String(station.behind))} 个提交，开工前会自动更新` : '可以接活'))
    const STIP = {
      srun: '在这个工位上开一批：自动从 TAPD 拉一张标了 ready-for-agent 的卡，跑完自动回写。',
      smerge: `把这个工位分支上 ${station.pending} 个未合入提交 cherry-pick 进主树，然后导表 → 验证门 → 推送 → 回写 TAPD。冲突会停下来等人（表格冲突必须手合）。`,
      sdel: '删掉这棵 worktree。还有未合入提交、或有批次在跑时会被拦住。',
      sstop: '只停这个工位：不再给它派新卡，正在跑的那张跑完再停（不杀进程）。',
      sunity: '用 -unityPuerExecControl 启动这个工位的 Unity Editor（验证门要连它，首次导入约 4.5 分钟）。',
      sprobe: 'ping 一次这个工位的 Unity 控制端点（/health），区分「文件在但连不上」和真在线。',
      sclean: 'git restore 掉这个工位里没提交的改动（未跟踪文件不动）。',
    }
    const actions = running
      ? `<button data-sstop="${esc(station.name)}" title="${esc(STIP.sstop)}">跑完这张就停</button>`
      : trouble
        ? (unityOff
          ? `<button class="primary" data-sunity="${esc(station.name)}" title="${esc(STIP.sunity)}">打开 Unity</button>` +
            `<button data-sdel="${esc(station.name)}" title="${esc(STIP.sdel)}"${station.idle ? '' : ' disabled'}>删掉</button>`
          : station.dirty
            ? `<button class="primary" data-sclean="${esc(station.name)}" title="${esc(STIP.sclean)}">清理改动</button>` +
              `<button data-sdel="${esc(station.name)}" title="${esc(STIP.sdel)}"${station.idle ? '' : ' disabled'}>删掉</button>`
            : `<button data-sdel="${esc(station.name)}" title="${esc(STIP.sdel)}"${station.idle ? '' : ' disabled'}>删掉这个工位</button>`)
        : booting
          ? `<button data-sprobe="${esc(station.name)}" title="${esc(STIP.sprobe)}">检查端点</button>`
          : (Number(station.pending) > 0
            ? `<button class="primary" data-smerge="${esc(station.name)}" title="${esc(STIP.smerge)}">合入 ${esc(String(station.pending))}</button>` +
              `<button data-srun="${esc(station.name)}" title="${esc(STIP.srun)}">接一单</button>` +
              `<button data-sdel="${esc(station.name)}" title="${esc(STIP.sdel)}">删掉</button>`
            : `<button class="primary" data-srun="${esc(station.name)}" title="${esc(STIP.srun)}">接一单</button>` +
              `<button data-sdel="${esc(station.name)}" title="${esc(STIP.sdel)}">删掉</button>`)
    // 框颜色：在跑优先。在跑的时候工作区必然是脏的（agent 正在改文件），trouble 里那条
    // 「有没提交的改动」不是问题，不能因此把框画成红的——那会让人以为工位坏了。
    const tone = running ? 'run' : trouble ? 'bad' : ''
    // 悬停只给卡片号：开发机是黑箱，本机绝对路径对远程看板的人没有意义。
    const hover = station.card ? `卡片 ${station.card}` : ''
    return `<div class="card ${tone}" title="${esc(hover)}">` +
      `<div class="card-top"><span class="card-name">${esc(station.name)}</span>${badge}</div>` +
      `<div class="card-body">${body}</div>` +
      `<div class="card-actions">${actions}</div>` +
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
  for (const btn of box.querySelectorAll('button[data-sstop]')) {
    btn.onclick = () => { stopStation(find(btn.getAttribute('data-sstop'))).catch(() => {}) }
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
  const trouble = stations.filter((station) => !station.usable && !station.busy && !station.card).length
  const idle = stations.length - running - trouble
  const parts = [`<b>${stations.length}</b> 个工位`]
  if (idle) parts.push(`<span class="ok">${idle} 空闲</span>`)
  if (running) parts.push(`<span class="state-run">${running} 干活中</span>`)
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

function render(s) {
  view = s
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
  if (el('cStop')) el('cStop').disabled = !runs.length
  paintCountdown()
  paintMsg()
}

function paintCountdown() {
  const box = el('cNext')
  if (!box) return
  const s = view
  if (!s) {
    box.textContent = ''
    return
  }
  const w = s.watch
  const stations = Array.isArray(s.stations) ? s.stations : []
  const idle = stations.filter((station) => station.idle && station.usable).length
  if (!w.enabled) {
    // 关着的时候只说工位情况：那个勾选框本身就写着「没开」，不用再念一遍。
    box.textContent = stations.length ? `空闲 ${idle}/${stations.length}` : ''
    return
  }
  if (w.draining) {
    box.textContent = '正在查 TAPD…'
    return
  }
  const left = Number(w.nextAt || 0) - (Date.now() + serverSkew)
  const tail = (stations.length ? ` · 空闲 ${idle}/${stations.length}` : '') +
    (w.lastCheckAt ? ` · 上次 ${clockOf(w.lastCheckAt)} 可接 ${w.lastReady} 张` : '')
  const err = w.lastError ? ` · ${w.lastError}` : ''
  box.className = w.lastError ? 'ab-hint warn' : 'ab-hint dim'
  box.textContent = (left > 0 ? `${Math.ceil(left / 1000)}s 后看一次` : '马上看') + tail + err
}

async function poll() {
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

async function stopStation(station) {
  if (!station) return
  const res = await apiJson('api/stop', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workdir: station.path }),
  })
  if (!res.ok) say(res.data?.error || `停止失败（HTTP ${res.status}）`, 'bad')
  else say(`已给 ${station.name} 置停止标记（下一张卡之前停）`, 'warn')
  await poll()
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
  if (!res.ok) say(res.data?.error || `派单失败（HTTP ${res.status}）`, 'bad')
  else if (tick.skipped) say(`没派：${tick.skipped === 'no-idle' ? '没有空闲工位' : tick.skipped === 'no-station' ? '还没登记工位' : tick.skipped}` + (res.data?.watch?.lastError ? ` · ${res.data.watch.lastError}` : ''), 'warn')
  else say(`就绪 ${tick.ready ?? 0} 张 · 空闲 ${tick.idle ?? 0} · 派出 ${(tick.started || []).length} 张`, 'ok')
  await poll()
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
