/**
 * Git checkpoint/restore tests in disposable repositories.
 *
 *   node --test tests/run-runtime/checkpoint.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  checkpointStatus,
  createCheckpoint,
  restoreCheckpoint,
} from '../../lib/run-runtime/checkpoint.mjs'
import { CliError } from '../../lib/run-runtime/util.mjs'
import { cleanup, commitAll, git, makeRepo, tempDir } from './helpers.mjs'

function expectCode(code) {
  return (err) => err instanceof CliError && err.code === code
}

test('create requires a real Git repo and a clean worktree', () => {
  const dir = tempDir('rr-checkpoint-req-')
  try {
    const plain = join(dir, 'plain')
    mkdirSync(plain, { recursive: true })
    assert.throws(() => createCheckpoint({ workdir: plain, stateFile: join(dir, 's.json') }), expectCode('NOT_A_REPO'))

    const repo = join(dir, 'repo')
    mkdirSync(repo, { recursive: true })
    makeRepo(repo)
    writeFileSync(join(repo, 'a.txt'), 'dirty\n')
    assert.throws(() => createCheckpoint({ workdir: repo, stateFile: join(dir, 's.json') }), expectCode('DIRTY_WORKTREE'))
  } finally {
    cleanup(dir)
  }
})

test('create records root/head/ownership and status matches', () => {
  const dir = tempDir('rr-checkpoint-create-')
  try {
    const repo = join(dir, 'repo')
    mkdirSync(repo, { recursive: true })
    const head = makeRepo(repo)
    const stateFile = join(dir, 'state.json')
    const created = createCheckpoint({ workdir: repo, stateFile })
    assert.equal(created.created, true)
    assert.equal(created.head, head)

    const state = JSON.parse(readFileSync(stateFile, 'utf8'))
    assert.equal(state.tool, 'run-runtime')
    assert.equal(state.root.replace(/\\/g, '/').toLowerCase(), repo.replace(/\\/g, '/').toLowerCase())
    assert.equal(state.owner.pid, process.pid)

    const status = checkpointStatus({ stateFile })
    assert.equal(status.matches.rootMatches, true)
    assert.equal(status.matches.repoMatches, true)
    assert.equal(status.matches.headMatches, true)
    assert.equal(status.matches.clean, true)
    assert.equal(typeof state.repoHash, 'string')
    assert.equal(state.repoHash.length, 16)
  } finally {
    cleanup(dir)
  }
})

test('restore resets tracked files and only cleans untracked when asked', () => {
  const dir = tempDir('rr-checkpoint-restore-')
  try {
    const repo = join(dir, 'repo')
    mkdirSync(repo, { recursive: true })
    makeRepo(repo)
    const stateFile = join(dir, 'state.json')
    createCheckpoint({ workdir: repo, stateFile })

    writeFileSync(join(repo, 'a.txt'), 'changed\n')
    writeFileSync(join(repo, 'keep.txt'), 'keep\n')
    writeFileSync(join(repo, 'drop.txt'), 'drop\n')

    const readText = () => readFileSync(join(repo, 'a.txt'), 'utf8').replace(/\r\n/g, '\n')

    const soft = restoreCheckpoint({ stateFile })
    assert.equal(soft.untrackedCleaned, false)
    assert.equal(readText(), 'hello\n')
    assert.equal(existsSync(join(repo, 'keep.txt')), true)
    assert.equal(existsSync(join(repo, 'drop.txt')), true)

    writeFileSync(join(repo, 'a.txt'), 'changed again\n')
    const hard = restoreCheckpoint({ stateFile, cleanUntracked: true, excludePaths: ['keep.txt'] })
    assert.equal(hard.untrackedCleaned, true)
    assert.equal(readText(), 'hello\n')
    assert.equal(existsSync(join(repo, 'drop.txt')), false)
    assert.equal(existsSync(join(repo, 'keep.txt')), true)
  } finally {
    cleanup(dir)
  }
})

test('restore refuses a HEAD mismatch so concurrent commits survive', () => {
  const dir = tempDir('rr-checkpoint-head-')
  try {
    const repo = join(dir, 'repo')
    mkdirSync(repo, { recursive: true })
    makeRepo(repo)
    const stateFile = join(dir, 'state.json')
    createCheckpoint({ workdir: repo, stateFile })

    writeFileSync(join(repo, 'b.txt'), 'new\n')
    const newHead = commitAll(repo, 'concurrent')
    assert.throws(
      () => restoreCheckpoint({ stateFile }),
      (err) => err instanceof CliError && err.code === 'HEAD_MISMATCH',
    )
    assert.equal(git(repo, ['rev-parse', 'HEAD']).trim(), newHead)
    assert.equal(existsSync(join(repo, 'b.txt')), true)
  } finally {
    cleanup(dir)
  }
})

test('restore refuses a different repository root', () => {
  const dir = tempDir('rr-checkpoint-root-')
  try {
    const repoA = join(dir, 'a')
    const repoB = join(dir, 'b')
    mkdirSync(repoA, { recursive: true })
    mkdirSync(repoB, { recursive: true })
    makeRepo(repoA)
    makeRepo(repoB)
    const stateFile = join(dir, 'state.json')
    createCheckpoint({ workdir: repoA, stateFile })
    assert.throws(
      () => restoreCheckpoint({ stateFile, workdir: repoB }),
      (err) => err instanceof CliError && err.code === 'ROOT_MISMATCH',
    )
  } finally {
    cleanup(dir)
  }
})

test('missing and malformed state files are explicit', () => {
  const dir = tempDir('rr-checkpoint-state-')
  try {
    assert.throws(
      () => restoreCheckpoint({ stateFile: join(dir, 'none.json') }),
      (err) => err instanceof CliError && err.exitCode === 2 && err.code === 'STATE_MISSING',
    )
    const bad = join(dir, 'bad.json')
    writeFileSync(bad, '{not json', 'utf8')
    assert.throws(
      () => restoreCheckpoint({ stateFile: bad }),
      (err) => err instanceof CliError && err.exitCode === 2 && err.code === 'STATE_MALFORMED',
    )
    const wrong = join(dir, 'wrong.json')
    writeFileSync(wrong, JSON.stringify({ tool: 'other', root: 'x', head: 'y' }), 'utf8')
    assert.throws(
      () => restoreCheckpoint({ stateFile: wrong }),
      (err) => err instanceof CliError && err.code === 'STATE_INVALID',
    )
  } finally {
    cleanup(dir)
  }
})

test('create refuses an existing state file and state inside the worktree', () => {
  const dir = tempDir('rr-checkpoint-overwrite-')
  try {
    const repo = join(dir, 'repo')
    mkdirSync(repo, { recursive: true })
    makeRepo(repo)

    const stateFile = join(dir, 'state.json')
    writeFileSync(stateFile, 'already here\n', 'utf8')
    assert.throws(
      () => createCheckpoint({ workdir: repo, stateFile }),
      (err) => err instanceof CliError && err.code === 'STATE_EXISTS',
    )
    assert.equal(readFileSync(stateFile, 'utf8'), 'already here\n')

    assert.throws(
      () => createCheckpoint({ workdir: repo, stateFile: join(repo, 'state.json') }),
      (err) => err instanceof CliError && err.code === 'STATE_INSIDE_WORKTREE',
    )
  } finally {
    cleanup(dir)
  }
})

test('restore refuses untracked and ignored obstructions of tracked paths', () => {
  const dir = tempDir('rr-checkpoint-obstruct-')
  try {
    const repo = join(dir, 'repo')
    mkdirSync(repo, { recursive: true })
    makeRepo(repo)
    mkdirSync(join(repo, 'dir'))
    writeFileSync(join(repo, 'dir', 'file.txt'), 'tracked\n')
    writeFileSync(join(repo, '.gitignore'), 'dir\n')
    git(repo, ['add', '-f', 'dir/file.txt'])
    commitAll(repo, 'tracked dir')

    const stateFile = join(dir, 'state.json')
    createCheckpoint({ workdir: repo, stateFile })

    // A tracked directory is replaced by an ignored untracked file at the same path.
    rmSync(join(repo, 'dir'), { recursive: true, force: true })
    writeFileSync(join(repo, 'dir'), 'obstruction\n')

    for (const extra of [{}, { cleanUntracked: true }, { cleanUntracked: true, excludePaths: ['dir'] }]) {
      assert.throws(
        () => restoreCheckpoint({ stateFile, ...extra }),
        (err) => err instanceof CliError && err.code === 'OBSTRUCTED',
      )
      assert.equal(readFileSync(join(repo, 'dir'), 'utf8'), 'obstruction\n')
    }
  } finally {
    cleanup(dir)
  }
})

test('restore refuses a tracked file replaced by an untracked directory', () => {
  const dir = tempDir('rr-checkpoint-obstruct2-')
  try {
    const repo = join(dir, 'repo')
    mkdirSync(repo, { recursive: true })
    makeRepo(repo)
    const stateFile = join(dir, 'state.json')
    createCheckpoint({ workdir: repo, stateFile })

    rmSync(join(repo, 'a.txt'), { force: true })
    mkdirSync(join(repo, 'a.txt'))
    writeFileSync(join(repo, 'a.txt', 'nested.txt'), 'obstruction\n')

    assert.throws(
      () => restoreCheckpoint({ stateFile, cleanUntracked: true }),
      (err) => err instanceof CliError && err.code === 'OBSTRUCTED',
    )
    assert.equal(existsSync(join(repo, 'a.txt', 'nested.txt')), true)
    assert.equal(existsSync(join(repo, 'a.txt', 'a.txt')), false)
  } finally {
    cleanup(dir)
  }
})

test('inherited Git environment cannot redirect checkpoint operations', () => {
  const dir = tempDir('rr-checkpoint-env-')
  const saved = {
    GIT_DIR: process.env.GIT_DIR,
    GIT_WORK_TREE: process.env.GIT_WORK_TREE,
    GIT_INDEX_FILE: process.env.GIT_INDEX_FILE,
    GIT_COMMON_DIR: process.env.GIT_COMMON_DIR,
  }
  try {
    const repo = join(dir, 'repo')
    const decoy = join(dir, 'decoy')
    mkdirSync(repo, { recursive: true })
    mkdirSync(decoy, { recursive: true })
    const head = makeRepo(repo)
    makeRepo(decoy)

    process.env.GIT_DIR = join(decoy, '.git')
    process.env.GIT_WORK_TREE = decoy
    process.env.GIT_INDEX_FILE = join(decoy, '.git', 'index')
    process.env.GIT_COMMON_DIR = join(decoy, '.git')

    const stateFile = join(dir, 'state.json')
    const created = createCheckpoint({ workdir: repo, stateFile })
    assert.equal(created.head, head)
    assert.equal(
      created.root.replace(/\\/g, '/').toLowerCase(),
      repo.replace(/\\/g, '/').toLowerCase(),
    )
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    cleanup(dir)
  }
})
