import test from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

test('programmatic consumers can use libraries without tools or skill discovery', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'agent-libraries-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  cpSync(fileURLToPath(new URL('../../lib/', import.meta.url)), join(root, 'lib'), { recursive: true })
  const load = (path) => import(pathToFileURL(join(root, 'lib', path)).href)
  const { normalizeEvent } = await load('agent-events.mjs')
  const { captureWorkspace, diff } = await load('workspace-diff.mjs')
  const { assemblePrompt } = await load('prompt-compose.mjs')
  const { createRequirement } = await load('requirement-store.mjs')
  const { writeEvent, listEvents } = await load('event-inbox.mjs')
  const { appendEvent, readEvents } = await load('run-runtime/index.mjs')
  const { createWorkSource } = await load('work-items/index.mjs')
  const { runAgentTurn } = await load('agent-run/run-agent-turn.mjs')
  assert.equal(typeof runAgentTurn, 'function')
  assert.equal(createWorkSource('gh').capabilities().source, 'gh')

  const workspace = join(root, 'workspace')
  mkdirSync(workspace)
  const before = captureWorkspace(workspace, { mode: 'walk' }).files
  const prompt = assemblePrompt({ base: 'Document {{NAME}}', variables: { NAME: 'library composition' } })
  writeFileSync(join(workspace, 'prompt.md'), prompt.text)
  const changes = diff(before, captureWorkspace(workspace, { mode: 'walk' }).files)
  assert.deepEqual(changes.added, ['prompt.md'])
  const requirement = createRequirement({ id: 'r1', title: 'Library consumer', workdir: workspace }, { dir: join(root, 'records') })
  const event = writeEvent({ kind: 'changed', requirementId: requirement.id, detail: changes }, { dir: join(root, 'inbox') })
  assert.equal(listEvents({ dir: join(root, 'inbox') }).items[0].id, event.id)
  const progress = join(root, 'progress.jsonl')
  appendEvent(progress, { event: 'observed', data: { id: event.id } })
  assert.equal(readEvents(progress).events[0].id, event.id)
  assert.ok(normalizeEvent({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } }, 'pi').text.includes('ok'))
  assert.equal(readFileSync(join(workspace, 'prompt.md'), 'utf8'), prompt.text)
})
