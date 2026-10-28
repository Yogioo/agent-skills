/**
 * 重画前的一道闸：别把用户正在选的文本弄没。
 *
 * 看板两处都是整块 innerHTML 重写（运行列表每 2 秒、控制面板每 3 秒）。DOM 节点一销毁，
 * 浏览器就把选区丢了 —— 表现就是「选中的文字过一会儿自己取消选中」。这里做两层：
 *
 *  1. 数据没变就不重画（signature 相同直接跳过）。绝大多数轮询都是数据未变，
 *     不重建 DOM 就不会丢选区，顺带省掉一轮无谓的重排。
 *  2. 数据确实变了、但用户正在这个区域里选文本：这次先不画，等选区没了
 *     （selectionchange）再补画一次，不会漏掉状态。
 *
 * 只保护「用户正在选的那个区域」：在表格里选文本不影响控制面板刷新，反之亦然。
 */

/** 选区是不是落在某个节点里面（节点可以用函数懒取，元素可能还没建）。 */
function selectionInside(getContainer) {
  try {
    const sel = window.getSelection()
    if (!sel || !sel.rangeCount || !String(sel).trim()) return false
    const container = typeof getContainer === 'function' ? getContainer() : getContainer
    if (!container) return false
    const range = sel.getRangeAt(0)
    return container.contains(range.commonAncestorContainer)
  } catch {
    return false
  }
}

/**
 * @param {() => Node | null | undefined} getContainer 这个闸保护的区域
 * @returns {(paint: () => void, signature?: string | null | (() => string | null)) => void}
 */
export function selectionGuard(getContainer) {
  let last = null
  let pending = null
  let watching = false

  function flush() {
    if (selectionInside(getContainer)) return
    document.removeEventListener('selectionchange', flush)
    watching = false
    const run = pending
    pending = null
    if (run) run()
  }

  return function paintIfSafe(paint, signature) {
    const sig = typeof signature === 'function' ? signature() : signature
    if (sig != null && sig === last) return
    if (selectionInside(getContainer)) {
      pending = () => { last = sig; paint() }
      if (!watching) {
        watching = true
        document.addEventListener('selectionchange', flush)
      }
      return
    }
    last = sig
    paint()
  }
}

/**
 * 分钟粒度的时间戳：相对时间（「干活中 · 20m」「3 分钟前」）靠它每分钟刷一次，
 * 又不会因为每轮轮询里 now 变了就重画。
 */
export function minuteBucket(now = Date.now()) {
  return Math.floor(Number(now) / 60_000)
}
