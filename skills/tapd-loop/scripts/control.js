/**
 * 看板顶上的控制面板：选仓库、按一下跑、按一下停、定时接单开关。
 *
 * 面板只做三件事：把表单变成一次 POST、把服务端状态画出来、把「下一次什么时候查」
 * 倒数出来。取卡/占卡/判定/回写全在 loop.mjs，这里一个字都不重复实现。
 */

import { apiJson } from '/auth.js'

const el = (id) => document.getElementById(id)

let view = null
let refView = null
let serverSkew = 0
let msg = { text: '', cls: 'dim' }
let saveTimer = 0
let started = false

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
  box.innerHTML = runs.map((running) => {
    const elapsed = Date.now() + serverSkew - Number(running.startedAt || Date.now())
    const where = running.runId || `pid ${running.pid}`
    return '<div><span class="state-run">▶ 正在跑</span> · ' + esc(running.workdir || '') +
      ' · ' + esc(where) + ' · 已跑 ' + esc(dur(elapsed)) + '</div>'
  }).join('')
}

/**
 * 工位面板：每个工位一行（名字 / 路径 / 分支 / 状态 / 开跑·停·删），上面一行是调度器状态。
 * 没登记工位时退化成单工位提示，行为跟以前一样。
 */
function renderStations(s) {
  const box = el('cStations')
  if (!box) return
  const stations = Array.isArray(s.stations) ? s.stations : []
  const jobs = (Array.isArray(s.jobs) ? s.jobs : []).filter((job) => job.status === 'running' || job.alive)
  const idle = stations.filter((station) => station.idle && station.usable).length
  const watching = Boolean(s.config?.watch?.enabled)

  const head = stations.length
    ? '<div class="shead">' +
      `<span class="ok">空闲 ${idle}/${stations.length}</span>` +
      (watching
        ? `<span class="dim">调度器开着 · 每 ${esc(String(s.config.watch.pollSec))}s 派一轮</span>`
        : '<span class="dim">调度器关着</span>') +
      '<button id="sDispatch">' + (watching ? '立刻派一轮' : '派一轮') + '</button>' +
      '</div>'
    : '<div class="shead dim">还没登记工位：下面建一个或登记已有 worktree。没登记时按「工作目录」单工位跑。</div>'

  const rows = stations.map((station) => {
    const state = !station.exists ? '<span class="bad">目录不在</span>'
      : !station.isRepo ? '<span class="bad">不是 git 仓库</span>'
        : station.dirty ? '<span class="warn">工作区脏</span>'
          : station.card ? `<span class="state-run">▶ ${esc(station.card)}</span>`
            : '<span class="ok">空闲</span>'
    const behind = station.behind ? ` <span class="warn">落后 ${esc(String(station.behind))}</span>` : ''
    return '<div class="srow">' +
      `<span class="sname">${esc(station.name)}</span>` +
      `<span class="spath" title="${esc(station.path)}">${esc(station.path)}</span>` +
      `<span class="dim">${esc(station.branch || '—')}</span>` +
      `<span>${state}${behind}</span>` +
      '<span class="sact">' +
      `<button data-srun="${esc(station.name)}"${station.idle && station.usable ? '' : ' disabled'}>开跑</button>` +
      `<button data-sstop="${esc(station.name)}"${station.card ? '' : ' disabled'}>停</button>` +
      `<button data-sdel="${esc(station.name)}"${station.idle ? '' : ' disabled'}>删</button>` +
      '</span></div>'
  }).join('')

  const jobRows = jobs.map((job) =>
    `<div class="sjob">${job.kind === 'create' ? '建树' : '删树'} ${esc(job.name)} · ${esc(job.status || '')}` +
    `${job.log ? ' · 日志 ' + esc(job.log) : ''}</div>`).join('')

  box.innerHTML = head + (rows ? `<div class="slist">${rows}</div>` : '') + jobRows

  // innerHTML 重建会丢监听器，所以每次都重新挂。
  const find = (name) => stations.find((station) => station.name === name)
  el('sDispatch')?.addEventListener('click', () => { dispatchNow().catch(() => {}) })
  for (const btn of box.querySelectorAll('button[data-srun]')) {
    btn.onclick = () => { runStation(find(btn.getAttribute('data-srun'))).catch(() => {}) }
  }
  for (const btn of box.querySelectorAll('button[data-sstop]')) {
    btn.onclick = () => { stopStation(find(btn.getAttribute('data-sstop'))).catch(() => {}) }
  }
  for (const btn of box.querySelectorAll('button[data-sdel]')) {
    btn.onclick = () => { removeStation(find(btn.getAttribute('data-sdel'))).catch(() => {}) }
  }
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
    ? `<span class="ok">就绪 ${q.ready.length} 张</span> · 被状态挡住 ${q.rejected.length} 张 · 查于 ${esc(clockOf(q.at))}` +
      (q.allowedStatuses?.length ? ` · 允许接单状态 ${esc(q.allowedStatuses.join(', '))}` : '')
    : `<span class="bad">拉队列失败</span> · ${esc(q.error)}`
  const rows = q.ok
    ? q.ready.map((card) => '<div class="qrow"><span class="qid">' + esc(card.id) + '</span>' +
      '<span class="qtitle" title="' + esc(card.title) + '">' + esc(card.title) + '</span>' +
      '<span class="dim">' + esc(card.statusLabel || '') + (card.priorityLabel ? ' · ' + esc(card.priorityLabel) : '') + '</span>' +
      '<button data-card="' + esc(card.id) + '">只跑这张</button></div>').join('')
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
    '<button id="cShareCopy">复制</button>' +
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

function render(s) {
  view = s
  serverSkew = Number(s.now || Date.now()) - Date.now()
  fill(s)
  renderStations(s)
  renderRunning(s)
  renderQueue(s)
  renderShare(s)
  // 多工位：按「当前选中的这个工位有没有批次」决定按钮，而不是全机有没有。
  const runs = Array.isArray(s.runs) ? s.runs : (s.running ? [s.running] : [])
  const busyHere = runs.some((item) => item.workdir === s.config.workdir)
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
    box.textContent = stations.length ? `调度器关着 · 空闲 ${idle}/${stations.length}` : '定时接单已关'
    return
  }
  if (w.draining) {
    box.textContent = '正在查 TAPD…'
    return
  }
  const left = Number(w.nextAt || 0) - (Date.now() + serverSkew)
  const tail = (stations.length ? ` · 空闲 ${idle}/${stations.length}` : '') +
    (w.lastCheckAt ? ` · 上次 ${clockOf(w.lastCheckAt)} 就绪 ${w.lastReady} 张` : '')
  const err = w.lastError ? ` · 上次：${w.lastError}` : ''
  box.className = w.lastError ? 'warn' : 'dim'
  box.textContent = (left > 0 ? `下次 ${Math.ceil(left / 1000)}s 后派` : '马上派') + tail + err
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

async function stationAction(action, payload) {
  const res = await apiJson('api/stations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...payload, action }),
  })
  if (!res.ok) say(res.data?.error || `失败（HTTP ${res.status}）`, 'bad')
  else if (res.data?.job) say(`已开始：${res.data.job.kind === 'create' ? '建树' : '删树'} ${res.data.job.name}（几分钟，日志 ${res.data.job.log || ''}）`, 'ok')
  else say('工位表已更新', 'ok')
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
  const ok = window.confirm(`真的删掉工位「${station.name}」？\n\n${station.path}\n\n会 git worktree remove + 删目录。有未合入提交时服务端会拒。`)
  if (!ok) return
  await stationAction('remove', { name: station.name, workdir: form().workdir, confirm: true })
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
  for (const field of ['cWorkdirText', 'cAssignee', 'cMaxTasks', 'cAllowDirty', 'cNoWrite', 'cWatch', 'cPollSec']) {
    el(field)?.addEventListener('input', () => scheduleSave())
    el(field)?.addEventListener('change', () => scheduleSave())
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
