/**
 * 任务源 adapter 工厂。
 * 接口（sealed）：
 *   listReady()          → [{id, title, priority}] 已就绪（无未完成前置）+ 排序好的
 *   getDetail(id)        → {id, title, body, requirements}
 *   markInProgress(id)   → 认领（防重入）
 *   markDone(id, result) → result: {status, summary, commit?}
 *   markFailed(id, note)
 *   recoverStale?(thresholdSec, now = Date.now) → string[] 仅 beads 实现的启动期 stale 恢复
 *   describeBlocked()    → { blocked: [{id, title}], inProgress: [{id, title}] }
 */

import { createBeadsSource } from './beads.mjs'
import { createGhSource } from './gh.mjs'

export const SOURCES = ['beads', 'gh']

export function createSource(name, opts = {}) {
  const key = String(name || 'beads').toLowerCase()
  switch (key) {
    case 'beads':
      return createBeadsSource(opts)
    case 'gh':
      return createGhSource(opts)
    default:
      throw new Error(`未知任务源: ${name}（支持: ${SOURCES.join(', ')}）`)
  }
}

export { createBeadsSource }
export { createGhSource }
