export type QueryCell = string | null

export type QuerySource = string

export type QueryTable = {
  columns: string[]
  numeric: boolean[]
  rows: QueryCell[][]
  total: number
  isTotalMinimum?: boolean
  isCapped: boolean
  note: string
}

export type QueryReload = {
  server: string
  tool: string
  artifactId: string
  daxQuery: string
  maxRows: number
}

export type QueryResult = QueryTable & {
  id: string
  source: QuerySource
  query: string
  reload?: QueryReload | null
  isPrimary: boolean
}

export type QuerySort = { column: number; isDescending: boolean }

export type QueryAggregation = 'sum' | 'mean' | 'min' | 'max' | 'count' | 'distinct'

export type QueryMeasure = QueryAggregation | 'off'

export type QueryGroup = { keys: number[]; aggregations: QueryMeasure[] }

export type QueryPanel = 'table' | 'changes' | 'group' | 'tables'

export type QueryView = {
  resultId: string
  sort: QuerySort | null
  filter: string
  order: number[]
  hidden: number[]
  bars: boolean
  group: QueryGroup | null
}

declare module 'claude-code' {
  interface PluginState {
    'data-explorer': {
      results: QueryResult[]
      shown: string
      views: QueryView[]
      unseen: string[]
      view: QueryView | null
      undo: QueryView | null
      panel: QueryPanel
      firstRow: number
      firstColumn: number
      sent: string
      loading: string
      asked: string
    }
  }
}
