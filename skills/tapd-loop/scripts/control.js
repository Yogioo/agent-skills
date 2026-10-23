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
  const running = s.running
  if (!running) {
    box.innerHTML = ''
    box.className = ''
    return
  }
  const elapsed = Date.now() + serverSkew - Number(running.startedAt || Date.now())
  const where = running.runId || `pid ${running.pid}`
  box.className = 'runline'
  box.innerHTML = '<span class="state-run">▶ 正在跑</span> · ' + esc(where) + ' · ' + esc(running.workdir || '') +
    ' · 已跑 ' + esc(dur(elapsed)) + ' · 点「停止」会在下一张卡之前停下'
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
  renderRunning(s)
  renderQueue(s)
  renderShare(s)
  const running = Boolean(s.running)
  if (el('cRun')) el('cRun').disabled = running
  if (el('cRefRun')) el('cRefRun').disabled = running || !s.config.workdir
  if (el('cQueue')) el('cQueue').disabled = !s.config.workdir
  if (el('cStop')) el('cStop').disabled = !(s.running?.workdir || s.config.workdir)
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
  if (!w.enabled) {
    box.textContent = '定时接单已关'
    return
  }
  if (s.running) {
    box.textContent = '有一批在跑，跑完再查'
    return
  }
  if (w.draining) {
    box.textContent = '正在查 TAPD…'
    return
  }
  const left = Number(w.nextAt || 0) - (Date.now() + serverSkew)
  const tail = w.lastCheckAt ? ` · 上次 ${clockOf(w.lastCheckAt)} 查到 ${w.lastReady} 张` : ''
  const err = w.lastError ? ` · 上次出错：${w.lastError}` : ''
  box.className = w.lastError ? 'warn' : 'dim'
  box.textContent = (left > 0 ? `下次 ${Math.ceil(left / 1000)}s 后查` : '马上查') + tail + err
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

  poll().catch(() => {})
  setInterval(() => { poll().catch(() => {}) }, 3000)
  setInterval(paintCountdown, 1000)
}
