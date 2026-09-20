/**
 * afk-init 写出物的回归测试（外部 seam = 写出的文件）。
 *
 * 覆盖 issue #7 的 init 部分：`README.md` 与 `config.json` 同层写/刷新，
 * 内容提到配置分区、提示词覆盖文件名与堆叠顺序，且**不**创建空覆盖壳文件。
 *
 * 运行：
 *   cd C:\projects\agent-skills
 *   node --test tests/afk-init/init.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { OVERLAY_FILENAMES } from '../../skills/exec-review/scripts/prompt-overlays.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..', '..')
const INIT = join(ROOT, 'skills', 'afk-init', 'scripts', 'init-project.mjs')

function runInit(args, afkHome) {
  const stdout = execFileSync(process.execPath, [INIT, ...args], {
    cwd: ROOT,
    env: { ...process.env, AFK_HOME: afkHome },
    encoding: 'utf8',
  })
  return JSON.parse(stdout)
}

/** 覆盖文件名全集，用来断言 init 没有偷偷建空壳。 */
const OVERLAY_STUBS = [
  OVERLAY_FILENAMES.standards,
  ...Object.values(OVERLAY_FILENAMES.append),
  ...Object.values(OVERLAY_FILENAMES.prompt),
]

function assertNoOverlayStubs(dir) {
  for (const name of OVERLAY_STUBS) {
    assert.ok(!existsSync(join(dir, name)), `init 不应创建覆盖文件 ${name}`)
  }
}

function assertReadmeDocumentsOverlays(text) {
  for (const name of OVERLAY_STUBS) {
    assert.ok(text.includes(name), `README 应记录覆盖文件名 ${name}`)
  }
  assert.match(text, /堆叠顺序（每个角色）/, 'README 应记录覆盖堆叠顺序')
  assert.match(text, /不会.*创建空壳/, 'README 应说明不生成空覆盖壳')
  for (const section of ['task', 'watch', 'run', 'execReview']) {
    assert.match(text, new RegExp(`### \`${section}\``), `README 应记录 ${section} 分区`)
  }
}

test('project 范围：README 与 config.json / meta.json 同层写出，且不建覆盖空壳', () => {
  const afkHome = mkdtempSync(join(tmpdir(), 'afk-init-home-'))
  const workdir = mkdtempSync(join(tmpdir(), 'afk-init-wd-'))
  try {
    const summary = runInit(['--workdir', workdir, '--source', 'beads'], afkHome)
    assert.equal(summary.files.readme, join(summary.afkDir, 'README.md'))
    assert.ok(existsSync(summary.files.config), '应写出 config.json')
    assert.ok(existsSync(summary.files.meta), 'project 范围应写出 meta.json')
    assert.ok(existsSync(summary.files.readme), '应写出 README.md')
    assertNoOverlayStubs(summary.afkDir)

    const readme = readFileSync(summary.files.readme, 'utf8')
    assert.match(readme, /# AFK 配置（project）/)
    assert.match(readme, /source：`beads`/)
    assertReadmeDocumentsOverlays(readme)
  } finally {
    rmSync(afkHome, { recursive: true, force: true })
    rmSync(workdir, { recursive: true, force: true })
  }
})

test('global 范围：README 写在 AFK home 根目录，无 meta.json', () => {
  const afkHome = mkdtempSync(join(tmpdir(), 'afk-init-home-'))
  try {
    const summary = runInit(['--scope', 'global', '--source', 'gh', '--repo', 'o/n'], afkHome)
    assert.equal(summary.scope, 'global')
    assert.equal(summary.files.meta, null)
    assert.equal(summary.files.readme, join(afkHome, 'README.md'))
    assert.ok(existsSync(summary.files.readme), 'global README 应写在 AFK home 根')
    assertNoOverlayStubs(afkHome)

    const readme = readFileSync(summary.files.readme, 'utf8')
    assert.match(readme, /# AFK 配置（global）/)
    assert.match(readme, /source：`gh`/)
    assertReadmeDocumentsOverlays(readme)
  } finally {
    rmSync(afkHome, { recursive: true, force: true })
  }
})

test('重复 init（--force）刷新 README，而不是保留旧内容', () => {
  const afkHome = mkdtempSync(join(tmpdir(), 'afk-init-home-'))
  const workdir = mkdtempSync(join(tmpdir(), 'afk-init-wd-'))
  try {
    const first = runInit(['--workdir', workdir, '--source', 'beads'], afkHome)
    writeFileSync(first.files.readme, 'STALE-README\n', 'utf8')

    const second = runInit(['--workdir', workdir, '--source', 'beads', '--force'], afkHome)
    const readme = readFileSync(second.files.readme, 'utf8')
    assert.ok(!readme.includes('STALE-README'), 'README 应被刷新')
    assertReadmeDocumentsOverlays(readme)
    assertNoOverlayStubs(second.afkDir)
  } finally {
    rmSync(afkHome, { recursive: true, force: true })
    rmSync(workdir, { recursive: true, force: true })
  }
})
