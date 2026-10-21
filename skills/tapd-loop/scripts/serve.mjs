/**
 * tapd-loop 的只读看板。默认绑定 127.0.0.1，不写任何文件。
 */

import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readAsset, sharedAsset } from '../../../lib/web-ui/assets.mjs'
import { listRuns, readArm, readCard } from './read-run.mjs'
import { pageHtml } from './page.mjs'

const args = process.argv.slice(2)
const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = argValue('--root') || join(homedir(), '.tapd-loop', 'runs')
const PORT = Number(argValue('--port') || 7317)

const server = createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1')
  try {
    if (url.pathname === '/' || url.pathname === '/index.html') return send(res, 200, pageHtml(), 'text/html; charset=utf-8')
    const asset = url.pathname.startsWith('/assets/') ? sharedAsset(url.pathname.slice('/assets/'.length)) : null
    if (asset) {
      res.writeHead(200, { 'content-type': asset.type, 'cache-control': 'no-store' })
      res.end(asset.body)
      return
    }
    if (url.pathname === '/app.js') {
      const app = readAsset(join(HERE, 'page-app.js'))
      res.writeHead(200, { 'content-type': app.type, 'cache-control': 'no-store' })
      res.end(app.body)
      return
    }
    if (url.pathname === '/api/state') {
      return send(res, 200, JSON.stringify({ runs: listRuns(ROOT) }), 'application/json; charset=utf-8')
    }
    if (url.pathname === '/api/card') {
      const run = url.searchParams.get('run') || ''
      const id = url.searchParams.get('id') || ''
      const card = readCard(ROOT, run, id)
      return send(res, card ? 200 : 404, JSON.stringify(card || { error: 'card not found' }), 'application/json; charset=utf-8')
    }
    if (url.pathname === '/api/arm') {
      const run = url.searchParams.get('run') || ''
      const id = url.searchParams.get('id') || ''
      const arm = url.searchParams.get('arm') || ''
      const data = readArm(ROOT, run, id, arm)
      return send(res, data ? 200 : 404, JSON.stringify(data || { error: 'arm not found' }), 'application/json; charset=utf-8')
    }
    if (url.pathname.startsWith('/img/')) {
      const parts = url.pathname.split('/').filter(Boolean).slice(1).map(safeName)
      if (parts.length !== 3) return send(res, 400, 'bad path')
      const file = join(ROOT, parts[0], parts[1], 'images', parts[2])
      if (!existsSync(file)) return send(res, 404, 'not found')
      res.writeHead(200, { 'content-type': mime(parts[2]), 'cache-control': 'max-age=3600' })
      res.end(readFileSync(file))
      return
    }
    send(res, 404, 'not found')
  } catch (err) {
    send(res, 500, String(err.message || err))
  }
})

server.on('error', (err) => {
  console.error(JSON.stringify({ error: err.code || err.message, port: PORT }))
  process.exit(err.code === 'EADDRINUSE' ? 2 : 1)
})

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}/`
  console.log(JSON.stringify({ url, root: ROOT, runs: listRuns(ROOT).length }))
  if (args.includes('--open')) open(url)
})

function send(res, code, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' })
  res.end(body)
}

function mime(name) {
  const ext = String(name).split('.').pop().toLowerCase()
  return { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' }[ext] || 'application/octet-stream'
}

function safeName(value) {
  return String(value || '').replace(/[^a-zA-Z0-9._-]/g, '')
}

function argValue(name) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : ''
}

function open(url) {
  if (process.platform === 'win32') execFile('cmd', ['/c', 'start', '', url])
  else execFile('open', [url])
}
