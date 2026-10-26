import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderSurface } from 'claude-code'

import type { QueryPanel, QueryReload, QueryResult, QueryTable, QueryView } from '../types'
import { captionOf, findTables } from './find'
import type { Format, Found, TextKind } from './find'
import { STORE_CAP, TABLE_FILE, parseFile, parsePowerBi } from './parse'
import { parseXlsx } from './xlsx'
import {
  GAP,
  MEASURES,
  MIN_WIDTH,
  bringToFront,
  canAggregate,
  columnsText,
  computed,
  contextText,
  copyText,
  countText,
  cycleSort,
  fitColumns,
  footerText,
  freshView,
  headLabel,
  hideColumn,
  isDefaultView,
  isDescendingFirst,
  lineCount,
  moveColumn,
  roleOf,
  rowSegments,
  rowsColumn,
  scopeText,
  setAggregation,
  toggleKey,
  ungroup,
  viewChanges,
  viewSignature,
} from './view'

const PANE = 'data-explorer'
const TITLE = 'Data'
const DEFAULT_MAX_ROWS = 250
const POWER_BI_SERVER = 'claude_ai_Power_BI'
const POWER_BI_TOOL = 'ExecuteQuery'
const POWER_BI_NAME = `mcp__${POWER_BI_SERVER}__${POWER_BI_TOOL}`
const FILE_TOOL = 'show_file'
const FILE_TOOL_NAME = /^mcp__data-explorer__show_file$/
const QUIET_TOOL =
  /^(Edit|MultiEdit|Write|NotebookEdit|TodoWrite|ToolSearch|Skill|EnterPlanMode|ExitPlanMode|EnterWorktree|ExitWorktree|AskUserQuestion|SendMessage|ListAgents|ReadNotifications|ScheduleWakeup|TaskStop|Monitor|LSP|Cron\w*|Artifact\w*|mcp__data-explorer__\w+|mcp__trace-waterfall__\w+)$/
const SHELL_TOOL = /^(Bash|PowerShell)$/
const DOCUMENT_FILE = /\.(md|markdown|txt|text|log|out|html?)$/i
const PARQUET_FILE = /\.parquet$/i
const XLSX_FILE = /\.xls[xm]$/i
const PATH_IN_COMMAND = /"([^"]+\.(?:csv|tsv|jsonl?|ndjson))"|'([^']+\.(?:csv|tsv|jsonl?|ndjson))'|([^\s"'|<>;&()]+\.(?:csv|tsv|jsonl?|ndjson))(?![\w.])/gi
const PRIMARY_FORMATS: Format[] = ['box', 'grid', 'psql', 'pandas', 'delimited']
const FILE_LIMIT = 4 * 1024 * 1024
const HISTORY = 12
const HISTORY_ROWS = 300000
const ACCENT = 'claude'
const BAR = 'subtle'
const CONTROL_WIDTH = 16
const BUTTON_LABELS = ['group rows', 'show data bars', 'copy table']
const GROUP_OPTIONS = ['off', 'group', ...MEASURES.filter(measure => measure !== 'off')] as const
const WAITING = 'Data explorer: a new table waits. Widen the terminal to 144 columns, or run /data-explorer'
const NO_KEYBOARD = 'Data explorer: empty the prompt box, then click "type a filter" again'

const resultsAtom = atom({ plugin: 'data-explorer', key: 'results' } as const, [] as QueryResult[])
const shownAtom = atom({ plugin: 'data-explorer', key: 'shown' } as const, '')
const viewsAtom = atom({ plugin: 'data-explorer', key: 'views' } as const, [] as QueryView[])
const unseenAtom = atom({ plugin: 'data-explorer', key: 'unseen' } as const, [] as string[])
const viewAtom = atom({ plugin: 'data-explorer', key: 'view' } as const, null)
const undoAtom = atom({ plugin: 'data-explorer', key: 'undo' } as const, null)
const panelAtom = atom({ plugin: 'data-explorer', key: 'panel' } as const, 'table' as QueryPanel)
const sentAtom = atom({ plugin: 'data-explorer', key: 'sent' } as const, '')
const firstRowAtom = atom({ plugin: 'data-explorer', key: 'firstRow' } as const, 0)
const firstColumnAtom = atom({ plugin: 'data-explorer', key: 'firstColumn' } as const, 0)
const loadingAtom = atom({ plugin: 'data-explorer', key: 'loading' } as const, '')
const askedAtom = atom({ plugin: 'data-explorer', key: 'asked' } as const, '')

const FILE_TOOL_DESCRIPTION = [
  'Shows every row of a CSV, TSV, JSON, JSON-lines or Excel (.xlsx) file in the data explorer pane beside the chat, where the user sorts, filters and groups the rows.',
  'The rows do not enter your context: the tool answers with the row and column count only.',
  'Use it when the user wants to explore a result that is too large to print: write the full result to a file first (in DuckDB: COPY (SELECT ...) TO \'result.csv\'), then pass the file path.',
  'A Parquet file needs that step too. Files up to 4 MiB; the pane keeps the first 100,000 rows.',
].join(' ')

let pageRows = 10
let loads = 0
let opensOnTable = true

type Ran = { deny?: unknown; isError?: unknown; result?: unknown; text?: unknown }

type Capture = { table: QueryTable; id: string; source: string; query: string; isPrimary: boolean; reload?: QueryReload | null }

type Placement = 'auto' | 'show' | 'keep'

function succeeded(ran: unknown): Ran | null {
  if (!ran || typeof ran !== 'object') return null
  const r = ran as Ran
  return r.deny !== undefined || r.isError === true ? null : r
}

function outputText(r: Ran): string | null {
  if (typeof r.text === 'string' && r.text.trim() !== '') return r.text
  if (typeof r.result === 'string') return r.result
  const result = r.result as { stdout?: unknown; content?: unknown } | undefined
  if (result && typeof result === 'object' && typeof result.stdout === 'string') return result.stdout
  const content = result?.content
  if (Array.isArray(content)) {
    return content
      .map(block => (block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string' ? (block as { text: string }).text : ''))
      .join('\n')
  }
  return null
}

function sourceOf(tool: string): string {
  if (tool === POWER_BI_NAME) return 'Power BI'
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool)
  if (!mcp) return tool
  return (mcp[1] ?? '').replace(/^claude_ai_/, '').replace(/^plugin_[^_]+_/, '').replace(/_/g, ' ')
}

function queryOf(tool: string, input: Record<string, unknown>): string {
  for (const key of ['command', 'url', 'file_path', 'description']) {
    const value = input[key]
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  const args = Object.fromEntries(Object.entries(input).filter(([key]) => !['tool', 'tool_use_id', 'agentId', 'requestMeta', 'consent'].includes(key)))
  const name = /^mcp__.+?__(.+)$/.exec(tool)?.[1] ?? tool
  return `${name} ${JSON.stringify(args)}`
}

function nameWidth(result: QueryResult): number {
  return result.columns.reduce((width, name) => Math.max(width, name.length), 0)
}

function blocksText(content: readonly { text?: string }[]): string {
  return content.map(block => block.text ?? '').join('\n')
}

function sameColumns(a: QueryTable, b: QueryTable): boolean {
  return JSON.stringify(a.columns) === JSON.stringify(b.columns)
}

function sameData(a: QueryTable, b: QueryTable): boolean {
  return (
    sameColumns(a, b) &&
    a.rows.length === b.rows.length &&
    a.total === b.total &&
    JSON.stringify(a.rows[0] ?? null) === JSON.stringify(b.rows[0] ?? null) &&
    JSON.stringify(a.rows[a.rows.length - 1] ?? null) === JSON.stringify(b.rows[b.rows.length - 1] ?? null)
  )
}

function askText(result: QueryResult): string {
  return [
    'Write every row of the table in the data explorer pane to a CSV file in a temporary folder, without printing the rows here.',
    "Then show that file with the data explorer's show_file tool.",
    `The pane holds ${countText(result.rows.length)} rows of a table from ${result.source}, which came from:`,
    '',
    '```',
    result.query,
    '```',
  ].join('\n')
}

function paneColumns(result: QueryResult): number {
  const width = computed(result, freshView(result)).layout.widths.reduce((sum, w) => sum + w + GAP, 2)
  const list = GROUP_OPTIONS.reduce((sum, option) => sum + option.length + GAP, nameWidth(result) + 2)
  return Math.min(100, Math.max(48, width, list))
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function currentView(result: QueryResult, stored: QueryView | null): QueryView {
  return stored && stored.resultId === result.id ? { ...freshView(result), ...stored } : freshView(result)
}

function entryLabel(entry: QueryResult): string {
  const rows = entry.rows.length
  const columns = entry.columns.length
  return `${entry.source}: ${countText(rows)} ${rows === 1 ? 'row' : 'rows'} × ${columns} ${columns === 1 ? 'column' : 'columns'}`
}

function kept(results: QueryResult[], keep: string): QueryResult[] {
  const list: QueryResult[] = []
  let rows = 0
  for (const result of results) {
    if (result.id !== keep && (list.length >= HISTORY || rows + result.rows.length > HISTORY_ROWS)) continue
    list.push(result)
    rows += result.rows.length
  }
  return list
}

async function shownResult($: EngineInterface): Promise<QueryResult | null> {
  const id = await read($, shownAtom)
  if (id === '') return null
  return (await read($, resultsAtom)).find(result => result.id === id) ?? null
}

async function canFollow($: EngineInterface, current: QueryResult | null, next: QueryResult): Promise<boolean> {
  if (!current) return true
  if (current.isPrimary && !next.isPrimary) return false
  if ((await read($, panelAtom)) !== 'table') return false
  return isDefaultView(current, currentView(current, await read($, viewAtom)))
}

async function showResult($: EngineInterface, result: QueryResult, keepsView: boolean, before: QueryResult | null): Promise<void> {
  const stored = await read($, viewAtom)
  const own = before && stored && stored.resultId === before.id ? stored : null
  const held = keepsView && before && own && sameColumns(before, result) ? own : null
  const saved = (await read($, viewsAtom)).find(view => view.resultId === result.id) ?? null
  await update($, viewsAtom, views => [
    ...views.filter(view => view.resultId !== result.id && view.resultId !== before?.id),
    ...(own && !held ? [own] : []),
  ])
  await update($, shownAtom, () => result.id)
  await update($, viewAtom, () => (held ? { ...held, resultId: result.id } : saved ?? freshView(result)))
  await update($, unseenAtom, ids => ids.filter(id => id !== result.id))
  await update($, undoAtom, () => null)
  await update($, firstRowAtom, () => 0)
  await update($, loadingAtom, () => '')
  await update($, askedAtom, () => '')
  if (!held) {
    await update($, panelAtom, () => 'table' as QueryPanel)
    await update($, firstColumnAtom, () => 0)
  }
}

async function reveal($: EngineInterface, result: QueryResult): Promise<void> {
  const opened = await $.ui.open({ id: PANE, title: TITLE, columns: paneColumns(result) })
  $.ui.status(opened.isPlaced ? undefined : WAITING)
}

async function store($: EngineInterface, capture: Capture, placement: Placement, replaces = ''): Promise<void> {
  const results = await read($, resultsAtom)
  const current = await shownResult($)
  const twin = placement === 'auto' ? results.find(entry => entry.source === capture.source && sameData(entry, capture.table)) : undefined
  if (twin && twin.id === current?.id) return
  loads += 1
  const result: QueryResult = twin ?? {
    ...capture.table,
    id: `${capture.id}#${loads}`,
    source: capture.source,
    query: capture.query,
    reload: capture.reload ?? null,
    isPrimary: capture.isPrimary,
  }
  const isShown = placement !== 'auto' || (await canFollow($, current, result))
  const others = results.filter(entry => entry.id !== result.id && entry.id !== replaces)
  await update($, resultsAtom, () => kept([result, ...others], isShown ? result.id : current?.id ?? ''))
  const ids = new Set((await read($, resultsAtom)).map(entry => entry.id))
  await update($, viewsAtom, views => views.filter(view => ids.has(view.resultId)))
  await update($, unseenAtom, unseen => unseen.filter(id => ids.has(id)))
  if (!isShown) {
    if (ids.has(result.id)) await update($, unseenAtom, unseen => [result.id, ...unseen.filter(id => id !== result.id)])
    return
  }
  await showResult($, result, placement === 'keep', current)
  if ((result.isPrimary && opensOnTable) || placement !== 'auto') await reveal($, result)
}

async function storeFound($: EngineInterface, found: Found[], text: string, meta: { id: string; source: string; query: string; isPrimary: boolean }): Promise<void> {
  for (const [k, f] of found.entries()) {
    const caption = captionOf(text, f.line)
    const query = meta.query !== '' ? (found.length > 1 ? `${meta.query} (table ${k + 1} of ${found.length})` : meta.query) : caption
    await store($, { table: f.table, id: `${meta.id}:${k}`, source: meta.source, query, isPrimary: meta.isPrimary && PRIMARY_FORMATS.includes(f.format) }, 'auto')
  }
}

async function captureText($: EngineInterface, text: string, kind: TextKind, meta: { id: string; source: string }): Promise<void> {
  const found = findTables(text, kind)
  for (const [k, f] of found.entries()) {
    await store($, { table: f.table, id: `${meta.id}:${k}`, source: meta.source, query: captionOf(text, f.line), isPrimary: false }, 'auto')
  }
}

async function readTable($: EngineInterface, path: string, isAsked: boolean): Promise<QueryTable | string> {
  if (PARQUET_FILE.test(path)) return `${path} is a Parquet file; write it to CSV first, for example in DuckDB: COPY (FROM '${path}') TO 'result.csv'.`
  const stat = await $.fs.stat(path).catch(() => undefined)
  if (!stat || stat.kind !== 'file') return `${path} is not a file.`
  if (stat.size > FILE_LIMIT) return `${path} is ${(stat.size / 1024 / 1024).toFixed(1)} MiB; the data explorer reads files up to 4 MiB.`
  if (XLSX_FILE.test(path)) return parseXlsx((await $.fs.read(path, { as: 'bytes' })).base64) ?? `${path} holds no sheet with a table.`
  const text = await $.fs.read(path)
  if (!isAsked && /\.json$/i.test(path) && !text.replace(/^﻿/, '').trimStart().startsWith('[')) return `${path} is not a JSON array.`
  return parseFile(path, text) ?? `${path} holds no table: the data explorer reads CSV, TSV, a JSON array of objects, or JSON lines.`
}

async function fileBehind($: EngineInterface, command: string, table: QueryTable): Promise<{ table: QueryTable; path: string } | null> {
  const paths = [...command.matchAll(PATH_IN_COMMAND)].map(match => match[1] ?? match[2] ?? match[3] ?? '').filter(path => path !== '')
  for (const path of paths.slice(0, 3)) {
    const drive = /^\/([a-z])\/(.*)$/i.exec(path)
    for (const candidate of drive ? [path, `${(drive[1] ?? '').toUpperCase()}:/${drive[2] ?? ''}`] : [path]) {
      const whole = await readTable($, candidate, false).catch(() => '')
      if (typeof whole !== 'string' && sameColumns(whole, table) && whole.rows.length >= table.rows.length) return { table: whole, path: candidate }
    }
  }
  return null
}

async function captureRead($: EngineInterface, path: string, id: string, where: string, isRead: boolean): Promise<void> {
  if (!isRead && !XLSX_FILE.test(path)) return
  if (TABLE_FILE.test(path) || XLSX_FILE.test(path)) {
    const table = await readTable($, path, false)
    if (typeof table !== 'string') await store($, { table, id, source: `File${where}`, query: path, isPrimary: true }, 'auto')
    else if (table.includes('MiB')) $.ui.toast(`Data explorer: ${table}`)
    return
  }
  if (!DOCUMENT_FILE.test(path)) return
  const stat = await $.fs.stat(path).catch(() => undefined)
  if (!stat || stat.kind !== 'file' || stat.size > FILE_LIMIT) return
  const text = await $.fs.read(path)
  await storeFound($, findTables(text, 'document'), text, { id, source: `File${where}`, query: path, isPrimary: false })
}

async function capturePowerBi($: EngineInterface, input: Record<string, unknown>, text: string, id: string, where: string): Promise<void> {
  const queries = Array.isArray(input.daxQueries) ? input.daxQueries.map(String) : []
  const maxRows = typeof input.maxRows === 'number' ? input.maxRows : DEFAULT_MAX_ROWS
  const table = parsePowerBi(text, maxRows)
  if (!table) return
  const reload =
    typeof input.artifactId === 'string' && queries[0] !== undefined
      ? { server: POWER_BI_SERVER, tool: POWER_BI_TOOL, artifactId: input.artifactId, daxQuery: queries[0], maxRows }
      : null
  await store($, { table, id, source: `Power BI${where}`, query: queries.join('\n'), isPrimary: true, reload }, 'auto')
}

async function captureCall($: EngineInterface, tool: string, input: Record<string, unknown>, ran: unknown): Promise<void> {
  const where = typeof input.agentId === 'string' ? ' in a subagent' : ''
  const id = String(input.tool_use_id ?? tool)
  const r = succeeded(ran)
  if (tool === 'Read') return captureRead($, String(input.file_path ?? ''), id, where, r !== null)
  if (!r) return
  const text = outputText(r)
  if (text === null || text.trim() === '' || text.length > FILE_LIMIT) return
  if (tool === POWER_BI_NAME) return capturePowerBi($, input, text, id, where)
  const found = findTables(text, 'output')
  if (found.length === 0) return
  const query = queryOf(tool, input)
  const isShell = SHELL_TOOL.test(tool)
  const first = found[0]
  if (isShell && found.length === 1 && first) {
    const whole = await fileBehind($, query, first.table)
    if (whole) return store($, { table: whole.table, id, source: `File${where}`, query: whole.path, isPrimary: true }, 'auto')
  }
  await storeFound($, found, text, { id, source: `${sourceOf(tool)}${where}`, query, isPrimary: isShell })
}

export const register: Register = (on, options) => {
  opensOnTable = options?.open !== 'off'

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'data-explorer',
      description: 'Show the tables Claude ran into in the data explorer pane',
    })
    await $.tool.register({
      name: FILE_TOOL,
      description: FILE_TOOL_DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'The file to show, absolute or relative to the working directory' } },
        required: ['path'],
      },
    })

    return next(e)
  })

  on('tool.call', { tool: FILE_TOOL_NAME }, async ($, e) => {
    const input = e as unknown as { path?: unknown; tool_use_id?: unknown }
    const path = String(input.path ?? '')
    const table = await readTable($, path, true).catch((error: unknown) => `${path} could not be read: ${String(error)}`)
    if (typeof table === 'string') return { deny: table }
    const asked = await read($, askedAtom)
    await store($, { table, id: String(input.tool_use_id ?? 'file'), source: 'File', query: path, isPrimary: true }, asked !== '' ? 'keep' : 'show', asked)
    const rows = table.isCapped ? `the first ${countText(table.rows.length)} of ${countText(table.total)} rows` : `${countText(table.rows.length)} rows`
    return { result: `The data explorer pane shows ${rows} and ${table.columns.length} columns of ${path}.` }
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (!QUIET_TOOL.test(e.tool)) await captureCall($, e.tool, e as unknown as Record<string, unknown>, ran).catch(() => undefined)

    return ran
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    const step = yield* next(e)
    if (e.agentId === undefined && step && step.answer.trim() !== '') {
      await captureText($, step.answer, 'message', { id: `reply-${e.turnId}-${e.index}`, source: 'Claude' }).catch(() => undefined)
    }

    return step
  })

  on('command.run', { command: 'data-explorer' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: TITLE })
    $.ui.status(undefined)

    return { text: opened.isPlaced ? 'Data explorer pane opened.' : `Data explorer pane is open but not drawn: ${opened.reason}` }
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.isMeta) return next(e)
    if (e.origin?.kind !== 'plugin') await captureText($, e.text, 'message', { id: 'prompt', source: 'Your message' }).catch(() => undefined)
    const result = await shownResult($)
    const stored = await read($, viewAtom)
    if (!result || !stored || stored.resultId !== result.id) return next(e)
    const view = currentView(result, stored)
    if (isDefaultView(result, view)) return next(e)
    const signature = viewSignature(view)
    if (signature === (await read($, sentAtom))) return next(e)
    await update($, sentAtom, () => signature)

    return next({ ...e, context: [...(e.context ?? []), contextText(result, view)] })
  }).catch(($, e, next) => next(e))

  on('ui.scroll', { requestId: PANE }, async ($, e, next) => {
    const result = await shownResult($)
    if (!result) return next(e)
    const view = currentView(result, await read($, viewAtom))
    const panel = await read($, panelAtom)
    if (panel === 'tables') return {}
    if (panel === 'group') {
      const last = Math.max(0, result.columns.length - (pageRows - 1))
      await update($, firstColumnAtom, n => Math.min(last, Math.max(0, n + e.by)))
      return {}
    }
    const last = Math.max(0, computed(result, view).shown.kept.length - pageRows)
    await update($, firstRowAtom, n => Math.min(last, Math.max(0, n + e.by)))

    return {}
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (e.surface !== 'terminal' && e.surface !== 'desktop') return next(e)
    const { Box, Button, Input, Text } = $.ui.resolve(e)
    const result = await shownResult($)

    if (!result) {
      return (
        <Box flexDirection="column">
          <Text key="status" dimColor>No table yet.</Text>
          <Text dimColor>
            Tables Claude runs into show up here: query results, CSV, JSON and Excel files, tables in command output, tool results and web pages, and tables in your messages and Claude's replies.
          </Text>
        </Box>
      )
    }

    const results = await read($, resultsAtom)
    const unseen = await read($, unseenAtom)
    const view = currentView(result, await read($, viewAtom))
    const undo = await read($, undoAtom)
    const panel = await read($, panelAtom)
    const loading = await read($, loadingAtom)
    const asked = await read($, askedAtom)
    const canUndo = undo !== null && undo.resultId === result.id && isDefaultView(result, view)

    const apply = async (fn: (v: QueryView) => QueryView) => {
      const held: { next?: QueryView; reorders?: boolean } = {}
      await update($, viewAtom, v => {
        if (!v || v.resultId !== result.id) return v
        const before = currentView(result, v)
        const after = fn(before)
        if (viewSignature(after) === viewSignature(before)) return v
        held.next = after
        held.reorders =
          after.filter !== before.filter ||
          JSON.stringify(after.sort) !== JSON.stringify(before.sort) ||
          JSON.stringify(after.group) !== JSON.stringify(before.group)
        return after
      })
      if (!held.next) return
      await update($, undoAtom, () => null)
      if (held.reorders) await update($, firstRowAtom, () => 0)
      if (isDefaultView(result, held.next)) await update($, panelAtom, p => (p === 'changes' ? 'table' : p))
    }
    const change = (fn: (v: QueryView) => QueryView) => () => apply(fn)
    const noop = () => undefined
    const setFilter = (value: string) => apply(v => ({ ...v, filter: value }))
    const togglePanel = (target: QueryPanel) => () => update($, panelAtom, p => (p === target ? 'table' : target))
    const backToTable = () => update($, panelAtom, () => 'table' as QueryPanel)
    const leaveTables = async () => {
      await update($, unseenAtom, () => [])
      await backToTable()
    }
    const toggleTables = () => (panel === 'tables' ? leaveTables() : update($, panelAtom, () => 'tables' as QueryPanel))
    const pick = (entry: QueryResult) => async () => {
      if (entry.id !== result.id) {
        await showResult($, entry, false, result)
        await $.ui.open({ id: PANE, title: TITLE, columns: paneColumns(entry) })
      }
      await leaveTables()
    }
    const reset = async () => {
      await update($, undoAtom, () => view)
      await update($, viewAtom, () => freshView(result))
      await update($, panelAtom, () => 'table' as QueryPanel)
      await update($, firstRowAtom, () => 0)
    }
    const undoReset = async () => {
      if (!canUndo || !undo) return
      await update($, viewAtom, () => undo)
      await update($, undoAtom, () => null)
      await update($, firstRowAtom, () => 0)
    }
    const typeFilter = async () => {
      await $.ui.open({ id: PANE, title: TITLE, focus: true })
      const pane = (await $.ui.panes()).find(p => p.id === PANE)
      if (!pane?.isFocused) $.ui.toast(NO_KEYBOARD)
    }

    const loadAll = async () => {
      const reload = result.reload
      if (!reload) return
      await update($, loadingAtom, () => result.id)
      const answer = await $.mcp
        .call(reload.server, reload.tool, { artifactId: reload.artifactId, daxQueries: [reload.daxQuery], maxRows: STORE_CAP })
        .catch((error: unknown) => ({ content: [{ type: 'text', text: String(error) }], isError: true }))
      const text = blocksText(answer.content)
      const table = answer.isError ? null : parsePowerBi(text, STORE_CAP)
      if (table) {
        const capture = { table, id: result.id, source: result.source, query: reload.daxQuery, isPrimary: true, reload: { ...reload, maxRows: STORE_CAP } }
        await store($, capture, 'keep', result.id)
        return
      }
      await update($, loadingAtom, () => '')
      $.ui.toast(`Data explorer: Power BI did not return the rows. ${oneLine(text).slice(0, 160)}`)
    }
    const askClaude = async () => {
      await update($, askedAtom, () => result.id)
      await $.prompt.submit({ text: askText(result) }).catch(async () => {
        await update($, askedAtom, () => '')
        $.ui.toast('Data explorer: the request to Claude did not go through')
      })
    }
    const allRows = !result.isCapped
      ? null
      : result.reload && result.reload.maxRows < STORE_CAP
        ? loading === result.id
          ? { label: 'loading all rows', isDim: true, press: noop }
          : { label: 'load all rows', isDim: false, press: loadAll }
        : result.query.trim() !== '' && !result.source.startsWith('File')
          ? asked === result.id
            ? { label: 'asked Claude for all rows', isDim: true, press: noop }
            : { label: 'ask Claude for all rows', isDim: false, press: askClaude }
          : null

    const { shown: found, layout } = computed(result, view)
    const { table, order, kept: keptRows, matched } = found
    const rows = rowsColumn(result)
    const name = (c: number) => table.columns[c] ?? `column ${c + 1}`
    const { kinds, widths } = layout
    const bodyColumns = Math.max(20, e.props.bodyColumns || 80)
    const { fitting, past } = fitColumns(order, widths, bodyColumns)
    const notes = result.note === '' ? '' : `${result.note}.`
    const changes = viewChanges(result, view)
    const buttonLines = lineCount([...BUTTON_LABELS.map(label => label.length + 4), CONTROL_WIDTH], bodyColumns, GAP)
    const showChanges = panel === 'changes' && changes.length > 0
    const showGroup = panel === 'group'
    const showTables = panel === 'tables'
    const showRows = !showChanges && !showGroup && !showTables
    pageRows = Math.max(1, (e.props.scroll?.bodyRows || 40) - (7 + buttonLines))
    const first = Math.min(await read($, firstRowAtom), Math.max(0, keptRows.length - pageRows))
    const indexes = keptRows.slice(first, first + pageRows)
    const hasMeasures = order.some(c => kinds[c] === 'measure')
    const cellWidth = (c: number, i: number) => (widths[c] ?? MIN_WIDTH) + (i < fitting.length - 1 ? GAP : 0)
    const align = (c: number) => (kinds[c] === 'text' ? 'flex-start' : 'flex-end')

    const listed = [...view.order, ...view.hidden]
    const listRoom = Math.max(1, pageRows - 1)
    const firstListed = Math.min(await read($, firstColumnAtom), Math.max(0, listed.length - listRoom))
    const listedShown = listed.slice(firstListed, firstListed + listRoom)
    const footer = showGroup
      ? listed.length > listRoom
        ? `columns ${footerText(firstListed, listedShown.length, listed.length)}`
        : ''
      : showTables
        ? ''
        : footerText(first, indexes.length, keptRows.length)

    const copy = async (surface: RenderSurface) => {
      const done = await $.ui.copy({ text: copyText(table, order, keptRows), surface })
      $.ui.toast(
        done.isCopied
          ? `Copied ${countText(keptRows.length)} ${keptRows.length === 1 ? 'row' : 'rows'} and ${order.length} columns, tab-separated`
          : `Data explorer: nothing copied (${done.reason})`,
      )
    }

    const controlLabel = canUndo ? 'Undo reset' : changes.length === 0 ? 'Default view' : `${changes.length} ${changes.length === 1 ? 'change' : 'changes'}`
    const pressControl = canUndo ? undoReset : changes.length === 0 ? noop : togglePanel('changes')
    const tablesLabel = `${results.length} ${results.length === 1 ? 'table' : 'tables'}${unseen.length > 0 ? `, ${unseen.length} new` : ''}`

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" height={1} overflow="hidden" columnGap={GAP}>
          <Box flexShrink={1}>
            <Text wrap="truncate-end">
              {scopeText(result, view, matched, keptRows.length)}
              {notes !== '' && <Text dimColor>{` ${notes}`}</Text>}
            </Text>
          </Box>
          {allRows && (
            <Box flexShrink={0}>
              <Button key="all-rows" label={allRows.label} dimColor={allRows.isDim} onPress={allRows.press} />
            </Box>
          )}
        </Box>
        <Box flexDirection="row" height={1} overflow="hidden" columnGap={GAP}>
          <Box flexShrink={1} flexGrow={1}>
            <Text dimColor wrap={SHELL_TOOL.test(result.source) ? 'truncate-start' : 'truncate-end'}>
              {oneLine(result.query) || ' '}
            </Text>
          </Box>
          <Box flexShrink={0}>
            <Button key="tables" onPress={toggleTables}>
              <Text color={unseen.length > 0 ? ACCENT : undefined}>{tablesLabel}</Text>
            </Button>
          </Box>
        </Box>
        <Box flexDirection="row" height={1} overflow="hidden" columnGap={GAP}>
          <Box flexShrink={0}>
            <Button key="type-filter" label="type a filter" dimColor={e.props.isFocused} onPress={typeFilter} />
          </Box>
          <Box flexGrow={1}>
            <Input
              key={`filter-${result.id}`}
              value={view.filter}
              autoFocus
              placeholder={e.props.isFocused ? 'type to keep matching rows, Esc to leave' : 'no filter'}
              submitLabel="done"
              onInput={value => setFilter(value)}
              onSubmit={value => setFilter(value)}
            />
          </Box>
          <Box flexShrink={0}>
            <Button key="clear-filter" plain label=" × " dimColor={view.filter === ''} onPress={view.filter === '' ? noop : () => setFilter('')} />
          </Box>
        </Box>
        <Box flexDirection="row" flexWrap="wrap" height={buttonLines} overflow="hidden" columnGap={GAP}>
          <Button key="group" label="group rows" onPress={togglePanel('group')} />
          <Button
            key="bars"
            label={view.bars ? 'hide data bars' : 'show data bars'}
            dimColor={!hasMeasures}
            onPress={hasMeasures ? change(v => ({ ...v, bars: !v.bars })) : noop}
          />
          <Button key="copy" label="copy table" onPress={press => void copy(press.surface)} />
          <Box width={CONTROL_WIDTH}>
            <Button key="view-state" dimColor={changes.length === 0 && !canUndo} onPress={pressControl}>
              <Text color={changes.length > 0 ? ACCENT : undefined}>{controlLabel}</Text>
            </Button>
          </Box>
        </Box>
        <Box flexDirection="row" height={1} overflow="hidden" columnGap={GAP}>
          <Box flexShrink={0}>
            <Text dimColor>{columnsText(order.length, past)}</Text>
          </Box>
          {past.map(c => (
            <Box flexShrink={0}>
              <Button key={`front-${c}`} plain label={name(c)} dimColor={c === rows} onPress={c === rows ? noop : change(v => bringToFront(v, c))} />
            </Box>
          ))}
        </Box>
        <Box flexDirection="row" height={1} overflow="hidden">
          {fitting.map((c, i) => {
            const kind = kinds[c] ?? 'text'
            const isSorted = view.sort?.column === c
            return (
              <Box width={cellWidth(c, i)} paddingRight={i < fitting.length - 1 ? GAP : 0} justifyContent={align(c)}>
                <Button key={`sort-${c}`} plain onPress={change(v => cycleSort(v, c, isDescendingFirst(kind)))}>
                  <Text bold color={isSorted ? ACCENT : undefined}>{headLabel(name(c), kind, view, c)}</Text>
                </Button>
              </Box>
            )
          })}
        </Box>
        <Box flexDirection="row" height={1} overflow="hidden">
          {fitting.map((c, i) => (
            <Box width={cellWidth(c, i)} paddingRight={i < fitting.length - 1 ? GAP : 0} justifyContent={align(c)}>
              {c !== rows && <Button key={`left-${c}`} plain dimColor label=" ‹ " onPress={change(v => moveColumn(result, v, c, -1))} />}
              {c !== rows && <Button key={`right-${c}`} plain dimColor label=" › " onPress={change(v => moveColumn(result, v, c, 1))} />}
              {c !== rows && <Button key={`hide-${c}`} plain dimColor label=" × " onPress={change(v => hideColumn(v, c))} />}
            </Box>
          ))}
        </Box>
        {showChanges && (
          <Box flexDirection="column">
            <Button key="back-to-table" label="Back to table" onPress={backToTable} />
            {changes.map(item => (
              <Button key={item.key} plain onPress={change(item.clear)}>
                <Text wrap="truncate-end">
                  <Text dimColor>× </Text>
                  {item.text}
                </Text>
              </Button>
            ))}
            <Button key="reset" plain onPress={reset}>
              <Text color={ACCENT}>Reset to default view</Text>
            </Button>
          </Box>
        )}
        {showGroup && (
          <Box flexDirection="column">
            <Box flexDirection="row" height={1} overflow="hidden" columnGap={GAP}>
              <Button key="back-to-table" label="Back to table" onPress={backToTable} />
              <Button key="ungroup" label="ungroup" dimColor={!view.group} onPress={view.group ? change(v => ungroup(result, v)) : noop} />
            </Box>
            {listedShown.map(c => {
              const role = roleOf(view, c)
              return (
                <Box flexDirection="row" height={1} overflow="hidden" columnGap={GAP}>
                  <Box width={nameWidth(result)} flexShrink={0}>
                    <Text dimColor={view.hidden.includes(c)} wrap="truncate-end">
                      {result.columns[c] ?? ''}
                    </Text>
                  </Box>
                  {GROUP_OPTIONS.map(option => {
                    const isAvailable = option === 'group' || canAggregate(result, c, option)
                    const press = !isAvailable
                      ? noop
                      : option === 'group'
                        ? change(v => toggleKey(result, v, c))
                        : change(v => setAggregation(result, v, c, option))
                    return (
                      <Button key={`role-${c}-${option}`} plain dimColor={!isAvailable} onPress={press}>
                        <Text color={role === option ? ACCENT : undefined}>{option}</Text>
                      </Button>
                    )
                  })}
                </Box>
              )
            })}
          </Box>
        )}
        {showTables && (
          <Box flexDirection="column">
            <Button key="back-to-table" label="Back to table" onPress={leaveTables} />
            {results.slice(0, listRoom).map((entry, n) => (
              <Button key={`table-${n}`} plain onPress={pick(entry)}>
                <Text wrap="truncate-end">
                  <Text color={entry.id === result.id ? ACCENT : undefined}>{entryLabel(entry)}</Text>
                  {unseen.includes(entry.id) && <Text color={ACCENT}>{' new'}</Text>}
                  <Text dimColor>{`  ${oneLine(entry.query)}`}</Text>
                </Text>
              </Button>
            ))}
          </Box>
        )}
        {showRows && result.rows.length === 0 && <Text dimColor>The table has no rows.</Text>}
        {showRows && result.rows.length > 0 && indexes.length === 0 && <Text dimColor>No row matches the filter.</Text>}
        {(showRows ? indexes : []).map((r, n) => (
          <Text key={`row-${n}`} wrap="truncate-end">
            {rowSegments(table, layout, r, fitting, view.bars).map(s =>
              s.isDim || s.isBar ? (
                <Text dimColor={s.isDim} backgroundColor={s.isBar ? BAR : undefined}>
                  {s.text}
                </Text>
              ) : (
                s.text
              ),
            )}
          </Text>
        ))}
        <Text dimColor>{footer}</Text>
      </Box>
    )
  })
}
