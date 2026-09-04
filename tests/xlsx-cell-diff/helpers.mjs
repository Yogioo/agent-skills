import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { writeZip } from '../../skills/xlsx-cell-diff/scripts/zip.mjs'
import { run } from '../../skills/xlsx-cell-diff/scripts/cli.mjs'

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships'
const CT = 'http://schemas.openxmlformats.org/package/2006/content-types'

function xml(s) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${s}`
}

function escape(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function parseRef(ref) {
  const match = /^([A-Z]+)(\d+)$/.exec(ref)
  let col = 0
  for (const ch of match[1]) col = col * 26 + (ch.charCodeAt(0) - 64)
  return { row: Number(match[2]), col }
}

function tNode(text) {
  const attrs = /^\s|\s$/.test(text) ? ' xml:space="preserve"' : ''
  return `<t${attrs}>${escape(text)}</t>`
}

export function buildWorkbook(sheets, options = {}) {
  const shared = options.shared ?? options.sharedStrings ?? null
  const sstIndex = new Map()
  const sst = []
  const intern = (text) => {
    if (sstIndex.has(text)) return sstIndex.get(text)
    const i = sst.length
    sst.push(text)
    sstIndex.set(text, i)
    return i
  }

  const sheetParts = sheets.map((sheet, i) => {
    const rows = new Map()
    for (const cell of sheet.cells) {
      const { row, col } = parseRef(cell.ref)
      if (!rows.has(row)) rows.set(row, [])
      rows.get(row).push({ ...cell, col })
    }
    const rowXml = [...rows.keys()].sort((a, b) => a - b).map((row) => {
      const cells = rows.get(row).sort((a, b) => a.col - b.col).map((cell) => {
        const extra = cell.style ? ` s="${cell.style}"` : ''
        if (cell.kind === 'formula') {
          return `<c r="${cell.ref}"${extra}><f>${escape(cell.text.replace(/^=/, ''))}</f><v>0</v></c>`
        }
        if (cell.kind === 'number') {
          return `<c r="${cell.ref}"${extra}><v>${escape(cell.text)}</v></c>`
        }
        if (shared) {
          const idx = intern(cell.text)
          return `<c r="${cell.ref}" t="s"${extra}><v>${idx}</v></c>`
        }
        return `<c r="${cell.ref}" t="inlineStr"${extra}><is>${tNode(cell.text)}</is></c>`
      })
      return `<row r="${row}">${cells.join('')}</row>`
    }).join('')

    const extras = sheet.extras ?? ''
    return {
      name: sheet.name,
      state: sheet.state,
      part: `xl/worksheets/sheet${i + 1}.xml`,
      xml: xml(
        `<worksheet xmlns="${NS}">${extras}<sheetData>${rowXml}</sheetData></worksheet>`,
      ),
    }
  })

  const workbookXml = xml(
    `<workbook xmlns="${NS}" xmlns:r="${REL}"><sheets>${
      sheetParts.map((sheet, i) => {
        const hidden = sheet.state && sheet.state !== 'visible' ? ` state="${sheet.state}"` : ''
        return `<sheet name="${sheet.name}" sheetId="${i + 1}" r:id="rId${i + 1}"${hidden}/>`
      }).join('')
    }</sheets></workbook>`,
  )
  const rels = xml(
    `<Relationships xmlns="${PKG}">${
      sheetParts.map((sheet, i) =>
        `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
      ).join('')
    }</Relationships>`,
  )
  const types = xml(
    `<Types xmlns="${CT}"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${
      sheetParts.map((sheet) =>
        `<Override PartName="/${sheet.part}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
      ).join('')
    }</Types>`,
  )

  const parts = [
    { name: '[Content_Types].xml', uncompressed: Buffer.from(types, 'utf8') },
    { name: 'xl/workbook.xml', uncompressed: Buffer.from(workbookXml, 'utf8') },
    { name: 'xl/_rels/workbook.xml.rels', uncompressed: Buffer.from(rels, 'utf8') },
    ...sheetParts.map((sheet) => ({
      name: sheet.part,
      uncompressed: Buffer.from(sheet.xml, 'utf8'),
    })),
  ]
  if (shared) {
    const sstXml = xml(
      `<sst xmlns="${NS}" count="${sst.length}" uniqueCount="${sst.length}">${
        sst.map((item) => `<si>${tNode(item)}</si>`).join('')
      }</sst>`,
    )
    parts.push({ name: 'xl/sharedStrings.xml', uncompressed: Buffer.from(sstXml, 'utf8') })
  }
  if (options.app) {
    parts.push({
      name: 'docProps/app.xml',
      uncompressed: Buffer.from(options.app, 'utf8'),
    })
  }
  return writeZip(parts)
}

export function writeWorkbook(dir, name, sheets, options) {
  const path = join(dir, name)
  writeFileSync(path, buildWorkbook(sheets, options))
  return path
}

export function tempDir(prefix = 'xlsx-cell-diff-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

export function capture(argv) {
  let stdout = ''
  let stderr = ''
  const code = run(argv, {
    stdout: (text) => { stdout += text },
    stderr: (text) => { stderr += text },
  })
  return { code, stdout, stderr }
}

export function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `git ${args.join(' ')} failed`)
  }
  return result.stdout.trim()
}

export function initRepo() {
  const dir = tempDir('xlsx-cell-diff-git-')
  git(dir, ['init'])
  git(dir, ['config', 'user.email', 'test@example.com'])
  git(dir, ['config', 'user.name', 'xlsx-cell-diff'])
  mkdirSync(join(dir, 'LubanData', 'Datas'), { recursive: true })
  mkdirSync(join(dir, 'LubanData', 'JsonData'), { recursive: true })
  return dir
}

export function languageCells(rows) {
  const header = [
    { ref: 'A1', text: '##var' },
    { ref: 'B1', text: 'id' },
    { ref: 'C1', text: 'ChineseSimplified' },
    { ref: 'D1', text: 'English' },
    { ref: 'A2', text: '##type' },
    { ref: 'B2', text: 'string' },
    { ref: 'C2', text: 'string' },
    { ref: 'D2', text: 'string' },
    { ref: 'A3', text: '##' },
    { ref: 'B3', text: '键' },
    { ref: 'C3', text: '简体' },
    { ref: 'D3', text: '英文' },
  ]
  const data = rows.flatMap((row, i) => {
    const r = i + 4
    return [
      { ref: `B${r}`, text: row.id },
      { ref: `C${r}`, text: row.zh },
      { ref: `D${r}`, text: row.en },
    ]
  })
  return [{ name: 'CfgLanguage', cells: [...header, ...data] }]
}

export const TERRAIN = [
  { id: 'Terrain_Name_1', zh: '旧关卡1', en: 'Test Stage 1' },
  { id: 'Terrain_Name_2', zh: '测试关卡2', en: 'Test Stage 2' },
  { id: 'Terrain_Name_3', zh: '测试关卡3', en: 'Test Stage 3' },
  { id: 'Terrain_Name_4', zh: '测试关卡4', en: 'Test Stage 4' },
  { id: 'Terrain_Name_5', zh: '测试关卡5', en: 'Test Stage 5' },
  { id: 'Terrain_Name_6', zh: '测试关卡6', en: 'Test Stage 6' },
]

export const TERRAIN_FIXED = TERRAIN.map((row) => {
  const names = {
    Terrain_Name_2: '林间小径',
    Terrain_Name_3: '荒原驿站',
    Terrain_Name_4: '潮汐码头',
    Terrain_Name_5: '雪原哨所',
    Terrain_Name_6: '熔岩裂谷',
  }
  return names[row.id] ? { ...row, zh: names[row.id] } : row
})
