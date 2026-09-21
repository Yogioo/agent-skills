/**
 * 工作区改动检测：通过「前后内容快照」对比，得到两端改动了哪些文件、
 * 以及是否发生改动。
 *
 * 快照是 `{ 相对路径 -> 内容指纹 }`。指纹一律用 git blob 的算法
 * （`sha1("blob <长度>\0" + 内容)`），所以「从 git 索引读到的指纹」和
 * 「现算的指纹」可以直接比较，两种模式可以混用。
 *
 * 两种模式（见 `captureWorkspace`）：
 * - **git 模式**：只问 git。两条命令 + 只读真正脏了的文件。
 *   51 GB / 12 万文件的 Unity 工程实测约 0.7 秒。
 * - **walk 模式**：不是 git 目录时老实遍历。跳过表默认只有版本控制元数据，
 *   项目自己的噪音（构建产物、依赖、编辑器缓存）由操作者配 `workspaceSkip` 补。
 *
 * 为什么 git 模式是默认：旧实现是「遍历整个目录，每个文件读全文算 SHA1」。
 * 对 DigitDoor（51 GB / 123266 个文件）一次要 5 分钟以上，每个任务跑 3 次；
 * 而且它是同步调用，卡住时连心跳和超时都起不来——一轮运行就此永久停在「执行中」。
 */

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'

/**
 * 默认跳过表：**只放「按定义就不属于工作树」的目录**——版本控制系统的元数据。
 *
 * 这里**不放**任何构建产物目录（`build/`、`dist/`、`node_modules/`、Unity 的 `Library/`…）。
 * 三条理由：
 * 1. 哪个目录算噪音是**项目自己的判断**，不是这个技能的判断；
 * 2. 任何一份名单都写不全（Unity / Unreal / Godot / Rust / Java / iOS… 各有各的），
 *    补名单是一场永远输的游戏；
 * 3. 更糟的是这些目录**都可能被某些项目正常提交**——统一跳过就是漏报改动。
 *
 * 权威来源有两处，都不在这里：
 * - git 工作树：项目自己的 `.gitignore`（git 模式直接问 git）；
 * - 其它目录：操作者用 `execReview.workspaceSkip` 或 `EXEC_REVIEW_WORKSPACE_SKIP` 补。
 */
export const DEFAULT_SKIP = new Set(['.git', '.hg', '.svn'])

/**
 * 操作者补的目录名与默认表**取并集**。
 * 默认表不允许被覆盖：少一个 `.git` 就会去哈希整个对象库。
 * @param {Iterable<string>|string[]} [extra]
 * @returns {Set<string>}
 */
export function resolveSkip(extra) {
  const out = new Set(DEFAULT_SKIP)
  const list = extra instanceof Set ? [...extra] : Array.isArray(extra) ? extra : []
  for (const name of list) {
    const value = String(name ?? '').trim()
    if (value) out.add(value)
  }
  return out
}

/**
 * git blob 指纹。git 索引里存的就是这个值，所以两边可以直接比。
 * 与 `git hash-object <file>` 逐字节一致。
 */
export function blobFingerprint(buf) {
  return createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex')
}

/**
 * 跑一条只读 git 命令。
 * 失败（没装 git、不是仓库、版本太老不认识参数）返回 `null`，**不抛**——
 * 调用方据此退回 walk 模式，而不是让整轮运行挂掉。
 */
function git(dir, args) {
  try {
    return execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      maxBuffer: 512 * 1024 * 1024,
    })
  } catch {
    return null
  }
}

/** 这个目录在不在 git 工作树里（仓库子目录也算）。 */
export function isGitWorkTree(dir) {
  const out = git(dir, ['rev-parse', '--is-inside-work-tree'])
  return out != null && out.trim() === 'true'
}

/** 相对路径里有没有落在跳过目录里的路径段。 */
export function hasSkippedSegment(rel, skip = DEFAULT_SKIP) {
  return rel.split('/').some((segment) => skip.has(segment))
}

/**
 * git 模式：只问 git。
 *
 * 1. `git ls-files -s` 一次拿到所有已跟踪文件在索引里的指纹——不读文件内容；
 * 2. `git status -z -uall --no-renames` 只列出真正脏了的文件，只给这些文件算指纹。
 *
 * 成本与「仓库有多少文件」基本无关，只与「改了多少文件」有关。
 * `--no-renames` 是为了让输出里不会出现「旧路径\0新路径」这种两项一组的条目。
 *
 * @returns {Record<string,string>|null} 不是 git 工作树时返回 null
 */
function gitSnapshot(dir, { skip = DEFAULT_SKIP } = {}) {
  const prefixOut = git(dir, ['rev-parse', '--show-prefix'])
  if (prefixOut == null) return null
  // 仓库根是 ''，子目录是 'sub/'。两条 git 命令给的都是「仓库根相对路径」，
  // 所以统一在这里剥掉前缀，快照里的键才是相对 dir 的。
  const prefix = prefixOut.trim()

  const localize = (path) => {
    if (!prefix) return path
    if (!path.startsWith(prefix)) return null
    return path.slice(prefix.length)
  }

  const map = {}

  const lsOut = git(dir, ['ls-files', '-s', '-z', '--full-name'])
  if (lsOut == null) return null
  for (const entry of lsOut.split('\0')) {
    if (!entry) continue
    const m = /^(\d+) ([0-9a-f]{40,64}) (\d+)\t([\s\S]+)$/.exec(entry)
    if (!m) continue
    const rel = localize(m[4])
    if (!rel) continue
    map[rel] = m[2]
  }

  const statusOut = git(dir, ['status', '--porcelain', '-z', '-uall', '--no-renames'])
  if (statusOut == null) return null
  for (const entry of statusOut.split('\0')) {
    if (entry.length < 4) continue
    const code = entry.slice(0, 2)
    const rel = localize(entry.slice(3))
    if (!rel) continue
    // 删了：索引里还留着它，但文件没了 → 从快照里拿掉，diff 才会报 removed
    if (code.includes('D')) {
      delete map[rel]
      continue
    }
    // 未跟踪的文件落在噪音目录里就跳过：.gitignore 写漏的构建产物不该拖慢快照。
    // 已跟踪文件不走这条——它们可能本来就住在 build/ 里，跳过就会漏掉改动。
    if (code === '??' && hasSkippedSegment(rel, skip)) continue
    try {
      map[rel] = blobFingerprint(readFileSync(join(dir, rel)))
    } catch {
      // 读不到（子模块、权限、正被独占）：保留索引里的指纹
    }
  }

  return map
}

// ---------------------------------------------------------------- walk 模式

/**
 * 老实的递归遍历：每个文件读全文算指纹。
 * 只有不是 git 目录、或 git 用不了时才走这里，所以 `skip` 很重要。
 * 路径统一用 `/` 拼，跟 git 的输出一致，两种模式的键可以直接比。
 */
function walk(dir, rel, skip, map) {
  const abs = rel ? join(dir, ...rel.split('/')) : dir
  let entries
  try {
    entries = readdirSync(abs)
  } catch {
    return
  }
  for (const name of entries) {
    if (skip.has(name)) continue
    const childRel = rel ? `${rel}/${name}` : name
    let st
    try {
      st = statSync(join(abs, name))
    } catch {
      continue
    }
    if (st.isDirectory()) {
      walk(dir, childRel, skip, map)
    } else if (st.isFile()) {
      try {
        map[childRel] = blobFingerprint(readFileSync(join(abs, name)))
      } catch {
        // 读不到就当它没变，不要让一个坏文件毁掉整次快照
      }
    }
  }
}

function walkSnapshot(dir, skip) {
  const map = {}
  walk(dir, '', skip, map)
  return map
}

// ---------------------------------------------------------------- 对外入口

/**
 * 抓一次工作区快照。
 *
 * @param {string} dir
 * @param {object} [opts]
 * @param {Iterable<string>} [opts.skip] 额外跳过的目录名，与默认表取并集
 * @param {'auto'|'git'|'walk'} [opts.mode]  默认 auto：是 git 目录就用 git
 * @returns {{ mode: 'git'|'walk', files: Record<string,string>, elapsedMs: number }}
 */
export function captureWorkspace(dir, opts = {}) {
  const root = resolve(dir)
  const skip = resolveSkip(opts.skip)
  const want = opts.mode || 'auto'
  const startedAt = Date.now()

  if (want !== 'walk') {
    const files = gitSnapshot(root, { skip })
    // 问不出 git（没装 / 不是仓库 / 命令失败）就退回遍历：
    // 宁可慢，也不能静默地把改动检测关掉。
    if (files) return { mode: 'git', files, elapsedMs: Date.now() - startedAt }
  }

  return { mode: 'walk', files: walkSnapshot(root, skip), elapsedMs: Date.now() - startedAt }
}

/**
 * 对目录做内容快照：`{ 相对路径 -> 指纹 }`。
 * 只要指纹表的调用方用这个；想知道走的是哪种模式用 `captureWorkspace`。
 * @param {string} dir
 * @param {object} [opts]
 * @returns {Record<string, string>}
 */
export function snapshot(dir, opts = {}) {
  return captureWorkspace(dir, opts).files
}

/**
 * 对比前后快照。
 * @param {Record<string, string>} before
 * @param {Record<string, string>} after
 * @returns {{ changed: string[], added: string[], removed: string[] }}
 */
export function diff(before, after) {
  const changed = []
  const added = []
  const removed = []
  const all = new Set([...Object.keys(before), ...Object.keys(after)])
  for (const k of all) {
    const b = before[k]
    const a = after[k]
    if (b === undefined) added.push(k)
    else if (a === undefined) removed.push(k)
    else if (b !== a) changed.push(k)
  }
  return { changed, added, removed }
}
