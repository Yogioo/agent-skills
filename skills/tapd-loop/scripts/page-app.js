/** tapd-loop 看板页面。只放这张页面自己的状态、深链和弹窗栈；渲染积木来自 /assets/client.mjs。 */

import {
  diffHtml, dur, esc, loadJson, md, paneHtml, rel, saveJson,
  timelineHtml, wireModal, wirePanes, wireTimeline,
} from '/assets/client.mjs'
import { apiFetch, withKey } from '/auth.js'
import { minuteBucket, selectionGuard } from '/dom-guard.js'
import { mountControl, notify } from '/control.js'

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

const PHASE = {
  claim: '占住卡片',
  fetch: '抓取工单与图片',
  fetched: '已抓取',
  salvage: '清理上一批残留',
  sync: '同步基线（git pull）',
  'after-sync': '导表/生成物',
  running: '内循环运行中',
  // turn_end 之后、card_done 之前的真实阶段：以前不区分，
  // 一律显示「内循环运行中」，一次 Unity 测试就能骗人十几分钟。
  'after-turn': 'AI 已交卷，后续处理中',
  verify: '验证门（编译+跑测试）',
  commit: '提交中',
  publish: '推送（sync + push）',
  timeout: '超时',
}
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


/**
 * 全链路：把「外循环这一批」和「跨批次的合入」串成一张表。
 *
 * 为什么单独一块：卡片弹窗里原来只有内循环时间线（AI 那一轮的工具调用），
 * 验证门、提交、推送、合入主树都不在那儿——出了问题的人只能猜这张卡走到哪一步了。
 */
const CHAIN_PHASE = {
  salvage: '清理上一批残留',
  sync: '同步基线（git pull）',
  'after-sync': '导表 / 生成物',
  claim: '占住卡片（afk-claimed）',
  fetch: '抓取工单',
  fetched: '工单已抓取',
  verify: '验证门',
  commit: '提交',
  publish: '推送（sync + push）',
}

function buildChain(d) {
  const progress = (d.progress || []).filter((e) => e && e.event)
  const startedAt = Number((progress.find((e) => e.event === 'card_start') || {}).t || 0)
  const rows = []
  const add = (at, label, note = '', cls = '') => rows.push({ at: Number(at) || 0, label, note: String(note || ''), cls })
  for (const e of progress) {
    const at = e.t
    switch (e.event) {
      case 'card_start':
        add(at, '开始', [e.title, e.priorityLabel, e.statusLabel].filter(Boolean).join(' · '), 'ok')
        break
      case 'card_phase': {
        const phase = String(e.phase || '')
        if (CHAIN_PHASE[phase]) add(at, CHAIN_PHASE[phase], phase === 'fetched' ? `评论 ${e.comments ?? 0} · 图片 ${e.images ?? 0}` : '')
        break
      }
      case 'card_sync':
        add(at, '同步基线完成', e.moved ? `${String(e.from || '').slice(0, 10)} → ${String(e.to || '').slice(0, 10)}` : `${String(e.to || '').slice(0, 10)}（已是最新）`)
        break
      case 'card_after_sync':
        add(at, '导表完成', `${Math.round(Number(e.elapsedMs || 0) / 1000)}s`)
        break
      case 'turn_start':
        add(at, 'AI 开始（内循环）', [e.cli, e.model && e.model !== '(default)' ? `模型 ${e.model}` : '', e.thinking && e.thinking !== '(default)' ? `思考 ${e.thinking}` : ''].filter(Boolean).join(' · '))
        break
      case 'turn_end':
        add(at, 'AI 交卷', [e.code != null ? `exit ${e.code}` : '', e.timedOut ? '⚠ 超时' : ''].filter(Boolean).join(' · '), e.timedOut ? 'bad' : 'ok')
        break
      case 'verify_repair_start':
        add(at, `第 ${e.round} 轮 AI 修复`, `验证 exit ${e.code}`)
        break
      case 'verify_repair_end':
        add(at, `第 ${e.round} 轮修复结束`, e.ok ? (e.touched ? `改了 ${e.touched} 个文件` : '没动文件') : String(e.reason || ''), e.ok ? 'ok' : 'bad')
        break
      case 'card_done':
        add(at, e.status === 'preview' ? '完成（预览，未提交）' : '完成', e.commit ? `提交 ${String(e.commit).slice(0, 10)}` : '', 'ok')
        break
      case 'card_failed':
        add(at, `失败${e.attempt ? `（第 ${e.attempt}/${e.maxAttempts || '?'} 次）` : ''}${e.requeued ? ' · 已自动放回队列' : ''}`, e.reason, 'bad')
        break
      case 'card_skipped':
        add(at, '跳过', e.reason, 'bad')
        break
      case 'card_blocked':
        add(at, '被挡（整批停）', e.reason, 'bad')
        break
      case 'card_crashed':
        add(at, '收尾异常', e.reason, 'bad')
        break
      default:
        break
    }
  }
  rows.sort((a, b) => a.at - b.at)
  // 每步耗时 = 到下一步的距离；最后一步如果卡已经结束就是 0（不是“到现在”），
  // 还在跑才用“到现在”——否则一张一小时前完成的卡会一直显示「已 60m」。
  const ended = progress.some((e) => ['card_done', 'card_failed', 'card_skipped', 'card_blocked', 'card_crashed'].includes(e.event))
  const now = Date.now()
  const batch = rows.map((row, i) => {
    const next = rows[i + 1]
    const end = next ? next.at : (ended ? row.at : now)
    return { ...row, offset: startedAt ? row.at - startedAt : 0, spent: Math.max(0, end - row.at) }
  })
  // 跨批次的那半段（合入主树 / 推送 / 人工终止）单独一组：
  // 它们可能发生在几个小时前甚至别的批次里，混进本批的「偏移/耗时」只会误导人。
  const cross = (d.trace || [])
    .filter((e) => ['merged', 'batch_killed', 'job_done', 'job_failed'].includes(String(e.kind || '')))
    .sort((a, b) => Number(a.t) - Number(b.t))
    .map((e) => ({
      at: Number(e.t) || 0,
      label: e.kind === 'merged' ? '合入主树' : e.kind === 'batch_killed' ? '人工终止了批次' : (e.kind === 'job_done' ? '主树任务完成' : '主树任务失败'),
      note: [e.sha ? `提交 ${String(e.sha).slice(0, 10)}` : '', e.note].filter(Boolean).join(' · '),
      cls: e.kind === 'job_failed' || e.kind === 'batch_killed' ? 'bad' : '',
    }))
  return { batch, cross }
}

function chainCount(d) {
  const chain = buildChain(d)
  return chain.batch.length + chain.cross.length
}

const chainRowHtml = (time, label, spent, note, cls) =>
  `<div class="chainrow ${cls || ''}">` +
  `<span class="ct">${esc(time)}</span>` +
  `<span class="cl">${esc(label)}</span>` +
  `<span class="cd">${esc(spent)}</span>` +
  `<span class="cn" title="${esc(note)}">${esc(note)}</span>` +
  '</div>'

function chainHtml(d) {
  const chain = buildChain(d)
  if (!chain.batch.length && !chain.cross.length) return '<div class="dim">这一批里没有留下可展示的步骤。</div>'
  const parts = []
  if (chain.batch.length) {
    parts.push('<div class="chainhead">本批次（AI 那一轮之前 → 之后）</div>')
    parts.push('<div class="chain">' + chain.batch.map((row) => chainRowHtml(
      `+${dur(row.offset)}`,
      row.label,
      row.spent >= 1000 ? dur(row.spent) : '',
      row.note,
      row.cls,
    )).join('') + '</div>')
  }
  if (chain.cross.length) {
    parts.push('<div class="chainhead">跨批次（合入主树 / 推送 / 人工干预）</div>')
    parts.push('<div class="chain">' + chain.cross.map((row) => chainRowHtml(
      rel(row.at),
      row.label,
      '',
      row.note,
      row.cls,
    )).join('') + '</div>')
  }
  return parts.join('')
}

function st(s) {
  const hit = STATUS[s] || ['·', s || '未知', 'dim']
  return `<span class="${hit[2]}">${hit[0]} ${esc(hit[1])}</span>`
}

function what(c) {
  const phase = String(c.phase || '')
  // 修复轮的 phase 是动态的（verify-repair-1/2），按前缀认，别一条条罗列。
  const repair = /^verify-repair-(\d+)$/.exec(phase)
  const label = repair
    ? `验证没过，第 ${repair[1]} 轮 AI 修复中`
    : (PHASE[phase] || '')
  if (c.status !== 'running') return c.note || label || '—'
  // 阶段已经跑了多久：一个阶段停太久就该有人去看（AFK 里最怕的就是“看着像在动”）。
  const since = Number(c.phaseAt || 0)
  const spent = since ? dur(Date.now() - since) : ''
  const tail = spent && Date.now() - since > 60_000 ? ` · 已 ${spent}` : ''
  return (label || '运行中') + tail
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

const statsBodyEl = () => document.getElementById('statsBody')
const statsIfSafe = selectionGuard(() => document.getElementById('statsPanel'))

let statsDays = 14
let statsTimer = 0

/**
 * 统计面板：默认折叠，展开才拉数据（30 秒一次，手动点刷新也能拉）。
 * 数据源是 ~/.tapd-loop/index.jsonl（全局、跨仓库），口径见 scripts/stats.mjs 顶部注释：
 * 一张卡 = 一个工单，多次 card_start = 重试。
 */
/**
 * 「统计」「高级设置」都是弹窗面板：节点平时藏在 #panelHome 里，打开时**搬进** #mbody。
 * 搬而不是克隆——高级设置里的控件事件都绑在原件上（control.js 用 getElementById 取），
 * 克隆一份会变成一堆点了没反应的死控件。搬到 mbody 后 #ctl 的样式靠 .ctl-ui 这个 class 保留。
 */
const PANELS = {
  stats: {
    title: '统计',
    hint: '全局（所有仓库）· 一张卡 = 一个工单，多次跑 = 重试',
    el: () => document.getElementById('statsPanel'),
    open: () => startStats(),
    close: () => stopStats(),
  },
  advanced: {
    title: '高级设置',
    hint: '项目 / 处理人 / 工位 / 指定工单',
    el: () => document.getElementById('advancedPanel'),
  },
}

const startStats = () => {
  const refresh = () => { loadStats().catch(() => {}) }
  clearInterval(statsTimer)
  refresh()
  statsTimer = setInterval(refresh, 30_000)
}

const stopStats = () => {
  clearInterval(statsTimer)
  statsTimer = 0
}

function highlightView(kind) {
  document.getElementById('openStats')?.classList.toggle('on', kind === 'stats')
  document.getElementById('openAdvanced')?.classList.toggle('on', kind === 'advanced')
}

/** 打开一个面板弹窗（和卡片弹窗共用同一个 #modal，栈里放 {type:'panel'}）。 */
function openPanel(kind) {
  const panel = PANELS[kind]
  if (!panel) return
  const top = stack[stack.length - 1]
  if (top && top.type === 'panel' && top.kind !== kind) releasePanel(top.kind)
  stack = [{ type: 'panel', kind }]
  cardSig = null
  armSig = null
  showModal()
}

/** 把面板节点还回 #panelHome（隐藏），并把它的定时器停掉。 */
function releasePanel(kind) {
  const panel = PANELS[kind]
  if (!panel) return
  panel.close?.()
  const node = panel.el()
  if (!node) return
  node.hidden = true
  const home = document.getElementById('panelHome')
  if (home && node.parentElement !== home) home.appendChild(node)
}

function renderPanel(top) {
  const panel = PANELS[top.kind]
  const node = panel?.el()
  if (!panel || !node) return
  const mhead = document.getElementById('mhead')
  if (mhead) mhead.innerHTML = `<h3>${esc(panel.title)}</h3><div class="sub">${esc(panel.hint || '')}</div>`
  const mbody = document.getElementById('mbody')
  if (!mbody) return
  if (node.parentElement !== mbody) {
    mbody.innerHTML = ''
    node.hidden = false
    mbody.appendChild(node)
  }
  highlightView(top.kind)
  panel.open?.()
}

function wirePanels() {
  document.getElementById('openStats')?.addEventListener('click', () => openPanel('stats'))
  document.getElementById('openAdvanced')?.addEventListener('click', () => openPanel('advanced'))
  statsBodyEl()?.addEventListener('click', (event) => {
    if (event.target?.id === 'statsRefresh') loadStats().catch(() => {})
  })
}

async function loadStats() {
  const res = await apiFetch(`api/stats?days=${statsDays}`)
  if (!res.ok) {
    statsBodyEl() && (statsBodyEl().innerHTML = '<div class="dim">统计接口打不开（HTTP ' + res.status + '）</div>')
    return
  }
  const data = await res.json()
  // 数据没变就不重画（和运行列表同一道闸：重画会冲掉选中的文本）
  statsIfSafe(() => paintStats(data), () => JSON.stringify(data))
}

const chip = (value, label, tone = '') => `<span class="chip ${tone}"><b>${esc(String(value))}</b>${esc(label)}</span>`

function paintStats(d) {
  const body = statsBodyEl()
  if (!body) return
  const t = d.totals || {}
  const days = d.days || []
  const cov = d.range?.coverage || {}
  const stamp = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : '?')
  const coverage = cov.first ? `${stamp(cov.first)} → ${stamp(cov.last)}（${cov.rows || 0} 条事件）` : '还没有数据'
  const maxAttempts = Math.max(1, ...days.map((x) => x.attempts || 0))

  const chips = [
    chip(t.cards ?? 0, '工单'),
    chip(t.attempts ?? 0, '次尝试'),
    chip(t.retries ?? 0, `次重试（${t.retriedCards ?? 0} 张卡）`, (t.retriedCards ?? 0) > 0 ? 'warn' : ''),
    chip(`${t.firstTryRate ?? 0}%`, '一次通过', (t.firstTryRate ?? 0) >= 80 ? 'ok' : (t.firstTryRate ?? 0) >= 50 ? 'warn' : 'bad'),
    chip(`${t.done ?? 0}/${(t.done ?? 0) + (t.unresolved ?? 0)}`, '完成'),
    chip(t.mergedEvents ?? 0, '次合入'),
    `<span class="chip">耗时 p50 <b>${t.p50Minutes ?? 0}</b>min · p90 <b>${t.p90Minutes ?? 0}</b>min</span>`,
    `<button id="statsRefresh" title="重新拉一次（数据来自 ~/.tapd-loop/index.jsonl）">刷新</button>`,
  ].join('')

  const dayRows = days.map((x) => `<tr>
      <td class="mono">${esc(String(x.date).slice(5))}</td>
      <td class="num">${x.runs}</td>
      <td class="num">${x.attempts}</td>
      <td class="num">${x.cards}</td>
      <td class="num" style="color:#7ee787">${x.done || ''}</td>
      <td class="num" style="color:#ff9d96">${x.failed || ''}</td>
      <td class="num">${x.merged || ''}</td>
      <td class="num">${x.p50 ? x.p50 + 'm' : ''}</td>
      <td style="width:26%"><div class="track"><div class="bar" style="width:${Math.round(((x.attempts || 0) / maxAttempts) * 100)}%"></div></div></td>
    </tr>`).join('')

  const retryRows = (d.retriedCards || []).map((c) => `<tr>
      <td class="mono" title="${esc(String(c.card))}">${esc(String(c.card).slice(-7))}</td>
      <td>${esc(String(c.title || '').slice(0, 30))}</td>
      <td class="num">${c.attempts} <span class="dim">(${c.retries} 重试)</span></td>
      <td class="mono">${esc((c.statuses || []).join(' → '))}</td>
      <td class="num">${c.spanMinutes}m</td>
      <td class="mono">${esc(c.sha || '')}</td>
    </tr>`).join('')

  const failRows = (d.failures || []).map((f) => `<tr>
      <td class="mono">${esc(f.kind)}</td>
      <td>${esc(f.note)}</td>
      <td class="num">${f.count}</td>
      <td class="num">${f.cards || ''}</td>
    </tr>`).join('')

  const stationRows = (d.stations || []).map((s) => `<tr>
      <td class="mono">${esc(s.name)}</td>
      <td class="num">${s.attempts}</td>
      <td class="num">${s.done}</td>
      <td class="num">${s.minutes ? s.minutes + 'm' : ''}</td>
    </tr>`).join('')

  const table = (head, rows) => `<table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`
  body.innerHTML = `<div class="chips">${chips}</div>` +
    (dayRows ? `<h4>每日吞吐</h4>${table('<th>日期</th><th class="num">批</th><th class="num">尝试</th><th class="num">卡</th><th class="num">完成</th><th class="num">失败</th><th class="num">合入</th><th class="num">p50</th><th></th>', dayRows)}` : '<div class="dim">这段时间还没有数据。</div>') +
    (retryRows ? `<h4>重试的工单（同一张卡跑了多次 = 重试）</h4>${table('<th>工单</th><th>标题</th><th class="num">次数</th><th>每次结果</th><th class="num">跨时</th><th>提交</th>', retryRows)}` : '') +
    (failRows ? `<h4>失败原因 Top</h4>${table('<th>事件</th><th>原因</th><th class="num">次数</th><th class="num">卡</th>', failRows)}` : '') +
    (stationRows ? `<h4>工位</h4>${table('<th>工位</th><th class="num">尝试</th><th class="num">完成</th><th class="num">成功耗时</th>', stationRows)}` : '') +
    `<div class="dim" style="margin-top:10px;font-size:11px">数据源 ~/.tapd-loop/index.jsonl（全局，跨仓库）· 索引覆盖 ${coverage} · 一张卡 = 一个工单，多次跑 = 重试 · 「合入」只统计有 merged 埋点之后的事件（历史批次补不回来）</div>`
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
  for (const item of stack) {
    if (item.type === 'panel') releasePanel(item.kind)
  }
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
  const top = stack[stack.length - 1]
  if (top && top.type === 'panel') return closeModal()
  stack.pop()
  cardSig = null
  if (stack.length) showModal()
  else closeModal()
}

function closeModal() {
  for (const item of stack) {
    if (item.type === 'panel') releasePanel(item.kind)
  }
  stack = []
  cardSig = null
  armSig = null
  highlightView('')
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
  if (top.type === 'panel') renderPanel(top)
  else if (top.type === 'card') renderCard(top)
  else renderArm(top)
}

function refreshModal() {
  const top = stack[stack.length - 1]
  if (!top || top.type === 'panel') return
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
        (runInfo ? '<div class="sub">' + runInfo + '</div>' : '') +
        // 批次还活着就给一个人能按的终止键：出了问题不应该只能等人去找进程号。
        // 杀的是整批（loop 没提供单卡终止：它一张一张跑，停这一批就等于停这张卡）。
        (run && run.alive
          ? '<div class="sub"><button type="button" class="danger" id="mkillrun" title="强杀这一批（含这张卡）：不等它收尾，工作区半截改动留到下一批开工前存档，TAPD 上留 afk-claimed">■ 终止这一批</button></div>'
          : '')
      const killBtn = document.getElementById('mkillrun')
      if (killBtn) {
        killBtn.onclick = () => {
          const label = card.title || sel.cardId
          if (!window.confirm(`停掉「${label}」这一批？\n\n` +
            '会强杀批次进程（含它的内循环子代理），不等它自己收尾：\n' +
            '· 工作区里的半截改动留着 —— 下一批开工前会存成 tapd-loop-orphan/<卡> 分支再清掉\n' +
            '· TAPD 上这张卡留着 afk-claimed —— 想再被接单得用 loop.mjs --retry <卡>')) return
          killBtn.disabled = true
          killBtn.textContent = '正在终止…'
          apiFetch('api/stations', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'kill', runId: sel.runId, card: sel.cardId, workdir: (run && run.workdir) || '' }),
          })
            .then((r) => r.json())
            .then((res) => {
              if (res && res.ok) notify(`已终止这一批（pid ${res.killed?.pid}）`, 'ok')
              else {
                notify((res && res.error) || '停不掉', 'bad')
                killBtn.disabled = false
                killBtn.textContent = '■ 终止这一批'
              }
            })
            .catch(() => {
              notify('停不掉：请求失败', 'bad')
              killBtn.disabled = false
              killBtn.textContent = '■ 终止这一批'
            })
        }
      }
      if (d.error) {
        mbody.innerHTML = '<div class="bad">读不到：' + esc(d.error) + '</div>'
        return
      }
      const sig = [sel.runId, sel.cardId, (d.events || []).length, d.diff ? d.diff.length : 0, d.cardMd ? d.cardMd.length : 0].join('|')
      if (sig === cardSig) return
      cardSig = sig
      const html = []
      // 全链路放第一个、默认展开：这是“这张卡从头到尾发生了什么”的主视图，
      // 内循环时间线只是其中一段（AI 那一轮），验证/提交/推送/合入都不在那里。
      if ((d.progress || []).length || (d.trace || []).length) {
        const chainKey = sel.runId + '|' + sel.cardId + '|chain'
        html.push(paneHtml(chainKey, '全链路 · ' + chainCount(d) + ' 步', chainHtml(d), paneState[chainKey] !== false))
      }
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
  wirePanels()
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
