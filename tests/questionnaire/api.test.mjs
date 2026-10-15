import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  QuestionnaireError, artifactPaths, buildResponseMarkdown, lanAddresses,
  parseQuestionnaire, readStatusFile, validateSubmission, writeFileAtomic, writeJsonAtomic,
} from '../../lib/questionnaire.mjs'

const MARKDOWN = `# 封面问卷

这是背景说明。
第二行。

### 你叫什么名字

> 默认名字

### 什么时候有空

> 周末

普通段落会一直读到下一个标题。
`

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'questionnaire-api-'))
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }))
  return dir
}

test('parseQuestionnaire keeps title, intro, questions and first quoted answer', () => {
  const model = parseQuestionnaire(MARKDOWN)
  assert.equal(model.title, '封面问卷')
  assert.match(model.intro, /这是背景说明/)
  assert.deepEqual(model.questions, [
    { id: 'q1', question: '你叫什么名字', answer: '默认名字' },
    { id: 'q2', question: '什么时候有空', answer: '周末' },
  ])
})

test('artifactPaths derives names and rejects unsafe sessions', (t) => {
  const dir = fixture(t)
  const file = join(dir, 'form.md')
  writeFileSync(file, '# x\n')
  const paths = artifactPaths({ file })
  assert.deepEqual(paths, {
    dir,
    responseFile: join(dir, 'form-response.json'),
    responseMarkdown: join(dir, 'form-response.md'),
    statusFile: join(dir, 'form-status.json'),
    lockFile: join(dir, 'form-lock.json'),
  })
  const custom = artifactPaths({ file, outDir: join(dir, 'out'), session: 'round-1' })
  assert.equal(custom.statusFile, join(dir, 'out', 'round-1-status.json'))
  for (const session of ['   ', '../evil', 'a/b', 'a\\b', '.', '..']) {
    assert.throws(() => artifactPaths({ file, session }), QuestionnaireError, session)
  }
  assert.throws(() => artifactPaths({ file: '' }), QuestionnaireError)
})

test('validateSubmission accepts known ids and ignores client question text', () => {
  const model = parseQuestionnaire(MARKDOWN)
  const answers = validateSubmission(model, {
    answers: {
      q1: { question: 'TAMPERED', answer: 'Ada' },
      q2: { question: 'x', answer: '' },
    },
  })
  assert.deepEqual(answers, {
    q1: { question: '你叫什么名字', answer: 'Ada' },
    q2: { question: '什么时候有空', answer: '' },
  })
  const bad = [
    null, [], {}, { answers: null }, { answers: [] },
    { answers: { q9: { answer: 'x' } } },
    { answers: { q1: 'x' } },
    { answers: { q1: { answer: 5 } } },
  ]
  for (const payload of bad) assert.throws(() => validateSubmission(model, payload), QuestionnaireError)
})

test('a questionnaire without ### questions accepts only the general fallback', () => {
  const model = parseQuestionnaire('# Free form\n\nTell us anything.\n')
  assert.deepEqual(model.questions, [])
  const answers = validateSubmission(model, { answers: { general: { answer: 'hello' } } })
  assert.deepEqual(answers, { general: { question: '回答', answer: 'hello' } })
  assert.throws(() => validateSubmission(model, { answers: { q1: { answer: 'x' } } }), QuestionnaireError)
  const result = { questionnaireFile: '/tmp/x.md', submittedAt: '2020-01-01T00:00:00.000Z', answers }
  assert.match(buildResponseMarkdown(model, result), /## 回答\n\nhello/)
})

test('buildResponseMarkdown uses known question text, not the submission', () => {
  const model = parseQuestionnaire(MARKDOWN)
  const result = {
    questionnaireFile: '/tmp/form.md',
    submittedAt: '2020-01-01T00:00:00.000Z',
    answers: { q1: { question: 'TAMPERED', answer: 'Ada' }, q2: { question: 'TAMPERED', answer: '周一' } },
  }
  const text = buildResponseMarkdown(model, result)
  assert.match(text, /## 你叫什么名字\n\nAda/)
  assert.match(text, /## 什么时候有空\n\n周一/)
  assert.ok(!text.includes('TAMPERED'))
})

test('readStatusFile distinguishes missing, malformed and valid state', (t) => {
  const dir = fixture(t)
  const file = join(dir, 's.json')
  assert.deepEqual(readStatusFile(file), { missing: true })
  writeFileSync(file, '{not json')
  assert.equal(readStatusFile(file).malformed, true)
  writeFileSync(file, '[]')
  assert.equal(readStatusFile(file).malformed, true)
  const full = {
    state: 'waiting', pid: 4321, file: 'C:/x/form.md', statusFile: file,
    responseFile: 'C:/x/form-response.json', responseMarkdown: 'C:/x/form-response.md',
  }
  writeFileSync(file, JSON.stringify(full))
  assert.deepEqual(readStatusFile(file), { status: full })
})

test('readStatusFile rejects arbitrary JSON objects with a reason', (t) => {
  const dir = fixture(t)
  const file = join(dir, 's.json')
  const base = {
    state: 'waiting', pid: 1, file: 'f.md', statusFile: file,
  }
  const bad = [
    {},
    { ...base, state: 'bogus' },
    { ...base, pid: 0 },
    { ...base, pid: 'x' },
    { ...base, file: '' },
    { ...base, statusFile: undefined },
    { ...base, state: 'submitted' },
    { ...base, state: 'submitted', submittedAt: 'now' },
  ]
  for (const value of bad) {
    writeFileSync(file, JSON.stringify(value))
    const result = readStatusFile(file)
    assert.equal(result.malformed, true, JSON.stringify(value))
    assert.equal(typeof result.reason, 'string')
    assert.ok(result.reason.length > 0)
  }
  writeFileSync(file, JSON.stringify({
    state: 'submitted', pid: 1, file: 'f.md', statusFile: file,
    submittedAt: 'now', responseFile: 'r.json', responseMarkdown: 'r.md',
  }))
  assert.equal(readStatusFile(file).status.state, 'submitted')
})

test('writeFileAtomic and writeJsonAtomic replace files and clean temp files', (t) => {
  const dir = fixture(t)
  const file = join(dir, 'out.json')
  writeFileSync(file, 'old')
  writeJsonAtomic(file, { ok: true })
  assert.equal(readFileSync(file, 'utf8'), '{\n  "ok": true\n}\n')
  writeFileAtomic(file, 'new')
  assert.equal(readFileSync(file, 'utf8'), 'new')
  const leftovers = readdirSync(dir).filter((name) => name.endsWith('.tmp'))
  assert.deepEqual(leftovers, [])
  assert.ok(!existsSync(join(dir, '.out.json.0.tmp')))
})

test('lanAddresses returns non-internal IPv4 candidates', () => {
  const addresses = lanAddresses()
  assert.ok(Array.isArray(addresses))
  for (const item of addresses) {
    assert.equal(typeof item.name, 'string')
    assert.match(item.address, /^\d+\.\d+\.\d+\.\d+$/)
    assert.ok(!item.address.startsWith('169.254.'))
  }
})
