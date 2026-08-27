#!/usr/bin/env node
/**
 * 实时进度查看器（独立进程）。
 * 读取单条 progress.jsonl，经 SSE 推送给浏览器渲染成实时 HTML。
 *
 * 用法：
 *   node scripts/serve.mjs <runDir> [port]
 *   node scripts/serve.mjs --progress-file <path> [port]
 */

import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { createProgressWatcher } from './progress-http.mjs'

function parseArgs(argv) {
  if (argv[0] === '--progress-file') {
    return {
      progressFile: resolve(argv[1] || process.cwd()),
      port: Number(argv[2]) || 8642,
    }
  }
  const runDir = resolve(argv[0] || process.cwd())
  return {
    progressFile: `${runDir}/progress.jsonl`,
    port: Number(argv[1]) || 8642,
  }
}

const { progressFile, port } = parseArgs(process.argv.slice(2))
const watcher = createProgressWatcher(progressFile)

const server = createServer((req, res) => {
  const handled = watcher.handleRequest(req.url || '/', req, res, { basePath: '' })
  if (handled) return
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('not found')
})

server.listen(port, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${port}/`
  console.error(`exec-review 实时进度: ${url}`)
  console.error(`  读取: ${progressFile}`)
})

process.on('SIGINT', () => {
  watcher.close()
  server.close()
  process.exit(0)
})
