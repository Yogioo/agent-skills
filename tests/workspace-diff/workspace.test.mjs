import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DEFAULT_SKIP, blobFingerprint, captureWorkspace, diff, resolveSkip } from '../../lib/workspace-diff.mjs'

const empty = { changed: [], added: [], removed: [] }

function git(dir, args, input) {
  return execFileSync('git', args, {
    cwd: dir, input, encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  }).trim()
}

function put(dir, path, contents) {
  const full = join(dir, path)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, contents)
}

function fixture(t, repo = false) {
  const dir = mkdtempSync(join(tmpdir(), 'workspace-diff-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  if (repo) {
    git(dir, ['init', '-q'])
    for (const [key, value] of Object.entries({
      'user.name': 'Workspace test', 'user.email': 'workspace@example.test',
      'core.autocrlf': 'false', 'commit.gpgsign': 'false', 'core.hooksPath': join(dir, '.no-hooks'),
    })) git(dir, ['config', key, value])
    put(dir, 'src/main.js', 'export const value = 1\n')
    put(dir, 'src/remove.js', 'export default 0\n')
    put(dir, '.gitignore', 'ignored/\n')
    git(dir, ['add', '-A'])
    git(dir, ['commit', '-qm', 'base'])
  }
  return dir
}

test('blob fingerprints match Git for binary content and require buffers', (t) => {
  const dir = fixture(t)
  const bytes = Buffer.from([0, 255, 10, 13, 127])
  put(dir, 'binary', bytes)
  assert.equal(blobFingerprint(bytes), git(dir, ['hash-object', '--no-filters', 'binary']))
  assert.throws(() => blobFingerprint('text'), /Buffer/)
})

test('skip defaults contain only VCS metadata and extras form a union', () => {
  assert.deepEqual([...DEFAULT_SKIP].sort(), ['.git', '.hg', '.svn'])
  assert.deepEqual([...resolveSkip([' build ', '', 'build'])].sort(), ['.git', '.hg', '.svn', 'build'])
  assert.ok(resolveSkip(new Set(['cache'])).has('cache'))
  assert.throws(() => resolveSkip('build'), /array or Set/)
})

test('ordinary document directory detects edits, additions and removals', (t) => {
  const dir = fixture(t)
  put(dir, 'notes/decision.md', '# Decision\nDraft\n')
  put(dir, 'old.txt', 'old')
  const before = captureWorkspace(dir)
  assert.equal(before.mode, 'walk')
  assert.ok(before.elapsedMs >= 0)
  put(dir, 'notes/decision.md', '# Decision\nAccepted\n')
  put(dir, 'notes/next.md', '# Next\n')
  rmSync(join(dir, 'old.txt'))
  const after = captureWorkspace(dir)
  assert.deepEqual(diff(before.files, after.files), {
    changed: ['notes/decision.md'], added: ['notes/next.md'], removed: ['old.txt'],
  })
  assert.deepEqual(diff(after.files, captureWorkspace(dir).files), empty)
})

test('walk skips metadata and configured segments, without guessing build directories', (t) => {
  const dir = fixture(t)
  for (const name of ['.git', '.hg', '.svn', 'build', 'node_modules', 'nested/cache']) put(dir, `${name}/data`, name)
  const files = captureWorkspace(dir, { mode: 'walk', skip: ['cache'] }).files
  assert.deepEqual(Object.keys(files).sort(), ['build/data', 'node_modules/data'])
})

test('Git code changes include staged, unstaged, untracked and deleted files', (t) => {
  const dir = fixture(t, true)
  const before = captureWorkspace(dir)
  assert.equal(before.mode, 'git')
  put(dir, 'src/main.js', 'export const value = 2\n')
  git(dir, ['add', 'src/main.js'])
  put(dir, 'src/main.js', 'export const value = 3\n')
  put(dir, 'src/staged.js', 'export default 4\n')
  git(dir, ['add', 'src/staged.js'])
  put(dir, 'src/new.js', 'export default 5\n')
  put(dir, 'ignored/cache', 'ignored')
  rmSync(join(dir, 'src/remove.js'))
  const indexBefore = readFileSync(join(dir, '.git/index'))
  const after = captureWorkspace(dir)
  assert.deepEqual(readFileSync(join(dir, '.git/index')), indexBefore, 'capture must not refresh the index')
  assert.equal(after.files['src/main.js'], blobFingerprint(Buffer.from('export const value = 3\n')))
  assert.deepEqual(diff(before.files, after.files), {
    changed: ['src/main.js'], added: ['src/new.js', 'src/staged.js'], removed: ['src/remove.js'],
  })
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-qm', 'changes'])
  assert.deepEqual(diff(after.files, captureWorkspace(dir).files), empty)
  assert.deepEqual(diff(before.files, captureWorkspace(dir).files), diff(before.files, after.files))
})

test('staged deletion then recreation hashes the actual file even under an extra skip', (t) => {
  const dir = fixture(t, true)
  const before = captureWorkspace(dir).files
  git(dir, ['rm', '-q', 'src/main.js', 'src/remove.js'])
  put(dir, 'src/main.js', 'recreated\n')
  put(dir, 'src/noise.js', 'untracked\n')
  const after = captureWorkspace(dir, { skip: ['src'] }).files
  assert.deepEqual(diff(before, after), { changed: ['src/main.js'], added: [], removed: ['src/remove.js'] })
  put(dir, 'src/main.js', 'export const value = 1\n')
  assert.deepEqual(diff(before, captureWorkspace(dir, { skip: ['src'] }).files).changed, [])
})

test('extra skips never suppress clean or modified tracked files', (t) => {
  const dir = fixture(t, true)
  const before = captureWorkspace(dir, { skip: ['src'] }).files
  assert.ok(Object.hasOwn(before, 'src/main.js'))
  put(dir, 'src/main.js', 'changed\n')
  put(dir, 'src/noise.js', 'noise\n')
  assert.deepEqual(diff(before, captureWorkspace(dir, { skip: ['src'] }).files), {
    changed: ['src/main.js'], added: [], removed: [],
  })
})

test('subdirectory captures localize both index and status paths', (t) => {
  const dir = fixture(t, true)
  const sub = join(dir, 'src')
  const before = captureWorkspace(sub).files
  put(dir, 'src/main.js', 'changed\n')
  put(dir, 'src/new file.js', 'new\n')
  put(dir, 'outside.js', 'outside\n')
  assert.deepEqual(diff(before, captureWorkspace(sub).files), {
    changed: ['main.js'], added: ['new file.js'], removed: [],
  })
})

test('Git canonical text hashes stay stable across CRLF staging and commits', (t) => {
  const dir = fixture(t, true)
  git(dir, ['config', 'core.autocrlf', 'true'])
  put(dir, '.gitattributes', '*.txt text eol=crlf\n')
  put(dir, 'note.txt', 'first\r\nsecond\r\n')
  put(dir, 'new.js', 'export default 9\r\n')
  const beforeStage = captureWorkspace(dir).files
  assert.equal(beforeStage['note.txt'], blobFingerprint(Buffer.from('first\nsecond\n')))
  git(dir, ['add', '-A'])
  assert.deepEqual(diff(beforeStage, captureWorkspace(dir).files), empty)
  git(dir, ['commit', '-qm', 'CRLF text'])
  assert.deepEqual(diff(beforeStage, captureWorkspace(dir).files), empty)
  put(dir, 'note.txt', 'edited\r\n')
  const dirty = captureWorkspace(dir).files
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-qm', 'edit CRLF text'])
  assert.deepEqual(diff(dirty, captureWorkspace(dir).files), empty)
})

for (const mode of ['walk', 'git']) {
  test(`${mode} snapshots preserve prototype-like filenames`, (t) => {
    const dir = fixture(t, mode === 'git')
    for (const name of ['__proto__', 'toString', 'constructor']) put(dir, name, name)
    const before = captureWorkspace(dir, { mode }).files
    assert.equal(Object.getPrototypeOf(before), null)
    assert.equal(before.__proto__, blobFingerprint(Buffer.from('__proto__')))
    put(dir, '__proto__', 'edited')
    rmSync(join(dir, 'toString'))
    assert.deepEqual(diff(before, captureWorkspace(dir, { mode }).files), {
      changed: ['__proto__'], added: [], removed: ['toString'],
    })
  })
}

test('diff uses own keys, sorts all groups and does not mutate inputs', () => {
  const before = Object.freeze({ z: 'old', a: 'old', y: 'gone', b: 'gone' })
  const after = Object.freeze({ z: 'new', a: 'new', x: 'added', c: 'added', toString: 'own' })
  assert.deepEqual(diff(before, after), {
    changed: ['a', 'z'], added: ['c', 'toString', 'x'], removed: ['b', 'y'],
  })
  assert.deepEqual(diff({}, {}), empty)
})

test('invalid roots and modes fail; explicit Git never falls back for ordinary directories', (t) => {
  const dir = fixture(t)
  put(dir, 'file', 'contents')
  for (const root of [undefined, null, '', ' ', 42, join(dir, 'missing'), join(dir, 'file')]) {
    assert.throws(() => captureWorkspace(root))
  }
  for (const mode of ['', 'typo', null, false]) assert.throws(() => captureWorkspace(dir, { mode }), /mode/)
  assert.throws(() => captureWorkspace(dir, { mode: 'git' }), /not a Git work tree/)
  assert.equal(captureWorkspace(dir, { mode: 'auto' }).mode, 'walk')
})

test('Git is optional in auto mode but required in explicit Git mode', (t) => {
  const dir = fixture(t)
  put(dir, 'document.md', 'document')
  const moduleUrl = new URL('../../lib/workspace-diff.mjs', import.meta.url).href
  const script = `import { captureWorkspace } from ${JSON.stringify(moduleUrl)};
    import assert from 'node:assert/strict';
    assert.equal(captureWorkspace(process.argv[1]).mode, 'walk');
    assert.throws(() => captureWorkspace(process.argv[1], {mode:'git'}), {code:'ENOENT'});`
  execFileSync(process.execPath, ['--input-type=module', '-e', script, dir], {
    env: { ...process.env, PATH: '', Path: '' }, cwd: dir, stdio: 'pipe', windowsHide: true,
  })
})

test('Git failures never silently become walk snapshots', (t) => {
  const dir = fixture(t, true)
  writeFileSync(join(dir, '.git/index'), 'corrupted index')
  assert.throws(() => captureWorkspace(dir), /Git ls-files failed/)
})

for (const flag of ['--skip-worktree', '--assume-unchanged']) {
  test(`unsupported index ${flag} is explicit`, (t) => {
    const dir = fixture(t, true)
    git(dir, ['update-index', flag, 'src/main.js'])
    assert.throws(() => captureWorkspace(dir), /Unsupported Git index state/)
  })
}

test('Git submodules and unresolved index stages are explicitly unsupported', (t) => {
  const dir = fixture(t, true)
  git(dir, ['update-index', '--add', '--cacheinfo', `160000,${git(dir, ['rev-parse', 'HEAD'])},dependency`])
  assert.throws(() => captureWorkspace(dir), /Unsupported Git index state/)
  git(dir, ['update-index', '--force-remove', 'dependency'])
  const hash = git(dir, ['rev-parse', ':src/main.js'])
  git(dir, ['update-index', '--index-info'], `0 ${'0'.repeat(40)}\tsrc/main.js\n100644 ${hash} 1\tsrc/main.js\n100644 ${hash} 2\tsrc/main.js\n`)
  assert.throws(() => captureWorkspace(dir), /Unsupported Git index state/)
})

test('external clean filters fail without executing a configured command', (t) => {
  const dir = fixture(t, true)
  put(dir, '.gitattributes', '*.js filter=external\n')
  git(dir, ['config', 'filter.external.clean', 'this-command-must-never-run'])
  assert.throws(() => captureWorkspace(dir), /Unsupported Git clean filter/)
})

test('walk fingerprints a directory symlink target without recursing', (t) => {
  const dir = fixture(t)
  put(dir, 'document.md', 'content')
  try {
    symlinkSync(dir, join(dir, 'loop'), process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    if (!['EPERM', 'EACCES'].includes(error.code)) throw error
    t.skip('Creating symlinks is not permitted')
    return
  }
  const files = captureWorkspace(dir, { mode: 'walk' }).files
  assert.deepEqual(Object.keys(files).sort(), ['document.md', 'loop'])
  assert.equal(typeof files.loop, 'string')
})

test('file symlinks hash link targets, including dangling links, in both modes', (t) => {
  const dir = fixture(t, true)
  try {
    symlinkSync('missing-one', join(dir, 'link'))
  } catch (error) {
    if (!['EPERM', 'EACCES'].includes(error.code)) throw error
    t.skip('Creating symlinks is not permitted')
    return
  }
  for (const mode of ['git', 'walk']) {
    assert.equal(captureWorkspace(dir, { mode }).files.link, blobFingerprint(Buffer.from('missing-one')))
  }
  const before = captureWorkspace(dir).files
  rmSync(join(dir, 'link'))
  symlinkSync('missing-two', join(dir, 'link'))
  assert.deepEqual(diff(before, captureWorkspace(dir).files).changed, ['link'])
})

test('unreadable files and directories fail instead of returning partial snapshots', (t) => {
  if (process.platform === 'win32' || process.getuid?.() === 0) {
    t.skip('Requires POSIX permission enforcement for a non-root user')
    return
  }
  const dir = fixture(t, true)
  const file = join(dir, 'src/main.js')
  chmodSync(file, 0)
  try {
    for (const mode of ['git', 'walk']) assert.throws(() => captureWorkspace(dir, { mode }), /EACCES|Permission denied/)
  } finally {
    chmodSync(file, 0o600)
  }
  put(dir, 'private/document.md', 'hidden')
  const privateDir = join(dir, 'private')
  chmodSync(privateDir, 0)
  try {
    for (const mode of ['git', 'walk']) assert.throws(() => captureWorkspace(dir, { mode }), /EACCES|Permission denied|Git status failed/)
  } finally {
    chmodSync(privateDir, 0o700)
  }
})
