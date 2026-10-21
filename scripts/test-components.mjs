#!/usr/bin/env node
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const groups = ['agent-run', 'subagent', 'work-items', 'event-inbox', 'requirement-store', 'questionnaire',
  'prompt-compose', 'run-runtime', 'workspace-diff', 'xlsx-cell-diff', 'web-ui', 'components', 'layers', 'packaging']
const selected = process.argv.length > 2 ? process.argv.slice(2) : groups
if (selected.some((name) => !groups.includes(name))) {
  process.stderr.write(`Unknown test group; choose from ${groups.join(', ')}\n`)
  process.exit(2)
}
const files = selected.flatMap((name) => readdirSync(join(root, 'tests', name))
  .filter((file) => file.endsWith('.test.mjs')).map((file) => join(root, 'tests', name, file)))
const result = spawnSync(process.execPath, ['--test', ...files], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: true,
  // 测试里不许拉起常驻看板（也不许往真实 ~/.afk 里登记 run）。
  env: { ...process.env, AGENT_TOOLS_BOARD: 'off' },
})
if (result.error) process.stderr.write(`${result.error.message}\n`)
process.exitCode = result.status ?? 1
