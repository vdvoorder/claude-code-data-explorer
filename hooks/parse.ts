import type { QueryCell, QueryTable } from '../types'

export const STORE_CAP = 100000
export const TABLE_FILE = /\.(csv|tsv|json|jsonl|ndjson)$/i

const NUMBER = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/
const NUMERIC_TYPE = /^(u?(tiny|small|big|huge)?int(eger)?\d*|float\d*|double|real|decimal.*|numeric.*|[iuf]\d+)$/i
const TYPE_NAME =
  /^(u?(tiny|small|big|huge)?int(eger)?\d*|float\d*|double|real|decimal.*|numeric.*|[iuf]\d+|(var)?char.*|text|string|str|bool(ean)?|date.*|time.*|interval|blob|uuid|json|struct.*|map.*|list.*|enum.*|bit|null|duration.*|cat(egorical)?|object|.*\[\])$/i
const ROW_FOOTER = /(>)?(\d[\d,]*) rows?(?: \((\d[\d,]*) shown\)|, (\d[\d,]*) shown)?/
const DELIMITERS = ['\t', ';', ',', '|']
const SAMPLE_LENGTH = 65536
const COLUMN_FOOTER = /(\d[\d,]*) columns? \((\d[\d,]*) shown\)/
const SHAPE_LINE = /^shape: \((\d[\d_]*), (\d[\d_]*)\)/
const BOX_TOP = /^[┌┏╔╭]/
const BOX_SEPARATOR = /^[├┝┞┟┠┡┢┣╞╟╠]/
const BOX_BOTTOM = /^[└┕┖┗╘╙╚╰]/
const BOX_ROW = /^[│┃║]/
const BOX_BAR = /[│┃║┆┊╎╏]/
const ELIDED = /^(·|…|\.\.\.?)$/
const NULL_TEXT = /^(NULL|null)$/

function toCount(text: string | undefined): number | null {
  if (text === undefined) return null
  const n = Number(text.replace(/[,_]/g, ''))
  return Number.isFinite(n) ? n : null
}

export function guessNumeric(rows: QueryCell[][], width: number): boolean[] {
  const numeric: boolean[] = []
  for (let c = 0; c < width; c++) {
    let seen = 0
    let isNumeric = true
    for (const row of rows) {
      const cell = row[c]
      if (cell === null || cell === undefined || cell === '') continue
      seen += 1
      if (!NUMBER.test(cell)) {
        isNumeric = false
        break
      }
    }
    numeric.push(isNumeric && seen > 0)
  }
  return numeric
}

export function capRows(table: QueryTable): QueryTable {
  if (table.rows.length <= STORE_CAP) return table
  return {
    ...table,
    rows: table.rows.slice(0, STORE_CAP),
    isCapped: true,
    total: Math.max(table.total, table.rows.length),
  }
}

export type Block = { table: QueryTable; end: number }

function boxCells(line: string): string[] {
  const parts = line.trim().split(BOX_BAR)
  return parts.slice(1, parts.length - 1).map(part => part.trim())
}

function joinHead(head: string[][]): string[] {
  const width = Math.max(...head.map(cells => cells.length))
  return Array.from({ length: width }, (_, c) =>
    head
      .map(cells => cells[c] ?? '')
      .filter(cell => cell !== '')
      .join(' '),
  )
}

function isTypeRow(cells: string[] | undefined): boolean {
  return !!cells && cells.some(cell => cell !== '' && cell !== '…') && cells.every(cell => cell === '' || cell === '…' || TYPE_NAME.test(cell))
}

function boxHead(head: string[][], hasBody: boolean): { names: string[]; types: string[] | null; extra: string[][] } {
  if (!hasBody) return { names: head[0] ?? [], types: null, extra: head.slice(1) }
  const dashes = head.findIndex(cells => cells.length > 0 && cells.every(cell => /^-+$/.test(cell)))
  if (dashes > 0) return { names: joinHead(head.slice(0, dashes)), types: head[dashes + 1] ?? null, extra: [] }
  if (head.length === 2 && isTypeRow(head[1])) return { names: head[0] ?? [], types: head[1] ?? null, extra: [] }
  return { names: joinHead(head), types: null, extra: [] }
}

function footerCounts(lines: string[], from: number, rows: number): { total: number; isTotalMinimum: boolean; isCapped: boolean; notes: string[] } {
  let total = rows
  let isTotalMinimum = false
  let isCapped = false
  const notes: string[] = []
  for (const footer of lines.slice(from, from + 2)) {
    const rowMatch = ROW_FOOTER.exec(footer)
    if (rowMatch) {
      const all = toCount(rowMatch[2])
      const shown = toCount(rowMatch[3] ?? rowMatch[4])
      if (all !== null) total = Math.max(total, all)
      if (rowMatch[1] === '>') isTotalMinimum = true
      if (shown !== null && all !== null && shown < all) isCapped = true
    }
    const columnMatch = COLUMN_FOOTER.exec(footer)
    if (columnMatch) {
      const all = toCount(columnMatch[1])
      const shown = toCount(columnMatch[2])
      if (all !== null && shown !== null && shown < all) notes.push(`The output shows ${shown} of ${all} columns`)
    }
  }
  return { total, isTotalMinimum, isCapped, notes }
}

export function readBox(lines: string[], start: number): Block | null {
  if (!BOX_TOP.test((lines[start] ?? '').trimStart())) return null
  const head: string[][] = []
  const body: string[][] = []
  let hasBody = false
  let end = -1
  for (let i = start + 1; i < lines.length; i++) {
    const trimmed = (lines[i] ?? '').trimStart()
    if (BOX_BOTTOM.test(trimmed)) {
      end = i
      break
    }
    if (BOX_SEPARATOR.test(trimmed)) {
      if (head.length > 0) hasBody = true
      continue
    }
    if (!BOX_ROW.test(trimmed)) return null
    if (hasBody) body.push(boxCells(trimmed))
    else head.push(boxCells(trimmed))
  }
  if (end < 0 || head.length === 0) return null
  const { names, types, extra } = boxHead(head, hasBody)
  if (names.length === 0) return null
  const rows: QueryCell[][] = []
  let hasEllipsis = false
  for (const cells of [...extra, ...body]) {
    if (cells.length !== names.length) continue
    if (cells.every(cell => ELIDED.test(cell) || cell === '')) {
      hasEllipsis = true
      continue
    }
    rows.push(cells.map(cell => (NULL_TEXT.test(cell) ? null : cell)))
  }
  const keep = names.map((name, c) => name !== '…' && (types?.[c] ?? '') !== '…')
  const columns = names.filter((_, c) => keep[c])
  const keptRows = rows.map(row => row.filter((_, c) => keep[c]))
  const keptTypes = types?.filter((_, c) => keep[c]) ?? null
  const numeric = keptTypes ? keptTypes.map(type => NUMERIC_TYPE.test(type)) : guessNumeric(keptRows, columns.length)
  const counts = footerCounts(lines, end + 1, keptRows.length)
  const shape = SHAPE_LINE.exec((lines[start - 1] ?? '').trim())
  const shapeRows = toCount(shape?.[1])
  const shapeColumns = toCount(shape?.[2])
  const total = Math.max(counts.total, shapeRows ?? 0)
  if (shapeColumns !== null && shapeColumns > columns.length) counts.notes.push(`The output shows ${columns.length} of ${shapeColumns} columns`)
  return {
    table: {
      columns,
      numeric,
      rows: keptRows,
      total,
      isTotalMinimum: counts.isTotalMinimum,
      isCapped: hasEllipsis || counts.isCapped || total > keptRows.length,
      note: counts.notes.join('; '),
    },
    end,
  }
}

export function parseDuckbox(text: string): QueryTable | null {
  const lines = text.split(/\r?\n/)
  let found: QueryTable | null = null
  for (let i = 0; i < lines.length; i++) {
    const read = readBox(lines, i)
    if (read) {
      found = read.table
      i = read.end
    }
  }
  return found ? capRows(found) : null
}

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

type RawTable = { columns: string[]; rows: Json[][] }

function isPrimitive(value: Json | undefined): boolean {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value)
}

function isRecord(value: Json | undefined): value is { [key: string]: Json } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function columnName(value: Json | undefined): string | null {
  if (typeof value === 'string') return value
  if (isRecord(value)) {
    for (const key of ['name', 'Name', 'columnName', 'ColumnName']) {
      const name = value[key]
      if (typeof name === 'string') return name
    }
  }
  return null
}

function isRow(item: Json, isStrict: boolean): boolean {
  if (!isRecord(item)) return false
  const values = Object.values(item)
  return isStrict ? values.every(isPrimitive) : values.some(isPrimitive)
}

function collectTables(value: Json, found: RawTable[], flags: { isTruncated: boolean }, isStrict: boolean): void {
  if (Array.isArray(value)) {
    if (value.length > 0 && value.every(item => isRow(item, isStrict))) {
      const columns: string[] = []
      for (const item of value) {
        if (!isRecord(item)) continue
        for (const key of Object.keys(item)) if (!columns.includes(key)) columns.push(key)
      }
      const rows = value.map(item => columns.map(key => (isRecord(item) ? item[key] ?? null : null)))
      found.push({ columns, rows })
      return
    }
    for (const item of value) collectTables(item, found, flags, isStrict)
    return
  }
  if (!isRecord(value)) return
  for (const [key, inner] of Object.entries(value)) {
    if (/truncat|hasMore|moreRows/i.test(key) && inner === true) flags.isTruncated = true
  }
  const columns = value.columns ?? value.Columns
  const rows = value.rows ?? value.Rows ?? value.data ?? value.Data
  if (Array.isArray(columns) && Array.isArray(rows) && rows.every(row => Array.isArray(row))) {
    const names = columns.map(columnName)
    if (names.every(name => name !== null)) {
      found.push({ columns: names as string[], rows: rows as Json[][] })
      return
    }
  }
  for (const inner of Object.values(value)) collectTables(inner, found, flags, isStrict)
}

function parseJsonValue(text: string): Json | undefined {
  const trimmed = text.trim()
  const attempts = [trimmed]
  const open = trimmed.search(/[[{]/)
  const close = Math.max(trimmed.lastIndexOf('}'), trimmed.lastIndexOf(']'))
  if (open > 0 && close > open) attempts.push(trimmed.slice(open, close + 1))
  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt) as Json
    } catch {
      continue
    }
  }
  return undefined
}

function cellOf(value: Json | undefined): QueryCell {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

export function parseJsonTable(text: string): QueryTable | null {
  const value = parseJsonValue(text)
  return value === undefined ? null : tableFromJson(value)
}

export function parseJsonLines(text: string): QueryTable | null {
  const values: Json[] = []
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue
    try {
      values.push(JSON.parse(line) as Json)
    } catch {
      return null
    }
  }
  return values.length === 0 ? null : tableFromJson(values)
}

export function tableFromJson(value: Json): QueryTable | null {
  const found: RawTable[] = []
  const flags = { isTruncated: false }
  collectTables(value, found, flags, true)
  if (found.length === 0) collectTables(value, found, flags, false)
  const first = found[0]
  if (!first || first.columns.length === 0) return null
  const numeric = first.columns.map((_, c) => {
    const present = first.rows.map(row => row[c]).filter(cell => cell !== null && cell !== undefined)
    return present.length > 0 && present.every(cell => typeof cell === 'number')
  })
  const rows = first.rows.map(row => first.columns.map((_, c) => cellOf(row[c])))
  const note = found.length > 1 ? `Showing result 1 of ${found.length}` : ''
  return { columns: first.columns, numeric, rows, total: rows.length, isCapped: flags.isTruncated, note }
}

function pipeCells(line: string): string[] {
  let body = line.trim()
  if (body.startsWith('|')) body = body.slice(1)
  if (body.endsWith('|') && !body.endsWith('\\|')) body = body.slice(0, -1)
  const cells: string[] = []
  let cell = ''
  for (let i = 0; i < body.length; i++) {
    const char = body[i]
    if (char === '\\' && body[i + 1] === '|') {
      cell += '|'
      i += 1
    } else if (char === '|') {
      cells.push(cell.trim())
      cell = ''
    } else {
      cell += char
    }
  }
  cells.push(cell.trim())
  return cells
}

function markdownCell(cell: string): QueryCell {
  const plain = cell.replace(/^(\*\*|__)(.*)\1$/, '$2').replace(/^`(.*)`$/, '$1').trim()
  return plain === '' ? null : plain
}

const PIPE_SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/

export function readMarkdown(lines: string[], start: number): Block | null {
  const headerLine = lines[start] ?? ''
  if (!headerLine.includes('|') || !PIPE_SEPARATOR.test(lines[start + 1] ?? '') || PIPE_SEPARATOR.test(headerLine)) return null
  const columns = pipeCells(headerLine).map(cell => markdownCell(cell) ?? '')
  const rows: QueryCell[][] = []
  let end = start + 1
  for (let j = start + 2; j < lines.length; j++) {
    const line = lines[j] ?? ''
    if (!line.includes('|')) break
    const cells = pipeCells(line)
    if (cells.length !== columns.length) break
    rows.push(cells.map(markdownCell))
    end = j
  }
  if (rows.length === 0) return null
  return { table: { columns, numeric: guessNumeric(rows, columns.length), rows, total: rows.length, isCapped: false, note: '' }, end }
}

export function parseMarkdownTable(text: string): QueryTable | null {
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const read = readMarkdown(lines, i)
    if (read) return read.table
  }
  return null
}

export function delimitedRecords(text: string, delimiter: string): string[][] {
  const records: string[][] = []
  let record: string[] = []
  let cell = ''
  let isQuoted = false
  const endRecord = () => {
    record.push(cell.trim())
    if (record.length > 1 || record[0] !== '') records.push(record)
    record = []
    cell = ''
  }
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (isQuoted) {
      if (char === '"' && text[i + 1] === '"') {
        cell += '"'
        i += 1
      } else if (char === '"') {
        isQuoted = false
      } else {
        cell += char
      }
    } else if (char === '"' && cell.trim() === '') {
      isQuoted = true
      cell = ''
    } else if (char === delimiter) {
      record.push(cell.trim())
      cell = ''
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i += 1
      endRecord()
    } else {
      cell += char
    }
  }
  if (cell !== '' || record.length > 0) endRecord()
  return records
}

function detectDelimiter(text: string): string | null {
  const cut = text.length > SAMPLE_LENGTH ? text.lastIndexOf('\n', SAMPLE_LENGTH) : text.length
  const sample = text.slice(0, cut > 0 ? cut : text.length)
  let best: { delimiter: string; width: number } | null = null
  for (const delimiter of DELIMITERS) {
    const records = delimitedRecords(sample, delimiter)
    const width = records[0]?.length ?? 0
    if (width < 2 || !records.every(record => record.length === width)) continue
    if (!best || width > best.width) best = { delimiter, width }
  }
  return best?.delimiter ?? null
}

export function parseDelimited(text: string, options: { delimiter?: string; isFile?: boolean } = {}): QueryTable | null {
  const isFile = options.isFile === true
  const delimiter = options.delimiter ?? detectDelimiter(text) ?? (isFile ? ',' : null)
  if (delimiter === null) return null
  const [columns, ...records] = delimitedRecords(text, delimiter)
  if (!columns || columns.length < (isFile ? 1 : 2)) return null
  if (records.length === 0 && !isFile) return null
  if (!records.every(cells => cells.length === columns.length)) return null
  const rows = records.map(cells => cells.map(cell => (cell === '' ? null : cell)))
  return { columns, numeric: guessNumeric(rows, columns.length), rows, total: rows.length, isCapped: false, note: '' }
}

export function parseFile(path: string, text: string): QueryTable | null {
  const body = text.replace(/^﻿/, '')
  const extension = /\.([a-z]+)$/i.exec(path)?.[1]?.toLowerCase()
  const table =
    extension === 'tsv'
      ? parseDelimited(body, { delimiter: '\t', isFile: true })
      : extension === 'csv'
        ? parseDelimited(body, { isFile: true })
        : extension === 'json'
          ? parseJsonTable(body) ?? parseJsonLines(body)
          : extension === 'jsonl' || extension === 'ndjson'
            ? parseJsonLines(body)
            : null
  return table ? capRows(table) : null
}

export function parsePowerBi(text: string, maxRows: number): QueryTable | null {
  const table = parseJsonTable(text) ?? parseMarkdownTable(text) ?? parseDuckbox(text) ?? parseDelimited(text)
  if (!table) return null
  if (table.rows.length >= maxRows && !table.isCapped) {
    const reached = `The result reached maxRows (${maxRows}), so more rows may exist`
    return capRows({ ...table, isCapped: true, note: table.note ? `${table.note}; ${reached}` : reached })
  }
  return capRows(table)
}
