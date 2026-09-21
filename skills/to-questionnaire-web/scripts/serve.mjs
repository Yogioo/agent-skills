#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { networkInterfaces } from 'node:os'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'

function parseArgs(argv) {
  const args = { file: '', host: '0.0.0.0', port: 0, open: false, requirement: '' }
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i]
    if (value === '--file') args.file = argv[++i] || ''
    else if (value === '--host') args.host = argv[++i] || args.host
    else if (value === '--port') args.port = Number(argv[++i] || 0)
    else if (value === '--requirement') args.requirement = argv[++i] || ''
    else if (value === '--open') args.open = true
    else if (value === '--help' || value === '-h') {
      console.log('Usage: node serve.mjs --file <questionnaire.md> [--host 0.0.0.0] [--port 0] [--open] [--requirement <id>]')
      process.exit(0)
    }
  }
  if (!args.file) throw new Error('--file is required')
  return args
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function parseQuestionnaire(markdown) {
  const lines = markdown.split(/\r?\n/)
  const titleIndex = lines.findIndex((line) => /^#\s+/.test(line))
  const title = (titleIndex === -1 ? '# Questionnaire' : lines[titleIndex]).replace(/^#\s+/, '').trim()
  const introEnd = lines.findIndex((line, index) => index > titleIndex && /^#{1,6}\s+/.test(line))
  const intro = lines.slice(titleIndex + 1, introEnd === -1 ? lines.length : introEnd).join('\n').trim()
  const questions = []
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(/^###\s+(.+?)\s*$/)
    if (!match) continue
    let answer = ''
    for (let j = i + 1; j < lines.length && !/^#{1,3}\s+/.test(lines[j]); j += 1) {
      if (lines[j].startsWith('>')) {
        answer = lines[j].replace(/^>\s?/, '')
        break
      }
    }
    questions.push({ id: `q${questions.length + 1}`, question: match[1], answer })
  }
  return { title, intro, questions }
}

const VIRTUAL_ADAPTER = /vEthernet|WSL|Docker|VMware|VirtualBox|Hyper-?V|Loopback|Tailscale|ZeroTier|Radmin|SmartRoute|TAP|OpenVPN|WireGuard|Bluetooth|虚拟|tun/i

function lanAddresses() {
  const candidates = []
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family !== 'IPv4' || entry.internal) continue
      if (entry.address.startsWith('169.254.')) continue
      const virtual = VIRTUAL_ADAPTER.test(name) ? 1 : 0
      const rank = entry.address.startsWith('192.168.') ? 0 : entry.address.startsWith('10.') ? 1 : 2
      candidates.push({ name, address: entry.address, virtual, rank })
    }
  }
  candidates.sort((a, b) => a.virtual - b.virtual || a.rank - b.rank || a.name.localeCompare(b.name))
  return candidates
}

function readBody(request) {
  return new Promise((resolveBody, reject) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => {
      body += chunk
      if (body.length > 2 * 1024 * 1024) request.destroy(new Error('request too large'))
    })
    request.on('end', () => resolveBody(body))
    request.on('error', reject)
  })
}

function renderPage(model, token) {
  const questions = model.questions.map((item) => `
    <label class="question" for="${escapeHtml(item.id)}">
      <span>${escapeHtml(item.question)}</span>
      <textarea id="${escapeHtml(item.id)}" data-question="${escapeHtml(item.question)}" rows="5">${escapeHtml(item.answer)}</textarea>
    </label>`).join('\n')
  const fallback = model.questions.length === 0 ? `
    <label class="question" for="general"><span>回答</span><textarea id="general" data-question="回答" rows="12"></textarea></label>` : ''
  const intro = model.intro ? `<p class="intro">${escapeHtml(model.intro)}</p>` : ''
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(model.title)}</title><style>
body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;max-width:900px;margin:0 auto;padding:24px;color:#202124;background:#f7f8fa}
main{background:#fff;border:1px solid #dfe3e8;padding:24px}h1{margin-top:0;font-size:28px}p{white-space:pre-wrap;line-height:1.6}.question{display:block;margin:24px 0}.question span{display:block;font-weight:650;margin-bottom:8px}.question textarea{box-sizing:border-box;width:100%;min-height:100px;padding:10px;border:1px solid #b8c0cc;border-radius:6px;font:inherit;resize:vertical}button{padding:10px 16px;border:0;border-radius:6px;background:#1769e0;color:#fff;font:inherit;cursor:pointer}button.secondary{background:#5f6368;margin-left:8px}#status{margin-left:12px;color:#5f6368}
</style></head><body><main><h1>${escapeHtml(model.title)}</h1>${intro}<p>请填写或修改下面的回答。可以先保存草稿，确认无误后提交。</p><form id="form">${questions}${fallback}<p><button type="button" id="draft" class="secondary">保存草稿</button><button type="submit">提交回答</button><span id="status"></span></p></form></main>
<script>
const token=${JSON.stringify(token)}, key='questionnaire-draft-'+location.pathname;
const form=document.querySelector('#form'), status=document.querySelector('#status');
const fields=[...form.querySelectorAll('textarea')];
const saved=JSON.parse(localStorage.getItem(key)||'null');
if(saved) fields.forEach((field)=>{if(saved[field.id]!==undefined) field.value=saved[field.id]});
function values(){return Object.fromEntries(fields.map((field)=>[field.id,{question:field.dataset.question,answer:field.value}]));}
function saveDraft(){localStorage.setItem(key,JSON.stringify(Object.fromEntries(fields.map((field)=>[field.id,field.value]))));status.textContent='草稿已保存在本浏览器';}
document.querySelector('#draft').onclick=saveDraft;
form.onsubmit=async(event)=>{event.preventDefault();saveDraft();status.textContent='正在提交...';const response=await fetch('/submit?token='+encodeURIComponent(token),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({answers:values()})});const body=await response.json();status.textContent=response.ok?'已提交，可以关闭页面':(body.error||'提交失败');if(response.ok) fields.forEach((field)=>field.disabled=true)};
</script></body></html>`
}

// 把「策划答了」告诉 AFK 收件箱。
// afk-run 可能没装（问卷技能应当能单独用），所以导入失败就只是不转发，不影响问卷本身。
let afkInbox = null
try {
  afkInbox = await import('../../afk-run/scripts/inbox.mjs')
} catch (error) {
  console.error(JSON.stringify({ event: 'afk_inbox_unavailable', error: error.message }))
}

const args = parseArgs(process.argv.slice(2))
const file = resolve(args.file)
if (!existsSync(file)) throw new Error(`questionnaire file not found: ${file}`)
const markdown = readFileSync(file, 'utf8')
const model = parseQuestionnaire(markdown)
const token = randomBytes(18).toString('hex')
const outputBase = basename(file, extname(file))
const responseFile = join(dirname(file), `${outputBase}-response.json`)
const responseMarkdown = join(dirname(file), `${outputBase}-response.md`)
const statusFile = join(dirname(file), `${outputBase}-status.json`)
const startedAt = new Date().toISOString()
let currentPort = args.port

// 状态文件是跨工具调用 / 跨会话的恢复锚点：不含 token，可安全随问卷目录一起分享。
function writeStatus(extra) {
  try {
    const payload = { file, port: currentPort, startedAt, updatedAt: new Date().toISOString(), responseFile, responseMarkdown, ...extra }
    writeFileSync(statusFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  } catch (error) {
    console.error(JSON.stringify({ event: 'status_write_failed', error: error.message }))
  }
}

function openBrowser(url) {
  try {
    const [command, commandArgs] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin' ? ['open', [url]]
        : ['xdg-open', [url]]
    const child = spawn(command, commandArgs, { detached: true, stdio: 'ignore' })
    child.on('error', () => {})
    child.unref()
  } catch {
    // 打不开浏览器不影响服务本身
  }
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost')
    if (url.pathname === '/' && request.method === 'GET' && url.searchParams.get('token') === token) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(renderPage(model, token))
      return
    }
    if (url.pathname === '/submit' && request.method === 'POST' && url.searchParams.get('token') === token) {
      const payload = JSON.parse(await readBody(request))
      const result = { questionnaireFile: file, submittedAt: new Date().toISOString(), answers: payload.answers || {} }
      writeFileSync(responseFile, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
      const lines = [`# ${model.title} - 回答`, '', `来源: ${file}`, `提交时间: ${result.submittedAt}`, '']
      for (const item of model.questions) {
        const answer = result.answers[item.id]?.answer || ''
        lines.push(`## ${item.question}`, '', answer, '')
      }
      if (model.questions.length === 0 && result.answers.general) lines.push('## 回答', '', result.answers.general.answer || '', '')
      writeFileSync(responseMarkdown, `${lines.join('\n')}\n`, 'utf8')
      const answeredCount = model.questions.filter((item) => (result.answers[item.id]?.answer || '').trim() !== '').length
      writeStatus({ state: 'submitted', submittedAt: result.submittedAt, answeredCount, questionCount: model.questions.length })
      if (afkInbox) {
        afkInbox.emitInboxEvent({
          kind: 'questionnaire-submitted',
          requirementId: args.requirement || null,
          workdir: process.cwd(),
          title: `策划回答了 ${answeredCount}/${model.questions.length} 题：${model.title}`,
          detail: { responseFile, responseMarkdown, statusFile, questionnaireFile: file, answeredCount },
          nextStep: '读回答，把它纳入需求上下文，继续澄清或推进',
        }, { log: (line) => console.error(line) })
      }
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      // 响应 flush 后再退出：closeAllConnections 清掉浏览器挂着的 keep-alive 空闲连接，
      // 否则 server.close() 可能一直等在位连接上，进程退不掉。
      response.end(JSON.stringify({ ok: true, responseFile, responseMarkdown }), () => {
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
        server.close(() => process.exit(0))
        setTimeout(() => process.exit(0), 1000).unref()
      })
      console.log(JSON.stringify({ event: 'questionnaire_submitted', responseFile, responseMarkdown, statusFile, answeredCount, questionCount: model.questions.length }))
      console.log(`\n================ 收到提交 ================\n回答数: ${answeredCount}/${model.questions.length}\n摘要: ${responseMarkdown}\n原始: ${responseFile}\n状态: ${statusFile}\n（只接受一次提交，本进程即将退出）\n==========================================\n`)
      return
    }
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('Not found')
  } catch (error) {
    response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify({ error: error.message }))
  }
})

server.on('error', (error) => { console.error(error.stack || error); process.exitCode = 1 })
server.listen(args.port, args.host, () => {
  const address = server.address()
  const port = typeof address === 'object' ? address.port : args.port
  const lan = lanAddresses().map((item) => ({ name: item.name, address: item.address, url: `http://${item.address}:${port}/?token=${token}` }))
  currentPort = port
  const localUrl = `http://127.0.0.1:${port}/?token=${token}`
  writeStatus({
    state: 'waiting',
    localOrigin: `http://127.0.0.1:${port}`,
    lanOrigins: lan.map((item) => `http://${item.address}:${port}`),
    lanInterfaces: lan.map((item) => `${item.name} ${item.address}`),
  })
  console.log(JSON.stringify({ event: 'questionnaire_started', file, localUrl, lanUrl: lan[0] ? lan[0].url : '', lanUrls: lan.map((item) => item.url), lanInterfaces: lan.map((item) => `${item.name} ${item.address}`), port, responseFile, responseMarkdown, statusFile }))
  const lines = ['', '================ 网页问卷已就绪 ================', `问卷: ${file}`, '发给回答者的地址（局域网）:']
  lan.forEach((item, index) => lines.push(`  ${index === 0 ? '首选' : '备选'}  ${item.url}   [${item.name} ${item.address}]`))
  lines.push(`本机自测: ${localUrl}`, '', '等待提交中……提交后本进程自动退出。', `（连接不上时优先换上面另一个网卡地址；状态见 ${statusFile}）`, '================================================', '')
  console.log(lines.join('\n'))
  if (args.open) openBrowser(localUrl)
})
