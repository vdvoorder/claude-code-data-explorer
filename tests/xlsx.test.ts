import { describe, expect, test } from 'claude-code/testing'

import { STORE_CAP } from '../hooks/parse'
import { parseXlsx } from '../hooks/xlsx'
import { CAPPED, EMPTY_SHEET, HAND_BUILT, MAC_1904, NOT_A_WORKBOOK, REALISTIC } from './xlsx-fixtures'

describe('a hand-built workbook', () => {
  const table = parseXlsx(HAND_BUILT)

  test('the first sheet in workbook order is read and the note names it', () => {
    expect(table?.note).toBe('Sheet 1 of 2 (Sales & Costs)')
    expect(table?.total).toBe(4)
    expect(table?.isCapped).toBe(false)
  })

  test('the first non-empty row is the header, empty header cells are numbered and trailing empty columns are dropped', () => {
    expect(table?.columns).toEqual(['name', 'amount', 'column 3', 'column 4', 'date', 'when', 'flag', 'weight', 'duration', 'note'])
  })

  test('shared strings, rich text runs, entities, phonetic runs and escaped characters', () => {
    expect(table?.rows.map(row => row[0])).toEqual(['Brussels City', 'R&D <team>', 'Café €', '東京'])
    expect(table?.rows[3]?.[9]).toBe('tab\there')
  })

  test('inline rich text, a formula string, an error and a formula without a cached value', () => {
    expect(table?.rows.map(row => row[9])).toEqual(['inline', 'R&D x', null, 'tab\there'])
    expect(table?.rows[2]?.[6]).toBe('#DIV/0!')
  })

  test('numbers keep the stored text and booleans read TRUE and FALSE', () => {
    expect(table?.rows.map(row => row[1])).toEqual(['0.1', '5875106', '42', '-2'])
    expect(table?.rows.map(row => row[2])).toEqual(['7', '-3.5E-2', null, null])
    expect(table?.rows.map(row => row[6])).toEqual(['TRUE', 'FALSE', '#DIV/0!', null])
  })

  test('the builtin date format 14, a custom date-time format, a time of day and a quoted "days" format', () => {
    expect(table?.rows.map(row => row[4])).toEqual(['2024-01-01', '2024-01-02', '1900-01-01', null])
    expect(table?.rows.map(row => row[5])).toEqual(['2024-01-01 12:00:00', '2024-01-02', '18:00:00', null])
    expect(table?.rows.map(row => row[7])).toEqual(['12.5', '3', null, null])
  })

  test('an elapsed [h]:mm format reads as a duration in hours', () => {
    expect(table?.rows.map(row => row[8])).toEqual(['36:00:00', '1:30:00', null, null])
  })

  test('cells without references follow order and the gap column stays empty', () => {
    expect(table?.rows[1]).toEqual(['R&D <team>', '5875106', '-3.5E-2', null, '2024-01-02', '2024-01-02', 'FALSE', '3', '1:30:00', 'R&D x'])
    expect(table?.rows.every(row => row[3] === null)).toBe(true)
  })

  test('only plain number columns are numeric, dates are not', () => {
    expect(table?.numeric).toEqual([false, true, true, false, false, false, false, true, false, false])
  })
})

describe('other workbooks', () => {
  test('a workbook written by openpyxl with a few hundred rows', () => {
    const table = parseXlsx(REALISTIC)
    expect(table?.columns).toEqual(['region', 'year', 'population', 'share', 'measured', 'measured at', 'capital', 'column 8', 'comment'])
    expect(table?.numeric).toEqual([false, true, true, true, false, false, false, false, false])
    expect(table?.total).toBe(400)
    expect(table?.rows[0]).toEqual(['Vlaanderen', '1990', '5000000', '0', '2020-01-01', '2021-03-01 08:00:00', 'TRUE', null, 'row 0 note'])
    expect(table?.rows[1]).toEqual(['Wallonië', '1990', '5007919', '0.01', '2020-01-02', '2021-03-01 08:37:00', 'FALSE', null, null])
    expect(table?.rows[399]).toEqual(['Gent & Co', '2029', '8159681', '0.11', '2021-02-03', '2021-03-11 14:03:00', 'TRUE', null, null])
    expect(table?.note).toBe('')
  })

  test('the 1904 date system and namespace-prefixed elements', () => {
    const table = parseXlsx(MAC_1904)
    expect(table?.columns).toEqual(['day'])
    expect(table?.rows).toEqual([['1904-01-02'], ['2024-01-01']])
    expect(table?.numeric).toEqual([false])
  })

  test('a sheet past the row limit keeps the first rows and the full count', () => {
    const table = parseXlsx(CAPPED)
    expect(table?.columns).toEqual(['n'])
    expect(table?.rows).toHaveLength(STORE_CAP)
    expect(table?.rows[0]).toEqual(['7'])
    expect(table?.total).toBe(STORE_CAP + 5)
    expect(table?.isCapped).toBe(true)
    expect(table?.numeric).toEqual([true])
  })

  test('an empty sheet, a zip without a workbook and bytes that are not a zip give null', () => {
    expect(parseXlsx(EMPTY_SHEET)).toBeNull()
    expect(parseXlsx(NOT_A_WORKBOOK)).toBeNull()
    expect(parseXlsx(btoa('year,sex\n2024,F\n'))).toBeNull()
    expect(parseXlsx('')).toBeNull()
    expect(parseXlsx('not base64 at all!')).toBeNull()
    expect(parseXlsx(HAND_BUILT.slice(0, 2000))).toBeNull()
  })
})
