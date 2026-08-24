/**
 * 任务源 adapter 工厂。
 * 接口（sealed）：
 *   listReady()          → [{id, title, priority}] 已就绪（无未完成前置）+ 排序好的
 *   getDetail(id)        → {id, title, body, requirements}
 *   markInProgress(id)   → 认领（防重入）
 *   markDone(id, result) → result: {status, summary, commit?}
 *   markFailed(id, note)
 *   describeBlocked()    → [{id, title}] 未就绪的未完成工单（stuck 报告用）
 */

import { createBeadsSource } from './beads.mjs'

export const SOURCES = ['beads']

export function createSource(name, opts = {}) {
  const key = String(name || 'beads').toLowerCase()
  switch (key) {
    case 'beads':
      return createBeadsSource(opts)
    default:
      throw new Error(`未知任务源: ${name}（支持: ${SOURCES.join(', ')}）`)
  }
}

export { createBeadsSource }