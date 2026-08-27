/**
 * git 操作封装（AFK 循环专用）。
 * 职责：init 兜底、干净校验、HEAD 读取、失败回滚。
 * 提交由 exec-review 端处理（gitCommit 开启时）；AFK 只要求任务间工作区干净。
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
 * 非 git 仓库则 git init。
 *
 * 提交身份默认沿用用户全局/系统 git 配置（不写 local user.*）。
 * 仅当 `useBotIdentity: true` 时，才写入 local user.name / user.email（CLI > 参数 > 默认 AFK Bot）。
 *
 * @param {string} workdir
 * @param {{ useBotIdentity?: boolean, name?: string, email?: string }} [identity]
 */
export function ensureGit(workdir, identity = {}) {
  if (!isGitRepo(workdir)) {
    runGit(workdir, ['init'])
  }
  if (!identity.useBotIdentity) {
    return isGitRepo(workdir)
  }
  const name = identity.name || 'AFK Bot'
  const email = identity.email || 'afk@local'
  runGit(workdir, ['config', '--local', 'user.name', name])
  runGit(workdir, ['config', '--local', 'user.email', email])
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
