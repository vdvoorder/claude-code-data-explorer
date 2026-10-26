import { describe, expect, test } from 'claude-code/testing'

import { STORE_CAP, parseDelimited, parseDuckbox, parseFile, parseMarkdownTable, parsePowerBi } from '../hooks/parse'
import { COMPLETE, CAPPED, PYTHON_CAPPED } from './fixtures'

describe('DuckDB box tables', () => {
  test('a complete result keeps every row and reads numeric types from the type row', () => {
    const table = parseDuckbox(COMPLETE)
    expect(table?.columns).toEqual(['year', 'sex', 'population'])
    expect(table?.numeric).toEqual([true, false, true])
    expect(table?.rows).toHaveLength(10)
    expect(table?.rows[0]).toEqual(['2022', 'F', '5875106'])
    expect(table?.isCapped).toBe(false)
    expect(table?.total).toBe(10)
  })

  test('a result DuckDB shortened is capped, skips the dot rows and keeps the full count', () => {
    const table = parseDuckbox(CAPPED)
    expect(table?.rows).toHaveLength(6)
    expect(table?.isCapped).toBe(true)
    expect(table?.total).toBe(70)
    expect(table?.rows.some(row => row.includes('·'))).toBe(false)
  })

  test('text without a box table is ignored', () => {
    expect(parseDuckbox('On branch main\nnothing to commit')).toBeNull()
    expect(parseDuckbox('a ┌ stray corner')).toBeNull()
  })

  test('the last table wins when the output holds two', () => {
    const table = parseDuckbox(`${CAPPED}\n${COMPLETE}`)
    expect(table?.rows).toHaveLength(10)
  })
})

describe('Power BI ExecuteQuery formats (unverified until a real call)', () => {
  test('the executeQueries REST shape: rows as objects keyed by column', () => {
    const text = JSON.stringify({
      results: [{ tables: [{ rows: [{ 'Date[Year]': 2024, '[Sales]': 12.5 }, { 'Date[Year]': 2025, '[Sales]': null }] }] }],
    })
    const table = parsePowerBi(text, 250)
    expect(table?.columns).toEqual(['Date[Year]', '[Sales]'])
    expect(table?.numeric).toEqual([true, true])
    expect(table?.rows).toEqual([['2024', '12.5'], ['2025', null]])
    expect(table?.isCapped).toBe(false)
  })

  test('JSON after a line of prose still parses', () => {
    const text = `Query results:\n${JSON.stringify([{ a: 'x', b: 1 }])}`
    expect(parsePowerBi(text, 250)?.rows).toEqual([['x', '1']])
  })

  test('a columns array beside rows as arrays', () => {
    const text = JSON.stringify({ columns: [{ name: 'Product[Color]' }, { name: '[Qty]' }], rows: [['Red', 3], ['Blue', 4]] })
    const table = parsePowerBi(text, 250)
    expect(table?.columns).toEqual(['Product[Color]', '[Qty]'])
    expect(table?.rows).toEqual([['Red', '3'], ['Blue', '4']])
  })

  test('a result that reaches maxRows is marked capped', () => {
    const text = JSON.stringify([{ a: 1 }, { a: 2 }])
    const table = parsePowerBi(text, 2)
    expect(table?.isCapped).toBe(true)
    expect(table?.note).toContain('maxRows (2)')
  })

  test('two result tables show the first and say so', () => {
    const text = JSON.stringify({ results: [{ tables: [{ rows: [{ a: 1 }] }] }, { tables: [{ rows: [{ b: 2 }] }] }] })
    const table = parsePowerBi(text, 250)
    expect(table?.columns).toEqual(['a'])
    expect(table?.note).toBe('Showing result 1 of 2')
  })

  test('a markdown table', () => {
    const table = parseMarkdownTable('| Year | Sales |\n|---|---:|\n| 2024 | 10.5 |\n| 2025 | 11 |')
    expect(table?.columns).toEqual(['Year', 'Sales'])
    expect(table?.numeric).toEqual([true, true])
    expect(table?.rows).toHaveLength(2)
  })

  test('a CSV table with a quoted comma', () => {
    const table = parseDelimited('Name,Amount\n"Brussels, City",12\nGhent,7')
    expect(table?.rows).toEqual([['Brussels, City', '12'], ['Ghent', '7']])
    expect(table?.numeric).toEqual([false, true])
  })

  test('plain prose is not a table', () => {
    expect(parsePowerBi('The query failed: column not found.', 250)).toBeNull()
  })
})

describe('files and footers', () => {
  test('the Python footer "(>9999 rows, 20 shown)" gives a lower bound for the row count', () => {
    const table = parseDuckbox(PYTHON_CAPPED)
    expect(table?.rows).toHaveLength(4)
    expect(table?.total).toBe(9999)
    expect(table?.isTotalMinimum).toBe(true)
    expect(table?.isCapped).toBe(true)
  })

  test('a semicolon CSV with a byte order mark, a quoted line break and decimal commas', () => {
    const table = parseFile('data.csv', '﻿gemeente;inwoners;aandeel\n"Sint-Niklaas\nWaas";80000;1,5\nGent;265000;4,2\n')
    expect(table?.columns).toEqual(['gemeente', 'inwoners', 'aandeel'])
    expect(table?.rows).toEqual([['Sint-Niklaas\nWaas', '80000', '1,5'], ['Gent', '265000', '4,2']])
    expect(table?.numeric).toEqual([false, true, false])
  })

  test('a CSV file with a header and no rows, and a CSV file with one column', () => {
    expect(parseFile('empty.csv', 'year,sex\n')?.rows).toEqual([])
    expect(parseFile('ids.csv', 'id\n1\n2\n')?.rows).toEqual([['1'], ['2']])
  })

  test('a CSV file whose rows have different numbers of cells is not a table', () => {
    expect(parseFile('broken.csv', 'a,b\n1,2\n3\n')).toBeNull()
  })

  test('JSON lines, also with a nested value, and a JSON array', () => {
    const lines = parseFile('rows.json', '{"a":1,"b":"x"}\n{"a":2,"b":"y","c":{"d":1}}\n')
    expect(lines?.columns).toEqual(['a', 'b', 'c'])
    expect(lines?.rows).toEqual([['1', 'x', null], ['2', 'y', '{"d":1}']])
    expect(parseFile('rows.ndjson', '{"a":1}\n{"a":2}')?.numeric).toEqual([true])
    expect(parseFile('rows.json', '[{"a":"x"},{"a":"y"}]')?.rows).toEqual([['x'], ['y']])
  })

  test('a TSV file splits on tabs only', () => {
    expect(parseFile('t.tsv', 'name\tnote\nGent\ta, b\n')?.rows).toEqual([['Gent', 'a, b']])
  })

  test('a file past the row limit keeps the first rows and the full count', () => {
    const text = ['n,m', ...Array.from({ length: STORE_CAP + 5 }, (_, i) => `${i},x`)].join('\n')
    const table = parseFile('big.csv', text)
    expect(table?.rows).toHaveLength(STORE_CAP)
    expect(table?.total).toBe(STORE_CAP + 5)
    expect(table?.isCapped).toBe(true)
  })
})
