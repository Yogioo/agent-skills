/** tapd-loop 看板页面。只放这张页面自己的状态、深链和弹窗栈；渲染积木来自 /assets/client.mjs。 */

import {
  diffHtml, dur, esc, loadJson, md, paneHtml, rel, saveJson,
  timelineHtml, wireModal, wirePanes, wireTimeline,
} from '/assets/client.mjs'
import { apiFetch, withKey } from '/auth.js'
import { minuteBucket, selectionGuard } from '/dom-guard.js'
import { mountControl } from '/control.js'

const rowsEl = document.getElementById('rows')
const meta = document.getElementById('meta')

let stack = []
let cardSig = null
let armSig = null

const paintModalIfSafe = selectionGuard(() => document.getElementById('modal'))

const state = { runs: [], selected: null }

let deep = null
try {
  const q = new URLSearchParams(location.search)
  if (q.get('run') && q.get('id')) deep = { runId: q.get('run'), cardId: q.get('id') }
} catch {}
// 深链只消费一次：这次打开后就把参数从 URL 抹掉，刷新一轮就回到列表。
// （否则关了卡片刷新又弹回来——旧版 openCard 会把 run/id 写进 URL，关掉也不清。）
if (deep) {
  try { history.replaceState(null, '', location.pathname) } catch {}
}

const savedView = loadJson('tapd-loop-view', null)
let view = savedView && typeof savedView.days === 'number' ? savedView : { days: 0, onlyAlive: false }
const saveView = () => saveJson('tapd-loop-view', view)

const paneState = loadJson('tapd-loop-panes', {})
const savePaneState = () => saveJson('tapd-loop-panes', paneState)

// 旧版把 diff 模式存成裸字符串，别改成 JSON，否则已经存下的 'dual' 读不出来。
let diffMode = 'single'
try { diffMode = localStorage.getItem('tapd-loop-diff') || 'single' } catch {}
function saveDiffMode() {
  try { localStorage.setItem('tapd-loop-diff', diffMode) } catch {}
}

let currentDiff = ''
let autoscroll = true

const PHASE = { claim: '占住卡片', fetch: '抓取工单与图片', fetched: '已抓取', running: '内循环运行中', timeout: '超时' }
const STATUS = {
  running: ['▶', '运行中', 'state-run'],
  done: ['●', '完成', 'ok'],
  failed: ['✕', '失败', 'bad'],
  pending: ['⏸', '等环境/等人', 'warn'],
  interrupted: ['⊘', '已中断', 'warn'],
  preview: ['◐', '预览', 'warn'],
  blocked: ['⊘', '状态挡住', 'dim'],
  queued: ['○', '排队', 'dim'],
  skipped: ['⊘', '跳过', 'dim'],
}

function st(s) {
  const hit = STATUS[s] || ['·', s || '未知', 'dim']
  return `<span class="${hit[2]}">${hit[0]} ${esc(hit[1])}</span>`
}

function what(c) {
  if (c.status === 'running') return PHASE[c.phase] || '运行中'
  return c.note || PHASE[c.phase] || '—'
}

function elapsed(c) {
  if (!c.startedAt) return ''
  return dur((c.endedAt || Date.now()) - c.startedAt)
}

function visible(run) {
  const t = run.startedAt || 0
  if (view.days > 0 && Date.now() - t > view.days * 86400000) return false
  if (view.onlyAlive && !run.alive) return false
  if (!run.cards.length && !run.alive) return false
  return true
}

function pick() {
  const runs = state.runs.filter(visible)
  for (const run of runs) {
    for (const card of run.cards) {
      if (card.status === 'running') return { run, card }
    }
  }
  if (!runs.length) return null
  const first = runs[0]
  return first.cards.length ? { run: first, card: first.cards[0] } : { run: first, card: null }
}

const paintRowsIfSafe = selectionGuard(() => rowsEl)

/** 运行列表的数据指纹：相同就不重画（每 2 秒重建 tbody 会把选中的文本冲掉）。 */
function rowsSignature() {
  return JSON.stringify({
    t: minuteBucket(),
    days: view.days,
    onlyAlive: view.onlyAlive,
    selected: state.selected,
    runs: state.runs,
  })
}

function render() {
  paintRowsIfSafe(paintRows, rowsSignature)
}

function paintRows() {
  const runs = state.runs.filter(visible)
  rowsEl.innerHTML = ''
  if (deep) state.selected = deep
  const current = pick()
  const exists = state.selected && state.runs.some((run) => run.runId === state.selected.runId && run.cards.some((card) => card.id === state.selected.cardId))
  if (!exists) state.selected = current ? { runId: current.run.runId, cardId: current.card ? current.card.id : null } : null
  if (!runs.length) {
    rowsEl.innerHTML = '<tr><td colspan="4" class="dim" style="padding:18px 10px">还没有 run。跑一次 loop 就有了。</td></tr>'
    meta.textContent = '没有数据'
    return
  }
  let total = 0
  for (const run of runs) {
    const head = document.createElement('tr')
    head.className = 'faded'
    head.innerHTML = '<td colspan="4" style="padding-top:14px;color:#8b949e">' +
      esc(run.runId) + ' · ' + esc(run.alive ? '运行中' : run.reason || '已结束') + ' · ' + esc(rel(run.startedAt)) + '</td>'
    rowsEl.appendChild(head)
    for (const card of run.cards) {
      total++
      const tr = document.createElement('tr')
      const selected = state.selected && state.selected.runId === run.runId && state.selected.cardId === card.id
      tr.className = 'card' + (selected ? ' sel' : '') + (card.status === 'blocked' || card.status === 'skipped' ? ' faded' : '')
      tr.innerHTML = '<td><div class="what" title="' + esc(card.title) + '">' + esc(card.title || card.id) + '</div>' +
        '<div class="dim" style="font-size:11px">' + esc(card.id) + (card.priorityLabel ? ' · ' + esc(card.priorityLabel) : '') + (card.commit ? ' · ' + esc(card.commit) : '') + '</div></td>' +
        '<td><div class="what">' + esc(what(card)) + '</div><div class="dim" style="font-size:11px">' + esc(rel(card.endedAt || card.startedAt)) + '</div></td>' +
        '<td>' + esc(elapsed(card)) + '</td><td>' + st(card.status) + '</td>'
      tr.onclick = () => openCard(run.runId, card.id)
      rowsEl.appendChild(tr)
    }
  }
  const alive = state.runs.filter((run) => run.alive).length
  meta.textContent = (view.days > 0 ? `近 ${view.days} 天` : '全部') + ' · ' + runs.length + ' 个 run · ' + total + ' 张卡' +
    (alive ? `（${alive} 个运行中）` : '') + ' · 每 2 秒刷新'
}

function tlList(events) {
  return timelineHtml(events, { base: events.length ? events[0].t : 0, images: true })
}

function wireDiff(root) {
  for (const btn of root.querySelectorAll('.diffbar button')) {
    btn.onclick = () => {
      diffMode = btn.getAttribute('data-mode')
      saveDiffMode()
      const box = root.querySelector('#diffbox')
      if (box) box.innerHTML = diffHtml(currentDiff, diffMode)
      for (const all of root.querySelectorAll('.diffbar button')) all.className = all.getAttribute('data-mode') === diffMode ? 'on' : ''
    }
  }
}

function openCard(runId, cardId) {
  state.selected = { runId, cardId }
  stack = [{ type: 'card', runId, cardId }]
  cardSig = null
  armSig = null
  // 不把 run/id 写进 URL：点开/关掉卡片是页内交互，刷新应该回到列表。
  // 深链（?run=…&id=…）仍然支持——只在页面加载时读一次（见文件头的 deep）。
  render()
  showModal()
}

function openArm(name) {
  const top = stack[stack.length - 1]
  if (!top || top.type !== 'card') return
  stack.push({ type: 'arm', name })
  armSig = null
  showModal()
}

function back() {
  stack.pop()
  cardSig = null
  if (stack.length) showModal()
  else closeModal()
}

function closeModal() {
  stack = []
  cardSig = null
  armSig = null
  document.getElementById('modal').classList.remove('on')
  // 从分享链接进来的（URL 还带着 ?run=&id=）：关掉时清掉参数，否则刷新又弹回来。
  try {
    if (new URLSearchParams(location.search).has('run')) history.replaceState(null, '', location.pathname)
  } catch {}
}

function showModal() {
  const top = stack[stack.length - 1]
  document.getElementById('mback').style.display = stack.length > 1 ? 'inline-block' : 'none'
  document.getElementById('modal').classList.add('on')
  if (!top) return
  if (top.type === 'card') renderCard(top)
  else renderArm(top)
}

function refreshModal() {
  const top = stack[stack.length - 1]
  if (!top) return
  // 弹窗里用户可能正选着日志/命令复制，重写 innerHTML 会把选区冲掉：选着就等下一次。
  paintModalIfSafe(() => (top.type === 'card' ? renderCard(top) : renderArm(top)))
}

function renderArm(top) {
  const card = stack[0]
  if (!card || card.type !== 'card') return
  apiFetch('api/arm?run=' + encodeURIComponent(card.runId) + '&id=' + encodeURIComponent(card.cardId) + '&arm=' + encodeURIComponent(top.name))
    .then((r) => r.json())
    .then((d) => {
      const mbody = document.getElementById('mbody')
      if (d.error) {
        mbody.innerHTML = '<div class="bad">读不到：' + esc(d.error) + '</div>'
        return
      }
      const sig = top.name + '|' + (d.events || []).length
      if (sig === armSig) return
      armSig = sig
      const head = (d.reports || [])
        .map((r) => esc([r.label, r.model, r.status, r.tokens ? r.tokens + ' tok' : '', dur(r.elapsedMs)].filter(Boolean).join(' · ')))
        .join('<br>')
      document.getElementById('mhead').innerHTML = '<h3>子代理 ' + esc(top.name) + '</h3><div class="sub">' + head + '</div>'
      mbody.innerHTML = '<div class="tlwrap"><div class="tlhead"><span>时间</span><span>起点+</span><span>动作</span><span>耗时</span></div>' +
        '<div class="tllist" id="tllist">' + tlList(d.events || []) + '</div></div>'
      wireTimeline(mbody)
      const box = document.getElementById('tllist')
      if (box) box.scrollTop = box.scrollHeight
    })
}

function renderCard(sel) {
  apiFetch('api/card?run=' + encodeURIComponent(sel.runId) + '&id=' + encodeURIComponent(sel.cardId))
    .then((r) => r.json())
    .then((d) => {
      const mbody = document.getElementById('mbody')
      // 头部状态每轮都重画：进程被强制中断时事件流不再变化，只重画 body 的话这里会永远停在「运行中」。
      // 也放在读不到文件之前：还没开工的卡没有目录，头部还得显示卡号与状态。
      const run = state.runs.filter((r) => r.runId === sel.runId)[0]
      const card = (run && run.cards.filter((c) => c.id === sel.cardId)[0]) || {}
      // 这张卡用的 CLI / 模型 / 思考等级：运维时最常问的就是「它到底跑在什么上」。
      // 逐字段兜底：卡片自己的 turn_start 优先，没有就用这一批 loop_start 里的 runtime
      //（旧 run 两者都只会有一个 model，那就显示一个）。
      const rt = run && run.runtime ? run.runtime : {}
      const rtCli = card.cli || rt.cli
      const rtModel = card.model || rt.model
      const rtThinking = card.thinking || rt.thinking
      const runBits = []
      if (rtCli) runBits.push(rtCli)
      if (rtModel) runBits.push('模型 ' + rtModel)
      if (rtThinking) runBits.push('思考 ' + rtThinking)
      const runInfo = runBits.filter(Boolean).map(esc).join(' · ')
      document.getElementById('mhead').innerHTML = '<h3>' + esc(card.title || sel.cardId) + '</h3><div class="sub">' + esc(card.id) + ' · ' +
        (d.detail ? esc(d.detail.statusLabel + ' · ' + d.detail.priorityLabel + ' · ' + d.detail.owner) : '') + ' · ' + esc(elapsed(card)) + ' · ' +
        st(card.status || 'queued') + (card.note ? ' · ' + esc(card.note) : '') + '</div>' +
        (runInfo ? '<div class="sub">' + runInfo + '</div>' : '')
      if (d.error) {
        mbody.innerHTML = '<div class="bad">读不到：' + esc(d.error) + '</div>'
        return
      }
      const sig = [sel.runId, sel.cardId, (d.events || []).length, d.diff ? d.diff.length : 0, d.cardMd ? d.cardMd.length : 0].join('|')
      if (sig === cardSig) return
      cardSig = sig
      const html = []
      if (d.cardMd) {
        // 出网时 /img/ 也要带密钥（<img> 带不了 header，只能进 query）。
        const cardMd = String(d.cardMd).replace(/\]\(images\/([^)\s]+)\)/g,
          (_, name) => '](' + withKey('/img/' + sel.runId + '/' + sel.cardId + '/' + name) + ')')
        html.push(paneHtml(sel.runId + '|' + sel.cardId + '|card', '工单', '<div class="md">' + md(cardMd, { images: true }) + '</div>', !!paneState[sel.runId + '|' + sel.cardId + '|card']))
      }
      const says = (d.events || []).filter((e) => e.kind === 'say')
      if (says.length) {
        const key = sel.runId + '|' + sel.cardId + '|say'
        html.push(paneHtml(key, '主 Agent 结论', '<div class="md">' + md(says[says.length - 1].text, { images: true }) + '</div>', !!paneState[key]))
      }
      if (d.brief) {
        const key = sel.runId + '|' + sel.cardId + '|brief'
        html.push(paneHtml(key, '交给内循环的 brief', '<div class="md">' + md(d.brief, { images: true }) + '</div>', !!paneState[key]))
      }
      if (d.verify) {
        const key = sel.runId + '|' + sel.cardId + '|verify'
        html.push(paneHtml(key, '验证输出', '<pre>' + esc(d.verify) + '</pre>', !!paneState[key]))
      }
      if (d.diff) {
        currentDiff = d.diff
        const key = sel.runId + '|' + sel.cardId + '|diff'
        html.push(paneHtml(key, '改动 diff',
          '<div class="diffbar"><button data-mode="single"' + (diffMode === 'single' ? ' class="on"' : '') + '>单列</button>' +
          '<button data-mode="dual"' + (diffMode === 'dual' ? ' class="on"' : '') + '>双列</button></div>' +
          '<div id="diffbox">' + diffHtml(currentDiff, diffMode) + '</div>', !!paneState[key]))
      }
      if (d.logTail) {
        const key = sel.runId + '|' + sel.cardId + '|log'
        html.push(paneHtml(key, '进程日志尾部', '<pre>' + esc(d.logTail) + '</pre>', !!paneState[key]))
      }
      if (d.arms && d.arms.length) {
        let armBody = ''
        for (const arm of d.arms) {
          armBody += '<div class="armrow" data-arm="' + esc(arm.name) + '"><span class="nm">🤖 ' + esc(arm.name) + '</span><span>' +
            esc((arm.labels || []).join(',')) + '</span><span class="meta">' +
            esc([arm.status, arm.tokens ? arm.tokens + ' tok' : '', dur(arm.elapsedMs), arm.events + ' 条事件'].filter(Boolean).join(' · ')) + '</span></div>'
        }
        const key = sel.runId + '|' + sel.cardId + '|arms'
        html.push(paneHtml(key, '子代理 · ' + d.arms.length + ' 个', armBody, !!paneState[key]))
      }
      const evs = d.events || []
      // 区块区自己滚，时间线占剩下的地方：卡片本身不出滚动条。
      const panes = '<div class="panes">' + html.join('') + '</div>'
      mbody.innerHTML = panes + '<div class="tlbar"><span>内循环时间线 · ' + evs.length + ' 条</span>' +
        '<label><input type="checkbox" id="autoscroll">自动滚到最新</label></div>' +
        '<div class="tlwrap"><div class="tlhead"><span>时间</span><span>起点+</span><span>动作</span><span>耗时</span></div>' +
        '<div class="tllist" id="tllist">' + tlList(evs) + '</div></div>'
      const box = document.getElementById('tllist')
      const cb = document.getElementById('autoscroll')
      if (cb) {
        cb.checked = autoscroll
        cb.onchange = () => {
          autoscroll = cb.checked
          if (autoscroll) box.scrollTop = box.scrollHeight
        }
      }
      if (box && autoscroll) box.scrollTop = box.scrollHeight
      wirePanes(mbody, (key, open) => {
        paneState[key] = open
        savePaneState()
      })
      wireDiff(mbody)
      wireTimeline(mbody)
      for (const row of mbody.querySelectorAll('.armrow')) row.onclick = () => openArm(row.getAttribute('data-arm'))
    })
    .catch(() => { document.getElementById('mbody').innerHTML = '<div class="bad">读取失败，重试中…</div>' })
}

function poll() {
  apiFetch('api/state')
    .then((r) => r.json())
    .then((d) => {
      if (!Array.isArray(d.runs)) {
        // 401：骨架能打开但没数据。顶上那条横幅在说原因，这里别显示成「没有数据」。
        meta.textContent = '需要访问密钥（用带 ?k= 的链接打开）'
        return
      }
      state.runs = d.runs
      render()
      if (deep) {
        const first = deep
        deep = null
        openCard(first.runId, first.cardId)
        return
      }
      refreshModal()
    })
    .catch(() => { meta.textContent = '连接断开，重试中…' })
}

function syncFilters() {
  for (const btn of document.querySelectorAll('#filters button')) {
    btn.className = Number(btn.getAttribute('data-days')) === view.days ? 'on' : ''
  }
}

function wire() {
  for (const btn of document.querySelectorAll('#filters button')) {
    btn.onclick = () => {
      view.days = Number(btn.getAttribute('data-days'))
      saveView()
      syncFilters()
      poll()
    }
  }
  const cb = document.getElementById('onlyAlive')
  cb.checked = view.onlyAlive
  cb.onchange = () => {
    view.onlyAlive = cb.checked
    saveView()
    poll()
  }
  syncFilters()
  wireModal({ back, close: closeModal })
  mountControl()
}

wire()
poll()
setInterval(poll, 2000)
