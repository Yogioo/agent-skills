import { readFileSync } from 'node:fs'

/**
 * Normalize Cursor agent CLI stream-json events → internal NormalizedEvent.
 *
 * @typedef {object} NormalizedEvent
 * @property {string} kind - 'tool' | 'assistant' | 'outcome' | 'raw'
 * @property {number} t
 * @property {string} [callId]
 * @property {string} [phase] - 'start' | 'done' for tool events
 * @property {string} [toolName]
 * @property {unknown} [args]
 * @property {unknown} [result]
 * @property {string} [text]
 * @property {unknown} [payload]
 */

/**
 * @param {unknown} raw
 * @returns {NormalizedEvent}
 */
export function normalizeAgentEvent(raw) {
  const t = Date.now()
  if (!raw || typeof raw !== 'object') {
    return { kind: 'raw', t, payload: raw }
  }
  /** @type {Record<string, unknown>} */
  const ev = /** @type {Record<string, unknown>} */ (raw)
  const type = String(ev.type || '')

  if (type === 'assistant') {
    const text = extractAssistantText(ev)
    return { kind: 'assistant', t, text, payload: raw }
  }

  if (type === 'tool_call') {
    const subtype = String(ev.subtype || '')
    const callId = String(ev.call_id || ev.callId || '')
    const toolCall = ev.tool_call && typeof ev.tool_call === 'object' ? ev.tool_call : {}
    const toolName = Object.keys(toolCall)[0] || 'unknown'
    const toolBody =
      toolCall[toolName] && typeof toolCall[toolName] === 'object' ? toolCall[toolName] : {}
    const phase = subtype === 'completed' ? 'done' : 'start'
    const args = toolBody.args
    const result = toolBody.result
    return { kind: 'tool', t, callId, phase, toolName, args, result, payload: raw }
  }

  if (type === 'result') {
    const text = typeof ev.result === 'string' ? ev.result : ''
    return { kind: 'outcome', t, text, payload: raw }
  }

  return { kind: 'raw', t, payload: raw }
}

/**
 * @param {Record<string, unknown>} ev
 */
function extractAssistantText(ev) {
  const msg = ev.message
  if (!msg || typeof msg !== 'object') return ''
  const content = /** @type {{ content?: unknown }} */ (msg).content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (part && typeof part === 'object' && 'text' in part) return String(part.text || '')
      return ''
    })
    .join('')
}

/**
 * @param {string} text
 * @returns {object | null}
 */
export function extractJsonFromText(text) {
  const raw = String(text || '').trim()
  if (!raw) return null
  const tryParse = (s) => {
    try {
      return JSON.parse(s)
    } catch {
      return null
    }
  }
  let v = tryParse(raw)
  if (v) return v
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) {
    v = tryParse(fence[1].trim())
    if (v) return v
  }
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start >= 0 && end > start) {
    v = tryParse(raw.slice(start, end + 1))
    if (v) return v
  }
  return null
}

/**
 * Parse normalized events file and extract executor/reviewer JSON object.
 * Prefers terminal outcome events; falls back to assistant text.
 * @param {string} eventsFile
 * @returns {object | null}
 */
export function extractJsonFromEventsFile(eventsFile) {
  let text = ''
  try {
    text = readEventsFile(eventsFile)
  } catch {
    return null
  }
  if (!text.trim()) return null

  const events = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line))
    } catch {
      /* skip bad lines */
    }
  }

  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]
    if (ev?.kind === 'outcome' && ev.text) {
      const parsed = extractJsonFromText(ev.text)
      if (parsed) return parsed
    }
  }

  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]
    if (ev?.kind === 'assistant' && ev.text) {
      const parsed = extractJsonFromText(ev.text)
      if (parsed) return parsed
    }
  }

  return null
}

/**
 * @param {string} eventsFile
 */
function readEventsFile(eventsFile) {
  return readFileSync(eventsFile, 'utf8')
}
