/**
 * Layered config, redaction and project identity tests.
 *
 *   node --test tests/run-runtime/config.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  deepMerge,
  mergeConfigFiles,
  projectIdentity,
  redactSecrets,
} from '../../skills/run-runtime/scripts/config.mjs'
import { workdirHash } from '../../skills/run-runtime/scripts/util.mjs'
import { CLI, cleanup, git, makeRepo, runNode, tempDir } from './helpers.mjs'

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value)}\n`, 'utf8')
  return file
}

test('layers merge in order and malformed layers are visible', () => {
  const dir = tempDir('rr-config-')
  try {
    const a = writeJson(join(dir, 'a.json'), { a: 1, b: { x: 1, keep: true }, list: [1] })
    const b = writeJson(join(dir, 'b.json'), { b: { y: 2 }, c: 3, list: [2] })
    const merged = mergeConfigFiles([a, b])
    assert.equal(merged.ok, true)
    assert.deepEqual(merged.value, { a: 1, b: { x: 1, keep: true, y: 2 }, c: 3, list: [2] })
    assert.equal(merged.layers.length, 2)

    const bad = join(dir, 'bad.json')
    writeFileSync(bad, '{oops', 'utf8')
    const failed = mergeConfigFiles([a, bad])
    assert.equal(failed.ok, false)
    assert.equal(failed.malformed.length, 1)
    assert.match(failed.malformed[0].error, /not valid JSON/)

    const missing = mergeConfigFiles([join(dir, 'ghost.json')])
    assert.equal(missing.ok, false)
    assert.match(missing.malformed[0].error, /does not exist/)
  } finally {
    cleanup(dir)
  }
})

test('deepMerge ignores non-objects and replaces arrays/scalars', () => {
  assert.deepEqual(deepMerge({ a: { x: 1 } }, null, { a: { y: 2 } }, 5), { a: { x: 1, y: 2 } })
  assert.deepEqual(deepMerge({ a: [1, 2] }, { a: [3] }), { a: [3] })
})

test('deepMerge never pollutes Object.prototype', () => {
  const merged = deepMerge(JSON.parse('{"__proto__":{"polluted":true},"a":1}'))
  assert.equal(merged.a, 1)
  assert.equal({}.polluted, undefined)
  assert.equal(Object.prototype.polluted, undefined)
})

test('redactSecrets hides secret-looking keys recursively', () => {
  const input = {
    apiKey: 'sk-live',
    nested: { password: 'p', token: 't', keep: 1 },
    list: [{ credential: 'c', plain: 'ok' }],
    normal: 'visible',
  }
  assert.deepEqual(redactSecrets(input), {
    apiKey: '[redacted]',
    nested: { password: '[redacted]', token: '[redacted]', keep: 1 },
    list: [{ credential: '[redacted]', plain: 'ok' }],
    normal: 'visible',
  })
})

test('identity hashes the workdir and separates linked worktrees from the common repo', () => {
  const dir = tempDir('rr-identity-')
  try {
    const repo = join(dir, 'repo')
    mkdirSync(repo, { recursive: true })
    makeRepo(repo)
    const main = projectIdentity(repo)
    assert.equal(main.git.isRepo, true)
    assert.equal(main.git.isLinkedWorktree, false)
    assert.equal(main.workdirHash, workdirHash(repo))
    assert.equal(main.git.repoHash, workdirHash(main.git.commonDir))

    const worktree = join(dir, 'linked')
    git(repo, ['worktree', 'add', '-q', '-b', 'linked-branch', worktree])
    const linked = projectIdentity(worktree)
    assert.equal(linked.git.isLinkedWorktree, true)
    assert.equal(linked.git.commonDir, main.git.commonDir)
    assert.equal(linked.git.repoHash, main.git.repoHash)
    assert.notEqual(linked.workdirHash, main.workdirHash)
    assert.equal(linked.git.worktreeRoot, linked.workdir)
  } finally {
    cleanup(dir)
  }
})

test('config CLI redacts by default, writes raw with --output, and exits 2 on bad input', async () => {
  const dir = tempDir('rr-config-cli-')
  try {
    const cfg = writeJson(join(dir, 'cfg.json'), { apiKey: 'sk-secret', port: 1 })
    const shown = await runNode([CLI, 'config', 'merge', '--file', cfg], dir)
    assert.equal(shown.code, 0)
    assert.match(shown.stdout, /\[redacted\]/)
    assert.ok(!shown.stdout.includes('sk-secret'))

    const out = join(dir, 'out.json')
    const written = await runNode([CLI, 'config', 'merge', '--file', cfg, '--output', out], dir)
    assert.equal(written.code, 0)
    assert.ok(!written.stdout.includes('sk-secret'))
    assert.match(readFileSync(out, 'utf8'), /sk-secret/)

    const raw = await runNode([CLI, 'config', 'merge', '--file', cfg, '--show-secrets'], dir)
    assert.match(raw.stdout, /sk-secret/)

    const bad = join(dir, 'bad.json')
    writeFileSync(bad, 'nope', 'utf8')
    const failed = await runNode([CLI, 'config', 'merge', '--file', bad], dir)
    assert.equal(failed.code, 2)
    assert.match(failed.stderr, /malformed config layer/)
  } finally {
    cleanup(dir)
  }
})
