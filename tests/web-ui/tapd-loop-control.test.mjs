/**
 * tapd-loop 看板控制面的契约：配置白名单、密钥、一次一批、停止文件。
 *
 * 这一层钉住「页面能做什么」，不碰真 TAPD：批次的命令用假脚本，队列用假输出。
 *
 *   node --test tests/web-ui/tapd-loop-control.test.mjs
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  DEFAULTS, batchArgs, createControl, exitMarkerPath, jobCommand, parseCardRef, sameKey, sanitizeControl, stopFilePath,
} from '../../skills/tapd-loop/scripts/control.mjs'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const serveScript = join(repoRoot, 'skills', 'tapd-loop', 'scripts', 'serve.mjs')

test('control config keeps only whitelisted, clamped fields', () => {
  const saved = sanitizeControl({
    workdir: '  C:/p/x  ',
    assignee: ' 张三 ',
    maxTasks: 999,
    allowDirty: 'yes',
    noWrite: 1,
    watch: { enabled: 'on', pollSec: 5 },
    run: { push: { enabled: true } },
    task: { assignee: '别人' },
  })
  assert.equal(saved.workdir, 'C:/p/x')
  assert.equal(saved.assignee, '张三')
  assert.equal(saved.maxTasks, 20, 'maxTasks 有上限')
  assert.equal(saved.allowDirty, true)
  assert.equal(saved.noWrite, true)
  assert.equal(saved.watch.enabled, true)
  assert.equal(saved.watch.pollSec, 30, 'pollSec 有下限，不能让轮询变成死循环')
  assert.equal(saved.run, undefined, '不能从浏览器改运行配置')
  assert.equal(saved.task, undefined)
})

test('control config falls back to defaults on garbage', () => {
  const saved = sanitizeControl({ maxTasks: 'abc', watch: { pollSec: -1 } }, DEFAULTS)
  assert.equal(saved.maxTasks, DEFAULTS.maxTasks, '读不出来的数字退回旧值')
  assert.equal(saved.watch.pollSec, 30, '读得出来的越界数字夹到下限')
  assert.equal(sanitizeControl({ watch: { pollSec: 'abc' } }, DEFAULTS).watch.pollSec, DEFAULTS.watch.pollSec)
  assert.deepEqual(sanitizeControl(null), DEFAULTS)
})

test('batch command is the plain loop.mjs CLI, never a new board', () => {
  const args = batchArgs({ workdir: 'C:/p/x', maxTasks: 2, assignee: '张三', allowDirty: true, noWrite: true }, { card: '1005001' })
  assert.deepEqual(args, [
    '--workdir', 'C:/p/x', '--max-tasks', '2',
    '--assignee', '张三', '--card', '1005001', '--allow-dirty', '--no-write', '--no-board',
  ])
  const bare = batchArgs({ workdir: 'C:/p/x', maxTasks: 1 })
  assert.deepEqual(bare, ['--workdir', 'C:/p/x', '--max-tasks', '1', '--no-board'])
})

test('a pasted TAPD link resolves to the story id, not the workspace id', () => {
  const forms = [
    'https://www.tapd.cn/tapd_fe/52320961/story/detail/1152360842001005050',
    'https://www.tapd.cn/tapd_fe/52320961/story/detail/1152360842001005050?page=1#comments',
    'https://www.tapd.cn/52320961/prong/stories/view/1152360842001005050',
    '  https://www.tapd.cn/tapd_fe/52320961/story/detail/1152360842001005050  ',
  ]
  for (const input of forms) {
    const parsed = parseCardRef(input)
    assert.equal(parsed.ok, true, input)
    assert.equal(parsed.id, '1152360842001005050', input)
    assert.equal(parsed.workspaceId, '52320961', input)
    assert.equal(parsed.guessed, false, input)
  }
  assert.deepEqual(parseCardRef('1152360842001005050'), { ok: true, id: '1152360842001005050', ref: '1152360842001005050', workspaceId: '', guessed: false })
})

test('a messy copy-paste falls back to the longest digit run', () => {
  const parsed = parseCardRef('需求 1152360842001005050 修数字门（项目 52320961）')
  assert.equal(parsed.ok, true)
  assert.equal(parsed.id, '1152360842001005050')
  assert.equal(parsed.guessed, true, '兜底猜出来的要标记，页面会提示确认')
  assert.equal(parseCardRef('随便一句没有数字的话').ok, false)
  assert.equal(parseCardRef('').ok, false)
  assert.match(parseCardRef('').error, /先贴/)
})

test('key comparison is exact and empty never matches', () => {
  assert.equal(sameKey('abc', 'abc'), true)
  assert.equal(sameKey('abc', 'abd'), false)
  assert.equal(sameKey('abc', 'abcd'), false)
  assert.equal(sameKey('', ''), false, '没有配置密钥时不能放行')
})

test('stop file follows the worktree, and degrades to the workdir', () => {
  const plain = mkdtempSync(join(tmpdir(), 'tapd-stop-'))
  try {
    assert.equal(stopFilePath(plain), join(plain, 'tapd-loop-stop'))
  } finally {
    rmSync(plain, { recursive: true, force: true })
  }
})

test('loopback board needs no key and round-trips its config', async (t) => {
  const board = await withBoard(t, ['--host', '127.0.0.1'])
  const control = await getJson(board, 'api/control')
  assert.equal(control.status, 200)
  assert.equal(control.data.config.maxTasks, 1)
  assert.equal(control.data.board.authRequired, false)
  assert.ok(Array.isArray(control.data.workdirs))

  const saved = await postJson(board, 'api/control', {
    workdir: 'C:/p/demo', maxTasks: 3, assignee: '张三',
    watch: { enabled: true, pollSec: 120 },
    run: { push: { enabled: true } },
  })
  assert.equal(saved.status, 200)
  assert.equal(saved.data.config.maxTasks, 3)
  assert.equal(saved.data.config.watch.pollSec, 120)
  assert.equal(saved.data.config.run, undefined, '不认识的字段不回写')

  // 落到磁盘：看板重启之后开关还在，否则「定时接单」会莫名失效。
  const onDisk = JSON.parse(readFileSync(join(board.home, 'board-control.json'), 'utf8'))
  assert.equal(onDisk.workdir, 'C:/p/demo')
  assert.equal(onDisk.watch.enabled, true)
})

test('LAN board demands the key for data, but still serves the page', async (t) => {
  const board = await withBoard(t, ['--host', '0.0.0.0'])

  const health = await fetch(`${board.base}healthz`)
  assert.equal(health.status, 200, '探活不需要密钥，start-board 靠它复用')
  const info = await health.json()
  assert.equal(info.app, 'tapd-loop')
  assert.equal(info.authRequired, true)

  const page = await fetch(board.base)
  assert.equal(page.status, 200)
  assert.match(await page.text(), /id="cRun"/, '页面骨架里有「接单开跑」')

  const denied = await fetch(`${board.base}api/state`)
  assert.equal(denied.status, 401)
  const header = await fetch(`${board.base}api/state`, { headers: { 'x-tapd-loop-key': board.key } })
  assert.equal(header.status, 200)
  const query = await fetch(`${board.base}api/state?k=${encodeURIComponent(board.key)}`)
  assert.equal(query.status, 200, '<img> 带不了 header，query 也得认')

  const control = await getJson(board, 'api/control', { headers: { 'x-tapd-loop-key': board.key } })
  assert.match(control.data.board.shareWithKey, /\?k=/, '页面上的分享链接自带密钥')
})

test('a run against a non-repo is refused instead of spawning a doomed batch', async (t) => {
  const board = await withBoard(t, ['--host', '127.0.0.1'])
  const plain = join(board.home, 'plain')
  mkdirSync(plain, { recursive: true })

  const refused = await postJson(board, 'api/run', { workdir: plain })
  assert.equal(refused.status, 409)
  assert.match(refused.data.error, /不是 git 仓库/)
  assert.equal(refused.data.running, null)

  const missing = await postJson(board, 'api/run', { workdir: join(plain, 'nope') })
  assert.equal(missing.status, 409)
  assert.match(missing.data.error, /工作目录不存在/)

  const relative = await postJson(board, 'api/run', { workdir: 'relative/dir' })
  assert.equal(relative.status, 409)
  assert.match(relative.data.error, /绝对路径/)

  const stopped = await postJson(board, 'api/stop', { workdir: plain })
  assert.equal(stopped.status, 200)
  assert.ok(existsSync(join(plain, 'tapd-loop-stop')), '停止文件写在 workdir 里（非 git 场景的兜底）')
})

test('pasting a link previews the card, and a blocked card never spawns a batch', async (t) => {
  const board = await withBoard(t, ['--host', '127.0.0.1', '--loop-script', await fakeLoop(t)])
  const repo = await gitRepo(t, board.home)

  const blocked = await getJson(board, `api/card-link?ref=${encodeURIComponent('https://www.tapd.cn/tapd_fe/52320961/story/detail/1152360842001005050')}`)
  assert.equal(blocked.status, 200)
  assert.equal(blocked.data.id, '1152360842001005050')
  assert.equal(blocked.data.card.title, '假卡（已交付）')
  assert.match(blocked.data.card.blockedReason, /afk-delivered/)

  const refused = await postJson(board, 'api/run', { workdir: repo, ref: '1152360842001005050' })
  assert.equal(refused.status, 409)
  assert.match(refused.data.error, /afk-delivered/)
  const status = await getJson(board, 'api/control')
  assert.equal(status.data.running, null, '被挡住的卡不能起批次')

  const missing = await getJson(board, `api/card-link?ref=${encodeURIComponent('不是链接')}`)
  assert.equal(missing.status, 400)
  assert.match(missing.data.error, /认不出/)

  const unknown = await getJson(board, 'api/card-link?ref=9999999999999999999')
  assert.equal(unknown.status, 400)
  assert.match(unknown.data.error, /1005001 失败/, 'TAPD 报错要原样带回来')
})

test('a claimable card from a link starts a one-card batch', async (t) => {
  const board = await withBoard(t, ['--host', '127.0.0.1', '--loop-script', await fakeLoop(t)])
  const repo = await gitRepo(t, board.home)

  const started = await postJson(board, 'api/run', {
    workdir: repo, ref: 'https://www.tapd.cn/tapd_fe/52320961/story/detail/1152360842001005051', maxTasks: 5,
  })
  assert.equal(started.status, 200, JSON.stringify(started.data).slice(0, 300))
  assert.equal(started.data.batch.card, '1152360842001005051')
  assert.equal(started.data.batch.maxTasks, 1, '指定一张卡就只跑一张')
  assert.ok(started.data.batch.argv.includes('--card'))
  assert.ok(started.data.batch.argv.includes('--no-board'))
})

// ---------------------------------------------------------------- 工位状态

test('a station with a live batch is busy before the card id is known', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'tapd-busy-'))
  t.after(() => cleanup(home))
  const runsRoot = join(home, 'runs')
  const runDir = join(runsRoot, 'run-1')
  mkdirSync(runDir, { recursive: true })
  // loop 记的是反斜杠路径，工位表里存的是正斜杠：两种写法必须认成同一个目录，
  // 否则「跑着」的工位会显示成空闲，还会给它画「合入 / 接一单」。
  const workdir = 'C:\\projects\\demo-wt-a'
  writeFileSync(join(runDir, 'progress.jsonl'), [
    JSON.stringify({ t: Date.now(), event: 'loop_start', workdir, pid: process.pid, maxTasks: 1 }),
    // 刚开跑：批次已经起来，但卡还没分到（card 是空的）。
    JSON.stringify({ t: Date.now(), event: 'heartbeat', pid: process.pid, card: '' }),
  ].join('\n') + '\n', 'utf8')

  const ctl = createControl({ home, runsRoot, loopScript: 'unused.mjs' })
  ctl.write({ workdir: 'C:/projects/demo', stations: [{ name: 'a', path: 'C:/projects/demo-wt-a' }] })

  const station = ctl.status().stations[0]
  assert.equal(station.busy, true)
  assert.equal(station.idle, false)
  assert.equal(station.card, '', '还没有卡，但页面不能因此画成空闲')
  assert.equal(ctl.busy('C:/projects/demo-wt-a').pid, process.pid, '斜杠方向不同也要拦得住第二批')
})

test('pending merge count ignores commits the main tree has not pulled yet', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'tapd-pending-'))
  t.after(() => cleanup(home))
  const git = (cwd, ...args) => execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  }).trim()

  const origin = join(home, 'origin.git')
  git(home, 'init', '--bare', origin)

  // 主树：develop 跟 origin/develop 同步
  const main = join(home, 'main')
  git(home, 'clone', origin, main)
  git(main, 'checkout', '-B', 'develop')
  git(main, 'config', 'user.email', 'a@b.c')
  git(main, 'config', 'user.name', 't')
  writeFileSync(join(main, 'a.txt'), 'base', 'utf8')
  git(main, 'add', '-A')
  git(main, 'commit', '-m', 'base')
  git(main, 'push', '-u', 'origin', 'develop')

  // 工位：从 develop 开分支
  const station = join(home, 'main-wt-a')
  git(main, 'worktree', 'add', '-b', 'feat/a', station, 'develop')

  // 别人往 origin/develop 推了一个提交（美术/别人的活，不是这一单的）
  const other = join(home, 'other')
  git(home, 'clone', origin, other)
  git(other, 'checkout', '-B', 'develop', 'origin/develop')
  git(other, 'config', 'user.email', 'a@b.c')
  git(other, 'config', 'user.name', 't')
  writeFileSync(join(other, 'art.txt'), 'art', 'utf8')
  git(other, 'add', '-A')
  git(other, 'commit', '-m', 'art: 别人的提交')
  git(other, 'push', 'origin', 'develop')

  // 工位开工前 sync 把别人刚推的提交拉进来，主树本地还没 pull
  git(station, 'pull', '--rebase', 'origin', 'develop')
  assert.equal(git(main, 'rev-parse', 'HEAD'), git(main, 'rev-parse', 'origin/develop~1'), '主树故意落后一格')
  assert.equal(git(main, 'rev-list', '--count', 'HEAD..feat/a'), '1', '只跟本地 HEAD 比会算出 1，这就是那个假「合入 1」')

  const runsRoot = join(home, 'runs')
  mkdirSync(runsRoot, { recursive: true })
  const ctl = createControl({ home, runsRoot, loopScript: 'unused.mjs' })
  ctl.write({ workdir: main.replace(/\\/g, '/'), stations: [{ name: 'a', path: station.replace(/\\/g, '/') }] })
  assert.equal(ctl.status().stations[0].pending, 0, '上游已有的提交不算待合入')

  // 工位真提交了自己的活，就得算回来
  writeFileSync(join(station, 'mine.txt'), 'mine', 'utf8')
  git(station, 'add', '-A')
  git(station, 'commit', '-m', 'fix: 1005001 工位自己的提交')
  assert.equal(ctl.status().stations[0].pending, 1, '工位自己的提交不能被过滤掉')
})

test('paused station keeps out of dispatch and survives unrelated config writes', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'tapd-pause-'))
  t.after(() => cleanup(home))
  const git = (cwd, ...args) => execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  }).trim()

  // 暂停标记存在 stations 表里，登记工位要求目录真的是 git 仓库。
  const main = join(home, 'main')
  mkdirSync(main, { recursive: true })
  git(main, 'init')
  git(main, 'config', 'user.email', 'a@b.c')
  git(main, 'config', 'user.name', 't')
  writeFileSync(join(main, 'a.txt'), 'base', 'utf8')
  git(main, 'add', '-A')
  git(main, 'commit', '-m', 'base')

  const runsRoot = join(home, 'runs')
  mkdirSync(runsRoot, { recursive: true })
  const slash = (dir) => dir.replace(/\\/g, '/')
  const ctl = createControl({ home, runsRoot, loopScript: 'unused.mjs' })
  ctl.write({ workdir: slash(main), stations: [{ name: 'a', path: slash(main) }] })
  assert.equal(ctl.status().stations[0].paused, false, '新建的工位默认接活')

  assert.equal(ctl.pauseStation({ name: 'a', paused: true }).ok, true)
  assert.equal(ctl.status().stations[0].paused, true)
  // 页面每次改配置都会整份 sanitize 再写回：白名单很容易顺手吞掉这个字段。
  ctl.write({ maxTasks: 3 })
  assert.equal(ctl.status().stations[0].paused, true, '改别的设置不能把暂停标记冲掉')
  // 重启看板后还在（人在页面上关的，不是内存里的一次性开关）
  const again = createControl({ home, runsRoot, loopScript: 'unused.mjs' })
  assert.equal(again.status().stations[0].paused, true, '落盘，重启后仍然暂停')

  // 调度器跳过它，并且把「为什么没开工」说清楚（否则看着像坏了）
  const tick = await again.tick({ force: true })
  assert.equal(tick.skipped, 'no-idle')
  assert.match(again.status().watch.lastError, /a\(已暂停\)/)

  again.pauseStation({ name: 'a', paused: false })
  assert.equal(again.status().stations[0].paused, false, '能接回去')
  assert.equal(again.pauseStation({ name: 'nope', paused: true }).ok, false, '没这个工位就拒')
})

test('a job whose process vanished shows as interrupted, and the main tree stays busy for a grace period', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'tapd-orphan-'))
  t.after(() => cleanup(home))
  const runsRoot = join(home, 'runs')
  mkdirSync(runsRoot, { recursive: true })
  const ctl = createControl({ home, runsRoot, loopScript: 'unused.mjs' })
  // 主树指一个不存在的目录：过了宽限期 tick 只会返回 no-main，不会真的去起 collect。
  ctl.write({ workdir: join(home, 'nowhere'), autoPush: { enabled: true, pollSec: 60 } })

  // 拿一个确实死掉的 pid：spawn 一个马上退出的子进程。
  const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore', windowsHide: true })
  await new Promise((done) => child.once('exit', done))

  const file = join(home, 'board-control.json')
  const setJob = (startedAt) => {
    const current = JSON.parse(readFileSync(file, 'utf8'))
    writeFileSync(file, JSON.stringify({
      ...current,
      jobs: [{ id: 'job-orphan', kind: 'main-push', name: '(主树)', workdir: join(home, 'nowhere'), pid: child.pid || 0, startedAt, status: 'running', log: '' }],
    }), 'utf8')
  }

  setJob(Date.now())
  assert.equal(ctl.status().jobs[0].status, 'interrupted', '进程没了就不是 running（页面靠这个不再画「验证中」）')
  assert.deepEqual(await ctl.autoPushTick(), { skipped: 'busy' }, '刚断线的任务还是算主树忙：detached 的 collect 可能还在动 develop')

  setJob(Date.now() - 20 * 60_000)
  assert.equal((await ctl.autoPushTick()).skipped, 'no-main', '过了宽限期就不该无限挡路')
})

test('job command records its own exit code, so a restarted board can still settle the job', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tapd-exit-'))
  t.after(() => cleanup(dir))
  const bash = [
    'C:/Program Files/Git/bin/bash.exe',
    'C:/Program Files (x86)/Git/bin/bash.exe',
    'C:/Program Files/Git/usr/bin/bash.exe',
  ].find((file) => existsSync(file)) || 'bash'
  const run = (name, script) => {
    const log = join(dir, `${name}.log`)
    // 非 0 退出是预期（我们要的就是那个码），execFileSync 会抛，吞掉就好。
    try { execFileSync(bash, ['-c', jobCommand(log, script)], { stdio: 'ignore', windowsHide: true }) } catch { /* 退出码在标记里 */ }
    return {
      out: readFileSync(log, 'utf8'),
      code: readFileSync(exitMarkerPath(log), 'utf8').trim(),
    }
  }

  // 正常路径：日志进文件，退出码进标记
  const ok = run('ok', 'echo hello; exit 0')
  assert.equal(ok.code, '0')
  assert.match(ok.out, /hello/)

  // 失败的退出码也要原样留住
  assert.equal(run('bad', 'echo boom >&2; exit 3').code, '3')

  // 关键：每个任务脚本都自带 `exec`（exec 会把自己换成 node）。
  // 没套子 shell 的话，后面写标记那句永远轮不到执行。
  const execd = run('exec', `exec '${process.execPath.replace(/\\/g, '/')}' '-e' 'process.stdout.write("by exec")'`)
  assert.equal(execd.code, '0')
  assert.match(execd.out, /by exec/)
})

test('a restarted board settles a finished job from its exit marker instead of leaving it running', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'tapd-recover-'))
  t.after(() => cleanup(home))
  const runsRoot = join(home, 'runs')
  mkdirSync(runsRoot, { recursive: true })
  const ctl = createControl({ home, runsRoot, loopScript: 'unused.mjs' })
  ctl.write({ workdir: join(home, 'nowhere'), autoPush: { enabled: true, pollSec: 60 } })

  const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore', windowsHide: true })
  await new Promise((done) => child.once('exit', done))

  // 造一个「看板重启时还在跑」的现场：记录 running + 死 pid + 日志旁边有子进程写的退出码
  const log = join(home, 'station-merge-a.log')
  writeFileSync(log, '[失败] unity-puer-exec exec 失败（exit 17）\n', 'utf8')
  writeFileSync(exitMarkerPath(log), '1\n', 'utf8')
  const file = join(home, 'board-control.json')
  const current = JSON.parse(readFileSync(file, 'utf8'))
  writeFileSync(file, JSON.stringify({
    ...current,
    jobs: [{ id: 'job-recover', kind: 'main-push', name: '(主树)', workdir: join(home, 'nowhere'), pid: child.pid || 0, startedAt: Date.now(), status: 'running', log }],
  }), 'utf8')

  const job = ctl.status().jobs[0]
  assert.equal(job.status, 'failed', '有退出码就不叫 interrupted：这是真结果')
  assert.equal(job.code, 1)
  assert.equal(job.recovered, true)
  assert.match(job.summary || '', /unity-puer-exec/, '失败原因跟正常收尾一样从日志里捉')
  assert.deepEqual(await ctl.autoPushTick(), { skipped: 'no-main' }, '认回来之后就不该再挡着主树了')

  // 落盘了：第二次读不会又变回 running
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).jobs[0].status, 'failed')
})

// ---------------------------------------------------------------- 小工具

async function withBoard(t, args) {
  const home = mkdtempSync(join(tmpdir(), 'tapd-board-'))
  const root = join(home, 'runs')
  mkdirSync(root, { recursive: true })
  const port = await freePort()
  const child = spawn(process.execPath, [
    serveScript, '--home', home, '--root', root, '--port', String(port), ...args,
  ], {
    cwd: repoRoot,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    // 本机如果设了环境变量，会把测试绑到别的地址上。
    env: { ...process.env, TAPD_LOOP_BOARD_HOST: '' },
  })
  const base = `http://127.0.0.1:${port}/`
  t.after(() => {
    child.kill()
    cleanup(home)
  })
  await waitFor(`${base}healthz`)
  const keyFile = join(home, 'board-key')
  const key = existsSync(keyFile) ? readFileSync(keyFile, 'utf8').trim() : ''
  return { base, home, root, key }
}

/**
 * 假 loop.mjs：--show 按 id 回卡信息，--list 回空队列，真跑睡一下就退出。
 * 用「已交付」的那张卡验证拒绝路径，用另一张验证开跑路径。
 */
async function fakeLoop(t) {
  const dir = mkdtempSync(join(tmpdir(), 'tapd-fake-loop-'))
  const file = join(dir, 'loop.mjs')
  const source = `
const args = process.argv.slice(2)
if (args.includes('--list')) {
  console.log(JSON.stringify({ allowedStatuses: ['developing(开发中)'], ready: [], rejected: [] }))
  process.exit(0)
}
if (args.includes('--show')) {
  const id = args[args.indexOf('--show') + 1]
  if (id === '9999999999999999999') {
    console.error('tapd-cli story list 失败: 1005001 失败')
    process.exit(1)
  }
  const delivered = id.endsWith('050')
  console.log(JSON.stringify({
    source: 'tapd', workspaceId: '52320961', id,
    title: delivered ? '假卡（已交付）' : '假卡（可接）',
    status: 'developing', statusLabel: '开发中', priorityLabel: 'High',
    labels: ['ready-for-agent', ...(delivered ? ['afk-delivered'] : [])],
    readyLabel: 'ready-for-agent', hasReadyLabel: true,
    machineLabel: delivered ? 'afk-delivered' : '',
    claimable: true,
    blockedReason: delivered ? '已带 afk-delivered（可能正在跑、已交付或上次失败），要先在 TAPD 上把这个标签摘掉' : '',
    allowedStatuses: ['developing(开发中)'],
    url: 'https://www.tapd.cn/tapd_fe/52320961/story/detail/' + id,
  }))
  process.exit(0)
}
console.log('{"attempted":1,"done":1}')
process.exit(0)
`
  writeFileSync(file, source, 'utf8')
  t.after(() => cleanup(dir))
  return file
}

async function gitRepo(t, home) {
  const dir = join(home, 'repo')
  mkdirSync(dir, { recursive: true })
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
  git('init')
  git('config', 'user.email', 'a@b.c')
  git('config', 'user.name', 't')
  writeFileSync(join(dir, 'a.txt'), 'hi', 'utf8')
  git('add', '-A')
  git('commit', '-m', 'init')
  t.after(() => cleanup(dir))
  return dir.split(String.fromCharCode(92)).join('/')
}

/**
 * Windows 上 detached 的子进程/句柄可能还没放开，删目录会 EPERM。
 * 重试几次再放弃：临时目录清不干净不该让测试红。
 */
function cleanup(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  } catch {
    // 留给系统临时目录清理
  }
}

function getJson(board, path, init = {}) {
  return requestJson(board, path, init)
}

function postJson(board, path, body, init = {}) {
  return requestJson(board, path, {
    ...init,
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(init.headers || {}) },
    body: JSON.stringify(body),
  })
}

async function requestJson(board, path, init = {}) {
  const res = await fetch(`${board.base}${path}`, init)
  let data = {}
  try {
    data = await res.json()
  } catch {
    data = {}
  }
  return { status: res.status, data }
}

async function waitFor(url) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(700) })
      if (res.ok) return
    } catch {
      // 还没起来
    }
    await new Promise((done) => setTimeout(done, 120))
  }
  throw new Error(`board 没有起来：${url}`)
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}
