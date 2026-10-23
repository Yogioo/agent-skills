/**
 * 看板密钥的浏览器侧一小段。
 *
 * 看板出网（绑 0.0.0.0）之后，`/api/*` 一律要密钥。密钥只从 URL 里带一次：
 * `?k=xxx`，存进 localStorage，然后把地址栏里的 k 去掉 —— 分享出去的那条链接
 * 别人点开就能用，而他自己之后刷新地址栏里也不会有痕迹。
 *
 * 只用相对 URL，不碰 Node 内置模块。`tests/web-ui/units.test.mjs` 会拦。
 */

const STORE = 'tapd-loop-key'

function fromUrl() {
  try {
    const url = new URL(location.href)
    const key = url.searchParams.get('k') || ''
    if (!key) return ''
    try {
      localStorage.setItem(STORE, key)
    } catch {
      // 隐私模式下存不了：本次会话仍然能用
    }
    url.searchParams.delete('k')
    const rest = url.searchParams.toString()
    history.replaceState(null, '', url.pathname + (rest ? `?${rest}` : '') + url.hash)
    return key
  } catch {
    return ''
  }
}

export const boardKey = fromUrl() || (() => {
  try {
    return localStorage.getItem(STORE) || ''
  } catch {
    return ''
  }
})()

/** 给 `<img src>` 这种带不了 header 的地方。 */
export function withKey(url) {
  if (!boardKey) return url
  return `${url}${url.includes('?') ? '&' : '?'}k=${encodeURIComponent(boardKey)}`
}

/** 缺密钥时页面顶上要有一句话，否则所有请求都静默 401，看着像坏了。 */
function warnMissingKey() {
  const box = document.getElementById('warn')
  if (!box) return
  box.style.display = 'block'
  box.textContent = '这个页面需要访问密钥：用看板打印出来的带 ?k= 的链接打开一次（本机 127.0.0.1 直连不需要）。'
}

export function apiFetch(path, init = {}) {
  const headers = { ...(init.headers || {}) }
  if (boardKey) headers['x-tapd-loop-key'] = boardKey
  return fetch(withKey(path), { ...init, headers }).then((res) => {
    if (res.status === 401) warnMissingKey()
    return res
  })
}

/** 读 JSON，坏掉就退回 `{}`：页面不该因为一个 500 白屏。 */
export async function apiJson(path, init = {}) {
  const res = await apiFetch(path, init)
  let data = {}
  try {
    data = await res.json()
  } catch {
    data = {}
  }
  return { ok: res.ok && data.ok !== false, status: res.status, data }
}
