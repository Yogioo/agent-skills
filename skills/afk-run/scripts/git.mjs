/**
 * git 操作封装（AFK 循环专用）。
 * 职责：init 兜底、干净校验、HEAD 读取、统一提交、失败回滚。
 *
 * 边界：新 init 的仓库没有 HEAD——`head()` 返回 null，`resetHard()` 在无 HEAD
 * 时退化为 `git clean -fd`（删除所有 untracked 文件，即任务产生的文件）。
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

function runGit(workdir, args) {
  return execFileSync('git', args, {
    cwd: workdir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function isGitRepo(workdir) {
  if (existsSync(join(workdir, '.git'))) return true
  try {
    return runGit(workdir, ['rev-parse', '--is-inside-work-tree']).trim() === 'true'
  } catch {
    return false
  }
}

/**
 * 非 git 仓库则 git init，并补默认提交身份（git init 不自带身份，不配 commit 会失败）。
 * @param {string} workdir
 * @param {{ name?: string, email?: string }} [identity]
 */
export function ensureGit(workdir, identity = {}) {
  if (!isGitRepo(workdir)) {
    runGit(workdir, ['init'])
  }
  // 只查/设 local 身份：全局身份存在时 commit 也能成功，但 AFK 要保证身份可追溯且不依赖用户全局配置
  let name = ''
  let email = ''
  try {
    name = runGit(workdir, ['config', '--local', 'user.name']).trim()
    email = runGit(workdir, ['config', '--local', 'user.email']).trim()
  } catch {
    // 无 local 配置则设置
  }
  if (!name) runGit(workdir, ['config', '--local', 'user.name', identity.name || 'AFK Bot'])
  if (!email) runGit(workdir, ['config', '--local', 'user.email', identity.email || 'afk@local'])
  return isGitRepo(workdir)
}

/** 工作区是否有未提交改动（含 untracked）。 */
export function isClean(workdir) {
  return runGit(workdir, ['status', '--porcelain']).trim() === ''
}

/**
 * 当前 HEAD；新仓库无 commit 时返回 null。
 * @returns {string|null}
 */
export function head(workdir) {
  try {
    return runGit(workdir, ['rev-parse', 'HEAD']).trim() || null
  } catch {
    return null
  }
}

/**
 * 统一提交所有改动（AFK 循环作为调用方提交）。
 * @param {string} workdir
 * @param {{ id: string, title: string, status: string, summary: string }} task
 * @param {string} [excludePath] 提交时排除的路径（如停止文件），防止把哨兵文件提交进去
 */
export function commitAll(workdir, task, excludePath = '') {
  if (excludePath) {
    runGit(workdir, ['add', '-A', '--', `:(exclude)${excludePath}`])
  } else {
    runGit(workdir, ['add', '-A'])
  }
  const title = `afk: ${task.id} ${task.title}`.slice(0, 200)
  const body = `status: ${task.status}\nsummary: ${String(task.summary || '').slice(0, 500)}`
  runGit(workdir, ['commit', '-m', title, '-m', body])
}

/**
 * 失败回滚：回到任务开始前基线（tracked 重置 + untracked 清除）。
 * 有 HEAD → reset --hard + clean -fd；无 HEAD（新仓库首任务失败）→ 仅 clean -fd。
 * @param {string} workdir
 * @param {string|null} headRef
 * @param {string} [exclude] clean 时排除的路径（如停止文件），防止删掉哨兵
 */
export function resetHard(workdir, headRef, exclude = '') {
  if (headRef) {
    runGit(workdir, ['reset', '--hard', headRef])
  }
  const args = ['clean', '-fd']
  if (exclude) args.push('--', `:(exclude)${exclude}`)
  runGit(workdir, args)
}

export { isGitRepo }