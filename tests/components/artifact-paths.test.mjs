import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { compose } from '../../skills/prompt-compose/scripts/cli.mjs'
import { artifactPaths } from '../../skills/questionnaire/scripts/questionnaire.mjs'

test('artifact destinations cannot overwrite inputs through directory aliases', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'artifact-alias-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const real = join(dir, 'real')
  const alias = join(dir, 'alias')
  mkdirSync(real)
  symlinkSync(real, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const base = join(real, 'base.md')
  writeFileSync(base, 'original')
  const manifest = join(real, 'manifest.json')
  writeFileSync(manifest, JSON.stringify({ base: { file: 'base.md' }, layers: [{ mode: 'replace', text: 'replacement' }] }))
  assert.throws(() => compose({ manifest, out: join(alias, 'base.md'), force: true }), /overwrite input source/)
  assert.equal(readFileSync(base, 'utf8'), 'original')
  const questionnaire = join(real, 'session-response.md')
  writeFileSync(questionnaire, '# Questionnaire\n### Question\n')
  assert.throws(() => artifactPaths({ file: questionnaire, outDir: alias, session: 'session' }), /collide/)
})
