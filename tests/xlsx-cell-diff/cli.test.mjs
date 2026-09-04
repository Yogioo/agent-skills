/**
 * xlsx-cell-diff CLI 外部行为
 *
 *   node --test tests/xlsx-cell-diff/cli.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { EXIT } from '../../skills/xlsx-cell-diff/scripts/exit-codes.mjs'
import { loadWorkbookFromPath } from '../../skills/xlsx-cell-diff/scripts/xlsx-read.mjs'
import { readZip } from '../../skills/xlsx-cell-diff/scripts/zip.mjs'
import {
  TERRAIN,
  TERRAIN_FIXED,
  buildWorkbook,
  capture,
  git,
  initRepo,
  languageCells,
  tempDir,
  writeWorkbook,
} from './helpers.mjs'

function assertNoCells(stdout) {
  assert.match(stdout, /No display-value changes/)
}

test('help and usage errors', () => {
  const help = capture(['--help'])
  assert.equal(help.code, EXIT.ok)
  assert.match(help.stdout, /xlsx-cell-diff/)
  const missing = capture([])
  assert.equal(missing.code, EXIT.usage)
  const unknown = capture(['nope'])
  assert.equal(unknown.code, EXIT.usage)
})

test('resave with identical display values is empty status/diff', () => {
  const dir = tempDir()
  const left = writeWorkbook(dir, 'left.xlsx', languageCells(TERRAIN), { shared: true })
  const right = writeWorkbook(dir, 'right.xlsx', languageCells(TERRAIN), {
    shared: true,
    app: '<?xml version="1.0"?><Properties>rewritten</Properties>',
  })
  const status = capture(['status', '--left', left, '--right', right, '--json'])
  assert.equal(status.code, EXIT.ok)
  assert.deepEqual(JSON.parse(status.stdout).workbooks, [])
  const diff = capture(['diff', '--left', left, '--right', right])
  assert.equal(diff.code, EXIT.ok)
  assertNoCells(diff.stdout)
})

test('five Simplified Chinese terrain names, English unchanged', () => {
  const dir = tempDir()
  const left = writeWorkbook(dir, 'lang-old.xlsx', languageCells(TERRAIN), { shared: true })
  const right = writeWorkbook(dir, 'lang-new.xlsx', languageCells(TERRAIN_FIXED), { shared: true })
  const status = capture(['status', '--left', left, '--right', right, '--json'])
  assert.equal(status.code, EXIT.ok)
  const listed = JSON.parse(status.stdout).workbooks
  assert.equal(listed.length, 1)
  assert.equal(listed[0].cells, 5)
  assert.deepEqual(listed[0].sheets, ['CfgLanguage'])
  assert.ok(listed[0].rows.includes('Terrain_Name_2'))
  const statusText = capture(['status', '--left', left, '--right', right])
  assert.match(statusText.stdout, /Changed workbooks/)
  assert.match(statusText.stdout, /CfgLanguage: Terrain_Name_2/)
  assert.match(statusText.stdout, /5 rows/)

  const diff = capture(['diff', '--left', left, '--right', right, '--json'])
  const cells = JSON.parse(diff.stdout).results[0].cells
  assert.equal(cells.length, 5)
  for (const cell of cells) {
    assert.equal(cell.sheet, 'CfgLanguage')
    assert.equal(cell.column, 'ChineseSimplified')
    assert.match(cell.row, /^Terrain_Name_[2-6]$/)
    assert.equal(cell.kind, 'changed')
  }
  assert.ok(cells.every((cell) => cell.column !== 'English'))
  assert.ok(cells.every((cell) => cell.address && cell.excelRow && cell.path === `/${cell.sheet}/${cell.address}`))

  const text = capture(['diff', '--left', left, '--right', right])
  assert.match(text.stdout, /CfgLanguage/)
  assert.match(text.stdout, /Terrain_Name_2  \(Excel row 5\)/)
  assert.match(text.stdout, /ChineseSimplified \/CfgLanguage\/C5 /)
  assert.match(text.stdout, /5 rows/)
  assert.doesNotMatch(text.stdout, /English/)
})

test('shared-string index reshuffle is not a change', () => {
  const dir = tempDir()
  const cells = languageCells(TERRAIN)
  const left = writeWorkbook(dir, 'a.xlsx', cells, { shared: true })
  const reversed = {
    ...cells[0],
    cells: [...cells[0].cells].reverse(),
  }
  const right = writeWorkbook(dir, 'b.xlsx', [reversed], { shared: true })
  const diff = capture(['diff', '--left', left, '--right', right])
  assert.equal(diff.code, EXIT.ok)
  assertNoCells(diff.stdout)
})

test('primary-key insert does not rewrite later rows', () => {
  const dir = tempDir()
  const before = [
    { id: 'a', zh: '甲', en: 'A' },
    { id: 'b', zh: '乙', en: 'B' },
    { id: 'c', zh: '丙', en: 'C' },
  ]
  const after = [
    { id: 'a', zh: '甲', en: 'A' },
    { id: 'new', zh: '新', en: 'New' },
    { id: 'b', zh: '乙', en: 'B' },
    { id: 'c', zh: '丙', en: 'C' },
  ]
  const left = writeWorkbook(dir, 'before.xlsx', languageCells(before))
  const right = writeWorkbook(dir, 'after.xlsx', languageCells(after))
  const diff = capture(['diff', '--left', left, '--right', right, '--json'])
  const result = JSON.parse(diff.stdout).results[0]
  assert.deepEqual(result.structural.map((s) => `${s.kind}:${s.row}`), ['row-added:new'])
  assert.equal(result.cells.length, 0)
})

test('generic profile falls back to row numbers', () => {
  const dir = tempDir()
  const left = writeWorkbook(dir, 'g1.xlsx', [{
    name: 'Notes',
    cells: [{ ref: 'A1', text: 'hello' }, { ref: 'B2', text: 'x' }],
  }])
  const right = writeWorkbook(dir, 'g2.xlsx', [{
    name: 'Notes',
    cells: [{ ref: 'A1', text: 'hello' }, { ref: 'B2', text: 'y' }],
  }])
  const diff = capture(['diff', '--left', left, '--right', right, '--no-luban', '--json'])
  const cells = JSON.parse(diff.stdout).results[0].cells
  assert.equal(cells.length, 1)
  assert.equal(cells[0].row, 'R2')
  assert.equal(cells[0].column, 'B')
  assert.equal(cells[0].new.text, 'y')
})

test('one-sided three-way auto-merges', () => {
  const dir = tempDir()
  const base = writeWorkbook(dir, 'base.xlsx', languageCells(TERRAIN))
  const local = writeWorkbook(dir, 'local.xlsx', languageCells(TERRAIN))
  const remoteRows = TERRAIN.map((row) => row.id === 'Terrain_Name_2' ? { ...row, zh: '远端改' } : row)
  const remote = writeWorkbook(dir, 'remote.xlsx', languageCells(remoteRows))
  const conflicts = capture(['conflicts', '--base', base, '--local', local, '--remote', remote, '--json'])
  assert.equal(conflicts.code, EXIT.ok)
  const payload = JSON.parse(conflicts.stdout)
  assert.equal(payload.conflicts.length, 0)
  assert.ok(payload.auto.some((item) => item.row === 'Terrain_Name_2' && item.take === 'remote'))
  const conflictsText = capture(['conflicts', '--base', base, '--local', local, '--remote', remote])
  assert.match(conflictsText.stdout, /No conflicts/)
  assert.match(conflictsText.stdout, /Terrain_Name_2/)
  assert.match(conflictsText.stdout, /\/CfgLanguage\/C5/)
  assert.match(conflictsText.stdout, /remote/)

  const out = join(dir, 'merged.xlsx')
  const merged = capture(['merge', '--base', base, '--local', local, '--remote', remote, '--out', out])
  assert.equal(merged.code, EXIT.ok)
  assert.match(merged.stdout, /Wrote/)
  assert.match(merged.stdout, /Terrain_Name_2/)
  assert.match(merged.stdout, /\/CfgLanguage\/C5/)
  assert.equal(existsSync(out), true)
  const after = capture(['diff', '--left', local, '--right', out, '--json'])
  const cells = JSON.parse(after.stdout).results[0].cells
  assert.equal(cells.length, 1)
  assert.equal(cells[0].row, 'Terrain_Name_2')
  assert.equal(cells[0].column, 'ChineseSimplified')
  assert.equal(cells[0].new.text, '远端改')
})

test('both-sides cell conflict refuses merge and leaves no target', () => {
  const dir = tempDir()
  const base = writeWorkbook(dir, 'base.xlsx', languageCells(TERRAIN))
  const localRows = TERRAIN.map((row) => row.id === 'Terrain_Name_2' ? { ...row, zh: '本地' } : row)
  const remoteRows = TERRAIN.map((row) => row.id === 'Terrain_Name_2' ? { ...row, zh: '远端' } : row)
  const local = writeWorkbook(dir, 'local.xlsx', languageCells(localRows))
  const remote = writeWorkbook(dir, 'remote.xlsx', languageCells(remoteRows))
  const out = join(dir, 'merged.xlsx')
  const merged = capture(['merge', '--base', base, '--local', local, '--remote', remote, '--out', out])
  assert.equal(merged.code, EXIT.conflict)
  assert.equal(existsSync(out), false)
  assert.match(merged.stdout, /Conflicts/)
  assert.match(merged.stdout, /Terrain_Name_2/)
  assert.match(merged.stdout, /ChineseSimplified/)
  assert.match(merged.stdout, /\/CfgLanguage\/C5/)
})

test('structural sheet/row/column changes refuse merge', () => {
  const dir = tempDir()
  const base = writeWorkbook(dir, 'base.xlsx', languageCells(TERRAIN))
  const local = writeWorkbook(dir, 'local.xlsx', languageCells(TERRAIN))
  const extra = languageCells(TERRAIN)
  extra.push({ name: 'Extra', cells: [{ ref: 'A1', text: 'x' }] })
  const remote = writeWorkbook(dir, 'remote.xlsx', extra)
  const out = join(dir, 'merged.xlsx')
  const merged = capture(['merge', '--base', base, '--local', local, '--remote', remote, '--out', out])
  assert.equal(merged.code, EXIT.structural)
  assert.equal(existsSync(out), false)
  assert.match(merged.stdout, /sheet/)
})

test('unicode quotes and newlines round-trip through merge', () => {
  const dir = tempDir()
  const fancy = '你好, "基础"\n第二行'
  const sheets = (value) => [{
    name: 'Data',
    extras: '<cols><col min="1" max="2" width="24" customWidth="1"/></cols>',
    cells: [
      { ref: 'A1', text: 'header', style: '3' },
      { ref: 'A2', text: 'key' },
      { ref: 'B2', text: value },
    ],
  }]
  const base = writeWorkbook(dir, 'base.xlsx', sheets(fancy))
  const local = writeWorkbook(dir, 'local.xlsx', sheets(fancy))
  const remote = writeWorkbook(dir, 'remote.xlsx', sheets('你好, "远端"\n第二行'))
  const out = join(dir, 'merged.xlsx')
  const merged = capture(['merge', '--base', base, '--local', local, '--remote', remote, '--out', out])
  assert.equal(merged.code, EXIT.ok)
  const after = loadWorkbookFromPath(out)
  assert.equal(after.sheets[0].cells.get('B2').text, '你好, "远端"\n第二行')
  const xml = readZip(readFileSync(out)).byName.get('xl/worksheets/sheet1.xml').uncompressed.toString('utf8')
  assert.match(xml, /width="24"/)
})

test('filters keep only matching workbook/column', () => {
  const dir = tempDir()
  const left = writeWorkbook(dir, 'lang.xlsx', languageCells(TERRAIN))
  const right = writeWorkbook(dir, 'lang-new.xlsx', languageCells(TERRAIN_FIXED))
  const other = writeWorkbook(dir, 'other.xlsx', [{
    name: 'X',
    cells: [{ ref: 'A1', text: '1' }],
  }])
  const otherNew = writeWorkbook(dir, 'other-new.xlsx', [{
    name: 'X',
    cells: [{ ref: 'A1', text: '2' }],
  }])
  const filtered = capture([
    'diff', '--left', left, '--right', right,
    '--workbook', 'lang-new.xlsx', '--column', 'English', '--json',
  ])
  assert.equal(JSON.parse(filtered.stdout).results[0].cells.length, 0)
  const unfiltered = capture(['diff', '--left', other, '--right', otherNew, '--json'])
  assert.equal(JSON.parse(unfiltered.stdout).results[0].cells.length, 1)
})

test('git commit input matches path input', () => {
  const repo = initRepo()
  const datas = join(repo, 'LubanData', 'Datas')
  const path = join(datas, '#Language-语言表.xlsx')
  writeFileSync(path, buildWorkbook(languageCells(TERRAIN), { shared: true }))
  writeFileSync(join(repo, 'LubanData', 'JsonData', 'ignore.json'), '{}')
  git(repo, ['add', '.'])
  git(repo, ['commit', '-m', 'base'])
  writeFileSync(path, buildWorkbook(languageCells(TERRAIN_FIXED), { shared: true }))
  git(repo, ['add', '.'])
  git(repo, ['commit', '-m', 'terrain names'])
  const commit = git(repo, ['rev-parse', 'HEAD'])

  const fromGit = capture(['diff', '--commit', commit, '--cwd', repo, '--json'])
  assert.equal(fromGit.code, EXIT.ok)
  const gitCells = JSON.parse(fromGit.stdout).results[0].cells
  assert.equal(gitCells.length, 5)

  const tmp = tempDir()
  const left = writeWorkbook(tmp, 'old.xlsx', languageCells(TERRAIN), { shared: true })
  const right = writeWorkbook(tmp, 'new.xlsx', languageCells(TERRAIN_FIXED), { shared: true })
  const fromFiles = capture(['diff', '--left', left, '--right', right, '--json'])
  const fileCells = JSON.parse(fromFiles.stdout).results[0].cells
  assert.deepEqual(
    gitCells.map((c) => `${c.row}:${c.column}:${c.new.text}`).sort(),
    fileCells.map((c) => `${c.row}:${c.column}:${c.new.text}`).sort(),
  )

  const status = capture(['status', '--commit', commit, '--cwd', repo, '--json'])
  const books = JSON.parse(status.stdout).workbooks
  assert.equal(books.length, 1)
  assert.match(books[0].workbook, /Language/)
})

test('formula compared by formula text, empty equals missing', () => {
  const dir = tempDir()
  const left = writeWorkbook(dir, 'f1.xlsx', [{
    name: 'S',
    cells: [
      { ref: 'A1', text: '1+1', kind: 'formula' },
      { ref: 'B1', text: '' },
    ],
  }])
  const right = writeWorkbook(dir, 'f2.xlsx', [{
    name: 'S',
    cells: [{ ref: 'A1', text: '1+1', kind: 'formula' }],
  }])
  const diff = capture(['diff', '--left', left, '--right', right, '--no-luban'])
  assertNoCells(diff.stdout)
})

test('duplicate primary key fails as input error', () => {
  const dir = tempDir()
  const dup = [
    { id: 'same', zh: '一', en: 'a' },
    { id: 'same', zh: '二', en: 'b' },
  ]
  const left = writeWorkbook(dir, 'd1.xlsx', languageCells(dup))
  const right = writeWorkbook(dir, 'd2.xlsx', languageCells(dup))
  const diff = capture(['diff', '--left', left, '--right', right])
  assert.equal(diff.code, EXIT.input)
  assert.match(diff.stderr, /Duplicate primary key/)
})

test('merge resolutions file takes remote value', () => {
  const dir = tempDir()
  const base = writeWorkbook(dir, 'base.xlsx', languageCells(TERRAIN))
  const localRows = TERRAIN.map((row) => row.id === 'Terrain_Name_2' ? { ...row, zh: '本地' } : row)
  const remoteRows = TERRAIN.map((row) => row.id === 'Terrain_Name_2' ? { ...row, zh: '远端' } : row)
  const local = writeWorkbook(dir, 'local.xlsx', languageCells(localRows))
  const remote = writeWorkbook(dir, 'remote.xlsx', languageCells(remoteRows))
  const resolutions = join(dir, 'res.json')
  writeFileSync(resolutions, JSON.stringify([{
    sheet: 'CfgLanguage',
    row: 'Terrain_Name_2',
    column: 'ChineseSimplified',
    take: 'remote',
  }]))
  const out = join(dir, 'merged.xlsx')
  const merged = capture([
    'merge', '--base', base, '--local', local, '--remote', remote,
    '--out', out, '--resolve', resolutions,
  ])
  assert.equal(merged.code, EXIT.ok, merged.stderr || merged.stdout)
  const wb = loadWorkbookFromPath(out)
  const alignedDiff = capture(['diff', '--left', remote, '--right', out, '--json'])
  const cells = JSON.parse(alignedDiff.stdout).results[0].cells
  assert.equal(cells.length, 0)
  const zh = [...wb.sheets[0].cells.entries()]
    .find(([ref, value]) => value.text === '远端')
  assert.ok(zh, 'merged workbook should contain the remote Simplified Chinese value')
})

test('missing file on one side is workbook added', () => {
  const dir = tempDir()
  const right = writeWorkbook(dir, 'new.xlsx', languageCells(TERRAIN))
  const status = capture(['status', '--left', join(dir, 'missing.xlsx'), '--right', right, '--json'])
  assert.equal(status.code, EXIT.ok)
  const listed = JSON.parse(status.stdout).workbooks
  assert.equal(listed.length, 1)
  assert.equal(listed[0].structural, 1)
})

test('hidden sheets are included', () => {
  const dir = tempDir()
  const left = writeWorkbook(dir, 'h1.xlsx', [{
    name: 'Hidden',
    state: 'hidden',
    cells: [{ ref: 'A1', text: 'old' }],
  }])
  const right = writeWorkbook(dir, 'h2.xlsx', [{
    name: 'Hidden',
    state: 'hidden',
    cells: [{ ref: 'A1', text: 'new' }],
  }])
  const diff = capture(['diff', '--left', left, '--right', right, '--no-luban', '--json'])
  assert.equal(JSON.parse(diff.stdout).results[0].cells[0].new.text, 'new')
})
