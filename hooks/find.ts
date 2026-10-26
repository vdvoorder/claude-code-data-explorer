import type { QueryCell, QueryTable } from '../types'
import { capRows, guessNumeric, parseDelimited, parseJsonLines, parseJsonTable, readBox, readMarkdown, tableFromJson } from './parse'
import type { Block, Json } from './parse'

export type Format = 'box' | 'grid' | 'markdown' | 'psql' | 'dashed' | 'pandas' | 'html' | 'delimited' | 'json'

export type Found = { table: QueryTable; format: Format; line: number | null }

export type TextKind = 'output' | 'document' | 'message'

type Reader = { format: Format; read: (lines: string[], start: number) => Block | null }

const MAX_TABLES = 5
const GRID_RULE = /^\+[-=:+]*[-=][-=:+]*\+$/
const GRID_FOOTER = /^(\d[\d,]*) rows? in set/
const PSQL_RULE = /^-+(\+-+)+$/
const PSQL_FOOTER = /^\((\d[\d,]*) rows?\)$/
const DASH_RULE = /^ *-{2,}( +-{2,})* *$/
const AFFECTED_FOOTER = /^\((\d[\d,]*) rows? affected\)$/
const PANDAS_FOOTER = /^\[(\d[\d,]*) rows x (\d[\d,]*) columns\]$/
const NULL_TEXT = /^(NULL|null|None)$/
const FENCE = /^\s*(`{3,}|~{3,})\s*([\w+-]*)\s*$/
const HEADER_LIMIT = 64
const GROUPED_NUMBER = /^[-+]?\d{1,3}(,\d{3})+(\.\d+)?$/
const PLAIN_NUMBER = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

function cellOrNull(cell: string): QueryCell {
  const trimmed = cell.trim()
  return trimmed === '' || NULL_TEXT.test(trimmed) ? null : trimmed
}

function toCount(text: string | undefined): number | null {
  if (text === undefined) return null
  const n = Number(text.replace(/,/g, ''))
  return Number.isFinite(n) ? n : null
}

function tableOf(columns: string[], rows: QueryCell[][], total = rows.length, note = ''): QueryTable {
  return { columns, numeric: guessNumeric(rows, columns.length), rows, total, isCapped: total > rows.length, note }
}

function splitBars(line: string): string[] {
  const parts = line.trim().split('|')
  return parts.slice(1, parts.length - 1).map(part => part.trim())
}

function joinCells(group: string[][], width: number): string[] {
  return Array.from({ length: width }, (_, c) =>
    group
      .map(cells => cells[c] ?? '')
      .filter(cell => cell !== '')
      .join(' '),
  )
}

function readGrid(lines: string[], start: number): Block | null {
  if (!GRID_RULE.test((lines[start] ?? '').trim())) return null
  const groups: string[][][] = []
  let current: string[][] = []
  let headGroups = -1
  let end = start
  for (let i = start + 1; i < lines.length; i++) {
    const trimmed = (lines[i] ?? '').trim()
    if (GRID_RULE.test(trimmed)) {
      if (current.length > 0) groups.push(current)
      current = []
      if (trimmed.includes('=') && headGroups < 0) headGroups = groups.length
      end = i
      continue
    }
    if (trimmed.length > 1 && trimmed.startsWith('|') && trimmed.endsWith('|')) {
      current.push(splitBars(trimmed))
      continue
    }
    break
  }
  if (current.length > 0 || groups.length < 2) return null
  const width = groups[0]?.[0]?.length ?? 0
  if (width === 0 || groups.some(group => group.some(cells => cells.length !== width))) return null
  const headCount = headGroups > 0 ? headGroups : 1
  const columns = joinCells(groups.slice(0, headCount).flat(), width)
  const body = groups.slice(headCount)
  const records = body.length === 1 ? (body[0] ?? []) : body.map(group => joinCells(group, width))
  const rows = records.map(cells => cells.map(cellOrNull))
  const footer = GRID_FOOTER.exec((lines[end + 1] ?? '').trim())
  return { table: tableOf(columns, rows, Math.max(rows.length, toCount(footer?.[1]) ?? 0)), end }
}

function readPsql(lines: string[], start: number): Block | null {
  const header = lines[start] ?? ''
  const rule = (lines[start + 1] ?? '').trim()
  if (!header.includes('|') || !PSQL_RULE.test(rule)) return null
  const width = rule.split('+').length
  const columns = header.split('|').map(cell => cell.trim())
  if (columns.length !== width || columns.some(name => name === '')) return null
  const rows: QueryCell[][] = []
  let end = start + 1
  let total: number | null = null
  for (let i = start + 2; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const footer = PSQL_FOOTER.exec(line.trim())
    if (footer) {
      total = toCount(footer[1])
      end = i
      break
    }
    const cells = line.split('|')
    if (line.trim() === '' || cells.length !== width) break
    rows.push(cells.map(cellOrNull))
    end = i
  }
  return { table: tableOf(columns, rows, Math.max(rows.length, total ?? 0)), end }
}

type Span = { from: number; to: number }

function dashSpans(rule: string): Span[] {
  return [...rule.matchAll(/-+/g)].map(match => ({ from: match.index ?? 0, to: (match.index ?? 0) + match[0].length }))
}

function columnCuts(spans: Span[], texts: string[]): number[] {
  const cuts: number[] = []
  for (let k = 0; k + 1 < spans.length; k++) {
    const from = spans[k]?.to ?? 0
    const to = spans[k + 1]?.from ?? from
    let best = { at: to, length: 0 }
    let run = -1
    for (let p = from; p <= to; p++) {
      const isBlank = p < to && texts.every(text => (text[p] ?? ' ') === ' ')
      if (isBlank && run < 0) run = p
      if (!isBlank && run >= 0) {
        if (p - run > best.length) best = { at: run, length: p - run }
        run = -1
      }
    }
    cuts.push(best.at)
  }
  return cuts
}

function cutLine(line: string, cuts: number[]): string[] {
  return [0, ...cuts].map((from, k) => line.slice(from, cuts[k]).trim())
}

function readDashed(lines: string[], start: number): Block | null {
  const header = lines[start] ?? ''
  const rule = lines[start + 1] ?? ''
  if (header.trim() === '' || !DASH_RULE.test(rule) || DASH_RULE.test(header)) return null
  const spans = dashSpans(rule)
  if (spans.length < 2) return null
  const body: string[] = []
  let end = start + 1
  let total: number | null = null
  for (let i = start + 2; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const footer = AFFECTED_FOOTER.exec(line.trim())
    if (footer) {
      total = toCount(footer[1])
      end = i
      break
    }
    if (DASH_RULE.test(line)) {
      end = i
      break
    }
    if (line.trim() === '') break
    body.push(line)
    end = i
  }
  if (body.length === 0) return null
  const cuts = columnCuts(spans, [header, ...body])
  const columns = cutLine(header, cuts)
  if (columns.some(name => name === '')) return null
  const rows = body.map(line => cutLine(line, cuts).map(cellOrNull))
  return { table: tableOf(columns, rows, Math.max(rows.length, total ?? 0)), end }
}

function readPandas(lines: string[], start: number): Block | null {
  const header = lines[start] ?? ''
  if (!/^ +\S/.test(header) || header.trimEnd().endsWith('\\')) return null
  const heads = [...header.matchAll(/\S+/g)].map(match => ({ name: match[0], end: (match.index ?? 0) + match[0].length }))
  if (heads.length === 0) return null
  const rows: QueryCell[][] = []
  const indexes: number[] = []
  let hasEllipsis = false
  let end = start
  let footer: RegExpExecArray | null = null
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (line.trim() === '') {
      footer = PANDAS_FOOTER.exec((lines[i + 1] ?? '').trim())
      if (footer) end = i + 1
      break
    }
    footer = PANDAS_FOOTER.exec(line.trim())
    if (footer) {
      end = i
      break
    }
    const first = /^(\S+)/.exec(line)
    if (!first) return null
    const index = first[1] ?? ''
    end = i
    if (/^\.{2,3}$/.test(index)) {
      hasEllipsis = true
      continue
    }
    if (!/^\d+$/.test(index)) return null
    const cells: string[] = []
    let from = index.length
    for (let j = 0; j < heads.length; j++) {
      const to = j === heads.length - 1 ? Math.max(line.length, heads[j]?.end ?? 0) : heads[j]?.end ?? 0
      if (j < heads.length - 1 && /\S/.test(line[to] ?? ' ') && /\S/.test(line[to - 1] ?? ' ')) return null
      cells.push(line.slice(from, to))
      from = to
    }
    indexes.push(Number(index))
    rows.push(cells.map(cellOrNull))
  }
  if (rows.length === 0 || indexes.some((n, k) => k > 0 && n <= (indexes[k - 1] ?? -1))) return null
  if (!footer && indexes[0] !== 0) return null
  const keep = heads.map(head => !/^\.{3}$/.test(head.name))
  const columns = heads.filter((_, c) => keep[c]).map(head => head.name)
  const kept = rows.map(row => row.filter((_, c) => keep[c]))
  const total = Math.max(kept.length, toCount(footer?.[1]) ?? 0)
  const allColumns = toCount(footer?.[2])
  const note = allColumns !== null && allColumns > columns.length ? `The output shows ${columns.length} of ${allColumns} columns` : ''
  const table = tableOf(columns, kept, total, note)
  return { table: { ...table, isCapped: table.isCapped || hasEllipsis }, end }
}

const READERS: Reader[] = [
  { format: 'box', read: readBox },
  { format: 'grid', read: readGrid },
  { format: 'markdown', read: readMarkdown },
  { format: 'psql', read: readPsql },
  { format: 'dashed', read: readDashed },
  { format: 'pandas', read: readPandas },
]

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name.startsWith('#x') || name.startsWith('#X')) return String.fromCodePoint(parseInt(name.slice(2), 16))
    if (name.startsWith('#')) return String.fromCodePoint(Number(name.slice(1)))
    return ENTITIES[name.toLowerCase()] ?? whole
  })
}

function htmlText(fragment: string): string {
  return decodeEntities(fragment.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()
}

export function parseHtmlTables(text: string): QueryTable[] {
  const tables: QueryTable[] = []
  for (const html of text.match(/<table[\s>][\s\S]*?<\/table>/gi) ?? []) {
    const rows = html
      .split(/(?=<tr[\s>])/i)
      .slice(1)
      .map(row => row.split(/(?=<t[hd][\s>])/i).slice(1).map(htmlText))
      .filter(cells => cells.length > 0)
    const [head, ...body] = rows
    if (!head || body.length === 0) continue
    const width = head.length
    const cells = body.map(row => Array.from({ length: width }, (_, c) => cellOrNull(row[c] ?? '')))
    tables.push(tableOf(head.map((name, c) => name || `column ${c + 1}`), cells))
  }
  return tables
}

function lineWidth(line: string, delimiter: string): number {
  let width = 1
  let isQuoted = false
  for (const char of line) {
    if (char === '"') isQuoted = !isQuoted
    else if (char === delimiter && !isQuoted) width += 1
  }
  return isQuoted ? 0 : width
}

function splitLine(line: string, delimiter: string): string[] {
  const cells: string[] = []
  let cell = ''
  let isQuoted = false
  for (const char of line) {
    if (char === '"') isQuoted = !isQuoted
    else if (char === delimiter && !isQuoted) {
      cells.push(cell.trim())
      cell = ''
    } else cell += char
  }
  cells.push(cell.trim())
  return cells
}

function shapeOf(cell: string): string {
  return cell
    .replace(/[0-9]+/g, '9')
    .replace(/[A-Z]+/g, 'A')
    .replace(/[a-z]+/g, 'a')
    .replace(/[^9Aa\s]+/g, '.')
    .replace(/\s+/g, ' ')
}

function isDataShaped(header: string, first: string, delimiter: string): boolean {
  const heads = splitLine(header, delimiter).map(shapeOf)
  const cells = splitLine(first, delimiter).map(shapeOf)
  const isMixedTwin = heads.some((shape, c) => /9/.test(shape) && /[^9]/.test(shape) && shape === cells[c])
  return isMixedTwin || (heads.some(shape => /[9.]/.test(shape)) && heads.every((shape, c) => shape === cells[c]))
}

function looksLikeHeader(columns: string[]): boolean {
  return (
    columns.every(name => name !== '' && name.length <= HEADER_LIMIT && !/^([-*+] |\d+\. )/.test(name) && !/[.!?:]$/.test(name)) &&
    new Set(columns).size === columns.length
  )
}

function isRunTable(table: QueryTable, delimiter: string): boolean {
  if (!looksLikeHeader(table.columns)) return false
  if (delimiter === '\t') return table.rows.length >= 1
  if (delimiter === '|') return table.rows.length >= 2
  return table.rows.length >= 2 && (table.numeric.some(Boolean) || table.rows.length >= 5)
}

function findRuns(lines: string[], used: boolean[]): Found[] {
  const candidates: { delimiter: string; from: number; to: number; size: number }[] = []
  for (const delimiter of ['\t', ';', ',', '|']) {
    let i = 0
    while (i < lines.length) {
      const width = used[i] ? 0 : lineWidth(lines[i] ?? '', delimiter)
      if (width < 2) {
        i += 1
        continue
      }
      let j = i
      while (j + 1 < lines.length && !used[j + 1] && lineWidth(lines[j + 1] ?? '', delimiter) === width) j += 1
      if (j > i) candidates.push({ delimiter, from: i, to: j, size: width * (j - i) })
      i = j + 1
    }
  }
  candidates.sort((a, b) => b.size - a.size)
  const found: Found[] = []
  const taken = [...used]
  for (const candidate of candidates) {
    if (taken.slice(candidate.from, candidate.to + 1).some(Boolean)) continue
    if (isDataShaped(lines[candidate.from] ?? '', lines[candidate.from + 1] ?? '', candidate.delimiter)) continue
    const table = parseDelimited(lines.slice(candidate.from, candidate.to + 1).join('\n'), { delimiter: candidate.delimiter })
    if (!table || !isRunTable(table, candidate.delimiter)) continue
    for (let k = candidate.from; k <= candidate.to; k++) taken[k] = true
    found.push({ table, format: 'delimited', line: candidate.from })
  }
  return found
}

function findFencedJson(lines: string[], used: boolean[]): Found[] {
  const found: Found[] = []
  for (let i = 0; i < lines.length; i++) {
    const open = FENCE.exec(lines[i] ?? '')
    if (!open || used[i]) continue
    let close = -1
    for (let j = i + 1; j < lines.length; j++) {
      if ((lines[j] ?? '').trim().startsWith(open[1] ?? '```')) {
        close = j
        break
      }
    }
    if (close < 0) break
    const body = lines.slice(i + 1, close).join('\n').trim()
    if (/^[[{]/.test(body)) {
      const table = parseJsonTable(body) ?? parseJsonLines(body)
      if (table) {
        found.push({ table, format: 'json', line: i })
        for (let k = i; k <= close; k++) used[k] = true
      }
    }
    i = close
  }
  return found
}

function wholeJson(text: string): QueryTable | null {
  const trimmed = text.trim()
  if (!/^[[{]/.test(trimmed)) return null
  try {
    return tableFromJson(JSON.parse(trimmed) as Json)
  } catch {
    return parseJsonLines(trimmed)
  }
}

function withPlainNumbers(table: QueryTable): QueryTable {
  const grouped = table.columns.map((_, c) => {
    let hasGrouped = false
    for (const row of table.rows) {
      const cell = row[c]
      if (cell === null || cell === undefined || cell === '') continue
      if (GROUPED_NUMBER.test(cell)) hasGrouped = true
      else if (!PLAIN_NUMBER.test(cell)) return false
    }
    return hasGrouped
  })
  if (!grouped.some(Boolean)) return table
  const rows = table.rows.map(row => row.map((cell, c) => (grouped[c] && cell ? cell.replace(/,/g, '') : cell)))
  return { ...table, rows, numeric: table.numeric.map((isNumeric, c) => isNumeric || grouped[c] === true) }
}

function largest(found: Found[]): Found[] {
  if (found.length <= MAX_TABLES) return found
  const size = (f: Found) => f.table.rows.length * f.table.columns.length
  const kept = new Set([...found].sort((a, b) => size(b) - size(a)).slice(0, MAX_TABLES))
  return found.filter(f => kept.has(f))
}

export function findTables(text: string, kind: TextKind): Found[] {
  if (kind === 'output') {
    const json = wholeJson(text)
    if (json) return [{ table: capRows(json), format: 'json', line: null }]
  }
  const lines = text.split(/\r?\n/)
  const used = lines.map(() => false)
  const found: Found[] = []
  for (let i = 0; i < lines.length; i++) {
    for (const reader of READERS) {
      const block = reader.read(lines, i)
      if (!block) continue
      found.push({ table: block.table, format: reader.format, line: i })
      for (let k = i; k <= block.end; k++) used[k] = true
      i = block.end
      break
    }
  }
  found.push(...findFencedJson(lines, used))
  if (kind !== 'document') found.push(...findRuns(lines, used))
  if (kind !== 'message' && /<table[\s>]/i.test(text)) found.push(...parseHtmlTables(text).map(table => ({ table, format: 'html' as const, line: null })))
  if (found.length === 0 && kind === 'output') {
    const embedded = parseJsonTable(text)
    if (embedded) found.push({ table: embedded, format: 'json', line: null })
  }
  return largest(found.sort((a, b) => (a.line ?? Infinity) - (b.line ?? Infinity))).map(f => ({
    ...f,
    table: capRows(f.format === 'delimited' || f.format === 'json' ? f.table : withPlainNumbers(f.table)),
  }))
}

export function captionOf(text: string, line: number | null): string {
  if (line === null) return ''
  const lines = text.split(/\r?\n/)
  for (let i = line - 1; i >= Math.max(0, line - 3); i--) {
    const candidate = (lines[i] ?? '').trim()
    if (FENCE.test(candidate)) continue
    if (candidate !== '') return candidate.replace(/^#+\s*/, '').replace(/^\*\*(.*)\*\*:?$/, '$1')
  }
  return ''
}
