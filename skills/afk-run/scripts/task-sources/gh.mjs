/**
 * GitHub Issues task source adapter.
 *
 * The gh CLI fetches list results in API pages when --limit is larger than a
 * page, so one list invocation can cover repositories with more than 100 open
 * issues without a second detail request per issue.
 */

import { execFileSync } from 'node:child_process'

const ISSUE_FIELDS = 'number,title,body,labels'
const LIST_LIMIT = 1000
const DEFAULT_RETRIES = 3
const DEFAULT_RETRY_DELAY_MS = 100

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

/**
 * Run gh with a bounded retry policy for transient network failures.
 * @param {string[]} args
 * @param {{ command?: string, commandPrefix?: string[], cwd?: string, retries?: number, retryDelayMs?: number }} [opts]
 */
export function runGh(args, opts = {}) {
  const command = opts.command || 'gh'
  const commandPrefix = Array.isArray(opts.commandPrefix) ? opts.commandPrefix : []
  const retries = Number.isInteger(opts.retries) ? Math.max(0, opts.retries) : DEFAULT_RETRIES
  const retryDelayMs = Number.isFinite(opts.retryDelayMs)
    ? Math.max(0, Number(opts.retryDelayMs))
    : DEFAULT_RETRY_DELAY_MS

  for (let attempt = 0; ; attempt++) {
    try {
      return execFileSync(command, [...commandPrefix, ...args], {
        cwd: opts.cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (err) {
      if (!isRetryableError(err) || attempt >= retries) {
        const detail = errorText(err)
        throw new Error(
          `gh 命令失败: ${command} ${[...commandPrefix, ...args].join(' ')}${detail ? ` — ${detail}` : ''}`,
          { cause: err },
        )
      }
      sleep(retryDelayMs * 2 ** attempt)
    }
  }
}

function labelName(label) {
  if (typeof label === 'string') return label
  return label && typeof label.name === 'string' ? label.name : ''
}

/** Map P0-P4 labels to the loop priority scale. No P label means P2. */
export function priorityFromLabels(labels) {
  const priorities = (Array.isArray(labels) ? labels : [])
    .map(labelName)
    .map((name) => name.match(/^P([0-4])$/i))
    .filter(Boolean)
    .map((match) => Number(match[1]))
  return priorities.length ? Math.min(...priorities) : 2
}

/**
 * Read local issue references from Markdown task-list lines. Cross-repository
 * references deliberately do not match this same-repository grammar.
 */
export function parseTaskList(body) {
  const references = []
  for (const line of String(body || '').split(/\r?\n/)) {
    const match = line.match(/^\s*-\s+\[([ xX])\]\s+#(\d+)(?:\s|$)/)
    if (match) {
      references.push({ number: Number(match[2]), checked: match[1].toLowerCase() === 'x' })
    }
  }
  return references
}

function normalizeIssue(raw) {
  const number = Number(raw?.number)
  if (!Number.isSafeInteger(number) || number < 1) return null
  return {
    number,
    id: String(number),
    title: raw.title || String(number),
    body: raw.body || '',
    labels: Array.isArray(raw.labels) ? raw.labels : [],
  }
}

function hasLabel(issue, wanted) {
  return issue.labels.some((label) => labelName(label).toLowerCase() === wanted)
}

function parseIssues(raw) {
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`gh issue list 返回非法 JSON: ${err.message}`, { cause: err })
  }
  if (!Array.isArray(parsed)) {
    throw new Error('gh issue list 返回格式错误：预期 JSON 数组')
  }
  return parsed.map(normalizeIssue).filter(Boolean)
}

function compareIssues(a, b) {
  return priorityFromLabels(a.labels) - priorityFromLabels(b.labels) || a.number - b.number
}

function isReadyIssue(issue, openSet) {
  return parseTaskList(issue.body).every(
    (reference) => reference.checked || !openSet.has(reference.number),
  )
}

function parseRepoRemote(remote) {
  let value = String(remote || '').trim().replace(/\/+$/, '').replace(/\.git$/i, '')
  if (!value) return ''

  let host = ''
  let path = ''
  const scp = !value.includes('://') && value.match(/^(?:[^@]+@)?([^:/]+):(.+)$/)
  if (scp) {
    host = scp[1]
    path = scp[2]
  } else {
    try {
      const url = new URL(value)
      host = url.host
      path = url.pathname.replace(/^\//, '')
    } catch {
      return ''
    }
  }

  const parts = path.split('/').filter(Boolean)
  if (parts.length < 2 || !host) return ''
  const repo = `${parts[parts.length - 2]}/${parts[parts.length - 1]}`
  return host.toLowerCase() === 'github.com' ? repo : `${host}/${repo}`
}

function inferRepo(cwd) {
  try {
    const remote = execFileSync('git', ['config', '--get', 'remote.origin.url'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const repo = parseRepoRemote(remote)
    if (repo) return repo
  } catch {
    // The public error below includes the actionable --repo escape hatch.
  }
  throw new Error('无法从 git remote 推断 GitHub 仓库，请使用 --repo owner/name')
}

function normalizeRepo(repo) {
  const value = String(repo || '').trim().replace(/^https?:\/\/github\.com\//i, '')
  if (!/^(?:[^/]+\/)?[^/]+\/[^/]+$/.test(value)) {
    throw new Error(`GitHub 仓库格式错误: ${repo || '(空)'}`)
  }
  return value.replace(/\.git$/i, '')
}

function issueArgs(repo, args) {
  return [...args, '--repo', repo]
}

/**
 * @param {{ cwd?: string, repo?: string, command?: string, commandPrefix?: string[], retries?: number, retryDelayMs?: number }} [opts]
 */
export function createGhSource(opts = {}) {
  const cwd = opts.cwd || process.cwd()
  const repo = normalizeRepo(opts.repo || inferRepo(cwd))
  const run = (args) => runGh(args, { ...opts, cwd })
  let snapshot = null

  function loadIssues() {
    const raw = run(
      issueArgs(repo, [
        'issue',
        'list',
        '--state',
        'open',
        '--limit',
        String(LIST_LIMIT),
        '--json',
        ISSUE_FIELDS,
      ]),
    )
    const issues = parseIssues(raw)
    snapshot = issues
    return issues
  }

  function getSnapshot() {
    return snapshot || loadIssues()
  }

  function readyIssues(issues) {
    const openSet = new Set(issues.map((issue) => issue.number))
    return issues
      .filter((issue) => !hasLabel(issue, 'afk-failed') && !hasLabel(issue, 'in-progress'))
      .filter((issue) => isReadyIssue(issue, openSet))
      .sort(compareIssues)
  }

  return {
    name: 'gh',

    listReady() {
      return readyIssues(loadIssues()).map((issue) => ({
        id: issue.id,
        title: issue.title,
        priority: priorityFromLabels(issue.labels),
      }))
    },

    getDetail(id) {
      const issue = getSnapshot().find((candidate) => candidate.id === String(id))
      if (!issue) throw new Error(`GitHub issue 不存在或无法读取: ${id}`)
      return {
        id: issue.id,
        title: issue.title,
        body: issue.body,
        requirements: '',
      }
    },

    markInProgress(id) {
      run(issueArgs(repo, ['issue', 'edit', String(id), '--add-label', 'in-progress']))
    },

    markDone(id, result = {}) {
      const comment = `afk: ${result.status || 'done'} — ${String(result.summary || '').slice(0, 200)}`
      run(issueArgs(repo, ['issue', 'close', String(id), '--comment', comment]))
    },

    markFailed(id, note = '') {
      run(issueArgs(repo, ['issue', 'comment', String(id), '--body', `afk failed: ${String(note).slice(0, 300)}`]))
      run(issueArgs(repo, ['issue', 'edit', String(id), '--add-label', 'afk-failed']))
    },

    describeBlocked() {
      const issues = getSnapshot()
      const readyIds = new Set(readyIssues(issues).map((issue) => issue.id))
      return issues
        .filter(
          (issue) =>
            !readyIds.has(issue.id) &&
            !hasLabel(issue, 'afk-failed'),
        )
        .map((issue) => ({ id: issue.id, title: issue.title }))
    },
  }
}

export { parseRepoRemote }
