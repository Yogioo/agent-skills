import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const skill = fileURLToPath(new URL('../../skills/prompt-compose/', import.meta.url))
const cli = join(skill, 'scripts', 'cli.mjs')

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'prompt-compose-cli-'))
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }))
  return dir
}

function put(dir, path, content) {
  const file = join(dir, path)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content, 'utf8')
  return file
}

function manifest(dir, name, value) {
  return put(dir, name, `${JSON.stringify(value, null, 2)}\n`)
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
  assert.equal(typeof error.error, 'string')
  return error
}

test('compose writes deterministically and reports provenance on stdout', (t) => {
  const dir = fixture(t)
  put(dir, 'base.md', 'BASE {{TASK}}\n')
  const manifestFile = manifest(dir, 'manifest.json', {
    variables: { TASK: 'ship it' },
    base: { file: 'base.md' },
    layers: [{ mode: 'append', label: 'std', text: 'STD\n' }],
    suffix: 'END\n',
  })
  const out = join(dir, 'out', 'prompt.md')
  const provenance = join(dir, 'provenance.json')
  const args = ['--manifest', manifestFile, '--out', out, '--provenance', provenance]
  const report = success(invoke(args))
  assert.equal(report.status, 'composed')
  assert.equal(report.outFile, out)
  assert.equal(report.textBytes, Buffer.byteLength('BASE ship it\n\nSTD\n\nEND\n'))
  assert.match(report.textSha256, /^[0-9a-f]{64}$/)
  assert.deepEqual(report.variables, ['TASK'])
  assert.equal(readFileSync(out, 'utf8'), 'BASE ship it\n\nSTD\n\nEND\n')
  assert.deepEqual(JSON.parse(readFileSync(provenance, 'utf8')), report)
  assert.equal(success(invoke(args.concat('--force'))).textSha256, report.textSha256)
})

test('help succeeds and invalid invocation is a usage error', (t) => {
  const dir = fixture(t)
  const help = invoke(['--help'])
  assert.equal(help.status, 0)
  assert.equal(help.stderr, '')
  assert.match(help.stdout, /--manifest/)
  const manifestFile = manifest(dir, 'm.json', { base: 'x' })
  const cases = [
    [],
    ['--manifest', manifestFile],
    ['--out', join(dir, 'o.md')],
    ['--manifest', manifestFile, '--out', join(dir, 'o.md'), '--nope'],
    ['--manifest', manifestFile, '--out', join(dir, 'o.md'), '--manifest', manifestFile],
    ['--manifest', manifestFile, '--out'],
    ['--manifest', manifestFile, '--out', join(dir, 'o.md'), '--force', '--force'],
    ['--manifest', manifestFile, '--out', join(dir, 'o.md'), '--provenance', join(dir, 'o.md')],
  ]
  for (const args of cases) failure(invoke(args), 2)
})

test('missing, malformed and unsatisfiable inputs fail with distinct codes', (t) => {
  const dir = fixture(t)
  const out = join(dir, 'o.md')
  failure(invoke(['--manifest', join(dir, 'missing.json'), '--out', out]), 1)

  const malformed = put(dir, 'bad.json', '{')
  failure(invoke(['--manifest', malformed, '--out', out]), 2)

  const missingSource = manifest(dir, 'missing-source.json', { base: { file: 'nope.md' } })
  failure(invoke(['--manifest', missingSource, '--out', out]), 1)

  const unknownVar = manifest(dir, 'unknown-var.json', { base: 'hi {{NOPE}}' })
  failure(invoke(['--manifest', unknownVar, '--out', out]), 2)
  assert.equal(existsSync(out), false, 'nothing is written on failure')
})

test('existing output is preserved unless --force is explicit', (t) => {
  const dir = fixture(t)
  const manifestFile = manifest(dir, 'm.json', { base: 'new\n' })
  const out = put(dir, 'out.md', 'original\n')
  failure(invoke(['--manifest', manifestFile, '--out', out]), 1)
  assert.equal(readFileSync(out, 'utf8'), 'original\n')
  const report = success(invoke(['--manifest', manifestFile, '--out', out, '--force']))
  assert.equal(readFileSync(out, 'utf8'), 'new\n')
  assert.equal(report.outFile, out)
})

test('outputs never overwrite inputs and out/provenance stay distinct with --force', (t) => {
  const dir = fixture(t)
  const baseFile = put(dir, 'base.md', 'BASE\n')
  const manifestFile = manifest(dir, 'm.json', { base: { file: 'base.md' } })
  const out = join(dir, 'out.md')

  failure(invoke(['--manifest', manifestFile, '--out', manifestFile, '--force']), 2)
  assert.match(readFileSync(manifestFile, 'utf8'), /base\.md/)

  failure(invoke(['--manifest', manifestFile, '--out', baseFile, '--force']), 2)
  assert.equal(readFileSync(baseFile, 'utf8'), 'BASE\n')

  failure(invoke(['--manifest', manifestFile, '--out', out, '--provenance', baseFile, '--force']), 2)
  assert.equal(readFileSync(baseFile, 'utf8'), 'BASE\n')
  assert.equal(existsSync(out), false)

  failure(invoke(['--manifest', manifestFile, '--out', out, '--provenance', out, '--force']), 2)
  assert.equal(existsSync(out), false)

  success(invoke(['--manifest', manifestFile, '--out', out]))
  assert.equal(readFileSync(out, 'utf8'), 'BASE\n')
})

test('packaged skill runs alone outside the repository', (t) => {
  const dir = fixture(t)
  const installed = join(dir, 'install', 'prompt-compose')
  cpSync(skill, installed, { recursive: true })
  assert.equal(existsSync(join(dirname(installed), 'exec-review')), false)
  const manifestFile = manifest(dir, 'm.json', { base: 'standalone {{X}}', variables: { X: 'ok' } })
  const out = join(dir, 'out.md')
  const report = success(invoke(
    ['--manifest', manifestFile, '--out', out],
    { executable: join(installed, 'scripts', 'cli.mjs'), cwd: dir },
  ))
  assert.equal(report.status, 'composed')
  assert.equal(readFileSync(out, 'utf8'), 'standalone ok\n')
})

test('installed directory junction executes help and compose', (t) => {
  const dir = fixture(t)
  const target = join(dir, 'skill-source')
  const installed = join(dir, 'installed-skill')
  cpSync(skill, target, { recursive: true })
  symlinkSync(target, installed, process.platform === 'win32' ? 'junction' : 'dir')
  const options = { executable: join(installed, 'scripts', 'cli.mjs'), cwd: dir }
  const help = invoke(['--help'], options)
  assert.equal(help.status, 0, help.stderr)
  assert.match(help.stdout, /manifest/)
  const manifestFile = manifest(dir, 'm.json', { base: 'junction\n' })
  const out = join(dir, 'junction-out.md')
  success(invoke(['--manifest', manifestFile, '--out', out], options))
  assert.equal(readFileSync(out, 'utf8'), 'junction\n')
})
