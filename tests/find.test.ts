import { describe, expect, test } from 'claude-code/testing'

import { captionOf, findTables } from '../hooks/find'
import { COMPLETE } from './fixtures'
import {
  CSV_IN_OUTPUT,
  FENCED_JSON,
  GET_CHILD_ITEM,
  HTML,
  MYSQL,
  PANDAS,
  PANDAS_TRUNCATED,
  POLARS,
  PROSE,
  PSQL,
  REPLY,
  RICH,
  SQLCMD,
  SQLITE_BOX,
  TABULATE_GRID,
  TSC_ERRORS,
} from './find-fixtures'

function only(text: string, kind: 'output' | 'document' | 'message' = 'output') {
  const found = findTables(text, kind)
  expect(found).toHaveLength(1)
  return found[0]
}

describe('box tables', () => {
  test('a SQLite box table without a type row', () => {
    const found = only(SQLITE_BOX)
    expect(found?.format).toBe('box')
    expect(found?.table.columns).toEqual(['id', 'name'])
    expect(found?.table.rows).toEqual([['1', 'Gent'], ['2', 'Brugge']])
    expect(found?.table.numeric).toEqual([true, false])
  })

  test('a Polars frame: dtype row, elided rows and the shape line', () => {
    const table = only(POLARS)?.table
    expect(table?.columns).toEqual(['year', 'sex'])
    expect(table?.numeric).toEqual([true, false])
    expect(table?.rows).toEqual([['2022', 'F'], ['2026', 'M']])
    expect(table?.total).toBe(5)
    expect(table?.isCapped).toBe(true)
  })

  test('a Rich table with heavy header lines', () => {
    const table = only(RICH)?.table
    expect(table?.columns).toEqual(['Region', 'Count'])
    expect(table?.rows).toEqual([['Gent', '12'], ['Brugge', '7']])
  })

  test('a DuckDB table keeps its type row', () => {
    expect(only(COMPLETE)?.table.numeric).toEqual([true, false, true])
  })
})

describe('grid, psql and dashed tables', () => {
  test('a MySQL table with NULL and its row count footer', () => {
    const found = only(MYSQL)
    expect(found?.format).toBe('grid')
    expect(found?.table.rows).toEqual([['1', 'Gent'], ['2', null]])
    expect(found?.table.total).toBe(2)
    expect(found?.table.isCapped).toBe(false)
  })

  test('a grid with a header rule and a cell over two lines', () => {
    const table = only(TABULATE_GRID)?.table
    expect(table?.columns).toEqual(['town', 'count'])
    expect(table?.rows).toEqual([['Gent', '12'], ['Sint- Niklaas', '7']])
  })

  test('psql output with an empty value and the row footer', () => {
    const found = only(PSQL)
    expect(found?.format).toBe('psql')
    expect(found?.table.columns).toEqual(['id', 'name'])
    expect(found?.table.rows).toEqual([['1', 'Gent'], ['2', null]])
  })

  test('PowerShell Get-ChildItem: right-aligned values that reach left of the dashes', () => {
    const found = only(GET_CHILD_ITEM)
    expect(found?.format).toBe('dashed')
    expect(found?.table.columns).toEqual(['Mode', 'LastWriteTime', 'Length', 'Name'])
    expect(found?.table.rows).toEqual([
      ['d----', '22/10/2026    13:55', null, 'agent-config'],
      ['-a---', '21/10/2026    09:12', '1234', 'notes.txt'],
    ])
  })

  test('sqlcmd output with dash groups', () => {
    const table = only(SQLCMD)?.table
    expect(table?.columns).toEqual(['name', 'rows'])
    expect(table?.rows).toEqual([['Gent', '12'], ['Brugge', '7']])
  })
})

describe('pandas, HTML, markdown and JSON', () => {
  test('a pandas frame with a range index', () => {
    const found = only(PANDAS)
    expect(found?.format).toBe('pandas')
    expect(found?.table.columns).toEqual(['year', 'sex', 'population'])
    expect(found?.table.rows[0]).toEqual(['2022', 'F', '5875106'])
    expect(found?.table.numeric).toEqual([true, false, true])
  })

  test('a truncated pandas frame keeps the full count from its footer', () => {
    const table = only(PANDAS_TRUNCATED)?.table
    expect(table?.rows).toHaveLength(4)
    expect(table?.total).toBe(60)
    expect(table?.isCapped).toBe(true)
  })

  test('an HTML table with entities', () => {
    const found = only(HTML)
    expect(found?.format).toBe('html')
    expect(found?.table.columns).toEqual(['Gemeente', 'Inwoners'])
    expect(found?.table.rows).toEqual([['Gent', '265000'], ['Sint-Niklaas & Waas', '80000']])
  })

  test('a markdown table in a reply: bold, an escaped pipe, thousands separators and the caption above it', () => {
    const found = only(REPLY, 'message')
    expect(found?.table.rows).toEqual([['Brussels', '1234567'], ['Flanders | VL', '6789000']])
    expect(found?.table.numeric).toEqual([false, true])
    expect(captionOf(REPLY, found?.line ?? null)).toBe('Population per region:')
  })

  test('JSON from a tool, JSON lines, and a fenced JSON block in a reply', () => {
    expect(only(JSON.stringify({ value: [{ a: 1, b: 'x' }, { a: 2, b: 'y' }] }))?.table.rows).toEqual([['1', 'x'], ['2', 'y']])
    expect(only('{"a":1}\n{"a":2}')?.table.rows).toEqual([['1'], ['2']])
    expect(only(FENCED_JSON, 'message')?.table.columns).toEqual(['town', 'n'])
  })
})

describe('delimited text and what is not a table', () => {
  test('CSV lines between other output', () => {
    const found = only(CSV_IN_OUTPUT)
    expect(found?.format).toBe('delimited')
    expect(found?.table.rows).toHaveLength(3)
  })

  test('tab-separated cells pasted from a spreadsheet', () => {
    expect(only('can you check these?\ntown\tcount\nGent\t12', 'message')?.table.rows).toEqual([['Gent', '12']])
  })

  test('prose with commas, compiler errors, git status and a document line are not tables', () => {
    expect(findTables(PROSE, 'message')).toHaveLength(0)
    expect(findTables(TSC_ERRORS, 'output')).toHaveLength(0)
    expect(findTables('On branch main\nnothing to commit, working tree clean', 'output')).toHaveLength(0)
    const stat = [' hooks/xlsx.ts          | 556 ++++++++++', ' tests/xlsx-fixtures.ts | 437 ++++++++', ' tests/xlsx.test.ts     |  93 ++', ' 3 files changed, 1086 insertions(+)']
    expect(findTables(stat.join('\n'), 'output')).toHaveLength(0)
    expect(findTables(CSV_IN_OUTPUT, 'document')).toHaveLength(0)
  })

  test('3 MB of log lines and a 60,000-row CSV in command output are scanned within a second each', () => {
    const log = Array.from({ length: 40000 }, (_, i) => `2026-10-25 12:00:${String(i % 60).padStart(2, '0')} INFO worker ${i} finished job, took ${i % 97} ms`).join('\n')
    const csv = ['year,sex,population', ...Array.from({ length: 60000 }, (_, i) => `${1967 + (i % 60)},${i % 2 ? 'M' : 'F'},${5000000 + i}`)].join('\n')
    const timed = (text: string) => {
      const started = performance.now()
      const found = findTables(text, 'output')
      expect(performance.now() - started).toBeLessThan(1000)
      return found
    }
    expect(timed(log)).toHaveLength(0)
    expect(timed(csv)[0]?.table.rows).toHaveLength(60000)
  })

  test('a text with many tables keeps the five largest in text order', () => {
    const tables = Array.from({ length: 7 }, (_, i) =>
      ['| n | m |', '|---|---|', ...Array.from({ length: i + 1 }, (_, r) => `| ${r} | ${i} |`)].join('\n'),
    ).join('\n\n')
    const found = findTables(tables, 'message')
    expect(found.map(f => f.table.rows.length)).toEqual([3, 4, 5, 6, 7])
  })
})
