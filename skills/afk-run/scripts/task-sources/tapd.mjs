/**
 * TAPD 任务源 adapter。
 *
 * 队列由标签定义（见 docs/adr/0003）：人类写 `ready-for-agent`，执行批次只写
 * `afk-claimed` / `afk-delivered` / `afk-failed`。批次不写状态，也不写处理人。
 *
 * 命令走本机已安装的 `tapd-cli`（见 docs/adr/0002）。参数名一律用下划线：
 * tapd-cli 会**静默丢弃**连字符形式的参数，把带过滤的查询变成不带过滤的查询。
 * 找不到 tapd-cli 直接抛错，绝不退化成空列表——空列表会让 watcher 安静空转。
 */

import { execFileSync } from 'node:child_process'

export const DEFAULT_READY_LABEL = 'ready-for-agent'
export const DEFAULT_CLAIMED_LABEL = 'afk-claimed'
export const DEFAULT_DELIVERED_LABEL = 'afk-delivered'
export const DEFAULT_FAILED_LABEL = 'afk-failed'

const PAGE_SIZE = 200
const MAX_PAGES = 20
const DEFAULT_RETRIES = 2
const DEFAULT_RETRY_DELAY_MS = 100
const COMMENT_PREFIX = '[AFK]'
const COMMENT_MAX = 2000
const UNPRIORITIZED = 1

/** TAPD 的 priority 是中文档位，不是数字。 */
const PRIORITY_BY_LABEL = { 高: 0, 中: 1, 低: 2 }

function sleep(ms) {
  if (ms <= 0) return
  const buffer = new SharedArrayBuffer(4)
  Atomics.wait(new Int32Array(buffer), 0, 0, ms)
}

function errorText(err) {
  return [err?.stderr, err?.stdout, err?.message]
    .filter(Boolean)
    .map((value) => String(value).trim())
    .filter(Boolean)
    .join(' ')
}

function isRetryableError(err) {
  const text = errorText(err).toLowerCase()
  return /network|timeout|timed out|timedout|connection|eai_again|econnreset|econnrefused|etimedout|enetunreach|ehostunreach|epipe|socket hang up|temporarily unavailable|rate limit|502|503|504|reset by peer|unexpected eof|\beof\b/.test(text)
}

function isMissingCommandError(err) {
  return err?.code === 'ENOENT' || /enoent|not recognized|not found|不是内部或外部命令/.test(errorText(err).toLowerCase())
}

/**
 * 调用 tapd-cli，对瞬时网络故障做有上限的重试。
 * @param {string[]} args
 * @param {{ command?: string, commandPrefix?: string[], cwd?: string, retries?: number, retryDelayMs?: number }} [opts]
 */
export function runTapd(args, opts = {}) {
  const command = opts.command || 'tapd-cli'
  const commandPrefix = Array.isArray(opts.commandPrefix) ? opts.commandPrefix : []
  const retries = Number.isInteger(opts.retries) ? Math.max(0, opts.retries) : DEFAULT_RETRIES
  const retryDelayMs = Number.isFinite(opts.retryDelayMs)
    ? Math.max(0, Number(opts.retryDelayMs))
    : DEFAULT_RETRY_DELAY_MS
  const full = [...commandPrefix, ...args].join(' ')

  for (let attempt = 0; ; attempt++) {
    try {
      return execFileSync(command, [...commandPrefix, ...args], {
        cwd: opts.cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (err) {
      if (isMissingCommandError(err)) {
        throw new Error(
          `找不到 tapd-cli 命令（${command}）。请先安装：https://cnb.cool/tapd.cn/skills/tapd-cli，或见 tapd-cli 技能。`,
          { cause: err },
        )
      }
      if (!isRetryableError(err) || attempt >= retries) {
        const detail = errorText(err)
        throw new Error(`tapd-cli 命令失败: ${full}${detail ? ` — ${detail}` : ''}`, { cause: err })
      }
      sleep(retryDelayMs * 2 ** attempt)
    }
  }
}

/** 解析 tapd-cli 的 JSON；TAPD 用 status=1 表示成功。 */
export function parseTapdPayload(raw, context) {
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`${context} 返回非法 JSON: ${err.message}`, { cause: err })
  }
  if (parsed && typeof parsed === 'object' && parsed.status !== undefined && Number(parsed.status) !== 1) {
    throw new Error(`${context} 失败: ${parsed.info || JSON.stringify(parsed).slice(0, 200)}`)
  }
  return parsed
}

/** TAPD 列表把实体包在 `{ Story: {...} }` 里。 */
export function storyRows(payload) {
  const rows = Array.isArray(payload?.data) ? payload.data : []
  return rows.map((row) => (row && row.Story) || row).filter((row) => row && row.id)
}

/** 标签读回来是 `a,b` 或 `a|b`；空字符串是「无标签」。 */
export function labelList(raw) {
  return String(raw ?? '')
    .split(/[|,]/)
    .map((value) => value.trim())
    .filter(Boolean)
}

export function hasLabel(labels, wanted) {
  if (!wanted) return false
  return (Array.isArray(labels) ? labels : []).includes(wanted)
}

export function priorityValue(raw) {
  return PRIORITY_BY_LABEL[String(raw || '').trim()] ?? UNPRIORITIZED
}

/**
 * 配置里的字段名一律给默认值——只有 assignee 必须显式配置。
 */
export function normalizeTapdConfig(raw = {}) {
  const cfg = raw && typeof raw === 'object' ? raw : {}
  const pick = (key, fallback) => String(cfg[key] ?? '').trim() || fallback
  return {
    assignee: String(cfg.assignee ?? '').trim(),
    readyLabel: pick('readyLabel', DEFAULT_READY_LABEL),
    claimedLabel: pick('claimedLabel', DEFAULT_CLAIMED_LABEL),
    deliveredLabel: pick('deliveredLabel', DEFAULT_DELIVERED_LABEL),
    failedLabel: pick('failedLabel', DEFAULT_FAILED_LABEL),
    commentAuthor: String(cfg.commentAuthor ?? '').trim(),
  }
}

/** 机器标签三件套；出现任意一个都表示这条已经不在就绪池里。 */
export function machineLabels(config) {
  return [config.claimedLabel, config.deliveredLabel, config.failedLabel].filter(Boolean)
}

export function machineLabelOf(labels, config) {
  return machineLabels(config).find((label) => hasLabel(labels, label)) || ''
}

const HTML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#x27': "'" }

/** 尽力把 TAPD 的 HTML 描述转成纯文本，保留图片链接。 */
export function htmlToText(html) {
  let text = String(html || '')
  if (!text) return ''
  text = text.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
  text = text.replace(/<img\b[^>]*?\bsrc\s*=\s*["']?([^"'\s>]+)[^>]*>/gi, '\n[图片]($1)\n')
  text = text.replace(/<br\s*\/?>/gi, '\n')
  text = text.replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
  text = text.replace(/<[^>]+>/g, '')
  text = text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, name) => HTML_ENTITIES[String(name).toLowerCase()] ?? match)
  return text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

export { COMMENT_PREFIX }

/**
 * 评论正文可能是纯文本，也可能是 HTML。只有认出真的 HTML 标签才走 htmlToText，
 * 否则 `a < b` 这类代码片段会被当成标签吃掉。
 */
export function commentText(raw) {
  const value = String(raw ?? '')
  // 标签名不能跟 `<` 分开，且必须以 `>` 收尾：`a < b && c > d` 不该被当成 HTML。
  if (/<\/?(p|div|br|span|img|a|ul|ol|li|strong|b|em|table|tr|td|h[1-6])(\s[^>]*)?\/?>/i.test(value)) {
    return htmlToText(value)
  }
  return value.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * 把描述和评论拼成进给执行端的正文。评论按时间升序，不给条数或长度上限。
 * @param {string} descriptionText 已经是纯文本的描述
 * @param {object[]} comments tapd-cli 返回的评论行
 */
export function renderTaskBody(descriptionText, comments = []) {
  const rows = (Array.isArray(comments) ? comments : [])
    .map((comment) => ({
      created: String(comment?.created || '').trim(),
      author: String(comment?.author || '').trim(),
      text: commentText(comment?.description),
    }))
    .filter((comment) => comment.text)
  const head = String(descriptionText || '').trim()
  if (!rows.length) return head
  const lines = rows.map((comment) => `- ${[comment.created, comment.author].filter(Boolean).join(' ')}：${comment.text}`)
  return [head || '（需求描述为空）', '', `## 评论（TAPD，时间升序，共 ${rows.length} 条）`, '', ...lines].join('\n')
}

/** 描述和评论都为空时，执行端无从下手——只能拒单，不能凭标题猜。 */
export function isBlankRequirement(descriptionText, comments = []) {
  if (String(descriptionText || '').trim()) return false
  return !(Array.isArray(comments) ? comments : []).some((comment) => commentText(comment?.description))
}

/**
 * @param {{ cwd?: string, tapd?: object, command?: string, commandPrefix?: string[], retries?: number, retryDelayMs?: number }} [opts]
 */
export function createTapdSource(opts = {}) {
  const cwd = opts.cwd || process.cwd()
  const config = normalizeTapdConfig(opts.tapd || opts.mapping || {})
  const request = (args) => runTapd(args, { ...opts, cwd })

  function requireAssignee() {
    if (!config.assignee) {
      throw new Error('TAPD 任务源缺少 tapd.assignee 配置（用处理人限定「我的需求」）')
    }
  }

  function fetchStories(extraArgs) {
    const rows = []
    for (let page = 1; page <= MAX_PAGES; page++) {
      const raw = request(['story', 'list', ...extraArgs, `limit=${PAGE_SIZE}`, `page=${page}`])
      const batch = storyRows(parseTapdPayload(raw, 'tapd-cli story list'))
      rows.push(...batch)
      if (batch.length < PAGE_SIZE) break
    }
    return rows
  }

  function fetchStory(id) {
    const rows = storyRows(parseTapdPayload(request(['story', 'list', `id=${id}`, 'limit=1']), 'tapd-cli story list'))
    const story = rows[0]
    if (!story) throw new Error(`TAPD 需求不存在或无权读取: ${id}`)
    return normalizeStory(story)
  }

  /** 评论按时间升序；不分页上限（MAX_PAGES 只封 API 调用次数，不封内容长度）。 */
  function fetchComments(id) {
    const rows = []
    for (let page = 1; page <= MAX_PAGES; page++) {
      const raw = request(['comment', 'list', 'entry_type=stories', `entry_id=${id}`, `limit=${PAGE_SIZE}`, `page=${page}`])
      const batch = (parseTapdPayload(raw, 'tapd-cli comment list').data || [])
        .map((row) => (row && row.Comment) || row)
        .filter(Boolean)
      rows.push(...batch)
      if (batch.length < PAGE_SIZE) break
    }
    return rows.sort((a, b) => String(a.created || '').localeCompare(String(b.created || '')))
  }

  function normalizeStory(story) {
    return {
      id: String(story.id),
      title: story.name || String(story.id),
      labels: labelList(story.label),
      priority: priorityValue(story.priority),
      owner: String(story.owner || '').replace(/;/g, '').trim(),
      status: String(story.status || ''),
      description: String(story.description ?? ''),
    }
  }

  const describeStory = (story) => ({ id: story.id, title: story.title, priority: story.priority })

  /**
   * 写标签是**全量替换**，所以先读当前集合再写回目标集合。
   * 读与写之间有窗口；与人类同时改标签时以本写入为准。
   */
  function writeLabels(id, labels) {
    const unique = [...new Set(labels.filter(Boolean))]
    request(['story', 'update', `id=${id}`, `label=${unique.join(',')}`])
    return unique
  }

  function addComment(id, text) {
    // entry_type / entry_id 用下划线：连字符形式在 comment 实体上会被静默丢弃（见 ADR-0002）。
    const args = ['comment', 'add', 'entry_type=stories', `entry_id=${id}`, `description=${String(text).slice(0, COMMENT_MAX)}`]
    if (config.commentAuthor) args.push(`author=${config.commentAuthor}`)
    request(args)
  }

  /**
   * 服务端已按 owner + label 过滤，本地再核一遍标签：tapd-cli 静默丢参数时
   * 过滤会失效，本地复查把它变回「少做」而不是「做错」。
   */
  function taggedStories() {
    requireAssignee()
    return fetchStories([`owner=${config.assignee}`, `label=${config.readyLabel}`])
      .map(normalizeStory)
      .filter((story) => hasLabel(story.labels, config.readyLabel))
  }

  function readyStories() {
    return taggedStories()
      .filter((story) => !machineLabelOf(story.labels, config))
      .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
  }

  function attemptClaim(id) {
    const claimMode = 'best-effort'
    let story
    try {
      story = fetchStory(id)
    } catch (err) {
      return { status: 'error', claimMode, message: err.message }
    }
    if (!hasLabel(story.labels, config.readyLabel)) {
      return { status: 'error', claimMode, message: `TAPD 需求缺少 ${config.readyLabel} 标签: ${id}` }
    }
    const machine = machineLabelOf(story.labels, config)
    if (machine) {
      return { status: 'already-claimed', claimMode, message: `TAPD 需求已带 ${machine} 标签，先由人撤销再重跑: ${id}` }
    }
    // 描述与评论都为空时拒单，并贴上失败标签：故事就此离开就绪池，不会卡住后面的工单。
    let comments
    try {
      comments = fetchComments(id)
    } catch (err) {
      return { status: 'error', claimMode, message: err.message }
    }
    if (isBlankRequirement(htmlToText(story.description), comments)) {
      try {
        writeLabels(id, [...story.labels, config.failedLabel])
        addComment(id, `${COMMENT_PREFIX} 需求描述与评论都为空，无法开工。请补充描述或评论，然后撤销 ${config.failedLabel} 重跑。`)
      } catch (err) {
        return { status: 'error', claimMode, message: `需求为空，写回失败: ${err.message}` }
      }
      return { status: 'error', claimMode, message: `需求描述与评论都为空，已标记 ${config.failedLabel}: ${id}` }
    }
    try {
      writeLabels(id, [...story.labels, config.claimedLabel])
    } catch (err) {
      return { status: 'error', claimMode, message: err.message }
    }
    return { status: 'claimed', claimMode }
  }

  return {
    name: 'tapd',
    // 读-改-写标签不是原子操作：同机由 watcher 注册表兜底，跨机靠标签出队兜底。
    claimMode: 'best-effort',
    config,

    listReady() {
      return readyStories().map(describeStory)
    },

    getDetail(id) {
      const story = fetchStory(id)
      return {
        id: story.id,
        title: story.title,
        body: renderTaskBody(htmlToText(story.description), fetchComments(id)),
        requirements: '',
      }
    },

    tryClaim(id) {
      return attemptClaim(id)
    },

    markInProgress(id) {
      const result = attemptClaim(id)
      if (result.status === 'claimed') return
      throw new Error(result.message || `TAPD 认领失败: ${id}`)
    },

    markDone(id, result = {}) {
      const story = fetchStory(id)
      writeLabels(id, [...story.labels.filter((label) => label !== config.claimedLabel), config.deliveredLabel])
      const lines = [`${COMMENT_PREFIX} 开发完成，请验收。`]
      const summary = String(result.summary || '').trim()
      const commit = String(result.commit || '').trim()
      if (summary) lines.push(summary)
      if (commit) lines.push(`提交：${commit}`)
      addComment(id, lines.join('\n\n'))
    },

    markFailed(id, note = '') {
      const story = fetchStory(id)
      writeLabels(id, [...story.labels.filter((label) => label !== config.claimedLabel), config.failedLabel])
      addComment(id, `${COMMENT_PREFIX} 失败：${String(note || '未说明原因').slice(0, 300)}`)
    },

    /** TAPD 需求没有 beads 式 epic 收尾；保留 seam 供 loop 统一调用。 */
    closeEligibleParents() {
      return []
    },

    describeBlocked() {
      const tagged = taggedStories()
      const toBlocked = (story) => {
        const machine = machineLabelOf(story.labels, config)
        return { ...describeStory(story), blockedBy: [], reason: `${machine} 待人工撤销` }
      }
      return {
        ready: readyStories().map(describeStory),
        blocked: tagged.filter((story) => !hasLabel(story.labels, config.claimedLabel)).filter((story) => machineLabelOf(story.labels, config)).map(toBlocked),
        inProgress: tagged.filter((story) => hasLabel(story.labels, config.claimedLabel)).map(describeStory),
      }
    },
  }
}
