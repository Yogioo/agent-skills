/**
 * 工作区改动检测：通过「前后内容快照」对比，得到两端改动了哪些文件、
 * 以及是否发生改动。不假设目标目录是 git 仓库。
 *
 * 用法：
 *   const before = snapshot(dir)
 *   …（agent 改动工作区）…
 *   const after = snapshot(dir)
 *   const { changed, added, removed } = diff(before, after)
 */

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

/** 默认忽略的目录（噪音/体积），可用 opts.skip 覆盖。 */
const DEFAULT_SKIP = new Set(['.git', 'node_modules'])

function walk(root, rel, skip, map) {
  const abs = rel ? join(root, rel) : root
  let entries
  try {
    entries = readdirSync(abs)
  } catch {
    return
  }
  for (const name of entries) {
    if (skip.has(name)) continue
    const childRel = rel ? rel + sep + name : name
    const childAbs = join(abs, name)
    let st
    try {
      st = statSync(childAbs)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      walk(root, childRel, skip, map)
    } else if (st.isFile()) {
      let buf
      try {
        buf = readFileSync(childAbs)
      } catch {
        continue
      }
      map[childRel] = createHash('sha1').update(buf).digest('hex')
    }
  }
}

/**
 * 对目录做内容快照：{ 相对路径 -> sha1(内容) }。
 * @param {string} dir
 * @param {{ skip?: Set<string> }} [opts]
 * @returns {Record<string, string>}
 */
export function snapshot(dir, opts = {}) {
  const root = resolve(dir)
  const skip = opts.skip || DEFAULT_SKIP
  const map = {}
  walk(root, '', skip, map)
  return map
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
