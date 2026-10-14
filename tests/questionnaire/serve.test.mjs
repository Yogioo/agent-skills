import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tempDir, startServer, invoke, poll, json } from './helpers.mjs'

const FORM = `# Demo form

Intro line.

### Name

> default name

### Time

> weekend
`

function makeForm(dir, name = 'form.md') {
  const file = join(dir, name)
  writeFileSync(file, FORM, 'utf8')
  return file
}

test('server enforces token, round-trips answers, polls and shuts down', async (t) => {
  const dir = tempDir(t)
  const file = makeForm(dir)
  const server = startServer(['--file', file, '--out-dir', join(dir, 'artifacts'), '--host', '127.0.0.1', '--port', '0'])
  t.after(() => { try { server.child.kill() } catch { /* already gone */ } })
  const started = await server.waitFor((event) => event.event === 'questionnaire_started')

  assert.ok(started.port > 0)
  const origin = `http://127.0.0.1:${started.port}`
  const token = new URL(started.url).searchParams.get('token')
  assert.ok(token)
  assert.equal(started.localUrl, started.url)
  assert.ok(started.statusFile.startsWith(join(dir, 'artifacts')))
  assert.ok(started.lanInterfaces.every((item) => typeof item === 'string'))

  assert.equal((await fetch(`${origin}/`)).status, 403)
  assert.equal((await fetch(`${origin}/?token=wrong`)).status, 403)
  const page = await fetch(started.url)
  assert.equal(page.status, 200)
  const html = await page.text()
  assert.match(html, /Demo form/)
  assert.match(html, /Intro line\./)
  assert.match(html, /data-question="Name"/)
  assert.match(html, /default name/)
  assert.match(html, /viewport/)

  const waiting = invoke(poll, ['--status', started.statusFile, '--timeout', '1', '--interval', '1'])
  assert.equal(waiting.status, 3, waiting.stderr)
  assert.equal(json(waiting).state, 'waiting')
  assert.equal(json(waiting).serverAlive, true)

  const noToken = await fetch(`${origin}/submit`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ answers: { q1: { answer: 'x' } } }),
  })
  assert.equal(noToken.status, 403)

  const submit = (body) => fetch(`${origin}/submit?token=${encodeURIComponent(token)}`, { method: 'POST', body })
  const unknown = await submit(JSON.stringify({ answers: { q9: { answer: 'x' } } }))
  assert.equal(unknown.status, 400)
  const badJson = await submit('{not json')
  assert.equal(badJson.status, 400)
  const notObject = await submit(JSON.stringify({ answers: { q1: { answer: 5 } } }))
  assert.equal(notObject.status, 400)
  assert.equal(JSON.parse(readFileSync(started.statusFile, 'utf8')).state, 'waiting', 'rejected submissions do not commit')

  const ok = await submit(JSON.stringify({ answers: { q1: { answer: 'Ada' }, q2: { answer: 'Monday' } } }))
  assert.equal(ok.status, 200)
  assert.equal((await ok.json()).ok, true)

  const submittedEvent = await server.waitFor((event) => event.event === 'questionnaire_submitted')
  assert.equal(submittedEvent.answeredCount, 2)
  assert.equal(submittedEvent.questionCount, 2)
  assert.equal(await server.closed, 0, server.stderr())

  const responseJson = JSON.parse(readFileSync(started.responseFile, 'utf8'))
  assert.equal(responseJson.answers.q1.answer, 'Ada')
  assert.equal(responseJson.questionnaireFile, file)
  const markdown = readFileSync(started.responseMarkdown, 'utf8')
  assert.match(markdown, /## Name\n\nAda/)
  assert.match(markdown, /## Time\n\nMonday/)
  const status = JSON.parse(readFileSync(started.statusFile, 'utf8'))
  assert.equal(status.state, 'submitted')
  assert.equal(status.answeredCount, 2)

  const done = invoke(poll, ['--status', started.statusFile])
  assert.equal(done.status, 0, done.stderr)
  assert.equal(json(done).state, 'submitted')
})

test('free-form questionnaire accepts only the general answer', async (t) => {
  const dir = tempDir(t)
  const file = join(dir, 'free.md')
  writeFileSync(file, '# Free form\n\nAnything goes.\n', 'utf8')
  const server = startServer(['--file', file, '--out-dir', dir, '--host', '127.0.0.1', '--port', '0'])
  t.after(() => { try { server.child.kill() } catch { /* already gone */ } })
  const started = await server.waitFor((event) => event.event === 'questionnaire_started')
  const token = new URL(started.url).searchParams.get('token')
  const origin = `http://127.0.0.1:${started.port}`
  const submit = (answers) => fetch(`${origin}/submit?token=${token}`, {
    method: 'POST', body: JSON.stringify({ answers }),
  })
  assert.equal((await submit({ q1: { answer: 'nope' } })).status, 400)
  assert.equal((await submit({ general: { answer: 'hello' } })).status, 200)
  assert.equal(await server.closed, 0)
  assert.match(readFileSync(started.responseMarkdown, 'utf8'), /## 回答\n\nhello/)
})

test('two simultaneous servers cannot both own one session', async (t) => {
  const dir = tempDir(t)
  const file = makeForm(dir)
  const outDir = join(dir, 'artifacts')
  const args = ['--file', file, '--out-dir', outDir, '--host', '127.0.0.1', '--port', '0']
  const a = startServer(args)
  const b = startServer(args)
  t.after(() => {
    for (const server of [a, b]) {
      try { server.child.kill() } catch { /* already gone */ }
    }
  })
  const outcomes = await Promise.all([
    a.waitFor((event) => event.event === 'questionnaire_started').then(() => 'started', () => 'refused'),
    b.waitFor((event) => event.event === 'questionnaire_started').then(() => 'started', () => 'refused'),
  ])
  assert.equal(outcomes.filter((item) => item === 'started').length, 1, JSON.stringify(outcomes))
  assert.equal(outcomes.filter((item) => item === 'refused').length, 1, JSON.stringify(outcomes))
  const loser = outcomes[0] === 'refused' ? a : b
  assert.equal(await loser.closed, 2)
  assert.match(loser.stderr(), /lock|live/)
})

test('exactly one of two concurrent valid submissions is authoritative', async (t) => {
  const dir = tempDir(t)
  const file = makeForm(dir)
  const outDir = join(dir, 'artifacts')
  const server = startServer(['--file', file, '--out-dir', outDir, '--host', '127.0.0.1', '--port', '0'])
  t.after(() => { try { server.child.kill() } catch { /* already gone */ } })
  const started = await server.waitFor((event) => event.event === 'questionnaire_started')
  const token = new URL(started.url).searchParams.get('token')
  const origin = `http://127.0.0.1:${started.port}`
  const submit = (name) => fetch(`${origin}/submit?token=${token}`, {
    method: 'POST', body: JSON.stringify({ answers: { q1: { answer: name } } }),
  })
  const responses = await Promise.all([submit('first'), submit('second')])
  const statuses = responses.map((item) => item.status).sort()
  assert.deepEqual(statuses, [200, 409])
  const accepted = responses.find((item) => item.status === 200)
  assert.equal((await accepted.json()).ok, true)
  const persisted = JSON.parse(readFileSync(started.responseFile, 'utf8'))
  assert.ok(['first', 'second'].includes(persisted.answers.q1.answer))
  const status = JSON.parse(readFileSync(started.statusFile, 'utf8'))
  assert.equal(status.state, 'submitted')
  assert.equal(await server.closed, 0)
})

test('a persistence failure keeps the session waiting and permits an explicit retry', async (t) => {
  const dir = tempDir(t)
  const file = makeForm(dir)
  const outDir = join(dir, 'artifacts')
  const server = startServer(['--file', file, '--out-dir', outDir, '--host', '127.0.0.1', '--port', '0'])
  t.after(() => { try { server.child.kill() } catch { /* already gone */ } })
  const started = await server.waitFor((event) => event.event === 'questionnaire_started')
  const token = new URL(started.url).searchParams.get('token')
  const origin = `http://127.0.0.1:${started.port}`
  const submit = () => fetch(`${origin}/submit?token=${token}`, {
    method: 'POST', body: JSON.stringify({ answers: { q1: { answer: 'x' }, q2: { answer: '' } } }),
  })
  // Block the atomic rename by putting a directory where the response file goes.
  mkdirSync(started.responseFile, { recursive: true })
  const failed = await submit()
  assert.equal(failed.status, 500)
  assert.equal((await failed.json()).retryable, true)
  assert.equal(JSON.parse(readFileSync(started.statusFile, 'utf8')).state, 'waiting')
  rmSync(started.responseFile, { recursive: true, force: true })
  const retried = await submit()
  assert.equal(retried.status, 200)
  assert.equal(await server.closed, 0)
  assert.equal(JSON.parse(readFileSync(started.statusFile, 'utf8')).state, 'submitted')
})
