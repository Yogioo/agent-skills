import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync,
  realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createRuntimeCopy } from '../support/runtime-package.mjs'

const cli = fileURLToPath(new URL('../../tools/workspace-diff/cli.mjs', import.meta.url))
const defaultSkip = ['.git', '.hg', '.svn']

function fixture(t) {
  const temp = mkdtempSync(join(tmpdir(), 'workspace-diff-cli-'))
  t.after(() => rmSync(temp, { recursive: true, force: true, maxRetries: 3 }))
  const root = join(temp, 'document workspace')
  mkdirSync(root)
  return { temp, root }
}

function put(root, path, content) {
  const file = join(root, path)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content, 'utf8')
  return file
}

function invoke(args, { executable = cli, cwd } = {}) {
  const result = spawnSync(process.execPath, [executable, ...args], {
    cwd, encoding: 'utf8', windowsHide: true, timeout: 30_000,
  })
  assert.ifError(result.error)
  assert.equal(result.signal, null)
  return result
}

function success(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.equal(result.stderr, '')
  return JSON.parse(result.stdout)
}

function failure(result, code) {
  assert.equal(result.status, code, result.stderr || result.stdout)
  assert.equal(result.stdout, '')
  const error = JSON.parse(result.stderr)
  assert.equal(typeof error, 'object')
  assert.ok(error && !Array.isArray(error))
  assert.ok(Object.keys(error).length > 0)
}

function snapshot(root, out, flags = [], options = {}) {
  const report = success(invoke(['snapshot', '--workdir', root, '--out', out, ...flags], options))
  const data = JSON.parse(readFileSync(out, 'utf8'))
  assert.deepEqual(report, {
    status: 'captured', snapshotFile: realpathSync(out),
    mode: data.mode, fileCount: Object.keys(data.files).length,
  })
  assert.equal(data.version, 1)
  assert.equal(data.root, realpathSync(root))
  assert.ok(['git', 'walk'].includes(data.mode))
  assert.deepEqual(data.skip, [...new Set(data.skip)].sort())
  for (const name of defaultSkip) assert.ok(data.skip.includes(name))
  for (const hash of Object.values(data.files)) assert.match(hash, /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)
  return data
}

function compare(before, after, options = {}) {
  return success(invoke(['compare', '--before', before, '--after', after], options))
}

function git(root, args) {
  return execFileSync('git', [
    '-c', 'core.autocrlf=false',
    '-c', 'user.name=workspace-diff test',
    '-c', 'user.email=workspace-diff@example.test', ...args,
  ], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30_000 })
}

test('Git code task captures tracked, staged and untracked content changes', (t) => {
  const { temp, root } = fixture(t)
  git(root, ['init', '--quiet'])
  put(root, '.gitignore', 'generated/\n')
  put(root, 'src/z.mjs', 'export const z = 1\n')
  put(root, 'src/a.mjs', 'export const a = 1\n')
  put(root, 'src/old-z.mjs', 'export default 0\n')
  put(root, 'src/old-a.mjs', 'export default 0\n')
  git(root, ['add', '.'])
  const before = join(temp, 'before.json')
  const initial = snapshot(root, before)
  assert.equal(initial.mode, 'git')
  assert.deepEqual(Object.keys(initial.files).sort(), [
    '.gitignore', 'src/a.mjs', 'src/old-a.mjs', 'src/old-z.mjs', 'src/z.mjs',
  ])

  put(root, 'src/z.mjs', 'export const z = 2\n')
  put(root, 'src/a.mjs', 'export const a = 2\n')
  git(root, ['add', 'src/a.mjs'])
  put(root, 'src/new-z.mjs', 'export default 2\n')
  put(root, 'src/new-a.mjs', 'export default 1\n')
  rmSync(join(root, 'src/old-z.mjs'))
  rmSync(join(root, 'src/old-a.mjs'))
  put(root, 'generated/output.js', 'ignored\n')
  const after = join(temp, 'after.json')
  snapshot(root, after, ['--mode', 'git'])
  assert.deepEqual(compare(before, after), {
    status: 'compared', changed: ['src/a.mjs', 'src/z.mjs'],
    added: ['src/new-a.mjs', 'src/new-z.mjs'], removed: ['src/old-a.mjs', 'src/old-z.mjs'],
  })

  const walked = snapshot(root, join(temp, 'walk.json'), ['--mode', 'walk'])
  assert.equal(walked.mode, 'walk')
  assert.ok(Object.hasOwn(walked.files, 'generated/output.js'))
  assert.ok(!Object.keys(walked.files).some((path) => path.startsWith('.git/')))
})

test('document edits and unchanged snapshots work with auto/walk and repeated skips', (t) => {
  const { temp, root } = fixture(t)
  put(root, 'notes/meeting.md', '# Meeting\n\u4f1a\u8bae\u8bb0\u5f55\n')
  put(root, 'archive.md', 'old\n')
  put(root, 'build/keep.md', 'included unless explicitly skipped\n')
  for (const name of ['.git', '.hg', '.svn', 'cache', 'drafts']) {
    put(root, `notes/${name}/hidden.txt`, 'excluded\n')
  }
  const skips = ['--skip', 'drafts', '--skip', 'cache', '--skip', 'cache']
  const before = join(temp, 'before.json')
  const initial = snapshot(root, before, ['--mode', 'auto', ...skips])
  assert.equal(initial.mode, 'walk')
  assert.deepEqual(initial.skip, [...defaultSkip, 'cache', 'drafts'])
  assert.deepEqual(Object.keys(initial.files).sort(), ['archive.md', 'build/keep.md', 'notes/meeting.md'])
  const unchanged = join(temp, 'unchanged.json')
  snapshot(root, unchanged, ['--mode', 'walk', ...skips])
  assert.deepEqual(compare(before, unchanged), { status: 'compared', changed: [], added: [], removed: [] })

  put(root, 'notes/meeting.md', '# Meeting\n\u5df2\u786e\u8ba4\n')
  put(root, 'notes/decision.md', '# Decision\n')
  put(root, 'notes/cache/hidden.txt', 'still excluded\n')
  rmSync(join(root, 'archive.md'))
  const after = join(temp, 'after.json')
  snapshot(root, after, skips)
  assert.deepEqual(compare(before, after), {
    status: 'compared', changed: ['notes/meeting.md'], added: ['notes/decision.md'], removed: ['archive.md'],
  })
})

test('copied runtime runs alone outside the repository on a document folder', (t) => {
  const { temp, root } = fixture(t)
  const rt = createRuntimeCopy('workspace-diff-runtime-')
  t.after(() => rmSync(rt.root, { recursive: true, force: true, maxRetries: 3 }))
  const options = { executable: rt.cli('workspace-diff'), cwd: temp }
  assert.equal(existsSync(join(rt.root, 'skills')), false)
  put(root, 'notes.md', '# Notes\n')
  const before = join(temp, 'before.json')
  snapshot(root, before, [], options)
  put(root, 'notes.md', '# Updated notes\n')
  const after = join(temp, 'after.json')
  snapshot(root, after, [], options)
  assert.deepEqual(compare(before, after, options), {
    status: 'compared', changed: ['notes.md'], added: [], removed: [],
  })
})

test('installed runtime directory junction or symlink executes help and snapshot', (t) => {
  const { temp, root } = fixture(t)
  const rt = createRuntimeCopy('workspace-diff-junction-')
  t.after(() => rmSync(rt.root, { recursive: true, force: true, maxRetries: 3 }))
  const installed = join(temp, 'installed-runtime')
  symlinkSync(rt.root, installed, process.platform === 'win32' ? 'junction' : 'dir')
  const options = { executable: join(installed, 'tools', 'workspace-diff', 'cli.mjs'), cwd: temp }
  const help = invoke(['--help'], options)
  assert.equal(help.status, 0, help.stderr)
  assert.equal(help.stderr, '')
  assert.match(help.stdout, /snapshot/)
  assert.match(help.stdout, /compare/)

  put(root, 'notes.md', '# Notes\n')
  const data = snapshot(root, join(temp, 'snapshot.json'), [], options)
  assert.equal(data.mode, 'walk')
  assert.deepEqual(Object.keys(data.files), ['notes.md'])
})

test('output cannot contaminate the root or replace an existing snapshot', (t) => {
  const { temp, root } = fixture(t)
  put(root, 'notes.md', 'notes\n')
  const internal = join(root, 'snapshot.json')
  failure(invoke(['snapshot', '--workdir', root, '--out', internal]), 2)
  assert.equal(existsSync(internal), false)
  const out = join(temp, 'existing.json')
  snapshot(root, out)
  const original = readFileSync(out, 'utf8')
  put(root, 'notes.md', 'changed\n')
  failure(invoke(['snapshot', '--workdir', root, '--out', out]), 1)
  assert.equal(readFileSync(out, 'utf8'), original)
})

test('missing roots, inputs and output parents report I/O errors', (t) => {
  const { temp, root } = fixture(t)
  const missing = join(temp, 'missing')
  const file = put(root, 'notes.md', 'notes\n')
  for (const workdir of [missing, file]) {
    failure(invoke(['snapshot', '--workdir', workdir, '--out', join(temp, 'out.json')]), 1)
  }
  failure(invoke(['snapshot', '--workdir', root, '--out', join(missing, 'out.json')]), 1)
  assert.equal(existsSync(missing), false)
  const valid = join(temp, 'valid.json')
  snapshot(root, valid)
  for (const input of [missing, root]) {
    failure(invoke(['compare', '--before', input, '--after', valid]), 1)
    failure(invoke(['compare', '--before', valid, '--after', input]), 1)
  }
})

test('malformed snapshots and unsafe file entries are invalid input', (t) => {
  const { temp, root } = fixture(t)
  put(root, 'notes.md', 'notes\n')
  const valid = join(temp, 'valid.json')
  const data = snapshot(root, valid)
  const hash = data.files['notes.md']
  const malformed = [
    '{', 'null', JSON.stringify({ ...data, version: 2 }),
    JSON.stringify({ ...data, files: [] }), JSON.stringify({ ...data, skip: '.git' }),
    JSON.stringify({ ...data, files: { 'notes.md': 'not-a-hash' } }),
    ...['../outside.md', '/absolute.md', 'notes\\unsafe.md'].map((path) =>
      JSON.stringify({ ...data, files: { [path]: hash } })),
  ]
  for (const [index, raw] of malformed.entries()) {
    const bad = put(temp, `bad-${index}.json`, raw)
    failure(invoke(['compare', '--before', valid, '--after', bad]), 2)
    failure(invoke(['compare', '--before', bad, '--after', valid]), 2)
  }
  if (process.platform === 'win32') {
    const bad = put(temp, 'drive-relative-root.json', JSON.stringify({ ...data, root: '\\notes' }))
    // Matching roots ensure metadata mismatch cannot mask missing validation.
    failure(invoke(['compare', '--before', bad, '--after', bad]), 2)
  }
})

test('snapshot comparison rejects mismatched root, mode or effective skips', (t) => {
  const { temp, root } = fixture(t)
  put(root, 'notes.md', 'notes\n')
  const before = join(temp, 'before.json')
  const data = snapshot(root, before)
  for (const [index, patch] of [
    { root: realpathSync(temp) }, { mode: 'git' }, { skip: [...defaultSkip, 'cache'] },
  ].entries()) {
    const after = put(temp, `incompatible-${index}.json`, JSON.stringify({ ...data, ...patch }))
    failure(invoke(['compare', '--before', before, '--after', after]), 2)
  }
})

test('help succeeds and invalid flags are usage errors', (t) => {
  const { temp, root } = fixture(t)
  const help = invoke(['--help'])
  assert.equal(help.status, 0)
  assert.equal(help.stderr, '')
  assert.match(help.stdout, /snapshot/)
  assert.match(help.stdout, /compare/)
  const capture = ['snapshot', '--workdir', root, '--out', resolve(temp, 'out.json')]
  const cases = [
    [], ['unknown'], ['snapshot', '--workdir', root], ['compare', '--before', 'before.json'],
    [...capture, '--unknown', 'value'], [...capture, '--skip'],
    [...capture, '--mode', 'invalid'], [...capture, '--workdir', root],
    ['compare', '--before', 'a.json', '--after', 'b.json', '--after', 'c.json'],
  ]
  for (const args of cases) failure(invoke(args), 2)
})
