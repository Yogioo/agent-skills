/**
 * exec-review 技能回归测试（防回归网）。
 *
 * 位置：仓库 tests/ 下（不在技能内部），随 repo 版本管理。
 * 覆盖三类真实回归：
 *   1. serve.mjs 的 HTML 模板里 `\n` 被求值成真实换行 → 渲染后 <script> 语法错误 → 页面全停
 *   2. render() 引用不存在的元素 id（$('roundCount')）→ null.textContent 抛错 → 时间线/日志渲染中断
 *   3. serve 把 context_start 文件注册耦合在 sentCount 增量里 / 新连接不回放上下文 → 上下文不显示
 *
 * 运行：
 *   cd C:\projects\agent-skills
 *   node --test tests/exec-review/
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import http from 'node:http'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderProgressHtml } from '../../skills/exec-review/scripts/progress-http.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SKILL = join(__dirname, '..', '..', 'skills', 'exec-review')
const SERVE = join(SKILL, 'scripts', 'serve.mjs')
const PROGRESS_HTTP = join(SKILL, 'scripts', 'progress-http.mjs')

// ---------- 1 & 2：静态渲染校验 ----------

/** 渲染 progress-http.mjs 的 HTML 模板，抽出 { html, script }。 */
function rendered() {
  const html = renderProgressHtml({ basePath: '', progressFile: '/tmp/progress.jsonl' })
  const sm = html.match(/<script>([\s\S]*?)<\/script>/)
  assert.ok(sm, 'HTML 应包含 <script> 块')
  return { html, script: sm[1] }
}

test('渲染后的 <script> 是合法 JS（防 \\n 模板转义回归）', () => {
  const { script } = rendered()
  // new Function 构造时即编译，语法错误会抛 SyntaxError
  assert.doesNotThrow(() => new Function(script), '渲染后脚本必须能解析')
})

test('JS 引用的每个元素 id 都在 HTML 中存在（防空引用回归）', () => {
  const { html, script } = rendered()
  const used = [...new Set([...script.matchAll(/\$\(['"]([a-zA-Z]+)['"]\)/g)].map((m) => m[1]))]
  const defined = new Set([...html.matchAll(/id="([a-zA-Z]+)"/g)].map((m) => m[1]))
  const missing = used.filter((id) => !defined.has(id))
  assert.deepStrictEqual(missing, [], '不应有缺失的元素 id')
})

test('上下文注册与 sentCount 解耦、新连接回放（防 serve 集成回归）', () => {
  const src = readFileSync(PROGRESS_HTTP, 'utf8')
  // 注册必须扫描全量事件，而非仅 sentCount 之后的新事件
  assert.match(src, /registerContextFiles\(evs\)/, 'broadcast 应全量扫描注册上下文文件')
  assert.match(src, /registeredFiles/, '注册应有去重守卫')
  assert.match(src, /registeredEventsFiles/, 'events 注册应有去重守卫')
  // 新连接必须回放 events / context
  assert.match(src, /writeEventsReplay\(res\)/, 'connect 处理器应回放 agent events')
  assert.match(src, /writeContextReplay\(res\)/, 'connect 处理器应回放 log context')
})

test('progress HTML 含结构化 context 卡片容器与 polish 控件', () => {
  const { html } = rendered()
  assert.match(html, /id="contextCards"/, '应有 contextCards 容器')
  assert.match(html, /ctx-trunc/, '应含可展开截断控件')
  assert.match(html, /ctx-shell-cmd/, '应含 shell 命令样式')
  assert.match(html, /ctx-edit-head/, '应含 edit/write 标题样式')
  assert.match(html, /fmtToolSummary/, '应注入 context-ui 格式化函数')
  assert.match(html, /assistant_partial/, '应处理 partial assistant 事件')
})

// ---------- 3：serve 端到端冒烟（真实回归网） ----------

function connectable(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/' }, (res) => {
      res.resume()
      resolve(true)
    })
    req.on('error', () => resolve(false))
    req.setTimeout(300, () => {
      req.destroy()
      resolve(false)
    })
  })
}

function waitFor(fn, timeout = 6000) {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    ;(function tick() {
      fn().then((ok) => {
        if (ok) resolve()
        else if (Date.now() - start > timeout) reject(new Error('等待超时'))
        else setTimeout(tick, 100)
      })
    })()
  })
}

/** 连接 /events，收集 ms 毫秒内的所有 data 事件。 */
function getEvents(port, ms) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/events' }, (res) => {
      let data = ''
      res.on('data', (c) => (data += c))
      setTimeout(() => {
        res.destroy()
        resolve(parseEvents(data))
      }, ms)
    })
    req.on('error', () => resolve([]))
  })
}

function parseEvents(data) {
  const out = []
  for (const line of data.split('\n')) {
    if (!line.startsWith('data: ')) continue
    try {
      out.push(JSON.parse(line.slice(6)))
    } catch {
      /* 忽略坏行 */
    }
  }
  return out
}

test('serve：推送里程碑 + agent_event，且新连接回放 events', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'er-reg-'))
  const now = Date.now()
  const eventsFile = join(dir, 'executor.events.jsonl')
  const evs = [
    { t: now - 5000, level: 1, event: 'run_start', title: 't', maxRounds: 2 },
    { t: now - 3000, level: 2, event: 'executor_start', round: 1 },
    {
      t: now - 2000,
      level: 2,
      event: 'context_start',
      role: 'executor',
      file: join(dir, 'executor.log'),
      eventsFile,
    },
  ]
  writeFileSync(join(dir, 'progress.jsonl'), evs.map((e) => JSON.stringify(e)).join('\n') + '\n')
  writeFileSync(
    eventsFile,
    JSON.stringify({ kind: 'assistant', t: now, text: 'hello from agent' }) + '\n',
  )

  const port = 19000 + Math.floor(Math.random() * 1000)
  const child = spawn(process.execPath, [SERVE, dir, String(port)], {
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  try {
    await waitFor(() => connectable(port))

    const first = await getEvents(port, 2600)
    assert.ok(first.some((e) => e.event === 'run_start'), '首个连接应收到里程碑')
    assert.ok(
      first.some((e) => e.type === 'agent_event' && e.event?.text === 'hello from agent'),
      '首个连接应收到 agent_event',
    )

    const second = await getEvents(port, 1800)
    assert.ok(
      second.some((e) => e.type === 'agent_event' && e.event?.text === 'hello from agent'),
      '第二个连接应回放 agent_event',
    )
  } finally {
    child.kill()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('serve：无 eventsFile 时仍回放 log 上下文', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'er-reg-log-'))
  const now = Date.now()
  const evs = [
    { t: now - 5000, level: 1, event: 'run_start', title: 't', maxRounds: 2 },
    { t: now - 3000, level: 2, event: 'executor_start', round: 1 },
    { t: now - 2000, level: 2, event: 'context_start', role: 'executor', file: join(dir, 'executor.log') },
  ]
  writeFileSync(join(dir, 'progress.jsonl'), evs.map((e) => JSON.stringify(e)).join('\n') + '\n')
  writeFileSync(join(dir, 'executor.log'), 'line one\nline two\nline three\n')

  const port = 19100 + Math.floor(Math.random() * 1000)
  const child = spawn(process.execPath, [SERVE, dir, String(port)], {
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  try {
    await waitFor(() => connectable(port))
    const first = await getEvents(port, 2600)
    assert.ok(first.some((e) => e.type === 'context' && e.line === 'line one'), '首个连接应收到 log 上下文')
  } finally {
    child.kill()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------- 4：单次「执行→审查」两阶段契约（防回炉循环回归） ----------

const RUN = join(SKILL, 'scripts', 'run-task.mjs')
const EXEC_PROMPT = join(SKILL, 'prompts', 'executor.md')
const REVIEW_PROMPT = join(SKILL, 'prompts', 'reviewer.md')
const REVIEW_SCHEMA = join(SKILL, 'schemas', 'review.schema.json')

function read(p) {
  return readFileSync(p, 'utf8')
}

test('run-task 已移除回炉循环词汇（lastFindings / revise / escalate / round_start）', () => {
  const src = read(RUN)
  for (const token of ['lastFindings', "'revise'", "'escalate'", "'round_start'", 'runGit']) {
    assert.ok(!src.includes(token), `run-task.mjs 不应再包含 ${token}`)
  }
})

test('run-task 收集 git 只读上下文，并以工作区快照检测改动', () => {
  const src = read(RUN)
  assert.match(src, /execFileSync/, '应通过 git 命令收集只读上下文')
  assert.match(src, /['"]git['"]/, '应调用 git 命令')
  assert.match(src, /rev-parse/, '应读取仓库状态与 BASE_HEAD')
  assert.ok(src.includes("from './workspace.mjs'"), '应引入 workspace 快照模块')
  assert.match(src, /snapshot\(workdir\)/, '执行前应做工作区快照')
  assert.match(src, /changedFiles/, '应以改动文件为准，而非提交')
})

test('run-task 保持单次 执行→审查 两阶段（executor_start / reviewer_start / approved）', () => {
  const src = read(RUN)
  assert.match(src, /progress\.write\('executor_start'/, '应发射执行阶段开始')
  assert.match(src, /progress\.write\('reviewer_start'/, '应发射审查阶段开始')
  assert.match(src, /status: 'approved'/, '审查后应定案 approved')
  // 审查端直接改进：审查阶段不再把结论交回执行端
  assert.match(src, /审查阶段：审查端直接改进/, '应注释审查端直接改进')
})

test('提示词模板使用动态提交规则和 git 上下文占位符', () => {
  const ex = read(EXEC_PROMPT)
  const rv = read(REVIEW_PROMPT)
  assert.match(ex, /{{COMMIT_RULE}}/, '执行端应有动态提交规则占位符')
  assert.match(ex, /{{GIT_LOG}}/, '执行端应有 git log 占位符')
  assert.match(rv, /{{GIT_REVIEW_CONTEXT}}/, '审查端应有 git 上下文占位符')
})

test('审查端提示词要求直接修改、seal 与 git diff 上下文', () => {
  const md = read(REVIEW_PROMPT)
  assert.match(md, /直接/, '审查端应被要求直接修改')
  assert.match(md, /clean\|refined/, '审查端输出应为 clean|refined')
  assert.match(md, /{{GIT_REVIEW_CONTEXT}}/, '审查端应有条件 git diff 上下文')
  assert.match(md, /# Seal/, '审查端应有 seal 步骤')
  assert.match(md, /amend/, '审查端应 amend 执行端 commit')
  assert.ok(!md.includes('REVISE'), '审查端不应再输出 REVISE 交回执行端')
})

test('审查 schema 为 clean|refined（非 APPROVE/REVISE）', () => {
  const schema = JSON.parse(read(REVIEW_SCHEMA))
  const st = schema.properties.status.enum
  assert.deepStrictEqual([...st].sort(), ['clean', 'refined'])
  assert.ok(!JSON.stringify(schema).includes('verdict'), 'schema 不应再含 verdict')
})

function git(dir, args) {
  return execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function makeGitRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'er-git-context-'))
  try {
    git(dir, ['init'])
    git(dir, ['config', 'user.name', 'exec-review test'])
    git(dir, ['config', 'user.email', 'exec-review@example.test'])
    for (const [name, message] of [
      ['one.txt', 'first context commit'],
      ['two.txt', 'second context commit'],
      ['three.txt', 'third context commit'],
    ]) {
      writeFileSync(join(dir, name), `${message}\n`)
      git(dir, ['add', name])
      git(dir, ['commit', '-m', message])
    }
    return { dir, head: git(dir, ['rev-parse', 'HEAD']) }
  } catch (err) {
    rmSync(dir, { recursive: true, force: true })
    throw err
  }
}

function runDryRun(workdir, cacheDir, extraArgs = []) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env }
    delete env.EXEC_REVIEW_GIT_COMMIT
    const child = spawn(
      process.execPath,
      [
        RUN,
        '--workdir',
        workdir,
        '--title',
        'prompt rendering',
        '--body',
        'render the prompts',
        '--dry-run',
        '--no-serve',
        '--cache-dir',
        cacheDir,
        ...extraArgs,
      ],
      { cwd: SKILL, env, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.once('error', reject)
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(`dry-run exit=${code}: ${stderr}`))
        return
      }
      try {
        resolve(JSON.parse(stdout.trim()))
      } catch (err) {
        reject(new Error(`无法解析 dry-run 摘要: ${err.message}\n${stdout}`))
      }
    })
  })
}

test('dry-run 在 git 仓库默认注入 log、提交规则和 BASE_HEAD', async () => {
  const repo = makeGitRepo()
  const cache = mkdtempSync(join(tmpdir(), 'er-git-cache-'))
  try {
    const summary = await runDryRun(repo.dir, cache)
    const executor = read(join(summary.cacheDir, 'executor.prompt.md'))
    const reviewer = read(join(summary.cacheDir, 'reviewer.prompt.md'))

    assert.match(executor, /参考：最近变更（git log）/)
    assert.match(executor, /third context commit/)
    assert.match(executor, /执行端 \*\*commit\*\*/)
    assert.match(executor, /本任务仅一个 commit/)
    assert.match(executor, /`no_change` \/ `blocked` \/ `empty`：不提交/)
    assert.match(reviewer, new RegExp(`BASE_HEAD：.*${repo.head}`))
    assert.match(reviewer, /git diff/)
    assert.match(reviewer, /审查端 \*\*amend\*\*/)
    assert.match(reviewer, /git commit --amend --no-edit/)
    assert.match(reviewer, /不另起新 commit/)
  } finally {
    rmSync(repo.dir, { recursive: true, force: true })
    rmSync(cache, { recursive: true, force: true })
  }
})

test('dry-run 的 gitCommit=false 保留禁止提交但仍注入 git 上下文', async () => {
  const repo = makeGitRepo()
  const cache = mkdtempSync(join(tmpdir(), 'er-git-cache-'))
  try {
    const summary = await runDryRun(repo.dir, cache, ['--git-commit', 'false'])
    const executor = read(join(summary.cacheDir, 'executor.prompt.md'))
    const reviewer = read(join(summary.cacheDir, 'reviewer.prompt.md'))

    assert.doesNotMatch(executor, /本任务仅一个 commit/)
    assert.match(executor, /不要提交（提交由调用方负责）/)
    assert.match(executor, /参考：最近变更（git log）/)
    assert.match(reviewer, new RegExp(`BASE_HEAD：.*${repo.head}`))
    assert.match(reviewer, /git diff/)
  } finally {
    rmSync(repo.dir, { recursive: true, force: true })
    rmSync(cache, { recursive: true, force: true })
  }
})

test('dry-run 在非 git 目录不注入 git 相关提示词', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'er-no-git-'))
  const cache = mkdtempSync(join(tmpdir(), 'er-no-git-cache-'))
  try {
    const summary = await runDryRun(dir, cache)
    const prompts = [
      read(join(summary.cacheDir, 'executor.prompt.md')),
      read(join(summary.cacheDir, 'reviewer.prompt.md')),
    ]
    for (const prompt of prompts) {
      assert.doesNotMatch(prompt, /\bgit\b|BASE_HEAD|最近变更/)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(cache, { recursive: true, force: true })
  }
})
