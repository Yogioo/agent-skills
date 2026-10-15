/**
 * Behavioral tests for scripts/sync-links.ps1 using an isolated temp repo and
 * temp destination: junction creation, -Prune safety, -Force, and -WhatIf.
 *
 *   node --test tests/packaging/sync-links.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { makeTempDir, cleanup, run, repoRoot } from './helpers.mjs'

const script = join(repoRoot, 'scripts', 'sync-links.ps1')

async function runSync(args) {
  let lastError
  for (const command of ['pwsh', 'powershell']) {
    try {
      return await run(command, ['-NoProfile', '-NonInteractive', '-File', script, ...args])
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

function addSkill(skillsRoot, name, withSkill) {
  const dir = join(skillsRoot, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, withSkill ? 'SKILL.md' : 'content.txt'), '# content\n')
  return dir
}

function makeJunction(linkPath, targetPath) {
  rmSync(linkPath, { recursive: true, force: true })
  symlinkSync(resolve(targetPath), resolve(linkPath), 'junction')
}

function linkExists(path) {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

function anyExists(path) {
  return existsSync(path) || linkExists(path)
}

function sameTarget(path, expected) {
  return resolve(readlinkSync(path)).toLowerCase() === resolve(expected).toLowerCase()
}

test('sync-links creates active junctions and -WhatIf mutates nothing', async () => {
  const root = makeTempDir('sync-whatif-')
  try {
    const skillsRoot = join(root, 'repo', 'skills')
    const destination = join(root, 'target')
    const active = addSkill(skillsRoot, 'active-a', true)

    const dry = await runSync(['-SkillsRoot', skillsRoot, '-Destination', destination, '-WhatIf'])
    assert.equal(dry.code, 0, dry.stderr)
    assert.match(dry.stdout, /\[WhatIf\]/)
    assert.ok(!anyExists(destination), '-WhatIf must not create the destination')

    const real = await runSync(['-SkillsRoot', skillsRoot, '-Destination', destination])
    assert.equal(real.code, 0, real.stderr)
    assert.ok(linkExists(join(destination, 'active-a')))
    assert.ok(sameTarget(join(destination, 'active-a'), active))
  } finally {
    cleanup(root)
  }
})

test('sync-links -Prune removes only retired junctions', async () => {
  const root = makeTempDir('sync-prune-')
  try {
    const skillsRoot = join(root, 'repo', 'skills')
    const destination = join(root, 'target')
    const otherRepo = join(root, 'other', 'skills')
    mkdirSync(destination, { recursive: true })

    const active = addSkill(skillsRoot, 'active-a', true)
    const liveOld = addSkill(skillsRoot, 'live-old', true)
    const retired = addSkill(skillsRoot, 'retired-b', false)
    const retiredGone = addSkill(skillsRoot, 'retired-gone', false)
    const foreignTarget = addSkill(otherRepo, 'foreign', true)
    const foreignBroken = addSkill(otherRepo, 'broken-foreign', true)

    makeJunction(join(destination, 'active-a'), active)
    makeJunction(join(destination, 'live-old'), liveOld)
    makeJunction(join(destination, 'retired-b'), retired)
    makeJunction(join(destination, 'retired-gone'), retiredGone)
    makeJunction(join(destination, 'foreign'), foreignTarget)
    makeJunction(join(destination, 'broken-foreign'), foreignBroken)
    rmSync(foreignBroken, { recursive: true, force: true })
    mkdirSync(join(destination, 'real-retired'), { recursive: true })
    writeFileSync(join(destination, 'real-retired', 'keep.txt'), 'keep\n')
    // Make retired-gone a broken junction that still records this repo's path.
    rmSync(retiredGone, { recursive: true, force: true })

    const dry = await runSync(['-SkillsRoot', skillsRoot, '-Destination', destination, '-Prune', '-WhatIf'])
    assert.equal(dry.code, 0, dry.stderr)
    assert.ok(linkExists(join(destination, 'retired-b')), '-WhatIf must not prune retired junctions')
    assert.ok(linkExists(join(destination, 'retired-gone')), '-WhatIf must not prune broken retired junctions')

    const result = await runSync(['-SkillsRoot', skillsRoot, '-Destination', destination, '-Prune'])
    assert.equal(result.code, 0, result.stderr)

    assert.ok(linkExists(join(destination, 'active-a')), 'active junction kept')
    assert.ok(linkExists(join(destination, 'live-old')), 'live skill junction kept')
    assert.ok(linkExists(join(destination, 'foreign')), 'foreign junction kept')
    assert.ok(linkExists(join(destination, 'broken-foreign')), 'foreign broken junction kept')
    assert.ok(existsSync(join(destination, 'real-retired')), 'real directory untouched')
    assert.ok(existsSync(join(destination, 'real-retired', 'keep.txt')))
    assert.ok(!anyExists(join(destination, 'retired-b')), 'retired junction pruned')
    assert.ok(!anyExists(join(destination, 'retired-gone')), 'broken retired junction pruned')
  } finally {
    cleanup(root)
  }
})

test('sync-links -Force replaces a real directory for an active skill', async () => {
  const root = makeTempDir('sync-force-')
  try {
    const skillsRoot = join(root, 'repo', 'skills')
    const destination = join(root, 'target')
    const active = addSkill(skillsRoot, 'active-a', true)
    const occupied = join(destination, 'active-a')
    mkdirSync(occupied, { recursive: true })
    writeFileSync(join(occupied, 'sentinel.txt'), 'old\n')

    const withoutForce = await runSync(['-SkillsRoot', skillsRoot, '-Destination', destination])
    assert.equal(withoutForce.code, 0, withoutForce.stderr)
    assert.ok(!linkExists(occupied), 'real directory preserved without -Force')
    assert.ok(existsSync(join(occupied, 'sentinel.txt')))

    const forced = await runSync(['-SkillsRoot', skillsRoot, '-Destination', destination, '-Force'])
    assert.equal(forced.code, 0, forced.stderr)
    assert.ok(linkExists(occupied), 'real directory replaced with -Force')
    assert.ok(sameTarget(occupied, active))
    assert.ok(!existsSync(join(occupied, 'sentinel.txt')), 'old real contents removed')
  } finally {
    cleanup(root)
  }
})
