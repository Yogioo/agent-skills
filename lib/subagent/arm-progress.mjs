/**
 * 一个臂的进度记录器：把归一化事件压成「能回答跑到哪」的少量 progress 记录。
 *
 * 为什么不全写：pi 一轮能产出上千条 assistant/thinking 片段，全写进 progress.jsonl
 * 会让看板既读不动也看不懂。这里只留三类：
 *   arm_start  臂开始
 *   tool       一次工具调用完成（start/done 成对合并，只写完成态）
 *   arm_end    臂结束，带 status/tokens/cost/耗时/失败原因（截断）
 *
 * 记录形状与 lib/run-runtime/progress.mjs 一致（t/level/event + 自定义字段），
 * 所以 `run-runtime serve`、看板、`progress read` 都能直接吃。
 *
 * 铁律：任何写入异常都必须吞掉。观察端不许杀死正在跑的执行。
 */

import { appendEvent } from '../run-runtime/progress.mjs'

const REASON_MAX = 200

/**
 * @param {{file:string, arm:string, now?:()=>number}} opts
 * @returns {{onEvent:(event:object)=>void, end:(facts:object)=>void, stats:()=>object}}
 */
export function createArmProgress(opts) {
  const { file, arm } = opts
  const now = opts.now || Date.now
  const startedAt = now()
  const toolStarts = new Map()
  let tools = 0
  let lastTool

  const write = (event, level, data) => {
    try {
      appendEvent(file, { event, level, data: { arm, ...data } })
    } catch {
      /* 观察端不许杀死执行 */
    }
  }

  write('arm_start', 1, { at: startedAt })

  const onEvent = (event) => {
    try {
      if (!event || event.kind !== 'tool') return
      const name = String(event.toolName || 'tool')
      // pi 的 tool 事件成对（start/done），Cursor 的是一次性。两种都要认。
      if (event.phase === 'start') {
        const key = event.callId || `${name}:${toolStarts.size}`
        toolStarts.set(key, now())
        return
      }
      const key = event.callId
      const begun = key ? toolStarts.get(key) : undefined
      if (key) toolStarts.delete(key)
      tools += 1
      lastTool = name
      // 没有配对的 start 就不要编一个耗时出来。
      write('tool', 1, { name, ms: begun ? now() - begun : undefined })
    } catch {
      /* 同上 */
    }
  }

  /**
   * 收尾。失败原因必带（否则看板只有 `error` 三个字母），且截断到 200 字符。
   * @param {{status?:string, tokens?:number, cost?:number, chars?:number,
   *   errorMessage?:string, stopReason?:string}} facts
   */
  const end = (facts = {}) => {
    const reason = facts.errorMessage ? String(facts.errorMessage).slice(0, REASON_MAX) : undefined
    write('arm_end', 1, {
      status: facts.status,
      stopReason: facts.stopReason,
      tokens: facts.tokens,
      cost: facts.cost,
      chars: facts.chars,
      tools,
      lastTool,
      elapsedMs: now() - startedAt,
      ...(reason ? { reason } : {}),
    })
  }

  return { onEvent, end, stats: () => ({ tools, lastTool, elapsedMs: now() - startedAt }) }
}
