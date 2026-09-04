import { formatA1, columnLetters } from './refs.mjs'
import { displayText } from './xlsx-read.mjs'

function cellAt(sheet, row, column) {
  return sheet.cells.get(formatA1(row, column))
}

function textAt(sheet, row, column) {
  return displayText(cellAt(sheet, row, column))
}

function isHeaderTag(text) {
  return text.trim().startsWith('##')
}

function uniqueName(name, column, used) {
  let candidate = name || columnLetters(column)
  if (!used.has(candidate)) {
    used.add(candidate)
    return candidate
  }
  const tagged = `${candidate}#${columnLetters(column)}`
  used.add(tagged)
  return tagged
}

function lubanMeta(sheet) {
  const maxProbe = Math.max(sheet.maxRow, 5)
  let headerEnd = 0
  let varRow = 0
  for (let row = 1; row <= Math.min(8, maxProbe); row++) {
    const a = textAt(sheet, row, 1).trim()
    if (!isHeaderTag(a)) break
    headerEnd = row
    if (a.toLowerCase() === '##var' && varRow === 0) varRow = row
  }
  if (!varRow || !headerEnd) return null

  const used = new Set()
  const columns = []
  const byName = new Map()
  const maxCol = Math.max(sheet.maxColumn, 1)
  for (let column = 1; column <= maxCol; column++) {
    const raw = textAt(sheet, varRow, column).trim()
    const skipTag = column === 1 && raw.toLowerCase().startsWith('##')
    const name = uniqueName(skipTag ? '' : raw, column, used)
    const info = { column, name, letter: columnLetters(column) }
    columns.push(info)
    byName.set(name, info)
  }

  const idCol = byName.get('id') ?? [...byName.values()].find((col) => col.name.toLowerCase() === 'id')
  return {
    kind: 'luban',
    headerEnd,
    varRow,
    columns,
    byName,
    keyColumn: idCol ?? null,
  }
}

function genericMeta(sheet) {
  const columns = []
  const byName = new Map()
  const maxCol = Math.max(sheet.maxColumn, 1)
  for (let column = 1; column <= maxCol; column++) {
    const name = columnLetters(column)
    const info = { column, name, letter: name }
    columns.push(info)
    byName.set(name, info)
  }
  return {
    kind: 'generic',
    headerEnd: 0,
    varRow: 0,
    columns,
    byName,
    keyColumn: null,
  }
}

export function sheetProfile(sheet, profileMode) {
  if (profileMode === 'none') return genericMeta(sheet)
  const luban = lubanMeta(sheet)
  if (profileMode === 'luban') return luban ?? genericMeta(sheet)
  return luban ?? genericMeta(sheet)
}

function rowKey(sheet, row, meta) {
  if (row <= meta.headerEnd || !meta.keyColumn) return `R${row}`
  const key = textAt(sheet, row, meta.keyColumn.column)
  return key === '' ? `R${row}` : key
}

export function alignedSheet(sheet, profileMode) {
  const meta = sheetProfile(sheet, profileMode)
  const rows = []
  const byKey = new Map()
  const maxRow = Math.max(sheet.maxRow, meta.headerEnd)
  for (let row = 1; row <= maxRow; row++) {
    const identity = row <= meta.headerEnd ? `R${row}` : rowKey(sheet, row, meta)
    const keyed = row > meta.headerEnd && meta.keyColumn && !identity.startsWith('R')
    const record = {
      row,
      identity,
      keyed,
      cells: new Map(),
    }
    for (const col of meta.columns) {
      const value = cellAt(sheet, row, col.column)
      if (!value || displayText(value) === '') continue
      record.cells.set(col.name, value)
    }
    if (keyed) {
      if (byKey.has(identity)) {
        const prev = byKey.get(identity)
        throw new Error(
          `Duplicate primary key '${identity}' on sheet '${sheet.name}' (rows ${prev.row} and ${row})`,
        )
      }
      byKey.set(identity, record)
    }
    rows.push(record)
  }
  return { sheet, meta, rows, byKey }
}
