/**
 * Structured context card formatting (browser + node tests).
 * Injected into progress-http client script (exports stripped).
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const PAYLOAD_TRUNCATE = 2048

/** @param {string} raw */
export function mapToolName(raw) {
  const name = String(raw || 'tool')
  if (name.endsWith('ToolCall')) return name.slice(0, -'ToolCall'.length)
  return name
}

/** @param {unknown} v */
function asObj(v) {
  return v && typeof v === 'object' ? /** @type {Record<string, unknown>} */ (v) : {}
}

/** @param {Record<string, unknown> | null | undefined} ev */
function pickArgs(ev) {
  return asObj(ev?.args)
}

/** @param {Record<string, unknown> | null | undefined} ev */
function pickResult(ev) {
  return asObj(ev?.result)
}

/**
 * @param {string} text
 * @param {number} [limit]
 */
export function truncateText(text, limit = PAYLOAD_TRUNCATE) {
  const s = String(text || '')
  if (s.length <= limit) return { text: s, truncated: false, total: s.length }
  return { text: s.slice(0, limit), truncated: true, total: s.length }
}

/**
 * @param {string} text
 * @param {number} [n]
 */
export function oneLine(text, n = 100) {
  const s = String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
  if (s.length <= n) return s
  return s.slice(0, Math.max(0, n - 1)) + '…'
}

/**
 * @param {string} text
 * @param {string} expandId
 * @param {(s: string) => string} esc
 * @param {number} [limit]
 */
export function renderTruncBlock(text, expandId, esc, limit = PAYLOAD_TRUNCATE) {
  const { text: shown, truncated, total } = truncateText(text, limit)
  if (!truncated) return '<pre class="ctx-mono">' + esc(shown) + '</pre>'
  return (
    '<pre class="ctx-mono ctx-trunc-preview">' +
    esc(shown) +
    '\n… (' +
    (total - shown.length) +
    ' more chars)</pre>' +
    '<details class="ctx-trunc" id="' +
    esc(expandId) +
    '"><summary>Show full (' +
    total +
    ' chars)</summary>' +
    '<pre class="ctx-mono ctx-trunc-full">' +
    esc(text) +
    '</pre></details>'
  )
}

/**
 * Pretty JSON dump, default collapsed behind a summary line.
 * @param {unknown} value
 * @param {string} expandId
 * @param {(s: string) => string} esc
 * @param {string} [label]
 */
export function renderJsonDetails(value, expandId, esc, label = 'JSON') {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  if (!text || text === '{}' || text === 'null') return ''
  return (
    '<details class="ctx-json" id="' +
    esc(expandId) +
    '"><summary>' +
    esc(label) +
    '</summary>' +
    renderTruncBlock(text, expandId + '-body', esc) +
    '</details>'
  )
}

/**
 * @param {Record<string, unknown> | null | undefined} start
 * @param {Record<string, unknown> | null | undefined} done
 */
export function extractShellFields(start, done) {
  const args = pickArgs(start)
  const result = pickResult(done)
  const command =
    String(args.command || args.cmd || args.script || result.command || '').trim() || '(no command)'
  const exitRaw = result.exit_code ?? result.exitCode ?? result.code
  const exitCode = exitRaw == null ? null : Number(exitRaw)
  const stdout = String(result.stdout ?? result.output ?? result.aggregated_output ?? '').trim()
  const stderr = String(result.stderr ?? result.error ?? '').trim()
  return { command, exitCode, stdout, stderr }
}

/**
 * @param {Record<string, unknown> | null | undefined} start
 * @param {Record<string, unknown> | null | undefined} done
 * @param {string} toolName
 */
export function extractEditWritePreview(start, done, toolName) {
  const args = pickArgs(start)
  const result = pickResult(done)
  const path = String(args.path || args.file || args.target || result.path || '').trim()
  const streamContent = String(
    args.streamContent ?? args.content ?? args.text ?? args.newText ?? args.new_string ?? '',
  ).trim()
  const oldText = String(args.oldText ?? args.old_string ?? '').trim()
  const newText = String(
    args.newText ?? args.new_string ?? args.content ?? args.text ?? streamContent,
  ).trim()
  const diff = String(args.diff ?? result.diff ?? '').trim()
  const action = String(args.action || toolName || 'edit').trim()

  if (diff) return { path, action, body: diff, kind: 'diff' }
  if (oldText || newText) {
    const body = (oldText ? '--- old ---\n' + oldText + '\n\n' : '') + '+++ new +++\n' + newText
    return { path, action, body, kind: 'diff' }
  }
  if (streamContent) return { path, action, body: streamContent, kind: 'stream' }
  return { path, action, body: '', kind: 'json' }
}

/**
 * @param {Record<string, unknown> | null | undefined} start
 * @param {Record<string, unknown> | null | undefined} done
 */
export function extractPathToolFields(start, done) {
  const args = pickArgs(start)
  const result = pickResult(done)
  const path = String(
    args.path || args.file || args.target_file || args.target || result.path || '',
  ).trim()
  const pattern = String(args.pattern || args.glob || args.glob_pattern || args.query || '').trim()
  const offset = args.offset ?? args.start_line ?? args.startLine
  const limit = args.limit ?? args.end_line ?? args.endLine
  const content = String(
    result.content ??
      result.output ??
      asObj(result.success).content ??
      asObj(result.success).output ??
      '',
  ).trim()
  return { path, pattern, offset, limit, content }
}

/**
 * Human one-liner for assistant / outcome JSON or prose.
 * @param {string} text
 * @param {string} [kind]
 */
export function fmtMessageSummary(text, kind = 'assistant') {
  const s = String(text || '').trim()
  if (!s) return kind
  try {
    const obj = JSON.parse(s)
    if (obj && typeof obj === 'object') {
      const status = obj.status != null ? String(obj.status) : ''
      const note = obj.note != null ? oneLine(String(obj.note), 80) : ''
      const taskId = obj.taskId != null ? String(obj.taskId) : ''
      const parts = [kind]
      if (status) parts.push(status)
      if (taskId) parts.push(taskId)
      if (note) parts.push(note)
      return parts.join(' · ')
    }
  } catch {
    /* prose */
  }
  return kind + ' · ' + oneLine(s, 100)
}

/**
 * Render assistant/outcome body: structured fields when JSON, else truncated text.
 * @param {string} text
 * @param {string} expandId
 * @param {(s: string) => string} esc
 */
export function formatMessageBody(text, expandId, esc) {
  const s = String(text || '')
  try {
    const obj = JSON.parse(s)
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      /** @type {Record<string, unknown>} */
      const rec = obj
      const keys = ['status', 'taskId', 'note', 'changedFiles', 'summary']
      const lines = []
      for (const k of keys) {
        if (rec[k] == null || rec[k] === '') continue
        const v = typeof rec[k] === 'string' ? String(rec[k]) : JSON.stringify(rec[k])
        lines.push('<div class="ctx-kv"><span class="ctx-k">' + esc(k) + '</span> ' + esc(v) + '</div>')
      }
      const rest = { ...rec }
      for (const k of keys) delete rest[k]
      const restKeys = Object.keys(rest)
      if (lines.length) {
        if (restKeys.length) lines.push(renderJsonDetails(rest, expandId + '-more', esc, '更多字段'))
        return lines.join('\n')
      }
    }
    return renderTruncBlock(JSON.stringify(obj, null, 2), expandId, esc)
  } catch {
    return renderTruncBlock(s, expandId, esc)
  }
}

/**
 * One-line summary for raw runner payload (codex turn/thread noise etc.).
 * @param {unknown} payload
 * @param {unknown} [fallbackEv]
 */
export function fmtRawSummary(payload, fallbackEv) {
  const p = asObj(payload)
  if (!Object.keys(p).length) {
    return oneLine(JSON.stringify(fallbackEv ?? payload ?? ''), 120) || 'raw'
  }
  const type = String(p.type || p.kind || '')
  if (type === 'thread.started') return 'thread.started' + (p.thread_id ? ' · ' + p.thread_id : '')
  if (type === 'turn.started') return 'turn.started'
  if (type === 'turn.completed') {
    const u = asObj(p.usage)
    if (Object.keys(u).length) {
      return (
        'turn.completed · in ' +
        (u.input_tokens ?? '?') +
        ' · out ' +
        (u.output_tokens ?? '?') +
        (u.reasoning_output_tokens ? ' · reason ' + u.reasoning_output_tokens : '')
      )
    }
    return 'turn.completed'
  }
  if (type === 'error' || p.error) {
    const msg = p.message || asObj(p.error).message || p.error || type || 'error'
    return 'error · ' + oneLine(String(msg), 100)
  }
  if (type) {
    const hint =
      p.path ||
      p.file ||
      p.command ||
      p.item_id ||
      p.id ||
      (typeof p.message === 'string' ? oneLine(p.message, 60) : '')
    return hint ? type + ' · ' + oneLine(String(hint), 80) : type
  }
  return oneLine(JSON.stringify(p), 120)
}

/**
 * @param {Record<string, unknown> | null | undefined} ev
 */
export function fmtToolSummary(ev) {
  const name = mapToolName(ev?.toolName)
  const phase = ev?.phase === 'done' ? 'done' : 'start'
  const args = pickArgs(ev)
  const result = pickResult(ev)

  if (name === 'shell') {
    const cmd = String(args.command || args.cmd || '(no command)').trim()
    return 'shell · ' + phase + ' · ' + oneLine(cmd, 100)
  }
  if (name === 'edit' || name === 'write' || name === 'delete' || name === 'Delete') {
    const path = String(args.path || args.file || result.path || '').trim()
    const label = name === 'Delete' ? 'delete' : name
    return label + ' · ' + phase + (path ? ' · ' + path : '')
  }
  if (name === 'read' || name === 'Read') {
    const path = String(args.path || args.file || args.target_file || '').trim()
    const off = args.offset ?? args.start_line
    const lim = args.limit
    let extra = path || ''
    if (off != null || lim != null) {
      extra += (extra ? ' ' : '') + '[' + (off ?? '') + (lim != null ? '+' + lim : '') + ']'
    }
    return 'read · ' + phase + (extra ? ' · ' + extra : '')
  }
  if (name === 'grep' || name === 'Grep' || name === 'rg') {
    const pattern = String(args.pattern || args.query || '').trim()
    const path = String(args.path || args.glob || args.glob_pattern || '').trim()
    return (
      'grep · ' +
      phase +
      (pattern ? ' · ' + oneLine(pattern, 60) : '') +
      (path ? ' · ' + path : '')
    )
  }
  if (name === 'glob' || name === 'Glob' || name === 'listDir' || name === 'LS') {
    const pattern = String(args.glob_pattern || args.pattern || args.glob || args.path || '').trim()
    return name.toLowerCase() + ' · ' + phase + (pattern ? ' · ' + pattern : '')
  }
  if (name === 'SemSearch' || name === 'search' || name === 'semanticSearch') {
    const q = String(args.query || args.pattern || args.search_term || '').trim()
    return 'search · ' + phase + (q ? ' · ' + oneLine(q, 80) : '')
  }
  if (name === 'Await' || name === 'await' || name === 'AwaitShell') {
    const id = String(args.shell_id || args.task_id || args.id || '').trim()
    return 'await · ' + phase + (id ? ' · ' + id : '')
  }

  // Generic: surface first useful arg key
  const pathish = String(
    args.path || args.file || args.command || args.query || args.pattern || args.url || '',
  ).trim()
  return name + ' · ' + phase + (pathish ? ' · ' + oneLine(pathish, 80) : '')
}

/**
 * @param {Record<string, unknown> | null | undefined} start
 * @param {Record<string, unknown> | null | undefined} done
 * @param {string} toolName
 * @param {string} expandPrefix
 * @param {(s: string) => string} esc
 */
export function formatToolBody(start, done, toolName, expandPrefix, esc) {
  const name = mapToolName(toolName)
  if (name === 'shell') {
    const { command, exitCode, stdout, stderr } = extractShellFields(start, done)
    const lines = ['<span class="ctx-shell-cmd">$ ' + esc(command) + '</span>']
    if (done && exitCode != null) {
      const exitCls = exitCode === 0 ? 'ctx-shell-exit ok' : 'ctx-shell-exit bad'
      lines.push('<span class="' + exitCls + '">exit ' + esc(String(exitCode)) + '</span>')
    }
    if (stdout) lines.push('', 'stdout:', renderTruncBlock(stdout, expandPrefix + '-stdout', esc))
    if (stderr) lines.push('', 'stderr:', renderTruncBlock(stderr, expandPrefix + '-stderr', esc))
    if (!done) lines.push('', '(running…)')
    return lines.join('\n')
  }

  if (name === 'edit' || name === 'write') {
    const preview = extractEditWritePreview(start, done, name)
    const head = preview.path ? preview.action + ' ' + preview.path : preview.action
    const parts = ['<span class="ctx-edit-head">' + esc(head) + '</span>']
    if (preview.body) {
      parts.push('', preview.kind === 'diff' ? '--- diff ---' : '--- content ---')
      parts.push(renderTruncBlock(preview.body, expandPrefix + '-body', esc))
    } else {
      const dump = []
      if (start?.args != null) dump.push(renderJsonDetails(start.args, expandPrefix + '-args', esc, 'args'))
      if (done?.result != null) {
        dump.push(renderJsonDetails(done.result, expandPrefix + '-result', esc, 'result'))
      }
      parts.push(...(dump.length ? dump : ['(no preview)']))
    }
    return parts.join('\n')
  }

  if (name === 'read' || name === 'Read') {
    const { path, offset, limit, content } = extractPathToolFields(start, done)
    const range =
      offset != null || limit != null
        ? ' · lines ' + (offset ?? '?') + (limit != null ? '+' + limit : '')
        : ''
    const parts = [
      '<span class="ctx-path-head">read ' + esc(path || '(no path)') + esc(range) + '</span>',
    ]
    if (content) {
      parts.push('', renderTruncBlock(content, expandPrefix + '-content', esc))
    } else if (!done) {
      parts.push('', '(reading…)')
    } else if (done?.result != null) {
      parts.push(renderJsonDetails(done.result, expandPrefix + '-result', esc, 'result'))
    }
    return parts.join('\n')
  }

  if (name === 'grep' || name === 'Grep' || name === 'rg') {
    const { path, pattern, content } = extractPathToolFields(start, done)
    const parts = [
      '<span class="ctx-path-head">grep ' +
        esc(pattern || '(no pattern)') +
        (path ? ' · ' + esc(path) : '') +
        '</span>',
    ]
    if (content) parts.push('', renderTruncBlock(content, expandPrefix + '-out', esc))
    else if (!done) parts.push('', '(searching…)')
    else if (done?.result != null) {
      parts.push(renderJsonDetails(done.result, expandPrefix + '-result', esc, 'result'))
    }
    return parts.join('\n')
  }

  if (name === 'glob' || name === 'Glob' || name === 'listDir' || name === 'LS') {
    const { path, pattern, content } = extractPathToolFields(start, done)
    const target = pattern || path || '(no pattern)'
    const parts = ['<span class="ctx-path-head">' + esc(name.toLowerCase()) + ' ' + esc(target) + '</span>']
    if (content) parts.push('', renderTruncBlock(content, expandPrefix + '-out', esc))
    else if (!done) parts.push('', '(listing…)')
    else if (done?.result != null) {
      parts.push(renderJsonDetails(done.result, expandPrefix + '-result', esc, 'result'))
    }
    return parts.join('\n')
  }

  if (name === 'delete' || name === 'Delete') {
    const { path } = extractPathToolFields(start, done)
    const parts = ['<span class="ctx-path-head">delete ' + esc(path || '(no path)') + '</span>']
    if (!done) parts.push('', '(deleting…)')
    else if (done?.result != null) {
      parts.push(renderJsonDetails(done.result, expandPrefix + '-result', esc, 'result'))
    }
    return parts.join('\n')
  }

  if (name === 'SemSearch' || name === 'search' || name === 'semanticSearch') {
    const args = pickArgs(start)
    const q = String(args.query || args.pattern || args.search_term || '').trim()
    const parts = ['<span class="ctx-path-head">search ' + esc(q || '(no query)') + '</span>']
    if (done?.result != null) {
      const result = pickResult(done)
      const text = String(result.content ?? result.output ?? '').trim()
      if (text) parts.push('', renderTruncBlock(text, expandPrefix + '-out', esc))
      else parts.push(renderJsonDetails(done.result, expandPrefix + '-result', esc, 'result'))
    } else if (!done) {
      parts.push('', '(searching…)')
    }
    return parts.join('\n')
  }

  // Unknown tools: human summary line + collapsed JSON (not a wall of nested dump)
  const parts = []
  if (start?.args != null) {
    parts.push(renderJsonDetails(start.args, expandPrefix + '-args', esc, 'args'))
  }
  if (done?.result != null) {
    parts.push(renderJsonDetails(done.result, expandPrefix + '-result', esc, 'result'))
  }
  if (!done) parts.push('(running…)')
  return parts.join('\n') || '(no details)'
}

/** Browser-safe source: strip imports/exports and helper loader. */
export function clientContextUiSource() {
  const file = fileURLToPath(new URL('./context-ui.mjs', import.meta.url))
  let src = readFileSync(file, 'utf8')
  src = src.replace(/^import .*$/gm, '')
  src = src.replace(/^export const PAYLOAD_TRUNCATE = \d+;/m, `const PAYLOAD_TRUNCATE = ${PAYLOAD_TRUNCATE};`)
  src = src.replace(/^export /gm, '')
  src = src.replace(/\n\/\*\* Browser-safe[\s\S]*$/, '\n')
  return src.trim()
}
