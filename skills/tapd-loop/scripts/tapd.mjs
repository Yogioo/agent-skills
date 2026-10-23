/**
 * TAPD 通道。只做四件事：拉就绪卡、读详情、写标签、写评论。
 * 命令走本机 tapd-cli，参数名一律下划线（连字符会被静默丢弃）。
 * 标签是多选字段，多个值用竖线分隔；写完必须回读，否则会把整串当新标签名。
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const LABEL_SEP = '|'
const PAGE = 200
const MAX_PAGES = 20
const MAX_BUFFER = 32 * 1024 * 1024
const MAX_IMAGES = 30
const IMAGE_TIMEOUT_MS = 30000

export const DEFAULTS = {
  readyLabel: 'ready-for-agent',
  claimedLabel: 'afk-claimed',
  deliveredLabel: 'afk-delivered',
  failedLabel: 'afk-failed',
  commentAuthor: '',
}

/** 只有这两个状态允许接单。其余状态（策划中/待启动/验收/已完成）一律不碰。 */
export const DEFAULT_STATUSES = ['developing', 'status_11']

/**
 * 「前置需求算完成了」的判定：有 task.doneStatuses 就按它（状态码或中文名都行），
 * 没配就按状态中文名猜。中文名猜测先排除「待/未/不/非」开头，否则「待完成」会被当成完成。
 */
const DONE_LABEL_RE = /(已完成|已关闭|已发布|已上线|已验收|已结|完成|关闭)/
const NOT_DONE_LABEL_RE = /^(待|未|不|非)/
/** 依赖查询按进程缓存 60 秒：listReady/listRejected/claim 会重复问同一张卡。 */
const DEP_TTL_MS = 60 * 1000

export function createTapd(opts = {}) {
  const workspaceId = String(opts.workspaceId || firstWorkspaceId())
  const assignee = String(opts.assignee || '')
  const labels = { ...DEFAULTS, ...(opts.labels || {}) }
  const bin = opts.bin || 'tapd-cli'
  const author = opts.commentAuthor || process.env.TAPD_NPC_ROLE || assignee
  const statuses = Array.isArray(opts.statuses) && opts.statuses.length
    ? opts.statuses.map(String)
    : [...DEFAULT_STATUSES]
  // 依赖检查默认开：TAPD 里标了「前置需求」的，前置没完成就不接这张卡。
  const checkDependencies = opts.checkDependencies !== false
  const doneStatuses = Array.isArray(opts.doneStatuses) ? opts.doneStatuses.map(String) : []
  let depSupported = true
  const depCache = new Map()
  let statusMap = null

  /**
   * @param {string[]} args tapd-cli 参数
   * @param {{ lenient?: boolean }} o 写类命令用 lenient：它们只回一个不带 status 的壳（长评论时还会夹一行日志），
   *   套读命令的 {status:1,data} 校验会把已经写成功的操作当成异常。写操作的可信度靠回读验证。
   */
  function call(args, o = {}) {
    let out
    try {
      out = execFileSync(bin, args, {
        cwd: opts.cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        timeout: opts.timeoutMs || 60000,
        maxBuffer: MAX_BUFFER,
      })
    } catch (err) {
      const detail = String(err?.stderr || err?.message || '').trim()
      throw new Error(`${bin} ${args.join(' ')} 失败: ${detail}`)
    }
    // 回执形状对不上时（历史上 comment add 就被误判成失败过），用这个把原始 stdout 看一眼。
    if (process.env.TAPD_LOOP_DEBUG) {
      process.stderr.write(`[tapd-cli] ${args[0]} ${args[1] || ''} -> ${out.slice(0, 2000)}\n`)
    }
    let body
    try {
      body = JSON.parse(out)
    } catch {
      // tapd-cli 写长评论时会先打一行日志再把内容回显，JSON 前后有噪音。
      body = parseLoose(out)
      if (!body) throw new Error(`${bin} 返回的不是 JSON: ${out.slice(0, 300)}`)
    }
    const failed = (body.status !== undefined && Number(body.status) !== 1) || body.error
    if (failed) {
      const hint = String(body.info || body.error || '').trim()
      throw new Error(`${bin} ${args.join(' ')} 返回 status=${body.status}: ${hint}`)
    }
    if (!o.lenient && body.status !== 1 && body.data === undefined) {
      throw new Error(`${bin} ${args.join(' ')} 返回无法识别的回执: ${out.slice(0, 300)}`)
    }
    return body
  }

  function stories(extra) {
    const rows = []
    for (let page = 1; page <= MAX_PAGES; page++) {
      const body = call([
        'story', 'list',
        `workspaceid=${workspaceId}`,
        ...extra,
        `limit=${PAGE}`,
        `page=${page}`,
      ])
      const batch = (body.data || []).map((row) => row.Story).filter(Boolean)
      rows.push(...batch)
      if (batch.length < PAGE) break
    }
    return rows
  }

  function splitLabels(value) {
    return String(value || '')
      .split(LABEL_SEP)
      .map((label) => label.trim())
      .filter(Boolean)
  }

  function machineOf(value) {
    const found = splitLabels(value)
    return found.find((label) => [labels.claimedLabel, labels.deliveredLabel, labels.failedLabel].includes(label)) || ''
  }

  function statusLabels() {
    if (!statusMap) {
      // 显式带 workspaceid：项目可能来自配置而不是环境变量里的第一个。
      const body = call(['story', 'fields', `workspaceid=${workspaceId}`])
      statusMap = body.data?.status?.options || {}
    }
    return statusMap
  }

  function statusLabel(status) {
    return statusLabels()[status] || String(status)
  }

  /** 前置需求是否算做完。 */
  function isDoneStory(row) {
    const code = String(row?.status || '')
    const label = String(statusLabel(code) || '').trim()
    if (doneStatuses.length) return doneStatuses.includes(code) || doneStatuses.includes(label)
    return !NOT_DONE_LABEL_RE.test(label) && DONE_LABEL_RE.test(label)
  }

  /**
   * 取这张卡的前置关系。返回统一后的扁平对象（TAPD 会把每条包在 WorkitemTimeRelation 里）。
   * 老版本 tapd-cli 没有 `story time-relations`，失败一次就永久降级为「不检查依赖」，
   * 免得整批卡在同一个不支持的命令上。
   */
  function relationsOf(id) {
    if (!depSupported) return []
    try {
      const body = call(['story', 'time-relations', `workspaceid=${workspaceId}`, `story-id=${id}`])
      if (!Array.isArray(body.data)) return []
      return body.data
        .map((row) => row?.WorkitemTimeRelation || row)
        .filter((row) => row && typeof row === 'object')
    } catch (err) {
      depSupported = false
      process.stderr.write(
        `[tapd-loop] 依赖检查已跳过：tapd-cli story time-relations 调用失败（${err.message}）。升级 tapd-cli（>= 1.16）后可恢复\n`,
      )
      return []
    }
  }

  /**
   * 前置没完成的卡 [{id, status, statusLabel, title}]；空数组表示可以开工。
   *
   * 方向按记录里的 src(src_field) / dst(dst_field) 判，不靠 relation_type 猜：
   * - type=after（默认）：dst 是后置，被 src 挡，所以只有 dst 会被卡。
   * - type=before：反过来，src 被 dst 挡。
   * 只认「前置已完成」：begin 型依赖（前置只要开始）也会按完成判，偏保守；
   * 不想要这种保守就用 task.checkDependencies=false 关掉，或在 task.doneStatuses 里写宽一点。
   */
  function blockersOf(id) {
    if (!checkDependencies || !id) return []
    const key = String(id)
    const hit = depCache.get(key)
    if (hit && Date.now() - hit.at < DEP_TTL_MS) return hit.blockers
    const depIds = []
    for (const rel of relationsOf(key)) {
      const src = String(rel.workitem_id || '')
      const dst = String(rel.dst_workitem_id || '')
      const before = String(rel.relation_type || 'after') === 'before'
      const blocked = before ? src : dst
      const prerequisite = before ? dst : src
      if (blocked === key && prerequisite && prerequisite !== key) depIds.push(prerequisite)
    }
    const blockers = []
    for (const depId of [...new Set(depIds)]) {
      let row
      try {
        row = getStory(depId)
      } catch {
        blockers.push({ id: depId, status: '', statusLabel: '查不到', title: '' })
        continue
      }
      if (isDoneStory(row)) continue
      blockers.push({ id: String(row.id), status: String(row.status || ''), statusLabel: statusLabel(row.status), title: String(row.name || '') })
    }
    depCache.set(key, { at: Date.now(), blockers })
    return blockers
  }

  function blockerNote(blockers) {
    return `前置未完成: ${blockers.map((b) => `${b.id}(${b.statusLabel})`).join('、')}`
  }

  function describe(story) {
    return {
      id: String(story.id),
      title: String(story.name || ''),
      priority: priorityOf(story.priority),
      priorityLabel: String(story.priority || ''),
      status: String(story.status || ''),
      statusLabel: statusLabel(story.status),
      labels: splitLabels(story.label),
    }
  }

  function listTagged() {
    if (!assignee) throw new Error('缺少 task.assignee，无法判断处理人')
    return stories([`owner=${assignee}`, `label=${labels.readyLabel}`])
      .filter((story) => splitLabels(story.label).includes(labels.readyLabel))
      .filter((story) => !machineOf(story.label))
      .map(describe)
      .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
  }

  /** 带标签只是候选；状态必须是实现中或开发中、且前置都完成，才允许接单。 */
  function partition(cards) {
    const ready = []
    const rejected = []
    for (const card of cards) {
      const statusOk = statuses.includes(card.status)
      const blockers = blockersOf(card.id)
      if (statusOk && !blockers.length) {
        ready.push(card)
        continue
      }
      const reason = [
        statusOk ? '' : `状态 ${card.statusLabel}，不在可接单范围`,
        blockers.length ? blockerNote(blockers) : '',
      ].filter(Boolean).join('；')
      rejected.push({ ...card, blockers, reason })
    }
    return { ready, rejected }
  }

  function listReady() {
    return partition(listTagged()).ready
  }

  function listRejected() {
    return partition(listTagged()).rejected
  }

  function getStory(id) {
    const rows = stories([`id=${id}`])
    const story = rows[0]
    if (!story) throw new Error(`TAPD 上找不到需求 ${id}`)
    return story
  }

  function listComments(id) {
    const body = call([
      'comment', 'list',
      `workspaceid=${workspaceId}`,
      'entry_type=stories',
      `entry_id=${id}`,
      'limit=200',
    ])
    return (body.data || [])
      .map((row) => row.Comment || row)
      .filter(Boolean)
      .map((row) => ({
        id: String(row.id || ''),
        author: String(row.author || row.user_name || ''),
        created: String(row.created || ''),
        description: String(row.description || ''),
      }))
      .sort((a, b) => a.created.localeCompare(b.created))
  }

  function getDetail(id, opts = {}) {
    const story = getStory(id)
    const comments = listComments(id)
    const imageDir = opts.imageDir || ''
    const images = []
    let counter = 0

    async function localize(html, prefix) {
      let out = String(html || '')
      for (const path of extractImagePaths(out)) {
        counter += 1
        try {
          const rel = await downloadImage(path, imageDir, counter)
          images.push(rel)
          out = replaceImage(out, path, `![图片](${prefix}${rel})`)
        } catch {
          out = replaceImage(out, path, `[图片下载失败: ${path}]`)
        }
      }
      return out
    }

    return (async () => {
      const description = htmlToText(await localize(story.description, 'images/'))
      const rows = []
      for (const comment of comments) {
        rows.push({
          author: comment.author,
          created: comment.created,
          text: htmlToText(await localize(comment.description, 'images/')),
        })
      }
      const blocks = [description]
      for (const row of rows) {
        blocks.push(`--- 评论 ${row.created} ${row.author} ---\n${row.text}`)
      }
      return {
        id: String(story.id),
        title: String(story.name || ''),
        status: String(story.status || ''),
        statusLabel: statusLabel(story.status),
        priorityLabel: String(story.priority || ''),
        owner: String(story.owner || '').replace(/;\s*$/, ''),
        url: `https://www.tapd.cn/tapd_fe/${workspaceId}/story/detail/${story.id}`,
        description,
        comments: rows,
        images,
        labels: splitLabels(story.label),
        commentCount: rows.length,
        body: blocks.filter(Boolean).join('\n\n'),
      }
    })()
  }

  async function downloadImage(imagePath, imageDir, index) {
    if (!imageDir) throw new Error('未指定图片目录')
    const body = call([
      'attachment', 'get-image',
      `image_path=${imagePath}`,
      `workspaceid=${workspaceId}`,
    ])
    const url = body.data?.Attachment?.download_url || ''
    if (!url) throw new Error('get-image 没有返回 download_url')
    const response = await fetch(url, { signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    if (!bytes.length) throw new Error('图片为空')
    const ext = (imagePath.match(/\.(png|jpe?g|gif|webp|bmp)$/i)?.[1] || 'png').toLowerCase()
    const rel = `img-${index}.${ext}`
    mkdirSync(imageDir, { recursive: true })
    writeFileSync(join(imageDir, rel), bytes)
    return rel
  }

  function writeLabels(id, wanted) {
    const story = getStory(id)
    const current = splitLabels(story.label)
    const next = [...new Set([...current, ...wanted])]
    call([
      'story', 'update',
      `workspaceid=${workspaceId}`,
      `id=${id}`,
      `label=${next.join(LABEL_SEP)}`,
    ])
    const back = splitLabels(getStory(id).label)
    const missing = next.filter((label) => !back.includes(label))
    if (missing.length) {
      throw new Error(`标签回读不一致 ${id}: 期望 ${next.join(LABEL_SEP)}，实际 ${back.join(LABEL_SEP)}`)
    }
  }

  function removeLabels(id, unwanted) {
    const story = getStory(id)
    const next = splitLabels(story.label).filter((label) => !unwanted.includes(label))
    call([
      'story', 'update',
      `workspaceid=${workspaceId}`,
      `id=${id}`,
      `label=${next.join(LABEL_SEP)}`,
    ])
    const back = splitLabels(getStory(id).label)
    const leftovers = unwanted.filter((label) => back.includes(label))
    if (leftovers.length) {
      throw new Error(`标签未撤掉 ${id}: ${leftovers.join(LABEL_SEP)}`)
    }
  }

  function addComment(id, description) {
    if (!author) throw new Error('缺少 commentAuthor 或 TAPD_NPC_ROLE，写不了评论')
    call([
      'comment', 'add',
      `workspaceid=${workspaceId}`,
      'entry_type=stories',
      `entry_id=${id}`,
      `author=${author}`,
      `description=${description}`,
    ], { lenient: true })
  }

  function updateComment(commentId, description) {
    if (!commentId) throw new Error('缺少评论 ID，无法修正评论')
    call([
      'comment', 'update',
      `workspaceid=${workspaceId}`,
      `id=${commentId}`,
      `description=${description}`,
    ], { lenient: true })
  }

  return {
    workspaceId,
    labels,
    listReady,
    listTagged,
    listRejected,
    partitionTagged: (cards) => partition(cards),
    getCard: (id) => describe(getStory(id)),
    statuses,
    statusLabel,
    checkDependencies,
    blockersOf,
    isDoneStory,
    getDetail,
    getStory,
    listComments,
    writeLabels,
    removeLabels,
    addComment,
    updateComment,

    claim(id) {
      const story = getStory(id)
      const machine = machineOf(story.label)
      if (machine) return { ok: false, reason: `已带 ${machine}` }
      if (!statuses.includes(String(story.status))) {
        return { ok: false, reason: `状态 ${statusLabel(story.status)}，不在可接单范围` }
      }
      const blockers = blockersOf(id)
      if (blockers.length) return { ok: false, reason: blockerNote(blockers), blockers }
      writeLabels(id, [labels.claimedLabel])
      return { ok: true }
    },

    deliver(id, note) {
      removeLabels(id, [labels.claimedLabel])
      writeLabels(id, [labels.deliveredLabel])
      addComment(id, note)
    },

    fail(id, note) {
      removeLabels(id, [labels.claimedLabel])
      writeLabels(id, [labels.failedLabel])
      addComment(id, note)
    },
  }
}

function parseLoose(text) {
  const source = String(text || '')
  const start = source.indexOf('{')
  if (start < 0) return null
  for (let i = source.indexOf('}', start); i > 0; i = source.indexOf('}', i + 1)) {
    try {
      return JSON.parse(source.slice(start, i + 1))
    } catch {
      // 嵌套对象会在内层 `}` 处失败，继续找下一个
    }
  }
  return null
}

function priorityOf(value) {
  const match = /P(\d)/i.exec(String(value || ''))
  if (match) return Number(match[1])
  const cn = { 高: 0, 中: 1, 低: 2 }
  return cn[String(value || '').trim()] ?? 9
}

function firstWorkspaceId() {
  const raw = String(process.env.TAPD_WORKSPACE_IDS || '').split(',')[0].trim()
  if (!raw) throw new Error('缺少 workspaceId，且 TAPD_WORKSPACE_IDS 为空')
  return raw
}

function extractImagePaths(html) {
  const source = String(html || '')
  const found = new Set()
  for (const match of source.matchAll(/(?:src|href)\s*=\s*["']?(\/tfl\/[^"'\s>]+)/gi)) found.add(match[1])
  for (const match of source.matchAll(/\]\(\s*(\/tfl\/[^)\s]+)\s*\)/g)) found.add(match[1])
  return [...found].slice(0, MAX_IMAGES)
}

/** 先换整个标签，再换裸路径；否则 img 标签会连同 markdown 一起被 htmlToText 删掉。 */
function replaceImage(html, imagePath, markdown) {
  const escaped = imagePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return String(html)
    .replace(new RegExp(`<img[^>]*${escaped}[^>]*>`, 'gi'), markdown)
    .replace(new RegExp(`<a[^>]*${escaped}[^>]*>[\\s\\S]*?<\/a>`, 'gi'), markdown)
    .replace(new RegExp(escaped, 'g'), markdown)
}

export function htmlToText(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
