import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { skill, serve, poll, tempDir, startServer, invoke, json } from './helpers.mjs'

function writeForm(dir, name = 'form.md') {
  const file = join(dir, name)
  writeFileSync(file, '# Form\n\n### Q\n\n> a\n', 'utf8')
  return file
}

function errorOf(result) {
  const line = result.stderr.trim().split('\n').pop()
  return JSON.parse(line)
}

test('missing inputs and invalid arguments fail with distinct codes', (t) => {
  const dir = tempDir(t)
  const file = writeForm(dir)
  const missing = join(dir, 'nope.md')
  assert.equal(invoke(serve, ['--file', missing]).status, 1)
  assert.equal(invoke(serve, []).status, 2)
  assert.equal(invoke(serve, ['--file', file, '--port', 'abc']).status, 2)
  assert.equal(invoke(serve, ['--file', file, '--session', '../evil']).status, 2)
  assert.equal(invoke(serve, ['--file', file, '--nope']).status, 2)
  assert.equal(invoke(poll, []).status, 2)
  assert.equal(invoke(poll, ['--status', join(dir, 'none.json'), '--timeout', '0']).status, 2)
  const malformed = join(dir, 'bad-status.json')
  writeFileSync(malformed, '{ not json')
  assert.equal(invoke(poll, ['--status', malformed]).status, 1)
  assert.equal(json(invoke(poll, ['--status', malformed])).state, 'error')
})

test('a live session is not silently replaced, but --force overrides corrupt state', async (t) => {
  const dir = tempDir(t)
  const file = writeForm(dir)
  const outDir = join(dir, 'artifacts')
  const args = ['--file', file, '--out-dir', outDir, '--host', '127.0.0.1', '--port', '0']
  const first = startServer(args)
  t.after(() => { try { first.child.kill() } catch { /* already gone */ } })
  await first.waitFor((event) => event.event === 'questionnaire_started')

  const second = invoke(serve, args)
  assert.equal(second.status, 2, second.stderr)
  assert.equal(second.stdout, '')
  assert.match(errorOf(second).error, /live/)

  const forcedLive = invoke(serve, args.concat('--force'))
  assert.equal(forcedLive.status, 2, forcedLive.stderr)
  assert.equal(forcedLive.stdout, '')
  assert.match(errorOf(forcedLive).error, /live|lock/)
  assert.equal(readFileSync(join(outDir, 'form-status.json'), 'utf8').includes('waiting'), true)

  mkdirSync(join(dir, 'corrupt'), { recursive: true })
  const corruptDir = join(dir, 'corrupt')
  writeFileSync(join(corruptDir, 'form-status.json'), '{ broken')
  const corruptArgs = ['--file', file, '--out-dir', corruptDir, '--host', '127.0.0.1', '--port', '0']
  assert.equal(invoke(serve, corruptArgs).status, 2)
  const forced = startServer(corruptArgs.concat('--force'))
  t.after(() => { try { forced.child.kill() } catch { /* already gone */ } })
  const started = await forced.waitFor((event) => event.event === 'questionnaire_started')
  assert.equal(JSON.parse(readFileSync(started.statusFile, 'utf8')).state, 'waiting')
})

test('completed and stale sessions require --force, stale recovery works', async (t) => {
  const dir = tempDir(t)
  const file = writeForm(dir)
  const outDir = join(dir, 'artifacts')
  const args = ['--file', file, '--out-dir', outDir, '--host', '127.0.0.1', '--port', '0']

  // A completed session (submitted status + response artifacts) is a collision.
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'form-status.json'), JSON.stringify({
    version: 1, state: 'submitted', pid: 123, file,
    statusFile: join(outDir, 'form-status.json'),
    responseFile: join(outDir, 'form-response.json'),
    responseMarkdown: join(outDir, 'form-response.md'),
    submittedAt: '2020-01-01T00:00:00.000Z',
  }))
  writeFileSync(join(outDir, 'form-response.json'), '{}')
  writeFileSync(join(outDir, 'form-response.md'), '# old\n')
  const collision = invoke(serve, args)
  assert.equal(collision.status, 2, collision.stderr)
  assert.equal(collision.stdout, '')
  assert.match(errorOf(collision).error, /refusing to replace/)

  const replaced = startServer(args.concat('--force'))
  t.after(() => { try { replaced.child.kill() } catch { /* already gone */ } })
  const replacedStarted = await replaced.waitFor((event) => event.event === 'questionnaire_started')
  assert.equal(JSON.parse(readFileSync(replacedStarted.statusFile, 'utf8')).state, 'waiting')
  replaced.child.kill()

  // A stale (dead-pid) waiting session also needs --force, and a stale lock is
  // reclaimed only after its pid is confirmed dead.
  const staleDir = join(dir, 'stale')
  mkdirSync(staleDir, { recursive: true })
  writeFileSync(join(staleDir, 'form-status.json'), JSON.stringify({
    version: 1, state: 'waiting', pid: 999999, file,
    statusFile: join(staleDir, 'form-status.json'),
    responseFile: join(staleDir, 'form-response.json'),
    responseMarkdown: join(staleDir, 'form-response.md'),
  }))
  writeFileSync(join(staleDir, 'form-lock.json'), JSON.stringify({ version: 1, pid: 999999, token: 'dead' }))
  const staleArgs = ['--file', file, '--out-dir', staleDir, '--host', '127.0.0.1', '--port', '0']
  assert.equal(invoke(serve, staleArgs).status, 2)
  const recovered = startServer(staleArgs.concat('--force'))
  t.after(() => { try { recovered.child.kill() } catch { /* already gone */ } })
  const recoveredStarted = await recovered.waitFor((event) => event.event === 'questionnaire_started')
  assert.equal(JSON.parse(readFileSync(recoveredStarted.statusFile, 'utf8')).state, 'waiting')
  assert.equal(JSON.parse(readFileSync(join(staleDir, 'form-lock.json'), 'utf8')).pid, recovered.child.pid)
  recovered.child.kill()

  // A stale lock with no session artifacts is reclaimed without --force.
  const lockOnlyDir = join(dir, 'lock-only')
  mkdirSync(lockOnlyDir, { recursive: true })
  writeFileSync(join(lockOnlyDir, 'form-lock.json'), JSON.stringify({ version: 1, pid: 999999, token: 'dead' }))
  const reclaimed = startServer(['--file', file, '--out-dir', lockOnlyDir, '--host', '127.0.0.1', '--port', '0'])
  t.after(() => { try { reclaimed.child.kill() } catch { /* already gone */ } })
  const reclaimedStarted = await reclaimed.waitFor((event) => event.event === 'questionnaire_started')
  assert.equal(JSON.parse(readFileSync(reclaimedStarted.statusFile, 'utf8')).state, 'waiting')
  reclaimed.child.kill()
})

test('a questionnaire that aliases a derived artifact is refused', (t) => {
  const dir = tempDir(t)
  // Questionnaire basename + matching session -> response file equals the input.
  const aliased = join(dir, 'form-response.json')
  writeFileSync(aliased, '# Form\n\n### Q\n\n> a\n')
  const result = invoke(serve, ['--file', aliased, '--out-dir', dir, '--session', 'form'])
  assert.equal(result.status, 2, result.stderr)
  assert.match(errorOf(result).error, /collide/)
  assert.match(readFileSync(aliased, 'utf8'), /^# Form/)
})

test('poll derives the serve status path from --file/--out-dir/--session', async (t) => {
  const dir = tempDir(t)
  const file = writeForm(dir)
  const outDir = join(dir, 'artifacts')
  const args = ['--file', file, '--out-dir', outDir, '--session', 'round1', '--host', '127.0.0.1', '--port', '0']
  const server = startServer(args)
  t.after(() => { try { server.child.kill() } catch { /* already gone */ } })
  const started = await server.waitFor((event) => event.event === 'questionnaire_started')
  assert.equal(started.statusFile, join(outDir, 'round1-status.json'))
  const derived = invoke(poll, ['--file', file, '--out-dir', outDir, '--session', 'round1', '--timeout', '1', '--interval', '1'])
  assert.equal(derived.status, 3, derived.stderr)
  assert.equal(json(derived).state, 'waiting')
  assert.equal(json(derived).statusFile, started.statusFile)
  server.child.kill()
})

test('a wrongly shaped status object is corrupt, not an empty session', (t) => {
  const dir = tempDir(t)
  const file = writeForm(dir)
  const outDir = join(dir, 'artifacts')
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'form-status.json'), JSON.stringify({ state: 'bogus', pid: 'x' }))
  const result = invoke(poll, ['--file', file, '--out-dir', outDir])
  assert.equal(result.status, 1, result.stderr)
  assert.equal(json(result).state, 'error')
  assert.match(json(result).error, /unknown status state|must be/)
  assert.equal(existsSync(join(outDir, 'form-status.json')), true)
})

test('packaged skill serves and polls alone outside the repository', async (t) => {
  const dir = tempDir(t)
  const installed = join(dir, 'install', 'questionnaire')
  cpSync(skill, installed, { recursive: true })
  assert.equal(existsSync(join(dir, 'install', 'exec-review')), false)
  const copiedServe = join(installed, 'scripts', 'serve.mjs')
  const copiedPoll = join(installed, 'scripts', 'poll.mjs')

  const help = invoke(copiedServe, ['--help'], { cwd: dir })
  assert.equal(help.status, 0)
  assert.match(help.stdout, /--file/)

  const file = writeForm(dir)
  const server = startServer(['--file', file, '--out-dir', join(dir, 'out'), '--host', '127.0.0.1', '--port', '0'], {
    executable: copiedServe, cwd: dir,
  })
  t.after(() => { try { server.child.kill() } catch { /* already gone */ } })
  const started = await server.waitFor((event) => event.event === 'questionnaire_started')
  const token = new URL(started.url).searchParams.get('token')
  const response = await fetch(`http://127.0.0.1:${started.port}/submit?token=${token}`, {
    method: 'POST', body: JSON.stringify({ answers: { q1: { answer: 'standalone' } } }),
  })
  assert.equal(response.status, 200)
  assert.equal(await server.closed, 0)
  assert.equal(invoke(copiedPoll, ['--status', started.statusFile], { cwd: dir }).status, 0)
})

test('installed directory junction runs help and a submission', async (t) => {
  const dir = tempDir(t)
  const target = join(dir, 'skill-source')
  const installed = join(dir, 'installed-skill')
  cpSync(skill, target, { recursive: true })
  symlinkSync(target, installed, process.platform === 'win32' ? 'junction' : 'dir')
  const junctionServe = join(installed, 'scripts', 'serve.mjs')
  const help = invoke(junctionServe, ['--help'], { cwd: dir })
  assert.equal(help.status, 0, help.stderr)
  assert.match(help.stdout, /questionnaire/)

  const file = writeForm(dir)
  const server = startServer(['--file', file, '--out-dir', dir, '--host', '127.0.0.1', '--port', '0'], {
    executable: junctionServe, cwd: dir,
  })
  t.after(() => { try { server.child.kill() } catch { /* already gone */ } })
  const started = await server.waitFor((event) => event.event === 'questionnaire_started')
  const token = new URL(started.url).searchParams.get('token')
  const response = await fetch(`http://127.0.0.1:${started.port}/submit?token=${token}`, {
    method: 'POST', body: JSON.stringify({ answers: { q1: { answer: 'junction' } } }),
  })
  assert.equal(response.status, 200)
  assert.equal(await server.closed, 0)
})
