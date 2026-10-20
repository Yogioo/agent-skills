/**
 * 把一张 TAPD 需求变成内循环的 brief。
 * 内循环是 yogioo-mode（poteto playbook + 本机零件），外循环只提供卡与边界。
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function buildBrief(opts) {
  const { card, workdir, skillPath, verify = '', attempt = 1, cardMdPath = '' } = opts

  const lines = [
    `你是这张需求的唯一执行端。工作目录是 ${workdir}。`,
    '',
    '## 内循环',
    '',
    `yogioo-mode（完整指令已随系统提示注入，技能目录 ${skillPath}）。不要再去读 SKILL.md。`,
    '',
    '## 这张需求',
    '',
    `- 卡片：${card.id}`,
    `- 标题：${card.title}`,
    cardMdPath ? `- 完整工单（含评论与图片）：${cardMdPath}` : null,
    attempt > 1 ? `- 这是第 ${attempt} 次尝试，上一次的失败原因在评论里。` : null,
    '',
    '## 正文',
    '',
    card.body || '（正文为空，按标题做最小改动，并在总结里说明你如何理解它）',
    '',
    '## 外循环的边界',
    '',
    '- 只改这张卡范围内的文件。发现范围外的问题，写进总结，不要顺手改。',
    '- 不要 git add / commit / checkout / reset / stash。提交、回滚、验收由外循环做，你只管让工作区留下正确的改动。',
    '- 不要问人，不要等确认，不要以「需要确认」结束。能自己观察到的就去观察。',
    '- 不要为一张卡开多个写入方。需要调查可以派只读的 arm，但改动只由你写。',
    '- 结束时不要留下注释掉的代码、TODO 注释、临时调试文件。',
    '',
    '## 完成定义',
    '',
    verify ? `工作区留下真实改动，并且这条命令退出码为 0：\n\n\`\`\`\n${verify}\n\`\`\`` : '工作区留下真实改动。',
    '',
    '## 提交',
    '',
    '提交由外循环做，你不要执行任何 git 命令。最后两行按这个格式输出：',
    '',
    '```',
    'RESULT: <一句话说清改了什么、怎么证明的>',
    `COMMIT: <type>:${String(card.id || '').slice(-7)} <中文描述>`,
    '```',
    '',
    `type 从 feat / fix / docs / art / style / refactor / test / chore / perf / revert 里选一个，工单号固定写 ${String(card.id || '').slice(-7)}。`,
  ]

  return lines.filter((line) => line !== null).join('\n') + '\n'
}

/**
 * 按项目 digitdoor-git-commit 的约定生成 message：`<type>:<7位工单号> <中文描述>`。
 * 内循环给的 COMMIT 行工单号对不上就用卡片标题兜底，绝不把 19 位 id 写进去。
 */
export function commitMessage(text, card) {
  const short = String(card.id || '').slice(-7)
  const hit = /^COMMIT:\s*(feat|fix|docs|art|style|refactor|test|chore|perf|revert)\s*[:：]\s*(\d{7})\s+(.+)$/m.exec(String(text || ''))
  if (hit && hit[2] === short) return `${hit[1]}: ${short} ${hit[3].trim()}`.slice(0, 120)
  return `feat: ${short} ${card.title}`.slice(0, 120)
}

export function writeBrief(outDir, text) {
  const path = join(outDir, 'brief.md')
  writeFileSync(path, text, 'utf8')
  return path
}

/** 完整工单落成本地 md，图片用 images/ 下的相对路径。 */
export function buildCardMd(detail) {
  const lines = [
    `# ${detail.title}`,
    '',
    `- 卡片：${detail.id}`,
    `- 状态：${detail.statusLabel}`,
    `- 优先级：${detail.priorityLabel}`,
    `- 处理人：${detail.owner}`,
    `- 链接：${detail.url}`,
    '',
    '## 描述',
    '',
    detail.description || '（空）',
  ]
  if (detail.comments.length) {
    lines.push('', '## 评论')
    for (const comment of detail.comments) {
      lines.push('', `### ${comment.created} ${comment.author}`, '', comment.text || '（空）')
    }
  }
  return lines.join('\n') + '\n'
}
