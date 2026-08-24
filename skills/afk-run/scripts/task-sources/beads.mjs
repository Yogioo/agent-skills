/**
 * beads 任务源 adapter。
 *
 * 已验证的 CLI 事实（2026-08，Windows）：
 * - `bd ready --json`：合法 JSON，含 id/title/status/priority/issue_type/dependency_count/dependent_count
 *   —— 原生就绪检测（无 open blocker 的工单）；**不排除 afk-failed**，需自行过滤。
 * - `bd show --json`：**非法 JSON**（description 内换行未转义）→ 弃用。
 * - `bd list --id <id> --json`：合法 JSON，含 description/labels/priority/title —— getDetail 用这个。
 * - `bd update <id> --claim`：置 in_progress，且 in_progress 工单不再出现在 bd ready（中断重启天然保守跳过）。
 * - Windows 上 npm 全局 `bd` 是 .cmd wrapper，execFileSync 找不到 → 直接定位 @beads/bd/bin/bd.js 用 node 跑。
 *
 * 约定：priority 0=Critical / 4=Backlog；排序取数值升序 + id 升序（稳定）。
 * 失败任务打 `afk-failed` label 排除出就绪池（宁可漏跑，不可重跑）。
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 解析 bd CLI：Windows 上 npm 全局的 `bd` 是 .cmd wrapper（execFileSync 找不到），
 * 直接定位 npm 包内的 bd.js 用 node 跑；否则回退 PATH 上的 bd。
 */
function resolveBd() {
  const root = process.env.APPDATA || ''
  const js = join(root, 'npm', 'node_modules', '@beads', 'bd', 'bin', 'bd.js')
  if (js && existsSync(js)) {
    return { command: process.execPath, prefix: [js] }
  }
  return { command: 'bd', prefix: [] }
}

const BD = resolveBd()

function runBd(cwd, args) {
  return execFileSync(BD.command, [...BD.prefix, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
}

/**
 * @param {{ cwd?: string }} [opts] cwd 必须能发现 .beads 库（通常就是 workdir）
 */
export function createBeadsSource(opts = {}) {
  const cwd = opts.cwd || process.cwd()

  return {
    name: 'beads',

    listReady() {
      // bd ready 不排除 afk-failed 工单，需要自己过滤；labels 从 bd list 拿（ready 输出无 labels）
      const ready = JSON.parse(runBd(cwd, ['ready', '--json']))
      const open = JSON.parse(runBd(cwd, ['list', '--json']))
      const failedIds = new Set(
        open
          .filter((r) => Array.isArray(r.labels) && r.labels.includes('afk-failed'))
          .map((r) => r.id),
      )
      return ready
        .filter((r) => r && r.id && !failedIds.has(r.id))
        .map((r) => ({
          id: r.id,
          title: r.title || r.id,
          priority: Number.isFinite(r.priority) ? r.priority : 2,
        }))
        .sort(
          (a, b) =>
            (a.priority ?? 2) - (b.priority ?? 2) || a.id.localeCompare(b.id),
        )
    },

    getDetail(id) {
      const raw = runBd(cwd, ['list', '--id', id, '--json'])
      const rows = JSON.parse(raw)
      const r = rows && rows[0]
      if (!r || !r.id) {
        throw new Error(`工单不存在或无法读取: ${id}`)
      }
      return {
        id: r.id,
        title: r.title || r.id,
        body: r.description || '',
        requirements: '',
      }
    },

    markInProgress(id) {
      runBd(cwd, ['update', id, '--claim'])
    },

    markDone(id, result = {}) {
      const reason = `afk: ${result.status || 'done'} — ${String(result.summary || '').slice(0, 200)}`
      runBd(cwd, ['close', id, '--reason', reason])
    },

    markFailed(id, note = '') {
      runBd(cwd, ['label', 'add', id, 'afk-failed'])
      runBd(cwd, ['comment', id, `afk failed: ${String(note).slice(0, 300)}`])
    },

    /**
     * stuck = open 全集 − ready 集合（排除 afk-failed，失败任务不算阻塞）。
     */
    describeBlocked() {
      const readyIds = new Set(this.listReady().map((t) => t.id))
      const rows = JSON.parse(runBd(cwd, ['list', '--json']))
      return rows
        .filter(
          (r) =>
            r &&
            r.id &&
            r.status !== 'closed' &&
            !readyIds.has(r.id) &&
            !(Array.isArray(r.labels) && r.labels.includes('afk-failed')),
        )
        .map((r) => ({ id: r.id, title: r.title || r.id }))
    },
  }
}