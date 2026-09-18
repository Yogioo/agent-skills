/**
 * TAPD 任务源扩展点。
 *
 * 不假设通用的 status / owner 字段名。调用方用 tapd 映射声明状态、负责人、
 * 自定义字段；真正的读写由注入的 transport 完成。映射不完整时 claimMode 为 unsupported。
 */

export function normalizeTapdMapping(raw = {}) {
  const mapping = raw && typeof raw === 'object' ? raw : {}
  const customFields = mapping.customFields && typeof mapping.customFields === 'object'
    ? { ...mapping.customFields }
    : {}
  return {
    claimMode: String(mapping.claimMode || ''),
    statusField: String(mapping.statusField || ''),
    ownerField: String(mapping.ownerField || ''),
    readyValue: String(mapping.readyValue || ''),
    claimedValue: String(mapping.claimedValue || ''),
    doneValue: String(mapping.doneValue || ''),
    failedValue: String(mapping.failedValue || ''),
    ownerValue: String(mapping.ownerValue || ''),
    customFields,
  }
}

export function resolveTapdClaimMode(mapping) {
  if (mapping.claimMode === 'atomic' || mapping.claimMode === 'best-effort' || mapping.claimMode === 'unsupported') {
    return mapping.claimMode
  }
  if (mapping.statusField && mapping.claimedValue) return 'best-effort'
  return 'unsupported'
}

/** 用映射里的字段名组装认领更新，不填默认的 status/owner 键。 */
export function buildTapdClaimUpdate(id, mapping) {
  if (!mapping.statusField || !mapping.claimedValue) return null
  const fields = { [mapping.statusField]: mapping.claimedValue }
  if (mapping.ownerField && mapping.ownerValue) fields[mapping.ownerField] = mapping.ownerValue
  for (const [key, value] of Object.entries(mapping.customFields || {})) {
    if (key) fields[key] = value
  }
  return { id: String(id), fields }
}

function statusPatch(mapping, value) {
  if (!mapping.statusField || !value) return { ...mapping.customFields }
  return { [mapping.statusField]: value, ...mapping.customFields }
}

/**
 * @param {{ tapd?: object, mapping?: object, transport?: { listReady?: Function, getDetail?: Function, tryClaim?: Function, update?: Function } }} [opts]
 */
export function createTapdSource(opts = {}) {
  const mapping = normalizeTapdMapping(opts.tapd || opts.mapping || {})
  const claimMode = resolveTapdClaimMode(mapping)
  const transport = opts.transport || null

  return {
    name: 'tapd',
    claimMode,
    mapping,

    listReady() {
      if (typeof transport?.listReady !== 'function') return []
      const rows = transport.listReady(mapping)
      return Array.isArray(rows) ? rows : []
    },

    tryClaim(id) {
      if (claimMode === 'unsupported') return { status: 'unsupported', claimMode }
      const update = buildTapdClaimUpdate(id, mapping)
      if (!update) {
        return { status: 'error', claimMode, message: 'TAPD field mapping is incomplete' }
      }
      if (typeof transport?.tryClaim !== 'function') {
        return { status: 'error', claimMode, message: 'TAPD transport is not configured' }
      }
      const result = transport.tryClaim(id, update) || {}
      return {
        status: result.status || 'error',
        claimMode: result.claimMode || claimMode,
        ...(result.message ? { message: result.message } : {}),
      }
    },

    getDetail(id) {
      if (typeof transport?.getDetail !== 'function') {
        throw new Error(`TAPD transport is not configured: ${id}`)
      }
      return transport.getDetail(id, mapping)
    },

    markInProgress(id) {
      const result = this.tryClaim(id)
      if (result.status === 'claimed') return
      if (result.status === 'already-claimed') throw new Error(`TAPD work item already claimed: ${id}`)
      throw new Error(result.message || `TAPD claim failed: ${id}`)
    },

    markDone(id, result = {}) {
      if (typeof transport?.update !== 'function') throw new Error('TAPD transport is not configured')
      transport.update(id, { op: 'done', fields: statusPatch(mapping, mapping.doneValue), result, mapping })
    },

    markFailed(id, note = '') {
      if (typeof transport?.update !== 'function') throw new Error('TAPD transport is not configured')
      transport.update(id, { op: 'failed', fields: statusPatch(mapping, mapping.failedValue), note, mapping })
    },
  }
}
