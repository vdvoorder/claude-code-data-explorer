import type { QueryAggregation, QueryCell, QueryGroup, QueryMeasure, QueryResult, QuerySort, QueryView } from '../types'

export const MIN_WIDTH = 9
export const GAP = 2
export const CONTEXT_ROWS = 10
export const MISSING = '–'
export const ROWS_NAME = 'rows'
export const MEASURES: QueryMeasure[] = ['off', 'sum', 'mean', 'min', 'max', 'count', 'distinct']

export type ColumnKind = 'measure' | 'year' | 'code' | 'date' | 'text'

export type Role = 'group' | QueryMeasure

export type Table = {
  columns: string[]
  numeric: boolean[]
  kinds: ColumnKind[]
  rows: QueryCell[][]
}

export type Shown = { table: Table; order: number[]; kept: number[]; matched: number }

export type Computed = { shown: Shown; layout: Layout }

type Scale = { lo: number; hi: number }

export type Layout = {
  kinds: ColumnKind[]
  cells: string[][]
  widths: number[]
  scales: (Scale | null)[]
}

export type Segment = { text: string; isDim: boolean; isBar: boolean }

export type Change = { key: string; text: string; clear: (view: QueryView) => QueryView }

const YEAR_NAME = /(^|[^a-z])(year|yr)([^a-z]|$)/i
const CODE_NAME = /(^|[^a-z])(code|id|key)([^a-z]|$)/i
const DATE_VALUE = /^\d{4}-\d{2}-\d{2}/
const NUMBER_VALUE = /^(-?)(\d+)(\.\d+)?$/

export function isMissing(cell: QueryCell | undefined): boolean {
  return cell === null || cell === undefined || cell === '' || /^-?nan$/i.test(cell)
}

export function freshView(result: QueryResult): QueryView {
  return {
    resultId: result.id,
    sort: null,
    filter: '',
    order: result.columns.map((_, c) => c),
    hidden: [],
    bars: false,
    group: null,
  }
}

export function columnKinds(result: QueryResult): ColumnKind[] {
  return result.columns.map((name, c) => {
    if (result.numeric[c]) {
      if (YEAR_NAME.test(name)) return 'year'
      if (CODE_NAME.test(name)) return 'code'
      return 'measure'
    }
    const values = result.rows.map(row => row[c]).filter(cell => !isMissing(cell))
    return values.length > 0 && values.every(cell => DATE_VALUE.test(cell ?? '')) ? 'date' : 'text'
  })
}

export function sourceTable(result: QueryResult): Table {
  return { columns: result.columns, numeric: result.numeric, kinds: columnKinds(result), rows: result.rows }
}

export function rowsColumn(result: QueryResult): number {
  return result.columns.length
}

export function isDescendingFirst(kind: ColumnKind): boolean {
  return kind === 'measure' || kind === 'year' || kind === 'date'
}

export function cycleSort(view: QueryView, column: number, descendingFirst: boolean): QueryView {
  if (!view.sort || view.sort.column !== column) {
    return { ...view, sort: { column, isDescending: descendingFirst } }
  }
  return { ...view, sort: { column, isDescending: !view.sort.isDescending } }
}

export function groupKeys(view: QueryView): number[] {
  const keys = view.group?.keys ?? []
  return view.order.filter(c => keys.includes(c))
}

export function shownOrder(result: QueryResult, view: QueryView): number[] {
  if (!view.group) return view.order
  const keys = groupKeys(view)
  return [...keys, rowsColumn(result), ...view.order.filter(c => !keys.includes(c) && roleOf(view, c) !== 'off')]
}

export function moveColumn(result: QueryResult, view: QueryView, column: number, step: -1 | 1): QueryView {
  const shown = shownOrder(result, view)
  const at = shown.indexOf(column)
  const other = at < 0 ? undefined : shown[at + step]
  if (other === undefined || !view.order.includes(column) || !view.order.includes(other)) return view
  return { ...view, order: view.order.map(c => (c === column ? other : c === other ? column : c)) }
}

export function hideColumn(view: QueryView, column: number): QueryView {
  if (!view.order.includes(column) || view.order.length <= 1) return view
  return {
    ...view,
    order: view.order.filter(c => c !== column),
    hidden: [...view.hidden, column],
    sort: view.sort?.column === column ? null : view.sort,
  }
}

export function showColumn(view: QueryView, column: number): QueryView {
  if (!view.hidden.includes(column)) return view
  const order = [...view.order]
  const neighbours = order.filter(c => c < column)
  const neighbour = neighbours.length === 0 ? -1 : Math.max(...neighbours)
  order.splice(neighbour < 0 ? 0 : order.indexOf(neighbour) + 1, 0, column)
  return { ...view, order, hidden: view.hidden.filter(c => c !== column) }
}

export function bringToFront(view: QueryView, column: number): QueryView {
  if (!view.order.includes(column)) return view
  return { ...view, order: [column, ...view.order.filter(c => c !== column)] }
}

export function startGroup(result: QueryResult): QueryGroup {
  return { keys: [], aggregations: result.columns.map(() => 'off') }
}

export function canAggregate(result: QueryResult, column: number, measure: QueryMeasure): boolean {
  return (measure !== 'sum' && measure !== 'mean') || result.numeric[column] === true
}

export function roleOf(view: QueryView, column: number): Role | null {
  if (!view.group || !view.order.includes(column)) return null
  return view.group.keys.includes(column) ? 'group' : view.group.aggregations[column] ?? 'off'
}

export function toggleKey(result: QueryResult, view: QueryView, column: number): QueryView {
  const group = view.group ?? startGroup(result)
  const keys = roleOf(view, column) === 'group' ? group.keys.filter(c => c !== column) : [...group.keys.filter(c => c !== column), column]
  return showColumn({ ...view, group: { ...group, keys } }, column)
}

export function setAggregation(result: QueryResult, view: QueryView, column: number, measure: QueryMeasure): QueryView {
  if (!canAggregate(result, column, measure)) return view
  const group = view.group ?? startGroup(result)
  const aggregations = [...group.aggregations]
  aggregations[column] = measure
  const sort = measure === 'off' && view.sort?.column === column ? null : view.sort
  return showColumn({ ...view, sort, group: { keys: group.keys.filter(c => c !== column), aggregations } }, column)
}

export function ungroup(result: QueryResult, view: QueryView): QueryView {
  return { ...view, group: null, sort: view.sort?.column === rowsColumn(result) ? null : view.sort }
}

function compareCells(a: QueryCell | undefined, b: QueryCell | undefined, isNumeric: boolean): number {
  if (isNumeric) {
    const x = Number(a)
    const y = Number(b)
    if (Number.isFinite(x) && Number.isFinite(y)) return x - y
  }
  const x = (a ?? '').toLowerCase()
  const y = (b ?? '').toLowerCase()
  return x < y ? -1 : x > y ? 1 : 0
}

export function sortRows(table: Table, indexes: number[], sort: QuerySort | null): number[] {
  if (!sort) return indexes
  const isNumeric = table.numeric[sort.column] === true
  const missing: boolean[] = []
  const numbers: number[] = []
  const texts: string[] = []
  for (const r of indexes) {
    const cell = table.rows[r]?.[sort.column]
    missing[r] = isMissing(cell)
    numbers[r] = isNumeric ? Number(cell) : NaN
    texts[r] = (cell ?? '').toLowerCase()
  }
  const sign = sort.isDescending ? -1 : 1
  return [...indexes].sort((r1, r2) => {
    const aMissing = missing[r1]
    const bMissing = missing[r2]
    if (aMissing || bMissing) {
      if (aMissing !== bMissing) return aMissing ? 1 : -1
      return r1 - r2
    }
    const x = numbers[r1] ?? NaN
    const y = numbers[r2] ?? NaN
    const a = texts[r1] ?? ''
    const b = texts[r2] ?? ''
    const order = Number.isFinite(x) && Number.isFinite(y) ? x - y : a < b ? -1 : a > b ? 1 : 0
    return sign * order || r1 - r2
  })
}

export function rowMatches(result: QueryResult, view: QueryView, row: number): boolean {
  const cells = result.rows[row] ?? []
  const needle = view.filter.trim().toLowerCase()
  if (needle === '') return true
  return view.order.some(c => (cells[c] ?? '').toLowerCase().includes(needle))
}

export function isNarrowed(view: QueryView): boolean {
  return view.filter.trim() !== ''
}

function decimalsOf(cell: string): number {
  return /\.(\d+)$/.exec(cell)?.[1]?.length ?? 0
}

function fixed(value: number, decimals: number): string {
  const text = value.toFixed(Math.min(20, decimals))
  return text.includes('.') ? text.replace(/\.?0+$/, '') : text
}

function aggregate(table: Table, column: number, rows: number[], aggregation: QueryAggregation): QueryCell {
  const cells: string[] = []
  for (const r of rows) {
    const cell = table.rows[r]?.[column]
    if (!isMissing(cell)) cells.push(cell ?? '')
  }
  if (aggregation === 'count') return String(cells.length)
  if (aggregation === 'distinct') return String(new Set(cells).size)
  if (aggregation === 'min' || aggregation === 'max') {
    const isNumeric = table.numeric[column] === true
    const sign = aggregation === 'min' ? -1 : 1
    return cells.reduce<string | null>((best, cell) => (best === null || sign * compareCells(cell, best, isNumeric) > 0 ? cell : best), null)
  }
  let sum = 0
  let count = 0
  let decimals = 0
  for (const cell of cells) {
    const value = Number(cell)
    if (!Number.isFinite(value)) continue
    sum += value
    count += 1
    decimals = Math.max(decimals, decimalsOf(cell))
  }
  if (count === 0) return null
  return aggregation === 'sum' ? fixed(sum, decimals) : fixed(sum / count, decimals + 2)
}

export function shownName(result: QueryResult, view: QueryView, column: number): string {
  if (column === rowsColumn(result)) return ROWS_NAME
  const name = result.columns[column] ?? `column ${column + 1}`
  const role = roleOf(view, column)
  return role === null || role === 'group' || role === 'off' ? name : `${name} (${role})`
}

function keepsKind(role: Role | null): boolean {
  return role === null || role === 'group' || role === 'off' || role === 'min' || role === 'max'
}

export function groupTable(result: QueryResult, view: QueryView, rows: number[]): Table {
  const source = sourceTable(result)
  const keys = groupKeys(view)
  const roles = result.columns.map((_, c) => roleOf(view, c))
  const groups = new Map<string, number[]>()
  for (const r of rows) {
    const id = JSON.stringify(keys.map(c => (isMissing(result.rows[r]?.[c]) ? null : result.rows[r]?.[c])))
    const members = groups.get(id)
    if (members) members.push(r)
    else groups.set(id, [r])
  }
  if (keys.length === 0 && groups.size === 0) groups.set('[]', [])
  return {
    columns: [...result.columns.map((_, c) => shownName(result, view, c)), ROWS_NAME],
    numeric: [...roles.map((role, c) => (keepsKind(role) ? source.numeric[c] === true : true)), true],
    kinds: [...roles.map((role, c) => (keepsKind(role) ? source.kinds[c] ?? 'text' : 'measure')), 'measure'],
    rows: [...groups.values()].map(members => [
      ...roles.map((role, c) => {
        if (role === null || role === 'off') return null
        if (role === 'group') return members[0] === undefined ? null : result.rows[members[0]]?.[c] ?? null
        return aggregate(source, c, members, role)
      }),
      String(members.length),
    ]),
  }
}

export function shown(result: QueryResult, view: QueryView): Shown {
  const matched = result.rows.map((_, r) => r).filter(r => rowMatches(result, view, r))
  if (!view.group) {
    const table = sourceTable(result)
    return { table, order: view.order, kept: sortRows(table, matched, view.sort), matched: matched.length }
  }
  const table = groupTable(result, view, matched)
  return { table, order: shownOrder(result, view), kept: sortRows(table, table.rows.map((_, r) => r), view.sort), matched: matched.length }
}

export function formatNumber(text: string): string {
  const m = NUMBER_VALUE.exec(text)
  if (!m) return text
  return `${m[1] ?? ''}${(m[2] ?? '').replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${m[3] ?? ''}`
}

export function countText(n: number): string {
  return formatNumber(String(n))
}

function displayCell(cell: QueryCell | undefined, kind: ColumnKind): string {
  if (isMissing(cell)) return MISSING
  return kind === 'measure' ? formatNumber(cell ?? '') : cell ?? ''
}

function scaleOf(table: Table, column: number): Scale | null {
  let lo = 0
  let hi = 0
  for (const row of table.rows) {
    const cell = row[column]
    const value = Number(cell)
    if (isMissing(cell) || !Number.isFinite(value)) continue
    lo = Math.min(lo, value)
    hi = Math.max(hi, value)
  }
  return hi > lo ? { lo, hi } : null
}

export function tableLayout(table: Table): Layout {
  const { kinds } = table
  const cells = table.rows.map(row => table.columns.map((_, c) => displayCell(row[c], kinds[c] ?? 'text')))
  const widths = table.columns.map((name, c) =>
    cells.reduce((width, row) => Math.max(width, (row[c] ?? '').length), Math.max(MIN_WIDTH, name.length + 2)),
  )
  const scales = kinds.map((kind, c) => (kind === 'measure' ? scaleOf(table, c) : null))
  return { kinds, cells, widths, scales }
}

export function shownLayout(result: QueryResult, view: QueryView, table: Table): Layout {
  const layout = tableLayout(table)
  if (!view.group || !isNarrowed(view)) return layout
  const whole = tableLayout(groupTable(result, view, result.rows.map((_, r) => r)))
  return { ...layout, widths: layout.widths.map((width, c) => Math.max(width, whole.widths[c] ?? 0)) }
}

export function fitColumns(order: number[], widths: number[], bodyColumns: number): { fitting: number[]; past: number[] } {
  const fitting: number[] = []
  const past: number[] = []
  let used = 0
  for (const c of order) {
    const width = (widths[c] ?? MIN_WIDTH) + GAP
    if (past.length === 0 && (used + width <= bodyColumns + GAP || fitting.length === 0)) {
      fitting.push(c)
      used += width
    } else {
      past.push(c)
    }
  }
  return { fitting, past }
}

function barExtent(scale: Scale | null | undefined, cell: QueryCell | undefined, width: number): [number, number] {
  const value = Number(cell)
  if (!scale || isMissing(cell) || !Number.isFinite(value)) return [0, 0]
  const at = (x: number) => Math.round((width * (x - scale.lo)) / (scale.hi - scale.lo))
  const zero = at(0)
  const end = at(value)
  return [Math.min(zero, end), Math.max(zero, end)]
}

export function rowSegments(table: Table, layout: Layout, row: number, columns: number[], bars: boolean): Segment[] {
  const segments: Segment[] = []
  const push = (text: string, isDim: boolean, isBar: boolean) => {
    if (text === '') return
    const last = segments[segments.length - 1]
    if (last && last.isDim === isDim && last.isBar === isBar) last.text += text
    else segments.push({ text, isDim, isBar })
  }
  columns.forEach((c, i) => {
    if (i > 0) push(' '.repeat(GAP), false, false)
    const kind = layout.kinds[c] ?? 'text'
    const width = layout.widths[c] ?? MIN_WIDTH
    const cell = table.rows[row]?.[c]
    const text = layout.cells[row]?.[c] ?? ''
    const padded = kind === 'text' ? text.padEnd(width) : text.padStart(width)
    const isDim = isMissing(cell) || kind === 'date'
    const [from, to] = bars ? barExtent(layout.scales[c], cell, width) : [0, 0]
    push(padded.slice(0, from), isDim, false)
    push(padded.slice(from, to), isDim, true)
    push(padded.slice(to), isDim, false)
  })
  return segments
}

export function headLabel(name: string, kind: ColumnKind, view: QueryView, column: number): string {
  const arrow = view.sort?.column === column ? (view.sort.isDescending ? '▼' : '▲') : ' '
  return kind === 'text' ? `${name} ${arrow}` : `${arrow} ${name}`
}

function sortWords(kind: ColumnKind, isDescending: boolean): string {
  if (kind === 'text') return isDescending ? 'Z to A' : 'A to Z'
  if (kind === 'year' || kind === 'date') return isDescending ? 'newest first' : 'oldest first'
  return isDescending ? 'high to low' : 'low to high'
}

function isMoved(view: QueryView): boolean {
  return view.order.some((c, i) => i > 0 && c < (view.order[i - 1] ?? -1))
}

function groupText(result: QueryResult, view: QueryView): string {
  const keys = groupKeys(view)
  if (keys.length === 0) return 'grouped into one total row'
  return `grouped by ${keys.map(c => result.columns[c] ?? `column ${c + 1}`).join(', ')}`
}

export function viewChanges(result: QueryResult, view: QueryView): Change[] {
  const name = (c: number) => result.columns[c] ?? `column ${c + 1}`
  const changes: Change[] = []
  if (view.group) changes.push({ key: 'clear-group', text: groupText(result, view), clear: v => ungroup(result, v) })
  if (view.sort) {
    const { column, isDescending } = view.sort
    const kinds = view.group ? groupTable(result, view, []).kinds : columnKinds(result)
    changes.push({
      key: 'clear-sort',
      text: `sorted by ${shownName(result, view, column)}, ${sortWords(kinds[column] ?? 'text', isDescending)}`,
      clear: v => ({ ...v, sort: null }),
    })
  }
  const filter = view.filter.trim()
  if (filter !== '') changes.push({ key: 'clear-text', text: `rows contain "${filter}"`, clear: v => ({ ...v, filter: '' }) })
  for (const c of view.hidden) {
    changes.push({ key: `clear-hidden-${c}`, text: `${name(c)} hidden`, clear: v => showColumn(v, c) })
  }
  if (isMoved(view)) {
    changes.push({ key: 'clear-order', text: 'columns moved', clear: v => ({ ...v, order: [...v.order].sort((a, b) => a - b) }) })
  }
  if (view.bars) changes.push({ key: 'clear-bars', text: 'data bars shown', clear: v => ({ ...v, bars: false }) })
  return changes
}

export function scopeText(result: QueryResult, view: QueryView, matched: number, groups: number): string {
  const n = result.rows.length
  const rows = isNarrowed(view) ? `${countText(matched)} of ${countText(n)} rows` : `${countText(n)} ${n === 1 ? 'row' : 'rows'}`
  const holder = result.source.startsWith('File') ? 'file' : 'result'
  const completeness = !result.isCapped ? 'complete' : result.total > n ? `capped, the ${holder} has ${totalText(result)}` : 'capped'
  const filter = view.filter.trim()
  const parts = [`${result.source}: ${rows}, ${completeness}.`]
  if (filter !== '') parts.push(`Rows contain "${filter}".`)
  if (view.group && groupKeys(view).length === 0) parts.push('Grouped into one total row.')
  else if (view.group) parts.push(`${groupText(result, view).replace(/^g/, 'G')}: ${countText(groups)} ${groups === 1 ? 'group' : 'groups'}.`)
  return parts.join(' ')
}

export function lineCount(widths: number[], room: number, gap: number): number {
  let lines = 1
  let used = 0
  for (const width of widths) {
    if (used > 0 && used + gap + width > room) {
      lines += 1
      used = width
    } else {
      used += (used > 0 ? gap : 0) + width
    }
  }
  return lines
}

export function footerText(first: number, shown: number, total: number): string {
  if (total === 0 || shown === 0) return ''
  return `${countText(first + 1)}–${countText(first + shown)} of ${countText(total)}`
}

export function columnsText(count: number, past: number[]): string {
  if (past.length > 0) return `${past.length} other ${past.length === 1 ? 'column' : 'columns'}:`
  return `All ${count} ${count === 1 ? 'column' : 'columns'} shown.`
}

export function copyText(table: Table, order: number[], rows: number[]): string {
  const clean = (text: string) => text.replace(/[\t\r\n]+/g, ' ')
  const lines = [order.map(c => clean(table.columns[c] ?? '')).join('\t')]
  for (const r of rows) {
    lines.push(order.map(c => (isMissing(table.rows[r]?.[c]) ? '' : clean(table.rows[r]?.[c] ?? ''))).join('\t'))
  }
  return lines.join('\n')
}

export function sizeLabel(result: QueryResult): string {
  const n = result.rows.length
  if (!result.isCapped) return `${countText(n)} ${n === 1 ? 'row' : 'rows'}, complete`
  if (result.total > n) return `capped at ${countText(n)} of ${totalText(result)} rows`
  return `capped at ${countText(n)} rows`
}

function totalText(result: QueryResult): string {
  return result.isTotalMinimum ? `more than ${countText(result.total)}` : countText(result.total)
}

let memo: { key: string; value: Computed } | null = null

export function computed(result: QueryResult, view: QueryView): Computed {
  const key = `${result.id}\n${viewSignature(view)}`
  if (memo?.key === key) return memo.value
  const found = shown(result, view)
  const value = { shown: found, layout: shownLayout(result, view, found.table) }
  memo = { key, value }
  return value
}

export function viewSignature(view: QueryView): string {
  return JSON.stringify([view.resultId, view.sort, view.filter.trim(), view.order, view.hidden, view.bars, view.group])
}

export function isDefaultView(result: QueryResult, view: QueryView): boolean {
  return viewSignature(view) === viewSignature(freshView(result))
}

export function contextText(result: QueryResult, view: QueryView): string {
  const { table, order, kept, matched } = computed(result, view).shown
  const parts: string[] = []
  parts.push(`The data explorer pane shows a table from ${result.source} (${sizeLabel(result)}).`)
  const query = result.query.replace(/\s+/g, ' ').trim()
  if (query !== '') parts.push(`The table came from: ${query.length > 300 ? `${query.slice(0, 300)}…` : query}.`)
  const changes = viewChanges(result, view).filter(change => change.key !== 'clear-bars')
  if (changes.length > 0) parts.push(`The user changed the view: ${changes.map(change => change.text).join('; ')}.`)
  if (isNarrowed(view)) parts.push(`${countText(matched)} of ${countText(result.rows.length)} rows match.`)
  if (view.group) parts.push(`The grouped table has ${countText(kept.length)} ${kept.length === 1 ? 'row' : 'rows'}.`)
  parts.push(`Column order: ${order.map(c => table.columns[c] ?? '').join(', ')}.`)
  const rows = kept.slice(0, CONTEXT_ROWS)
  const lines = [order.map(c => table.columns[c] ?? '').join(' | ')]
  for (const r of rows) lines.push(order.map(c => table.rows[r]?.[c] ?? '').join(' | '))
  const what = view.group ? 'grouped rows' : 'matching rows'
  return `${parts.join(' ')}\nThe first ${rows.length} ${what} as the user sees them:\n${lines.join('\n')}`
}
