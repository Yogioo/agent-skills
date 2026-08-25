import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProgressWriter } from '../../skills/exec-review/scripts/progress.mjs'

test('ProgressWriter 保留本地进度流并镜像到调用方指定路径', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'exec-progress-'))
  const mirror = join(dir, 'loop', 'task.progress.jsonl')
  try {
    const progress = new ProgressWriter(dir, { progressFile: mirror })
    progress.write('run_start', { title: 'mirror' })
    progress.heartbeat()
    await progress.end()
    const local = readFileSync(join(dir, 'progress.jsonl'), 'utf8')
    const copied = readFileSync(mirror, 'utf8')
    assert.equal(copied, local)
    assert.match(copied, /"heartbeat"/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
