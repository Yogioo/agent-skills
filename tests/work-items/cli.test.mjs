/**
 * work-items CLI tests: JSON output, exit codes, fake source transport,
 * standalone copy, and a Windows directory junction entry.
 *
 * Run: node --test tests/work-items/cli.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const skill = fileURLToPath(new URL('../../skills/work-items/', import.meta.url))
const cli = join(skill, 'scripts', 'cli.mjs')

const FAKE_BD = `import { readFileSync, writeFileSync } from 'node:fs'
const stateFile = process.env.WORK_ITEMS_FAKE_BD_STATE
const state = JSON.parse(readFileSync(stateFile, 'utf8'))
let args = process.argv.slice(2)
let actor = ''
const actorIndex = args.indexOf('--actor')
if (actorIndex >= 0) { actor = args[actorIndex + 1]; args.splice(actorIndex, 2) }
state.calls.push({ actor, args })
const save = () => writeFileSync(stateFile, JSON.stringify(state), 'utf8')
const find = (id) => state.issues.find((issue) => String(issue.id) === String(id))
if (state.error) { process.stderr.write(state.error); process.exit(1) }
if (args[0] === 'list') {
  const idIndex = args.indexOf('--id')
  const rows = idIndex >= 0 ? state.issues.filter((issue) => String(issue.id) === String(args[idIndex + 1])) : state.issues
  save(); process.stdout.write(JSON.stringify(rows))
} else if (args[0] === 'update' && args.includes('--claim')) {
  const issue = find(args[1]); issue.status = 'in_progress'; issue.claimedBy = actor
  save(); process.stdout.write('')
} else if (args[0] === 'label') {
  const issue = find(args[2])
  const labels = Array.isArray(issue.labels) ? issue.labels : []
  issue.labels = args[1] === 'add' ? [...labels, args[3]] : labels.filter((label) => label !== args[3])
  save(); process.stdout.write('')
} else if (args[0] === 'comment') { find(args[1]).comments = [...(find(args[1]).comments || []), args[2]]; save(); process.stdout.write('')
} else if (args[0] === 'close') { find(args[1]).status = 'closed'; save(); process.stdout.write('')
} else { process.stderr.write('unexpected bd command'); process.exit(1) }
`

function fixture(t) {
  const temp = mkdtempSync(join(tmpdir(), 'work-items-cli-'))
  t.after(() => rmSync(temp, { recursive: true, force: true, maxRetries: 3 }))
  const workdir = join(temp, 'work items dir')
  const configDir = join(temp, 'config dir')
  mkdirSync(workdir)
  mkdirSync(configDir)
  const stateFile = join(temp, 'bd-state.json')
  const fakeBd = join(temp, 'fake bd.mjs')
  writeFileSync(
    stateFile,
    JSON.stringify({ issues: [
      { id: 'a', title: 'alpha', description: 'body-a', status: 'open', priority: 0, labels: ['ready-for-agent'] },
      { id: 'b', title: 'beta', description: 'body-b', status: 'open', priority: 2, labels: [] },
    ], calls: [] }),
    'utf8',
  )
  writeFileSync(fakeBd, FAKE_BD, 'utf8')
  const config = join(configDir, 'work-items.json')
  writeFileSync(config, JSON.stringify({ workdir, command: process.execPath, commandPrefix: [fakeBd] }), 'utf8')
  process.env.WORK_ITEMS_FAKE_BD_STATE = stateFile
  return { temp, workdir, config, stateFile, configDir }
}

function invoke(args, { executable = cli, cwd, env = {} } = {}) {
  const result = spawnSync(process.execPath, [executable, ...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
    env: { ...process.env, ...env },
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
}

test('help succeeds and capabilities is one JSON value', () => {
  const help = invoke(['--help'])
  assert.equal(help.status, 0)
  assert.equal(help.stderr, '')
  assert.match(help.stdout, /capabilities/)
  assert.deepEqual(success(invoke(['capabilities', '--source', 'gh'])).claimMode, 'best-effort')
  assert.deepEqual(success(invoke(['capabilities', '--source', 'tapd'])).close, false)
})

test('list and mutations run through a fake source executable with spaced paths', (t) => {
  const fx = fixture(t)
  const facts = success(invoke(['list', '--source', 'beads', '--config', fx.config]))
  assert.deepEqual(facts.map((row) => row.id), ['a', 'b'])
  const ready = success(invoke(['list', '--source', 'beads', '--config', fx.config, '--ready', '--ready-label', 'ready-for-agent']))
  assert.deepEqual(ready.map((row) => row.id), ['a'])

  assert.deepEqual(success(invoke(['get', '--source', 'beads', '--config', fx.config, '--id', 'a'])).body, 'body-a')
  assert.equal(success(invoke(['claim', '--source', 'beads', '--config', fx.config, '--id', 'a'])).status, 'claimed')
  assert.deepEqual(success(invoke(['labels', '--source', 'beads', '--config', fx.config, '--id', 'a', '--add', 'triaged'])).added, ['triaged'])
  assert.equal(success(invoke(['comment', '--source', 'beads', '--config', fx.config, '--id', 'a', '--message', 'note'])).status, 'commented')
  assert.equal(success(invoke(['close', '--source', 'beads', '--config', fx.config, '--id', 'a', '--comment', 'done'])).status, 'closed')
  const state = JSON.parse(readFileSync(fx.stateFile, 'utf8'))
  assert.deepEqual(state.issues[0].comments, ['note'])
  assert.equal(state.issues[0].status, 'closed')
  assert.ok(state.issues[0].labels.includes('triaged'))
})

test('invalid arguments and malformed config are exit 2', (t) => {
  const fx = fixture(t)
  const cases = [
    [], ['bogus'], ['capabilities'], ['capabilities', '--source', 'svn'],
    ['get', '--source', 'beads', '--config', fx.config],
    ['list', '--source', 'beads'],
    ['list', '--source', 'gh'],
    ['list', '--source', 'tapd'],
    ['list', '--source', 'beads', '--config', fx.config, '--unknown', 'x'],
    ['list', '--source', 'beads', '--config', join(fx.temp, 'missing.json')],
    ['list', '--source', 'beads', '--config', fx.config, '--priority-max', 'x'],
    ['labels', '--source', 'beads', '--config', fx.config, '--id', 'a'],
    ['labels', '--source', 'beads', '--config', fx.config, '--id', 'a', '--set', 'x', '--add', 'y'],
  ]
  const badConfig = join(fx.configDir, 'bad.json')
  writeFileSync(badConfig, '{ not json', 'utf8')
  cases.push(['list', '--source', 'beads', '--config', badConfig])
  for (const args of cases) failure(invoke(args), 2)
})

test('operational source failure is exit 1, not a fake empty list', (t) => {
  const fx = fixture(t)
  writeFileSync(fx.stateFile, JSON.stringify({ issues: [], calls: [], error: 'db locked' }), 'utf8')
  const result = invoke(['list', '--source', 'beads', '--config', fx.config])
  failure(result, 1)
  assert.match(result.stderr, /db locked|Command failed/)
})

test('packaged skill runs alone with no old sibling skills', (t) => {
  const fx = fixture(t)
  const installed = join(fx.temp, 'install', 'work-items')
  cpSync(skill, installed, { recursive: true })
  const executable = join(installed, 'scripts', 'cli.mjs')
  assert.equal(existsSync(join(dirname(installed), 'afk-run')), false)
  assert.equal(existsSync(join(dirname(installed), 'afk-watch')), false)
  const options = { executable, cwd: fx.temp }
  assert.equal(success(invoke(['capabilities', '--source', 'beads'], options)).claimMode, 'atomic')
  assert.deepEqual(
    success(invoke(['list', '--source', 'beads', '--config', fx.config, '--ready', '--ready-label', 'ready-for-agent'], options)).map((row) => row.id),
    ['a'],
  )
})

test('installed directory junction executes help and capabilities', (t) => {
  const fx = fixture(t)
  const target = join(fx.temp, 'skill-source')
  const installed = join(fx.temp, 'installed-skill')
  cpSync(skill, target, { recursive: true })
  symlinkSync(target, installed, process.platform === 'win32' ? 'junction' : 'dir')
  const executable = join(installed, 'scripts', 'cli.mjs')
  const options = { executable, cwd: fx.temp }
  const help = invoke(['--help'], options)
  assert.equal(help.status, 0, help.stderr)
  assert.match(help.stdout, /capabilities/)
  assert.equal(success(invoke(['capabilities', '--source', 'tapd'], options)).source, 'tapd')
})
