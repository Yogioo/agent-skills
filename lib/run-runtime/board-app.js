import {
  clock, describeEvent, dur, esc, loadJson, md, msText, paneHtml, project, rel, saveJson,
  timelineHtml, wirePanes, wireTimeline,
} from '/assets/client.mjs'
import { fromProgress, fromProgressEvent } from '/assets/events.mjs'

const rowsEl = document.getElementById('rows')
const meta = document.getElementById('meta')
const detail = document.getElementById('detail')
const warn = document.getElementById('warn')

let selected = null
let requested = null
try { requested = new URLSearchParams(location.search).get('run') } catch {}

let view = { days: 7, onlyAlive: false }
const savedView = loadJson('agent-runs-view', null)
if (savedView && typeof savedView.days === 'number') view = { days: savedView.days, onlyAlive: !!savedView.onlyAlive }
const saveView = () => saveJson('agent-runs-view', view)

let openInputs = loadJson('agent-runs-inputs', {})
const saveOpenInputs = () => saveJson('agent-runs-inputs', openInputs)

let autoscroll = true
try { if (localStorage.getItem('agent-runs-autoscroll') === '0') autoscroll = false } catch {}
const saveAutoscroll = () => {
  try { localStorage.setItem('agent-runs-autoscroll', autoscroll ? '1' : '0') } catch {}
}
const scrollMemo = {}

let lastDetailSig = null
let lastDetailRun = null

function query() {
  return `days=${view.days}${view.onlyAlive ? '&alive=1' : ''}`
}

function promptText(input) {
  const text = String(input.prompt || '')
  const wrapped = text.match(/^<file name="[^"]*">\s*/)
  return wrapped ? text.slice(wrapped[0].length) : text
}

function armLine(arms) {
  if (!arms || !arms.length) return ''
  const seen = new Set()
  const out = []
  for (const arm of arms) {
    const bits = [arm.runner, arm.model, arm.thinking ? `thinking ${arm.thinking}` : ''].filter(Boolean).join(' · ')
    if (bits && !seen.has(bits)) {
      seen.add(bits)
      out.push(bits)
    }
  }
  if (!out.length) return ''
  return out.slice(0, 2).join(' ／ ') + (out.length > 2 ? ` 等 ${out.length} 种` : '')
}

function statusOf(run) {
  if (run.alive) return '<span class="ok">运行中</span>'
  if (run.crashed) return '<span class="bad">中断</span>'
  if (run.outcome === 'ok') return '<span class="ok">完成</span>'
  if (run.outcome === 'failed' || run.outcome === 'error') return '<span class="bad">失败</span>'
  return '<span class="dim">已结束</span>'
}

function row(run) {
  const tr = document.createElement('tr')
  tr.className = `run${run.alive ? '' : ' stale'}${run.runId === selected ? ' sel' : ''}`
  run._at = Date.now()
  const view = describeEvent(fromProgressEvent(run.lastEvent))
  const label = run.labels && run.labels.length ? run.labels.join(',') : '—'
  const arms = armLine(run.arms)
  tr.innerHTML = `<td>${esc(project(run.workdir))}</td>` +
    `<td><div>${esc(label)}</div>${arms ? `<div class="dim" style="font-size:11px">${esc(arms)}</div>` : ''}</td>` +
    `<td><div class="what" title="${esc(view.text)}">${view.icon} ${esc(view.text)}` +
    `${typeof view.ms === 'number' ? ` <span class="dim">${esc(msText(view.ms))}</span>` : ''}</div>` +
    `<div class="dim" style="font-size:11px">${esc(rel(run.lastEvent && run.lastEvent.t || run.startedAt))}</div></td>` +
    '<td class="el"></td>' +
    `<td>${statusOf(run)}</td>`
  tr.onclick = () => open(run.runId)
  tr._run = run
  return tr
}

function paintElapsed() {
  for (const tr of rowsEl.querySelectorAll('tr.run')) {
    const run = tr._run
    const cell = tr.querySelector('td.el')
    if (!run || !cell) continue
    cell.textContent = dur(run.elapsedMs + (run.alive ? Date.now() - run._at : 0))
  }
  if (lastDetailRun) setElapsedText(lastDetailRun)
}

function setElapsedText(run) {
  const el = document.getElementById('d-elapsed')
  if (!el) return
  el.textContent = (run.alive ? '已跑 ' : '用时 ') + dur(run.elapsedMs + (run.alive ? Date.now() - run._at : 0))
}

function wireAutoscroll(run) {
  const box = document.getElementById('tllist')
  if (!box) return
  const checkbox = document.getElementById('autoscroll')
  if (checkbox) {
    checkbox.checked = autoscroll
    checkbox.onchange = () => {
      autoscroll = checkbox.checked
      saveAutoscroll()
      if (autoscroll) box.scrollTop = box.scrollHeight
    }
  }
  box.onscroll = () => { scrollMemo[run.runId] = box.scrollTop }
  if (autoscroll) box.scrollTop = box.scrollHeight
  else if (scrollMemo[run.runId] != null) box.scrollTop = scrollMemo[run.runId]
}

function open(id) {
  selected = id
  lastDetailSig = null
  detail.textContent = '读取中…'
  try { history.replaceState(null, '', `?run=${encodeURIComponent(id)}`) } catch {}
  loadDetail()
  poll()
}

function loadDetail() {
  if (!selected) return
  fetch(`api/runs/${encodeURIComponent(selected)}`).then((r) => r.json()).then((data) => {
    if (data.error) {
      detail.innerHTML = `<h2>${esc(selected)}</h2><div class="bad">读不到：${esc(data.error)}</div>`
      return
    }
    const run = data.run
    const events = data.events || []
    run._at = Date.now()
    lastDetailRun = run
    const start = events.find((event) => event.event === 'arm_start') || null
    const sig = [run.runId, run.alive, run.endedAt || '', run.outcome || '', events.length,
      events.length ? events[events.length - 1].t : '', JSON.stringify(run.inputs || null)].join('|')
    if (sig === lastDetailSig) {
      setElapsedText(run)
      return
    }
    lastDetailSig = sig

    const bits = [project(run.workdir)]
    const arms = armLine(run.arms)
    if (arms) bits.push(arms)
    else if (start) {
      if (start.runner) bits.push(start.runner)
      if (start.model) bits.push(start.model)
      if (start.thinking) bits.push(`thinking ${start.thinking}`)
    }
    const html = [
      `<h2>${esc(run.labels && run.labels.length ? run.labels.join(',') : run.runId)}</h2>`,
      `<div class="sub">${esc(bits.join('  ·  '))} · <span id="d-elapsed"></span></div>`,
      `<div class="sub dim">${esc(run.outDir)}</div>`,
    ]

    const inputs = run.inputs && run.inputs.length ? run.inputs.slice() : []
    if (!inputs.length) {
      for (const event of events) {
        if (event.event === 'arm_start' && (event.prompt || event.promptFile)) {
          inputs.push({ label: event.arm, prompt: event.prompt, promptChars: event.promptChars, promptFile: event.promptFile })
        }
      }
    }
    for (const input of inputs) {
      const parts = ['输入']
      if (input.label && inputs.length > 1) parts.unshift(input.label)
      if (input.promptChars) parts.push(`${input.promptChars} 字`)
      if (input.promptFile) parts.push(project(input.promptFile))
      const key = `${run.runId}|${input.label || 'input'}`
      const known = Object.prototype.hasOwnProperty.call(openInputs, key)
      const shouldOpen = known ? !!openInputs[key] : !!(input.promptChars && input.promptChars <= 320)
      html.push(paneHtml(key, esc(parts.join('  ·  ')),
        `<div class="md">${md(promptText(input)) || '<span class="dim">（没读到输入正文）</span>'}</div>`, shouldOpen))
    }

    const items = fromProgress(events)
    html.push(`<div class="tlbar"><span>时间线 · ${items.length} 条</span>` +
      '<label><input type="checkbox" id="autoscroll">自动滚到最新</label></div>')
    html.push('<div class="tlwrap"><div class="tlhead"><span>时间</span><span>起点+</span><span>动作</span><span>耗时</span></div>' +
      `<div class="tllist" id="tllist">${timelineHtml(items, { base: (start && start.t) || run.startedAt })}</div></div>`)
    detail.innerHTML = html.join('')
    wirePanes(detail, (key, isOpen) => {
      openInputs[key] = isOpen
      saveOpenInputs()
    })
    wireTimeline(detail)
    wireAutoscroll(run)
    setElapsedText(run)
  }).catch(() => { detail.innerHTML = '<div class="bad">读取失败，重试中…</div>' })
}

function poll() {
  fetch(`api/runs?${query()}`).then((r) => r.json()).then((data) => {
    const runs = data.runs || []
    if (requested && runs.some((run) => run.runId === requested)) selected = requested
    requested = null
    const stillThere = selected && runs.some((run) => run.runId === selected)
    if (!stillThere) selected = runs.length ? runs[0].runId : null
    rowsEl.innerHTML = ''
    if (!runs.length) {
      const empty = document.createElement('tr')
      empty.innerHTML = '<td colspan="5" class="dim" style="padding:18px 10px">这个窗口里没有 run。' +
        (view.days > 0 ? '试试「全部」或把筛选放宽。' : (view.onlyAlive ? '取消「只看运行中」。' : '')) + '</td>'
      rowsEl.appendChild(empty)
    }
    let aliveCount = 0
    for (const run of runs) {
      rowsEl.appendChild(row(run))
      if (run.alive) aliveCount++
    }
    paintElapsed()
    const scope = view.days > 0 ? `近 ${view.days} 天` : '全部历史'
    meta.textContent = `${scope} · ${runs.length} 个 run` +
      (aliveCount ? `（${aliveCount} 个运行中）` : '') +
      (data.malformed ? ` · ${data.malformed} 个记录损坏` : '') +
      ' · 切筛选不删记录 · 每 2 秒刷新'
    if (data.board && data.board.share) {
      warn.style.display = 'block'
      warn.textContent = `对外监听中（无鉴权，局域网内任何人可读）：${data.board.share}`
    }
    if (selected) loadDetail()
    else {
      detail.innerHTML = ''
      lastDetailSig = null
      lastDetailRun = null
    }
  }).catch(() => { meta.textContent = '连接断开，重试中…' })
}

function syncFilters() {
  for (const button of document.querySelectorAll('#filters button')) {
    button.className = Number(button.getAttribute('data-days')) === view.days ? 'on' : ''
  }
}

for (const button of document.querySelectorAll('#filters button')) {
  button.onclick = () => {
    view.days = Number(button.getAttribute('data-days'))
    saveView()
    syncFilters()
    selected = null
    poll()
  }
}
const aliveBox = document.getElementById('onlyAlive')
aliveBox.checked = view.onlyAlive
aliveBox.onchange = () => {
  view.onlyAlive = aliveBox.checked
  saveView()
  selected = null
  poll()
}
syncFilters()

poll()
setInterval(poll, 2000)
setInterval(paintElapsed, 1000)
