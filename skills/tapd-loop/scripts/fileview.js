/**
 * 看板上的「文件」弹窗：点一下就地把日志摊开，不用人照着绝对路径去资源管理器里找。
 *
 * 服务端是 `/api/file`（只认 ~/.tapd-loop 下 runs / cards / board-batches 里的文件）。
 * 这里只做三件事：拉一次文件信息、画一个浮层、给「刷新 / 复制内容 / 关闭」。
 * 不显示、也不给复制本机绝对路径：看板是远程看的，开发机是黑箱。
 *
 * 两个模块（control.js 和 page-app.js）都可能用到，所以单独成模块，别各写一份。
 */

import { apiJson } from '/auth.js'

let layer = null
let currentPath = ''

function ensureLayer() {
  if (layer && layer.box.isConnected) return layer
  const box = document.createElement('div')
  box.id = 'fileview'
  box.innerHTML =
    '<div class="fv-mask"></div>' +
    '<div class="fv-panel" role="dialog" aria-modal="true">' +
    '<div class="fv-top"><span class="fv-name"></span><span class="fv-meta"></span></div>' +
    '<pre class="fv-body"></pre>' +
    '<div class="fv-actions">' +
    '<button data-fv-refresh>刷新</button>' +
    '<button data-fv-copy>复制内容</button>' +
    '<button data-fv-close>关闭</button>' +
    '</div></div>'
  document.body.appendChild(box)
  box.querySelector('.fv-mask').addEventListener('click', closeFile)
  box.querySelector('[data-fv-close]').addEventListener('click', closeFile)
  box.querySelector('[data-fv-refresh]').addEventListener('click', () => load(currentPath))
  box.querySelector('[data-fv-copy]').addEventListener('click', () => {
    // 剪贴板 API 在 http 的非 localhost 下不可用，退回 textarea + execCommand。
    const text = box.querySelector('.fv-body').textContent || ''
    const done = () => {
      const btn = box.querySelector('[data-fv-copy]')
      btn.textContent = '已复制'
      setTimeout(() => { btn.textContent = '复制内容' }, 1200)
    }
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done))
    } else fallbackCopy(text, done)
  })
  const onKey = (event) => {
    if (event.key === 'Escape' && box.classList.contains('on')) closeFile()
  }
  document.addEventListener('keydown', onKey)
  layer = { box }
  return layer
}

function fallbackCopy(text, done) {
  const area = document.createElement('textarea')
  area.value = text
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  try {
    document.execCommand('copy')
    done()
  } catch {
    // 复制不了也不阻断查看
  }
  area.remove()
}

function human(bytes) {
  const n = Number(bytes) || 0
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

async function load(path) {
  const { box } = ensureLayer()
  currentPath = path
  const name = box.querySelector('.fv-name')
  const meta = box.querySelector('.fv-meta')
  const body = box.querySelector('.fv-body')
  name.textContent = String(path || '').split(/[\\/]/).pop() || '(未给路径)'
  meta.textContent = '读取中…'
  body.textContent = ''

  const res = await apiJson('api/file?path=' + encodeURIComponent(path || ''))
  const data = res.data || {}
  if (!data.ok) {
    meta.textContent = '读不了'
    body.textContent = data.error || `HTTP ${res.status}`
    return
  }
  meta.textContent = `${human(data.size)} · 改于 ${new Date(Number(data.mtime) || Date.now()).toLocaleString()}` +
    (data.truncated ? ' · 只显示尾部 64KB' : '')
  // 日志末尾才是人在找的东西，滚到底。
  body.textContent = data.tail || '（空文件）'
  body.scrollTop = body.scrollHeight
}

export function openFile(path) {
  const { box } = ensureLayer()
  box.classList.add('on')
  load(path).catch((err) => {
    const meta = box.querySelector('.fv-meta')
    const body = box.querySelector('.fv-body')
    meta.textContent = '读不了'
    body.textContent = String(err?.message || err)
  })
}

export function closeFile() {
  if (!layer) return
  layer.box.classList.remove('on')
}
