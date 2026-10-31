/**
 * 一次合入的 TAPD 回写：评论 → 状态流转 → 处理人交回创建人。
 *
 * 三个动作都要**回读校验**（TAPD 的状态流转会被工作流规则拦住：必填字段、必填意见），
 * 并且**幂等**（评论里已经有那个合并后 sha 就算做过），所以重跑只会补没做成的那几步。
 *
 * 这是**唯一实现**，两个调用方：
 *   - 仓库里的 Tools/Worktree/close.mjs（命令行收尾）：动态 import 本文件
 *   - 本目录的 control.mjs（看板合入）：静态 import
 *
 * 为什么住在技能里而不是仓库里：control.mjs 是同步调用链（三个 onSettled/onDone 回调），
 * 只能静态 import；而技能不该反向依赖某个仓库的 Tools/ 目录。所以实现住这儿，
 * 仓库那边用 Tools/Worktree/loop-skill.mjs 动态取。
 */

/** 评论正文。只报合并后的 sha：工位那个 sha 在 cherry-pick 之后已经查不到了。 */
export function buildNote({
  mergedSha, originSha = '', from = '', target = 'develop', pushed = false, remote = 'origin',
  doneStatus = '', extraNote = '', via = '',
}) {
  const short = String(mergedSha || '').slice(0, 10)
  const how = via ? `已推送到 ${target}（${via}）` : `已合入 ${target}`
  const lines = [
    `[tapd-loop] ${how}，合并后提交 ${short}${pushed ? `（已推送 ${remote}/${target}）` : '（未推送远端）'}。`,
  ]
  if (from) lines.push(`来源：${from}${originSha ? `（工位提交 ${String(originSha).slice(0, 10)}）` : ''}`)
  if (doneStatus) lines.push(`状态流转：${doneStatus}，处理人已交回创建人。`)
  if (extraNote) lines.push('', String(extraNote).trim())
  return lines.join('\n')
}

/**
 * 回写一张卡。同步执行（tapd-cli 是同步子进程），返回每一步的结果。
 * @returns {{ok:boolean, cardId:string, mergedSha:string, steps:object, errors:string[], commentReadError:string}}
 */
export function writeBack(opts) {
  const {
    tapd, cardId, mergedSha, originSha = '', from = '', target = 'develop', pushed = false,
    remote = 'origin', doneStatus = '', extraNote = '', via = '', dryRun = false,
  } = opts || {}
  if (!tapd) throw new Error('writeBack 缺 tapd 客户端')
  if (!cardId) throw new Error('writeBack 缺 cardId')
  const short = String(mergedSha || '').slice(0, 10)
  if (!short) throw new Error('writeBack 缺 mergedSha')

  const steps = {}
  const errors = []

  // 幂等判断先读 TAPD：调用方的缓存（close/state.json、看板 flowed 集合）都可以丢，
  // TAPD 上的评论不会。读失败不致命——只是幂等性退化，继续写，把原因单独带出去。
  let already = false
  let readError = ''
  try {
    const comments = tapd.listComments(cardId)
    already = comments.some((c) => String(c.description || '').includes(short))
  } catch (err) {
    readError = err.message
  }

  if (already) {
    steps.comment = { ok: true, skipped: `评论里已经有 ${short}` }
  } else if (dryRun) {
    steps.comment = { ok: true, skipped: 'dry-run' }
  } else {
    try {
      tapd.addComment(cardId, buildNote({ mergedSha, originSha, from, target, pushed, remote, doneStatus, extraNote, via }))
      steps.comment = { ok: true }
    } catch (err) {
      steps.comment = { ok: false, error: err.message }
      errors.push(`评论：${err.message}`)
    }
  }

  if (!doneStatus) {
    steps.status = { ok: true, skipped: '没配 doneStatus' }
  } else if (dryRun) {
    steps.status = { ok: true, skipped: 'dry-run' }
  } else {
    try {
      // setStatus 内部回读校验，改不动会抛（TAPD 要求必填意见就是这里暴露的）
      const moved = tapd.setStatus(cardId, doneStatus)
      steps.status = { ok: true, status: moved.label || doneStatus, unchanged: Boolean(moved.unchanged) }
    } catch (err) {
      steps.status = { ok: false, error: err.message }
      errors.push(`状态：${err.message}`)
    }
  }

  if (dryRun) {
    steps.owner = { ok: true, skipped: 'dry-run' }
  } else {
    try {
      const handed = tapd.handToCreator(cardId)
      steps.owner = { ok: true, owner: handed.owner || '', skipped: handed.skipped || '', unchanged: Boolean(handed.unchanged) }
    } catch (err) {
      steps.owner = { ok: false, error: err.message }
      errors.push(`处理人：${err.message}`)
    }
  }

  return { ok: errors.length === 0, cardId, mergedSha: short, steps, errors, commentReadError: readError }
}
