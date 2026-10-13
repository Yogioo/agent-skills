/**
 * 任务源 adapter 工厂。
 * 接口：
 *   listReady()          → [{id, title, priority}] 已就绪（无未完成前置）+ 排序好的
 *   tryClaim(id)         → { status: claimed|already-claimed|unsupported|error, claimMode }
 *   claimMode            → atomic | best-effort | unsupported
 *   getDetail(id)        → {id, title, body, requirements}
 *   markInProgress(id)   → 认领（afk-run 批次仍走这条，不改现有语义）
 *   markDone(id, result) → result: {status, summary, commit?}
 *   closeEligibleParents?() → string[] 子单成功后收尾父容器（beads: bd epic close-eligible）
 *   markFailed(id, note)
 *   （no_change 没有对应调用：不重试、不打退避标记，工单保持认领状态等人工确认）
 *   recoverStale?(thresholdSec, now = Date.now) → string[] 仅 beads 实现的启动期 stale 恢复
 *   describeBlocked()    → { ready, blocked: [{id, title, blockedBy?}], inProgress: [{id, title}] }
 */

import { basename, resolve } from 'node:path'
import { createBeadsSource } from './beads.mjs'
import { createGhSource } from './gh.mjs'
import { createTapdSource } from './tapd.mjs'

export const SOURCES = ['beads', 'gh', 'tapd']

export function createSource(name, opts = {}) {
  const key = String(name || 'beads').toLowerCase()
  switch (key) {
    case 'beads':
      // 同一 beads 库被多个 worktree 共用时，按 workdir 区分 actor，`--claim` 才能互斥；
      // 同 workdir 的 watcher 与 afk-run 共用一个 actor，pinned 交接时重复认领仍成功。
      return createBeadsSource({
        ...opts,
        actor: opts.actor || (opts.cwd ? `afk@${basename(resolve(opts.cwd))}` : ''),
      })
    case 'gh':
      return createGhSource(opts)
    case 'tapd':
      return createTapdSource(opts)
    default:
      throw new Error(`未知任务源: ${name}（支持: ${SOURCES.join(', ')}）`)
  }
}

export { createBeadsSource }
export { createGhSource }
export { createTapdSource }
