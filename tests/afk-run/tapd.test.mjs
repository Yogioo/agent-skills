/**
 * TAPD claim mapping stays in configuration. No universal status or owner field.
 *
 * Run:
 *   node --test tests/afk-run/tapd.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSource } from '../../skills/afk-run/scripts/task-sources/index.mjs'
import { createTapdSource } from '../../skills/afk-run/scripts/task-sources/tapd.mjs'

test('tapd without a field mapping cannot claim', () => {
  const source = createSource('tapd', {})
  assert.equal(source.claimMode, 'unsupported')
  assert.deepEqual(source.tryClaim('1'), { status: 'unsupported', claimMode: 'unsupported' })
  assert.deepEqual(source.listReady(), [])
})

test('tapd claim update uses the configured field names', () => {
  const updates = []
  let seenMapping = null
  const source = createTapdSource({
    tapd: {
      statusField: 'v_status',
      ownerField: 'current_owner',
      readyValue: '待处理',
      claimedValue: '开发中',
      ownerValue: 'agent',
      customFields: { custom_field_9: 'afk' },
    },
    transport: {
      listReady(mapping) {
        seenMapping = mapping
        return [{ id: 's1', title: 'story', priority: 1 }]
      },
      tryClaim(id, update) {
        updates.push({ id, update })
        return { status: 'claimed' }
      },
    },
  })

  assert.equal(source.claimMode, 'best-effort')
  assert.deepEqual(source.listReady(), [{ id: 's1', title: 'story', priority: 1 }])
  assert.equal(seenMapping.statusField, 'v_status')
  assert.equal(seenMapping.readyValue, '待处理')
  assert.equal(Object.hasOwn(seenMapping, 'status'), false)
  assert.equal(Object.hasOwn(seenMapping, 'owner'), false)
  assert.deepEqual(source.tryClaim('s1'), { status: 'claimed', claimMode: 'best-effort' })
  assert.deepEqual(updates[0].update.fields, {
    v_status: '开发中',
    current_owner: 'agent',
    custom_field_9: 'afk',
  })
  assert.equal(Object.hasOwn(updates[0].update.fields, 'status'), false)
  assert.equal(Object.hasOwn(updates[0].update.fields, 'owner'), false)
})

test('tapd explicit claimMode is reported without inventing fields', () => {
  const source = createTapdSource({
    tapd: { claimMode: 'atomic', statusField: 'cf_1', claimedValue: 'yes' },
  })
  assert.equal(source.claimMode, 'atomic')
  assert.equal(source.tryClaim('s2').status, 'error')
})
