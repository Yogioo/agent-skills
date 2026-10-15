/**
 * Packaging tests: pack the private @yogioo/agent-tools package to a tarball,
 * install it into an isolated prefix (offline, no scripts), then prove the
 * installed CLI and package subpath exports work outside the repository.
 *
 *   node --test tests/packaging/pack.test.mjs
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  cleanup, installedPackageDir, makeTempDir, npmInstall, npmPack, repoRoot,
  run, runInstalledBin, runtimeBuilt,
} from './helpers.mjs'

const SUBPATHS = [
  '@yogioo/agent-tools/agent-events',
  '@yogioo/agent-tools/agent-run',
  '@yogioo/agent-tools/agent-run/runners',
  '@yogioo/agent-tools/work-items',
  '@yogioo/agent-tools/runtime',
  '@yogioo/agent-tools/workspace-diff',
  '@yogioo/agent-tools/prompt-compose',
  '@yogioo/agent-tools/event-inbox',
  '@yogioo/agent-tools/requirement-store',
  '@yogioo/agent-tools/questionnaire',
]

if (!runtimeBuilt()) {
  test('packaging requires the runtime source', () => {
    assert.fail('lib/ and tools/ are missing; the runtime package cannot be validated')
  })
} else {
  let workdir
  let tarball
  let files
  let prefix
  let outsideDir

  before(async () => {
    workdir = makeTempDir('at-pack-')
    const packed = await npmPack(workdir)
    tarball = packed.tarball
    files = packed.files
    prefix = join(workdir, 'install with spaces')
    mkdirSync(prefix, { recursive: true })
    await npmInstall(tarball, prefix)
    outsideDir = join(workdir, 'outside workspace')
    mkdirSync(outsideDir, { recursive: true })
  })

  after(() => {
    if (workdir) cleanup(workdir)
  })

  test('tarball ships runtime and excludes non-runtime paths', () => {
    assert.ok(files.includes('package.json'))
    assert.ok(files.includes('README.md'))
    assert.ok(files.includes('bin/agent-tools.mjs'))
    assert.ok(files.some((path) => path.startsWith('lib/')))
    assert.ok(files.some((path) => path.startsWith('tools/')))
    const forbidden = ['.scratch/', 'tests/', 'skills/', 'scripts/', 'node_modules/']
    for (const path of files) {
      for (const bad of forbidden) {
        assert.ok(!path.startsWith(bad), `tarball should not include ${bad} (found ${path})`)
      }
    }
  })

  test('installed bin runs from outside the repository', async () => {
    const help = await runInstalledBin(prefix, ['--help'], outsideDir)
    assert.equal(help.code, 0, help.stderr)
    assert.match(help.stdout, /agent-tools/)
    assert.match(help.stdout, /agent-run/)

    const caps = await runInstalledBin(prefix, ['agent-run', 'capabilities'], outsideDir)
    assert.equal(caps.code, 0, caps.stderr)
    assert.equal(JSON.parse(caps.stdout.trim()).runners.length, 3)

    const unknown = await runInstalledBin(prefix, ['nope'], outsideDir)
    assert.equal(unknown.code, 2)
  })

  test('package subpath exports resolve from the installed package', async () => {
    const consumer = join(prefix, 'consumer.mjs')
    writeFileSync(consumer, [
      `const specs = ${JSON.stringify(SUBPATHS)}`,
      'const counts = {}',
      'for (const spec of specs) {',
      '  const mod = await import(spec)',
      '  counts[spec] = Object.keys(mod).length',
      '}',
      'console.log(JSON.stringify(counts))',
      '',
    ].join('\n'))
    const result = await run(process.execPath, [consumer], { cwd: prefix })
    assert.equal(result.code, 0, result.stderr)
    const counts = JSON.parse(result.stdout.trim())
    for (const spec of SUBPATHS) {
      assert.ok(counts[spec] > 0, `${spec} exported nothing`)
    }
  })

  test('installed CLI preserves spaced file arguments through a real operation', async () => {
    const documents = join(outsideDir, 'my documents')
    mkdirSync(documents)
    writeFileSync(join(documents, 'note.md'), 'first')
    const before = join(outsideDir, 'before snapshot.json')
    const after = join(outsideDir, 'after snapshot.json')
    for (const file of [before, after]) {
      const captured = await runInstalledBin(prefix, ['workspace-diff', 'snapshot', '--workdir', documents, '--out', file, '--mode', 'walk'], outsideDir)
      assert.equal(captured.code, 0, captured.stderr)
      assert.equal(JSON.parse(captured.stdout).status, 'captured')
      writeFileSync(join(documents, 'note.md'), 'second')
    }
    const compared = await runInstalledBin(prefix, ['workspace-diff', 'compare', '--before', before, '--after', after], outsideDir)
    assert.equal(compared.code, 0, compared.stderr)
    assert.deepEqual(JSON.parse(compared.stdout).changed, ['note.md'])
    assert.ok(JSON.parse(readFileSync(before, 'utf8')).files['note.md'])
  })

  test('a lone thin skill uses the installed toolkit', async () => {
    const skillsDir = join(outsideDir, 'skills')
    mkdirSync(skillsDir, { recursive: true })
    const skillCopy = join(skillsDir, 'agent-run')
    cpSync(join(repoRoot, 'skills', 'agent-run'), skillCopy, { recursive: true })
    assert.ok(existsSync(join(skillCopy, 'SKILL.md')))
    assert.deepEqual(readdirSync(skillCopy), ['SKILL.md'], 'thin skill must not carry implementation')
    assert.ok(!existsSync(join(skillCopy, 'scripts')))

    const caps = await runInstalledBin(prefix, ['agent-run', 'capabilities'], skillsDir)
    assert.equal(caps.code, 0, caps.stderr)
    assert.equal(JSON.parse(caps.stdout.trim()).runners.length, 3)
  })
}
