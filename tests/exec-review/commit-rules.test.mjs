/**
 * commit-rules 单元测试
 *
 *   node --test tests/exec-review/commit-rules.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildExecutorCommitRule,
  buildReviewerGitContext,
} from '../../skills/exec-review/scripts/commit-rules.mjs'

test('buildExecutorCommitRule gitCommit 开启时要求 executor commit', () => {
  const rule = buildExecutorCommitRule({ gitCommit: true, isGit: true })
  assert.match(rule, /执行端 \*\*commit\*\*/)
  assert.match(rule, /审查端 \*\*amend\*\*/)
  assert.match(rule, /本任务仅一个 commit/)
  assert.match(rule, /git status --porcelain/)
})

test('buildReviewerGitContext gitCommit 开启时 reviewer amend 执行端 commit', () => {
  const baseHead = 'abc1234'
  const ctx = buildReviewerGitContext({ gitCommit: true, isGit: true, baseHead })
  assert.match(ctx, /BASE_HEAD：`abc1234`/)
  assert.match(ctx, /执行端已 \*\*commit\*\*/)
  assert.match(ctx, /审查端 \*\*amend\*\*/)
  assert.match(ctx, /不另起新 commit/)
  assert.match(ctx, /git commit --amend --no-edit/)
  assert.match(ctx, /git rev-list --count abc1234\.\.HEAD/)
  assert.match(ctx, /兜底/)
  assert.match(ctx, /\*\*clean：\*\*/)
})

test('buildReviewerGitContext gitCommit 关闭时禁止提交', () => {
  const ctx = buildReviewerGitContext({
    gitCommit: false,
    isGit: true,
    baseHead: 'abc1234',
  })
  assert.match(ctx, /不要提交/)
  assert.doesNotMatch(ctx, /## Seal/)
})

test('buildReviewerGitContext 非 git 或无 baseHead 时为空', () => {
  assert.equal(buildReviewerGitContext({ gitCommit: true, isGit: false, baseHead: 'x' }), '')
  assert.equal(buildReviewerGitContext({ gitCommit: true, isGit: true, baseHead: '' }), '')
})
