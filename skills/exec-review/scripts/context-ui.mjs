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
 * @param {Record<string, unknown> | null | undefined} ev
 */
export function fmtToolSummary(ev) {
  const name = mapToolName(ev?.toolName)
  const phase = ev?.phase === 'done' ? 'done' : 'start'
  if (name === 'shell') {
    const args = pickArgs(ev)
    const cmd = String(args.command || args.cmd || '(no command)').trim()
    const one = cmd.length > 120 ? cmd.slice(0, 117) + '…' : cmd
    return 'shell · ' + phase + ' · ' + one
  }
  if (name === 'edit' || name === 'write') {
    const args = pickArgs(ev)
    const path = String(args.path || args.file || '').trim()
    return name + ' · ' + phase + (path ? ' · ' + path : '')
  }
  return name + ' · ' + phase
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
      lines.push('<span class="ctx-shell-exit">exit ' + esc(String(exitCode)) + '</span>')
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
      if (start?.args != null) dump.push('args: ' + JSON.stringify(start.args, null, 2))
      if (done?.result != null) dump.push('result: ' + JSON.stringify(done.result, null, 2))
      const fallback = dump.join('\n\n') || '(no preview)'
      parts.push(renderTruncBlock(fallback, expandPrefix + '-json', esc))
    }
    return parts.join('\n')
  }

  const parts = []
  if (start?.args != null) {
    parts.push('args:', renderTruncBlock(JSON.stringify(start.args, null, 2), expandPrefix + '-args', esc))
  }
  if (done?.result != null) {
    parts.push(
      'result:',
      renderTruncBlock(JSON.stringify(done.result, null, 2), expandPrefix + '-result', esc),
    )
  }
  return parts.join('\n\n') || '(no details)'
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
