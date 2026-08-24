/**
 * afk-run git 工具测试（真实临时 git 仓库）。
 *
 * 运行：
 *   cd C:\projects\agent-skills
 *   node --test tests/afk-run/git.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureGit, isClean, head, commitAll, resetHard, isGitRepo } from '../../skills/afk-run/scripts/git.mjs'

function git(dir, args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function tmpRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'afk-git-'))
  ensureGit(dir, { name: 'Test', email: 'test@local' })
  return dir
}

test('ensureGit: 非 git 目录自动 init + 配置 local 身份（不依赖全局）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'afk-git-'))
  assert.equal(isGitRepo(dir), false)
  ensureGit(dir, { name: 'AFK Bot', email: 'afk@local' })
  assert.equal(isGitRepo(dir), true)
  assert.equal(git(dir, ['config', '--local', 'user.name']).trim(), 'AFK Bot')
  assert.equal(git(dir, ['config', '--local', 'user.email']).trim(), 'afk@local')
  rmSync(dir, { recursive: true, force: true })
})

test('isClean: 干净 true，有未提交改动 false', () => {
  const dir = tmpRepo()
  assert.equal(isClean(dir), true)
  writeFileSync(join(dir, 'a.txt'), 'x')
  assert.equal(isClean(dir), false)
  rmSync(dir, { recursive: true, force: true })
})

test('head: 无 commit 返回 null，commit 后返回 hash', () => {
  const dir = tmpRepo()
  assert.equal(head(dir), null)
  writeFileSync(join(dir, 'a.txt'), 'x')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-m', 'init'])
  const h = head(dir)
  assert.ok(h && h.length === 40)
  rmSync(dir, { recursive: true, force: true })
})

test('commitAll: 统一提交（消息含 afk: <id> <title>）', () => {
  const dir = tmpRepo()
  writeFileSync(join(dir, 'work.txt'), 'v1')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-m', 'init'])
  writeFileSync(join(dir, 'work.txt'), 'v2')
  writeFileSync(join(dir, 'new.txt'), 'n')
  commitAll(dir, { id: 'bd-1', title: '修复 bug', status: 'approved', summary: '完成' })
  const log = git(dir, ['log', '--format=%s', '-1'])
  assert.ok(log.includes('afk: bd-1'))
  assert.ok(log.includes('修复 bug'))
  assert.equal(isClean(dir), true)
  rmSync(dir, { recursive: true, force: true })
})

test('commitAll: 排除停止文件（afk-stop 不进 commit 也不被删）', () => {
  const dir = tmpRepo()
  writeFileSync(join(dir, 'a.txt'), 'x')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-m', 'init'])
  writeFileSync(join(dir, 'afk-stop'), 'stop me')
  writeFileSync(join(dir, 'real.txt'), 'r')
  commitAll(dir, { id: 'bd-2', title: 't', status: 'approved', summary: 's' }, 'afk-stop')
  const files = git(dir, ['show', '--name-only', '--format=', 'HEAD']).trim().split('\n')
  assert.ok(files.includes('real.txt'))
  assert.ok(!files.includes('afk-stop'), '停止文件不应被提交')
  assert.ok(git(dir, ['status', '--porcelain']).includes('afk-stop'), '停止文件仍在工作区（untracked）')
  rmSync(dir, { recursive: true, force: true })
})

test('resetHard: 有 HEAD 时回滚到指定基线（含 untracked 清除，排除停止文件）', () => {
  const dir = tmpRepo()
  writeFileSync(join(dir, 'a.txt'), 'x')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-m', 'init'])
  const base = head(dir)
  writeFileSync(join(dir, 'a.txt'), '被任务改了')
  writeFileSync(join(dir, 'junk.txt'), '残留')
  writeFileSync(join(dir, 'afk-stop'), 'stop')
  resetHard(dir, base, 'afk-stop')
  assert.equal(git(dir, ['show', 'HEAD:a.txt']).trim(), 'x')
  assert.ok(git(dir, ['status', '--porcelain']).includes('?? afk-stop'), '停止文件保留')
  assert.ok(!git(dir, ['status', '--porcelain']).includes('junk.txt'), 'untracked 残留被清')
  rmSync(dir, { recursive: true, force: true })
})

test('resetHard: 无 HEAD（新仓库首任务失败）→ clean 删除 untracked（排除停止文件）', () => {
  const dir = tmpRepo()
  writeFileSync(join(dir, 'junk.txt'), '任务残留')
  writeFileSync(join(dir, 'afk-stop'), 'stop')
  mkdirSync(join(dir, 'sub'))
  writeFileSync(join(dir, 'sub', 'nested.txt'), 'x')
  resetHard(dir, null, 'afk-stop')
  const st = git(dir, ['status', '--porcelain'])
  assert.ok(st.includes('?? afk-stop'), '停止文件保留')
  assert.ok(!st.includes('junk.txt') && !st.includes('nested'), 'untracked 残留被清')
  rmSync(dir, { recursive: true, force: true })
})