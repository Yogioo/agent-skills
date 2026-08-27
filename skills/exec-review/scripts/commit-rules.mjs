/**
 * exec-review 独有的 git 编排边界（非提交格式——格式由仓库技能 / AGENTS.md / runner 注入）。
 */

/**
 * @param {{ gitCommit: boolean, isGit: boolean }} ctx
 */
export function buildExecutorCommitRule({ gitCommit, isGit }) {
  if (!isGit || !gitCommit) {
    return '不要提交（提交由调用方负责）。'
  }
  return '有应保留改动则完成后 commit；blocked / 无应保留改动则不提交。'
}

/**
 * @param {{ gitCommit: boolean, isGit: boolean, baseHead?: string }} ctx
 */
export function buildReviewerGitContext({ gitCommit, isGit, baseHead = '' }) {
  if (!isGit || !baseHead) return ''

  let ctx = `\n## Git 参考\n\n任务开始前的 BASE_HEAD：\`${baseHead}\`。可用 \`git diff ${baseHead}\` 查看执行端以来的改动。\n`

  if (gitCommit) {
    ctx += '\n收尾时工作区应干净。\n'
  } else {
    ctx += '\n不要提交（提交由调用方负责）。\n'
  }

  return ctx
}
