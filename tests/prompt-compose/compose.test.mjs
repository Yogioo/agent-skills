import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { assemblePrompt, renderTemplate, PromptComposeError } from '../../lib/prompt-compose.mjs'

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'prompt-compose-api-'))
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }))
  return dir
}

function put(dir, path, content) {
  const file = join(dir, path)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content, 'utf8')
  return file
}

test('layers append in order, variables render, suffix is last and provenance is ordered', (t) => {
  const dir = fixture(t)
  put(dir, 'base.md', 'BASE for {{TASK}}\n')
  put(dir, 'standards.md', 'STANDARD ONE\n')
  const file = put(dir, 'append.md', 'APPEND {{TASK}}\n')
  const manifest = {
    variables: { TASK: 'fix login' },
    base: { file: 'base.md' },
    layers: [
      { mode: 'append', label: 'standards', file: 'standards.md' },
      { mode: 'append', label: 'project', heading: 'Extra {{TASK}}', text: 'PROJECT APPEND\n' },
    ],
    suffix: 'SUFFIX LAST\n',
  }
  const { text, sources, variables } = assemblePrompt(manifest, { baseDir: dir })

  assert.equal(
    text,
    'BASE for fix login\n\nSTANDARD ONE\n\n## Extra fix login\n\nPROJECT APPEND\n\nSUFFIX LAST\n',
  )
  assert.deepEqual(variables, { TASK: 'fix login' })
  assert.deepEqual(sources.map((s) => [s.role, s.mode, s.label, s.included]), [
    ['base', 'base', '', true],
    ['append', 'append', 'standards', true],
    ['append', 'append', 'project', true],
    ['suffix', 'suffix', '', true],
  ])
  assert.equal(sources[1].path, join(dir, 'standards.md'))
  assert.equal(sources[0].origin, 'file')
  assert.ok(sources[2].bytes > 0)

  const again = assemblePrompt(manifest, { baseDir: dir })
  assert.equal(again.text, text, 'composition is deterministic')
})

test('a later replace layer overrides an earlier base and appends still follow', (t) => {
  const dir = fixture(t)
  const manifest = {
    variables: {},
    base: { text: 'ORIGINAL BASE\n' },
    layers: [
      { mode: 'replace', label: 'global', text: 'GLOBAL BASE\n' },
      { mode: 'replace', label: 'project', text: 'PROJECT BASE\n' },
      { mode: 'append', text: 'APPENDED\n' },
    ],
  }
  const { text, sources } = assemblePrompt(manifest, { baseDir: dir })
  assert.equal(text, 'PROJECT BASE\n\nAPPENDED\n')
  assert.equal(sources[0].mode, 'replace')
  assert.equal(sources[0].label, 'project')
  assert.equal(sources.filter((s) => s.role === 'base').length, 1, 'only the effective base is reported')
})

test('empty and whitespace-only sources are absent, not empty sections', (t) => {
  const dir = fixture(t)
  put(dir, 'blank.md', '  \n\t\n')
  const { text, sources } = assemblePrompt({
    variables: {},
    base: 'BASE\n',
    layers: [
      { mode: 'append', file: 'blank.md' },
      { mode: 'append', text: '   ' },
      { mode: 'append', text: '' },
    ],
    suffix: '  \n',
  }, { baseDir: dir })
  assert.equal(text, 'BASE\n')
  assert.deepEqual(sources.map((s) => s.included), [true, false, false, false, false])
})

test('unknown variables and missing files raise typed errors', (t) => {
  const dir = fixture(t)
  assert.throws(
    () => assemblePrompt({ variables: {}, base: 'hi {{MISSING}}' }, { baseDir: dir }),
    (error) => error instanceof PromptComposeError && error.exitCode === 2 && /MISSING/.test(error.message),
  )
  assert.throws(
    () => assemblePrompt({ variables: {}, base: { file: 'nope.md' } }, { baseDir: dir }),
    (error) => error instanceof PromptComposeError && error.exitCode === 1 && /nope\.md/.test(error.message),
  )
  assert.throws(() => renderTemplate('{{X}}', {}), PromptComposeError)
})

test('invalid manifests are rejected instead of silently normalizing', (t) => {
  const dir = fixture(t)
  const bad = [
    null,
    [],
    { unexpected: true },
    { variables: [] },
    { variables: { 'bad name': 'x' } },
    { variables: { OK: 1 } },
    { layers: 'nope' },
    { layers: [null] },
    { layers: [{ mode: 'append', text: 'x', junk: 1 }] },
    { layers: [{ mode: 'frobnicate', text: 'x' }] },
    { layers: [{ mode: 'append' }] },
    { layers: [{ mode: 'append', text: 'x', file: 'y' }] },
    { base: { text: 'x', file: 'y' } },
    { base: 42 },
  ]
  for (const manifest of bad) {
    assert.throws(() => assemblePrompt(manifest, { baseDir: dir }), PromptComposeError, JSON.stringify(manifest))
  }
})
