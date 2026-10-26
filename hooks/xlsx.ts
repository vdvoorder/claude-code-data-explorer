import type { QueryCell, QueryTable } from '../types'
import { STORE_CAP } from './parse'

type ZipEntry = { method: number; size: number; compressedSize: number; offset: number }

type Zip = { bytes: Uint8Array; entries: Map<string, ZipEntry> }

type BitStream = { data: Uint8Array; pos: number; buffer: number; count: number }

type Output = { bytes: Uint8Array; length: number }

type Huffman = { table: Uint16Array; bits: number }

type NumberKind = 'number' | 'date' | 'duration'

type Relationship = { type: string; target: string }

type Sheet = { name: string; path: string }

type Book = {
  sheets: Sheet[]
  strings: string[]
  styles: NumberKind[]
  is1904: boolean
}

type Cell = { text: string; isNumber: boolean } | null

const END_OF_DIRECTORY = 0x06054b50
const DIRECTORY_ENTRY = 0x02014b50
const LOCAL_HEADER = 0x04034b50

const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258]
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]
const DISTANCE_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193,
  12289, 16385, 24577,
]
const DISTANCE_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13]
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]

const NUMBER = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/
const ATTRIBUTE = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
const ENTITY = /&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g
const ESCAPED_CHAR = /_x([0-9a-fA-F]{4})_/g
const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
const RELATIONSHIP = /<(?:\w+:)?Relationship\b([^>]*)>/g
const SHEET = /<(?:\w+:)?sheet\b([^>]*)>/g
const WORKBOOK_PROPERTIES = /<(?:\w+:)?workbookPr\b([^>]*)>/
const SHARED_ITEM = /<(?:\w+:)?si\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?si>)/g
const PHONETIC = /<(?:\w+:)?rPh\b[\s\S]*?<\/(?:\w+:)?rPh>/g
const TEXT = /<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g
const NUMBER_FORMAT = /<(?:\w+:)?numFmt\b([^>]*)>/g
const CELL_FORMATS = /<(?:\w+:)?cellXfs\b[^>]*>([\s\S]*?)<\/(?:\w+:)?cellXfs>/
const CELL_FORMAT = /<(?:\w+:)?xf\b([^>]*)>/g
const ROW = /<(?:\w+:)?row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?row>)/g
const CELL = /<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g
const VALUE = /<(?:\w+:)?v(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?v>/
const INLINE = /<(?:\w+:)?is\b[^>]*>([\s\S]*?)<\/(?:\w+:)?is>/
const CELL_REF = /^\$?([A-Za-z]{1,3})\$?\d*$/
const FORMAT_LITERAL = /"[^"]*"|\\.|[_*].|\[[^\]]*\]/g
const ELAPSED = /^\[(h+|m+|s+)\]$/i
const DATE_TOKEN = /[ymdhs]/i
const DATE_FORMAT_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 47])
const DURATION_FORMAT_ID = 46
const DAY_MS = 86400000
const EPOCH_1900 = Date.UTC(1899, 11, 30)
const EPOCH_1904 = Date.UTC(1904, 0, 1)

function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64.replace(/\s+/g, ''))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function uint16(bytes: Uint8Array, at: number): number {
  return (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8)
}

function uint32(bytes: Uint8Array, at: number): number {
  return (uint16(bytes, at) | (uint16(bytes, at + 2) << 16)) >>> 0
}

function findEndOfDirectory(bytes: Uint8Array): number {
  const last = Math.max(0, bytes.length - 22 - 65535)
  for (let at = bytes.length - 22; at >= last; at--) {
    if (uint32(bytes, at) === END_OF_DIRECTORY) return at
  }
  return -1
}

function readZip(bytes: Uint8Array): Zip | null {
  const end = findEndOfDirectory(bytes)
  if (end < 0) return null
  const count = uint16(bytes, end + 10)
  let at = uint32(bytes, end + 16)
  const decoder = new TextDecoder()
  const entries = new Map<string, ZipEntry>()
  for (let i = 0; i < count; i++) {
    if (uint32(bytes, at) !== DIRECTORY_ENTRY) break
    const nameLength = uint16(bytes, at + 28)
    const extraLength = uint16(bytes, at + 30)
    const commentLength = uint16(bytes, at + 32)
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength))
    entries.set(name.replace(/\\/g, '/').toLowerCase(), {
      method: uint16(bytes, at + 10),
      compressedSize: uint32(bytes, at + 20),
      size: uint32(bytes, at + 24),
      offset: uint32(bytes, at + 42),
    })
    at += 46 + nameLength + extraLength + commentLength
  }
  return entries.size > 0 ? { bytes, entries } : null
}

function readEntry(zip: Zip, name: string): Uint8Array | null {
  const entry = zip.entries.get(name.toLowerCase())
  if (!entry) return null
  const { bytes } = zip
  if (uint32(bytes, entry.offset) !== LOCAL_HEADER) return null
  const start = entry.offset + 30 + uint16(bytes, entry.offset + 26) + uint16(bytes, entry.offset + 28)
  const data = bytes.subarray(start, start + entry.compressedSize)
  if (entry.method === 0) return data
  if (entry.method === 8) return inflate(data, entry.size)
  return null
}

function readText(zip: Zip, name: string): string | null {
  const bytes = readEntry(zip, name)
  return bytes ? new TextDecoder().decode(bytes) : null
}

function needBits(stream: BitStream, bits: number): void {
  while (stream.count < bits) {
    if (stream.pos >= stream.data.length + 4) throw new Error('deflate data ends early')
    stream.buffer |= (stream.data[stream.pos] ?? 0) << stream.count
    stream.pos += 1
    stream.count += 8
  }
}

function readBits(stream: BitStream, bits: number): number {
  if (bits === 0) return 0
  needBits(stream, bits)
  const value = stream.buffer & ((1 << bits) - 1)
  stream.buffer >>>= bits
  stream.count -= bits
  return value
}

function buildHuffman(lengths: ArrayLike<number>): Huffman {
  let bits = 0
  const counts = new Array<number>(16).fill(0)
  for (let symbol = 0; symbol < lengths.length; symbol++) {
    const length = lengths[symbol] ?? 0
    counts[length] = (counts[length] ?? 0) + 1
    if (length > bits) bits = length
  }
  if (bits === 0) return { table: new Uint16Array(2), bits: 1 }
  const next = new Array<number>(16).fill(0)
  let code = 0
  for (let length = 1; length <= bits; length++) {
    code = (code + (length === 1 ? 0 : counts[length - 1] ?? 0)) << 1
    next[length] = code
  }
  const table = new Uint16Array(1 << bits)
  for (let symbol = 0; symbol < lengths.length; symbol++) {
    const length = lengths[symbol] ?? 0
    if (length === 0) continue
    const assigned = next[length] ?? 0
    next[length] = assigned + 1
    let reversed = 0
    for (let i = 0; i < length; i++) reversed |= ((assigned >> i) & 1) << (length - 1 - i)
    for (let i = reversed; i < table.length; i += 1 << length) table[i] = (symbol << 4) | length
  }
  return { table, bits }
}

function decodeSymbol(stream: BitStream, huffman: Huffman): number {
  needBits(stream, huffman.bits)
  const entry = huffman.table[stream.buffer & ((1 << huffman.bits) - 1)] ?? 0
  const length = entry & 15
  if (length === 0) throw new Error('invalid Huffman code')
  stream.buffer >>>= length
  stream.count -= length
  return entry >> 4
}

function reserve(output: Output, extra: number): void {
  if (output.length + extra <= output.bytes.length) return
  let size = Math.max(output.bytes.length * 2, 1024)
  while (size < output.length + extra) size *= 2
  const grown = new Uint8Array(size)
  grown.set(output.bytes.subarray(0, output.length))
  output.bytes = grown
}

function copyStored(stream: BitStream, output: Output): void {
  stream.pos -= stream.count >> 3
  stream.buffer = 0
  stream.count = 0
  const { data } = stream
  const length = uint16(data, stream.pos)
  const check = uint16(data, stream.pos + 2)
  if ((length ^ 0xffff) !== check) throw new Error('stored block length mismatch')
  const start = stream.pos + 4
  if (start + length > data.length) throw new Error('stored block ends early')
  reserve(output, length)
  output.bytes.set(data.subarray(start, start + length), output.length)
  output.length += length
  stream.pos = start + length
}

function fixedTrees(): [Huffman, Huffman] {
  const lengths = new Array<number>(288)
  for (let symbol = 0; symbol < 288; symbol++) {
    lengths[symbol] = symbol < 144 ? 8 : symbol < 256 ? 9 : symbol < 280 ? 7 : 8
  }
  return [buildHuffman(lengths), buildHuffman(new Array<number>(30).fill(5))]
}

function dynamicTrees(stream: BitStream): [Huffman, Huffman] {
  const literalCount = readBits(stream, 5) + 257
  const distanceCount = readBits(stream, 5) + 1
  const codeLengthCount = readBits(stream, 4) + 4
  const codeLengths = new Array<number>(19).fill(0)
  for (let i = 0; i < codeLengthCount; i++) codeLengths[CODE_LENGTH_ORDER[i] ?? 0] = readBits(stream, 3)
  const codeLengthTree = buildHuffman(codeLengths)
  const lengths: number[] = []
  while (lengths.length < literalCount + distanceCount) {
    const symbol = decodeSymbol(stream, codeLengthTree)
    if (symbol < 16) {
      lengths.push(symbol)
      continue
    }
    const previous = symbol === 16 ? lengths[lengths.length - 1] : 0
    if (previous === undefined) throw new Error('repeat without a previous length')
    const repeat = symbol === 16 ? 3 + readBits(stream, 2) : symbol === 17 ? 3 + readBits(stream, 3) : 11 + readBits(stream, 7)
    for (let i = 0; i < repeat; i++) lengths.push(previous)
  }
  if (lengths.length > literalCount + distanceCount) throw new Error('too many code lengths')
  return [buildHuffman(lengths.slice(0, literalCount)), buildHuffman(lengths.slice(literalCount))]
}

function inflateBlock(stream: BitStream, output: Output, literals: Huffman, distances: Huffman): void {
  while (true) {
    const symbol = decodeSymbol(stream, literals)
    if (symbol < 256) {
      reserve(output, 1)
      output.bytes[output.length] = symbol
      output.length += 1
      continue
    }
    if (symbol === 256) return
    const index = symbol - 257
    const base = LENGTH_BASE[index]
    if (base === undefined) throw new Error('invalid length symbol')
    const length = base + readBits(stream, LENGTH_EXTRA[index] ?? 0)
    const distanceSymbol = decodeSymbol(stream, distances)
    const distanceBase = DISTANCE_BASE[distanceSymbol]
    if (distanceBase === undefined) throw new Error('invalid distance symbol')
    const distance = distanceBase + readBits(stream, DISTANCE_EXTRA[distanceSymbol] ?? 0)
    if (distance > output.length) throw new Error('distance before the start')
    reserve(output, length)
    const bytes = output.bytes
    let from = output.length - distance
    for (let i = 0; i < length; i++) {
      bytes[output.length] = bytes[from] ?? 0
      output.length += 1
      from += 1
    }
  }
}

function inflate(data: Uint8Array, expectedSize: number): Uint8Array {
  const stream: BitStream = { data, pos: 0, buffer: 0, count: 0 }
  const output: Output = { bytes: new Uint8Array(Math.max(expectedSize, 1024)), length: 0 }
  let isFinal = false
  while (!isFinal) {
    isFinal = readBits(stream, 1) === 1
    const type = readBits(stream, 2)
    if (type === 0) copyStored(stream, output)
    else if (type === 1) inflateBlock(stream, output, ...fixedTrees())
    else if (type === 2) inflateBlock(stream, output, ...dynamicTrees(stream))
    else throw new Error('invalid block type')
  }
  return output.bytes.subarray(0, output.length)
}

function decodeEntities(text: string): string {
  if (!text.includes('&')) return text
  return text.replace(ENTITY, (match, name: string) => {
    const named = NAMED_ENTITIES[name]
    if (named !== undefined) return named
    const code = name.startsWith('#x') ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)
    return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match
  })
}

function decodeString(text: string): string {
  const decoded = decodeEntities(text)
  return decoded.includes('_x') ? decoded.replace(ESCAPED_CHAR, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))) : decoded
}

function readAttributes(tag: string): Record<string, string> {
  const attributes: Record<string, string> = {}
  for (const match of tag.matchAll(ATTRIBUTE)) {
    const name = match[1]
    if (name !== undefined) attributes[name] = decodeEntities(match[2] ?? match[3] ?? '')
  }
  return attributes
}

function prefixedId(attributes: Record<string, string>): string | undefined {
  for (const [name, value] of Object.entries(attributes)) if (name.endsWith(':id')) return value
  return undefined
}

function relsPath(part: string): string {
  const slash = part.lastIndexOf('/')
  return `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`
}

function resolvePath(part: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1)
  const parts = part.split('/').slice(0, -1)
  for (const piece of target.split('/')) {
    if (piece === '..') parts.pop()
    else if (piece !== '.' && piece !== '') parts.push(piece)
  }
  return parts.join('/')
}

function readRelationships(zip: Zip, part: string): Map<string, Relationship> {
  const relationships = new Map<string, Relationship>()
  const xml = readText(zip, relsPath(part))
  if (xml === null) return relationships
  for (const match of xml.matchAll(RELATIONSHIP)) {
    const attributes = readAttributes(match[1] ?? '')
    if (attributes.Id === undefined || attributes.Target === undefined || attributes.TargetMode === 'External') continue
    relationships.set(attributes.Id, { type: attributes.Type ?? '', target: resolvePath(part, attributes.Target) })
  }
  return relationships
}

function findTarget(relationships: Map<string, Relationship>, type: string, fallback: string): string {
  for (const relationship of relationships.values()) if (relationship.type.endsWith(`/${type}`)) return relationship.target
  return fallback
}

function richText(xml: string): string {
  let text = ''
  for (const match of xml.replace(PHONETIC, '').matchAll(TEXT)) text += match[1] ?? ''
  return decodeString(text)
}

function readSharedStrings(xml: string | null): string[] {
  if (xml === null) return []
  return Array.from(xml.matchAll(SHARED_ITEM), match => richText(match[2] ?? ''))
}

function formatKind(code: string): NumberKind {
  let isElapsed = false
  const bare = code.replace(FORMAT_LITERAL, token => {
    if (ELAPSED.test(token)) isElapsed = true
    return ''
  })
  if (isElapsed) return 'duration'
  return DATE_TOKEN.test(bare) ? 'date' : 'number'
}

function builtinKind(id: number): NumberKind {
  if (id === DURATION_FORMAT_ID) return 'duration'
  return DATE_FORMAT_IDS.has(id) ? 'date' : 'number'
}

function readStyles(xml: string | null): NumberKind[] {
  if (xml === null) return []
  const custom = new Map<number, string>()
  for (const match of xml.matchAll(NUMBER_FORMAT)) {
    const attributes = readAttributes(match[1] ?? '')
    const id = Number(attributes.numFmtId)
    if (Number.isInteger(id) && attributes.formatCode !== undefined) custom.set(id, attributes.formatCode)
  }
  const section = CELL_FORMATS.exec(xml)?.[1] ?? ''
  return Array.from(section.matchAll(CELL_FORMAT), match => {
    const id = Number(readAttributes(match[1] ?? '').numFmtId ?? 0)
    const code = custom.get(id)
    return code === undefined ? builtinKind(id) : formatKind(code)
  })
}

function readSheets(xml: string, relationships: Map<string, Relationship>): Sheet[] {
  const sheets: Sheet[] = []
  for (const match of xml.matchAll(SHEET)) {
    const attributes = readAttributes(match[1] ?? '')
    const id = attributes['r:id'] ?? prefixedId(attributes)
    const relationship = id === undefined ? undefined : relationships.get(id)
    if (relationship) sheets.push({ name: attributes.name ?? '', path: relationship.target })
  }
  return sheets
}

function readBook(zip: Zip): Book | null {
  const workbookPath = findTarget(readRelationships(zip, ''), 'officeDocument', 'xl/workbook.xml')
  const workbook = readText(zip, workbookPath)
  if (workbook === null) return null
  const relationships = readRelationships(zip, workbookPath)
  const sheets = readSheets(workbook, relationships)
  if (sheets.length === 0) return null
  const properties = readAttributes(WORKBOOK_PROPERTIES.exec(workbook)?.[1] ?? '')
  const date1904 = properties.date1904 ?? ''
  return {
    sheets,
    strings: readSharedStrings(readText(zip, findTarget(relationships, 'sharedStrings', 'xl/sharedStrings.xml'))),
    styles: readStyles(readText(zip, findTarget(relationships, 'styles', 'xl/styles.xml'))),
    is1904: date1904 === '1' || date1904.toLowerCase() === 'true',
  }
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0')
}

function clockText(seconds: number): string {
  return `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`
}

function dateText(serial: number, is1904: boolean): string {
  let days = Math.floor(serial)
  let seconds = Math.round((serial - days) * 86400)
  if (seconds === 86400) {
    days += 1
    seconds = 0
  }
  if (days === 0) return clockText(seconds)
  const shifted = !is1904 && days >= 1 && days < 60 ? days + 1 : days
  const date = new Date((is1904 ? EPOCH_1904 : EPOCH_1900) + shifted * DAY_MS)
  const day = `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
  return seconds === 0 ? day : `${day} ${clockText(seconds)}`
}

function durationText(serial: number): string {
  const seconds = Math.round(Math.abs(serial) * 86400)
  const text = `${Math.floor(seconds / 3600)}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`
  return serial < 0 ? `-${text}` : text
}

function numberCell(value: string, kind: NumberKind, is1904: boolean): Cell {
  const serial = Number(value)
  if (kind === 'number' || !Number.isFinite(serial)) return { text: value, isNumber: NUMBER.test(value) }
  return { text: kind === 'date' ? dateText(serial, is1904) : durationText(serial), isNumber: false }
}

function textCell(text: string): Cell {
  return text === '' ? null : { text, isNumber: false }
}

function readCell(attributes: Record<string, string>, inner: string, book: Book): Cell {
  const type = attributes.t ?? 'n'
  if (type === 'inlineStr') {
    const inline = INLINE.exec(inner)
    if (inline) return textCell(richText(inline[1] ?? ''))
  }
  const raw = VALUE.exec(inner)?.[1]
  if (raw === undefined) return null
  if (type === 's') return textCell(book.strings[Number(raw)] ?? '')
  if (type === 'b') return { text: raw.trim() === '1' || raw.trim() === 'true' ? 'TRUE' : 'FALSE', isNumber: false }
  if (type === 'str' || type === 'inlineStr' || type === 'e' || type === 'd') return textCell(decodeString(raw))
  const value = decodeEntities(raw).trim()
  if (value === '') return null
  return numberCell(value, book.styles[Number(attributes.s ?? 0)] ?? 'number', book.is1904)
}

function columnIndex(ref: string | undefined): number | null {
  const letters = ref === undefined ? undefined : CELL_REF.exec(ref)?.[1]
  if (letters === undefined) return null
  let index = 0
  for (const letter of letters.toUpperCase()) index = index * 26 + letter.charCodeAt(0) - 64
  return index - 1
}

function readRow(xml: string, book: Book): { cells: QueryCell[]; numbers: boolean[]; width: number } {
  const cells: QueryCell[] = []
  const numbers: boolean[] = []
  let column = -1
  let width = 0
  for (const match of xml.matchAll(CELL)) {
    const attributes = readAttributes(match[1] ?? '')
    column = columnIndex(attributes.r) ?? column + 1
    const cell = readCell(attributes, match[2] ?? '', book)
    if (cell === null) continue
    cells[column] = cell.text
    numbers[column] = cell.isNumber
    width = Math.max(width, column + 1)
  }
  return { cells, numbers, width }
}

function fill(cells: QueryCell[], width: number): QueryCell[] {
  return Array.from({ length: width }, (_, c) => cells[c] ?? null)
}

function readTable(xml: string, book: Book): QueryTable | null {
  let header: QueryCell[] | null = null
  const rows: QueryCell[][] = []
  const seen: boolean[] = []
  const notNumber: boolean[] = []
  let total = 0
  let width = 0
  for (const match of xml.matchAll(ROW)) {
    const row = readRow(match[2] ?? '', book)
    if (row.width === 0) continue
    width = Math.max(width, row.width)
    if (header === null) {
      header = row.cells
      continue
    }
    total += 1
    if (rows.length < STORE_CAP) rows.push(row.cells)
    for (let c = 0; c < row.width; c++) {
      if (row.cells[c] === undefined) continue
      seen[c] = true
      if (!row.numbers[c]) notNumber[c] = true
    }
  }
  if (header === null) return null
  const names = fill(header, width)
  return {
    columns: names.map((name, c) => name ?? `column ${c + 1}`),
    numeric: names.map((_, c) => seen[c] === true && notNumber[c] !== true),
    rows: rows.map(cells => fill(cells, width)),
    total,
    isCapped: total > STORE_CAP,
    note: '',
  }
}

export function parseXlsx(base64: string): QueryTable | null {
  try {
    const zip = readZip(decodeBase64(base64))
    if (!zip) return null
    const book = readBook(zip)
    const first = book?.sheets[0]
    if (!book || !first) return null
    const xml = readText(zip, first.path)
    if (xml === null) return null
    const table = readTable(xml, book)
    if (!table) return null
    const count = book.sheets.length
    return count > 1 ? { ...table, note: `Sheet 1 of ${count} (${first.name})` } : table
  } catch {
    return null
  }
}
