/**
 * End-to-end run CLI tests with fake local child executables.
 * The fake children are local Node scripts; no remote service is contacted.
 *
 *   node --test tests/agent-run/run.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runCli } from '../../tools/agent-run/cli.mjs'
import { runAgentTurn } from '../../lib/agent-run/run-agent-turn.mjs'

function capture() {
  const out = []
  const err = []
  return { io: { stdout: (t) => out.push(t), stderr: (t) => err.push(t) }, stdout: () => out.join(''), stderr: () => err.join('') }
}

function fake(dir, name, body) {
  const file = join(dir, name)
  writeFileSync(file, body, 'utf8')
  return file
}

const OK_AGENT =
  "process.stdout.write(JSON.stringify({type:'result',subtype:'success',result:'{\"status\":\"ok\",\"note\":\"fake\"}'})+ '\\n')\nprocess.exit(0)\n"

test('run reports facts for a successful local child', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ar run ok '))
  const outDir = join(dir, 'cache out')
  const bin = fake(dir, 'ok.mjs', OK_AGENT)
  const prompt = join(dir, 'prompt.md')
  writeFileSync(prompt, 'do the thing\n')
  const cap = capture()
  try {
    const code = await runCli(
      ['run', '--runner', 'agent', '--workdir', dir, '--prompt-file', prompt, '--out-dir', outDir, '--bin', bin],
      cap.io,
    )
    assert.equal(code, 0)
    const facts = JSON.parse(cap.stdout().trim())
    assert.equal(facts.exitCode, 0)
    assert.equal(facts.timedOut, false)
    assert.equal(facts.aborted, false)
    assert.equal(facts.outputFile, join(outDir, 'output.txt'))
    assert.ok(!('done' in facts) && !('approved' in facts))
    assert.match(readFileSync(facts.outputFile, 'utf8'), /"status":"ok"/)
    const events = readFileSync(facts.eventsFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    assert.equal(events.at(-1).kind, 'outcome')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('nonzero child exit makes the CLI exit 1 and surfaces the child code', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ar run bad-'))
  const outDir = join(dir, 'out')
  const bin = fake(dir, 'bad.mjs', "process.stderr.write('boom\\n')\nprocess.exit(3)\n")
  const prompt = join(dir, 'p.md')
  writeFileSync(prompt, 'x')
  const cap = capture()
  try {
    const code = await runCli(
      ['run', '--runner', 'agent', '--workdir', dir, '--prompt-file', prompt, '--out-dir', outDir, '--bin', bin],
      cap.io,
    )
    assert.equal(code, 1)
    assert.equal(JSON.parse(cap.stdout().trim()).exitCode, 3)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('timeout kills the owned child and reports timedOut', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ar run slow-'))
  const outDir = join(dir, 'out')
  const bin = fake(dir, 'slow.mjs', 'setInterval(() => {}, 1000)\n')
  const prompt = join(dir, 'p.md')
  writeFileSync(prompt, 'x')
  const cap = capture()
  try {
    const code = await runCli(
      ['run', '--runner', 'agent', '--workdir', dir, '--prompt-file', prompt, '--out-dir', outDir, '--bin', bin, '--timeout', '400'],
      cap.io,
    )
    assert.equal(code, 1)
    const facts = JSON.parse(cap.stdout().trim())
    assert.equal(facts.timedOut, true)
    assert.equal(facts.aborted, true)
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

test('codex child reads the prompt from stdin and emits a codex event', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ar-codex-e2e-'))
  const outDir = join(dir, 'out')
  const bin = fake(
    dir,
    'codex-fake.mjs',
    "import fs from 'node:fs'\nlet data=''\nprocess.stdin.on('data',(c)=>(data+=c))\nprocess.stdin.on('end',()=>{const text=data.trim().toUpperCase()\nconst out=process.argv[process.argv.indexOf('-o')+1]\nfs.writeFileSync(out,text)\nprocess.stdout.write(JSON.stringify({type:'item.completed',item:{id:'i1',type:'agent_message',text}})+'\\n')})\n",
  )
  const prompt = join(dir, 'p.md')
  writeFileSync(prompt, 'hello codex')
  const cap = capture()
  try {
    const code = await runCli(
      ['run', '--runner', 'codex', '--workdir', dir, '--prompt-file', prompt, '--out-dir', outDir, '--bin', bin],
      cap.io,
    )
    assert.equal(code, 0)
    const facts = JSON.parse(cap.stdout().trim())
    assert.match(readFileSync(facts.outputFile, 'utf8'), /HELLO CODEX/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CLI rejects a used out-dir, unsupported sandbox, session and schema', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ar-run-reject-'))
  const existing = join(dir, 'exists')
  mkdirSync(existing)
  const prompt = join(dir, 'p.md')
  writeFileSync(prompt, 'x')
  const cap = capture()
  try {
    const code = await runCli(
      ['run', '--runner', 'agent', '--workdir', dir, '--prompt-file', prompt, '--out-dir', existing, '--bin', fake(dir, 'ok.mjs', OK_AGENT)],
      cap.io,
    )
    assert.equal(code, 2)
    assert.match(cap.stderr(), /--out-dir already exists/)

    assert.equal(
      await runCli(['run', '--runner', 'pi', '--workdir', dir, '--prompt-file', prompt, '--out-dir', join(dir, 'a'), '--sandbox', 'danger-full-access'], cap.io),
      2,
    )
    assert.equal(
      await runCli(['run', '--runner', 'agent', '--workdir', dir, '--prompt-file', prompt, '--out-dir', join(dir, 'b'), '--session', 's'], cap.io),
      2,
    )
    assert.equal(
      await runCli(['run', '--runner', 'pi', '--workdir', dir, '--prompt-file', prompt, '--out-dir', join(dir, 'c'), '--schema-file', 's.json'], cap.io),
      2,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('runAgentTurn API returns the same facts shape', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ar-api-'))
  const bin = fake(dir, 'ok.mjs', OK_AGENT)
  try {
    const facts = await runAgentTurn({
      runner: 'agent',
      bin,
      workdir: dir,
      prompt: 'x',
      outFile: join(dir, 'o.txt'),
      eventsFile: join(dir, 'e.jsonl'),
      logFile: join(dir, 'l.txt'),
    })
    assert.equal(facts.runner, 'agent')
    assert.equal(facts.exitCode, 0)
    assert.ok(existsSync(facts.outputFile))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
