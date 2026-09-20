/**
 * AFK home 提示词覆盖（prompt overlay）回归测试。
 *
 * 主 seam（issue #7 指定的唯一 seam）：dry-run 写进 run cache 的
 * `executor.prompt.md` / `reviewer.prompt.md`，外加以 `AFK_HOME` 临时树放的覆盖文件。
 *
 * 运行：
 *   cd C:\projects\agent-skills
 *   node --test tests/exec-review/prompt-overlays.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { projectKeyFromWorkdir } from '../../skills/afk-run/scripts/afk-home.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SKILL = join(__dirname, '..', '..', 'skills', 'exec-review')
const RUN = join(SKILL, 'scripts', 'run-task.mjs')

function writeFiles(dir, files) {
  mkdirSync(dir, { recursive: true })
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text, 'utf8')
}

/** 临时 AFK_HOME：`global` 覆盖文件写到根，`project` 写到 workdir 对应的 <label>_<uid>。 */
function makeAfkHome(workdir, { global = {}, project = {} } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'er-overlay-home-'))
  writeFileSync(join(home, 'config.json'), JSON.stringify({ execReview: { runner: 'codex' } }), 'utf8')
  writeFiles(home, global)
  if (Object.keys(project).length) writeFiles(join(home, projectKeyFromWorkdir(workdir)), project)
  return home
}

function git(dir, args) {
  return execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function makeGitRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'er-overlay-git-'))
  git(dir, ['init'])
  git(dir, ['config', 'user.name', 'prompt overlay test'])
  git(dir, ['config', 'user.email', 'overlay@example.test'])
  writeFileSync(join(dir, 'one.txt'), 'one\n')
  git(dir, ['add', 'one.txt'])
  git(dir, ['commit', '-m', 'base commit'])
  return dir
}

function runDryRun({ workdir, cacheDir, afkHome }) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, AFK_HOME: afkHome }
    delete env.EXEC_REVIEW_GIT_COMMIT
    delete env.EXEC_REVIEW_REVIEW
    const child = spawn(
      process.execPath,
      [
        RUN,
        '--workdir',
        workdir,
        '--title',
        'prompt overlays',
        '--body',
        'render the overlays',
        '--dry-run',
        '--no-serve',
        '--review',
        'true',
        '--cache-dir',
        cacheDir,
      ],
      { cwd: SKILL, env, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.once('error', reject)
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(`dry-run exit=${code}: ${stderr}`))
        return
      }
      try {
        resolve(JSON.parse(stdout.trim()))
      } catch (err) {
        reject(new Error(`无法解析 dry-run 摘要: ${err.message}\n${stdout}`))
      }
    })
  })
}

/** 建 workdir + AFK_HOME + cache，跑一次 dry-run，回读两个角色的提示词。 */
async function renderPrompts({ workdir, global, project }) {
  const cache = mkdtempSync(join(tmpdir(), 'er-overlay-cache-'))
  const afkHome = makeAfkHome(workdir, { global, project })
  try {
    const summary = await runDryRun({ workdir, cacheDir: cache, afkHome })
    return {
      executor: readFileSync(join(summary.cacheDir, 'executor.prompt.md'), 'utf8'),
      reviewer: readFileSync(join(summary.cacheDir, 'reviewer.prompt.md'), 'utf8'),
    }
  } finally {
    rmSync(cache, { recursive: true, force: true })
    rmSync(afkHome, { recursive: true, force: true })
  }
}

/** 新建 workdir 并在用例结束后清理。 */
async function withWorkdir(fn) {
  const workdir = mkdtempSync(join(tmpdir(), 'er-overlay-wd-'))
  try {
    return await fn(workdir)
  } finally {
    rmSync(workdir, { recursive: true, force: true })
  }
}

test('standards.md 全局 + 项目注入两个角色，且按全局 → 项目排序', async () => {
  await withWorkdir(async (workdir) => {
    const { executor, reviewer } = await renderPrompts({
      workdir,
      global: {
        'standards.md': 'GLOBAL-STANDARDS-LINE\n',
        'executor.append.md': 'GLOBAL-EXEC-APPEND\n',
        'reviewer.append.md': 'GLOBAL-REVIEW-APPEND\n',
      },
      project: {
        'standards.md': 'PROJECT-STANDARDS-LINE\n',
        'executor.append.md': 'PROJECT-EXEC-APPEND\n',
        'reviewer.append.md': 'PROJECT-REVIEW-APPEND\n',
      },
    })

    for (const [role, prompt] of [
      ['executor', executor],
      ['reviewer', reviewer],
    ]) {
      assert.match(prompt, /## 附加标准（AFK home `standards\.md`）/, `${role} 应有标准段落`)
      assert.ok(prompt.includes('GLOBAL-STANDARDS-LINE'), `${role} 应注入全局标准`)
      assert.ok(prompt.includes('PROJECT-STANDARDS-LINE'), `${role} 应注入项目标准`)
      assert.ok(
        prompt.indexOf('GLOBAL-STANDARDS-LINE') < prompt.indexOf('PROJECT-STANDARDS-LINE'),
        `${role} 标准应按全局 → 项目排序`,
      )
    }

    assert.match(executor, /## 角色附加说明（AFK home `executor\.append\.md`）/)
    assert.ok(
      executor.indexOf('GLOBAL-EXEC-APPEND') < executor.indexOf('PROJECT-EXEC-APPEND'),
      '执行端 append 应按全局 → 项目排序',
    )
    assert.match(reviewer, /## 角色附加说明（AFK home `reviewer\.append\.md`）/)
    assert.ok(reviewer.includes('GLOBAL-REVIEW-APPEND') && reviewer.includes('PROJECT-REVIEW-APPEND'))
    // 角色隔离：执行端的 append 不落到审查端，反之亦然
    assert.ok(!reviewer.includes('EXEC-APPEND'), '审查端不应看到执行端 append')
    assert.ok(!executor.includes('REVIEW-APPEND'), '执行端不应看到审查端 append')
  })
})

test('缺失 / 空 / 纯空白的覆盖文件不注入任何段落', async () => {
  await withWorkdir(async (workdir) => {
    const { executor, reviewer } = await renderPrompts({
      workdir,
      global: { 'standards.md': '   \n\n\t\n', 'executor.append.md': '' },
      project: { 'standards.md': '', 'reviewer.append.md': ' \n \n', 'reviewer.prompt.md': '\n\t\n' },
    })

    for (const prompt of [executor, reviewer]) {
      assert.ok(!prompt.includes('附加标准'), '空白 standards.md 不应产生标准段落')
      assert.ok(!prompt.includes('角色附加说明'), '空白 append 不应产生附加段落')
    }
    // 空白的 *.prompt.md 不能顶掉内置 base
    assert.match(executor, /优先红绿重构/, '执行端应仍是内置模板')
    assert.match(reviewer, /唯一审查端/, '审查端应仍是内置模板')
  })
})

test('*.prompt.md 整段替换 base（项目盖全局）且仍带强制 footer', async () => {
  const repo = makeGitRepo()
  try {
    const { executor, reviewer } = await renderPrompts({
      workdir: repo,
      global: {
        'executor.prompt.md': 'GLOBAL-CUSTOM-EXEC\n',
        'reviewer.prompt.md': 'GLOBAL-CUSTOM-REVIEW\n',
        'standards.md': 'HOUSE-STANDARDS-LINE\n',
      },
      project: { 'executor.prompt.md': 'PROJECT-CUSTOM-EXEC title={{TASK_TITLE}}\n' },
    })

    // 项目覆盖全局，且任务变量照常渲染；内置 base 被整段替换
    assert.match(executor, /PROJECT-CUSTOM-EXEC title=prompt overlays/)
    assert.ok(!executor.includes('GLOBAL-CUSTOM-EXEC'), '项目 prompt 应盖过全局 prompt')
    assert.ok(!executor.includes('优先红绿重构'), '自定义 prompt 应替换内置执行端模板')
    assert.ok(!reviewer.includes('唯一审查端'), '自定义 prompt 应替换内置审查端模板')
    assert.match(reviewer, /GLOBAL-CUSTOM-REVIEW/)

    // 覆盖段落仍然注入
    assert.ok(executor.includes('HOUSE-STANDARDS-LINE'), '自定义 prompt 仍应收到 standards')
    assert.ok(reviewer.includes('HOUSE-STANDARDS-LINE'), '自定义 prompt 仍应收到 standards')

    // 强制 footer：结论契约 + git 分工（执行端 commit / 审查端 amend）
    assert.match(executor, /done\|no_change\|blocked\|empty/)
    assert.match(executor, /本任务仅一个 commit/)
    assert.match(reviewer, /clean\|refined/)
    assert.match(reviewer, /# Seal/)
    assert.match(reviewer, /amend/)
    assert.match(reviewer, /BASE_HEAD/)
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})
