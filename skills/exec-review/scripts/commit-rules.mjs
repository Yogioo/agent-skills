/**
 * exec-review 独有的 git 编排边界（非提交格式——格式由仓库 skills / AGENTS.md / runner 注入）。
 *
 * 分工：执行端 **commit**；审查端 refined 时 **amend** 执行端 commit（一任务一 commit）。
 */

/**
 * @param {{ gitCommit: boolean, isGit: boolean }} ctx
 */
export function buildExecutorCommitRule({ gitCommit, isGit }) {
  if (!isGit || !gitCommit) {
    return '不要提交（提交由调用方负责）。'
  }
  return [
    '本任务 git 分工：执行端 **commit**，审查端 **amend** 该 commit。',
    '`done` 且改了文件：输出 JSON 前 **commit**（本任务仅一个 commit）。',
    '`no_change` / `blocked` / `empty`：不提交。',
    '完成标准：输出 JSON 时 `git status --porcelain` 为空（已 commit 或无应保留改动）。',
  ].join('\n')
}

/**
 * @param {{ gitCommit: boolean, isGit: boolean, baseHead?: string }} ctx
 */
export function buildReviewerGitContext({ gitCommit, isGit, baseHead = '' }) {
  if (!isGit || !baseHead) return ''

  let ctx = `\n## Git 参考\n\n任务开始前的 BASE_HEAD：\`${baseHead}\`。可用 \`git diff ${baseHead}\` 查看执行端以来的改动。\n`

  if (gitCommit) {
    ctx += `\n## Seal\n\n分工：执行端已 **commit**；审查端 **amend** 该 commit（不另起新 commit）。\n\n**完成标准：** \`git status --porcelain\` 为空。\n\n**refined**（审查改动了文件）：\n\n1. stage 审查改动。\n2. \`git commit --amend --no-edit\`（并入执行端 commit）。\n3. 确认 \`git status --porcelain\` 为空。\n\n**clean：** 未改文件，无需 amend。\n\n**兜底：** 若 \`git rev-list --count ${baseHead}..HEAD\` 为 0（执行端未 commit），先 \`git commit\` 本任务改动再输出 JSON。\n`
  } else {
    ctx += '\n不要提交（提交由调用方负责）。\n'
  }

  return ctx
}
