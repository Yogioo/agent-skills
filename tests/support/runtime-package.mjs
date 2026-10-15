// Test support: build an isolated copy of the installed tool runtime.
//
// The installation contract is the private @yogioo/agent-tools package, not a
// copied skill directory. Tests that need to prove the runtime works outside
// this repository (and without any legacy skill copied alongside) use this
// helper to copy `lib/`, `tools/` and, when present, `bin/` + `package.json`
// into a fresh temp directory, then invoke the copied CLI through Node.
import { cpSync, existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Absolute path to the repository root. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** VCS/build directories that must never be copied into the runtime fixture. */
const RUNTIME_ENTRIES = ['lib', 'tools', 'bin', 'package.json']

/**
 * Copy the tool runtime into an isolated temp directory.
 *
 * @param {string} [prefix]
 * @returns {{root: string, lib: string, tools: string,
 *   path: (...parts: string[]) => string,
 *   cli: (name: string) => string,
 *   toolFile: (name: string, file: string) => string}}
 */
export function createRuntimeCopy(prefix = 'agent-tools-runtime-') {
  const root = mkdtempSync(join(tmpdir(), prefix))
  for (const entry of RUNTIME_ENTRIES) {
    const src = join(REPO_ROOT, entry)
    if (existsSync(src)) cpSync(src, join(root, entry), { recursive: true })
  }
  return {
    root,
    lib: join(root, 'lib'),
    tools: join(root, 'tools'),
    path: (...parts) => join(root, ...parts),
    cli: (name) => join(root, 'tools', name, 'cli.mjs'),
    toolFile: (name, file) => join(root, 'tools', name, file),
  }
}
