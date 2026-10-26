function placed(parts: [number, string][]): string {
  let line = ''
  for (const [at, text] of parts) line = line.padEnd(at) + text
  return line
}

function rightTo(parts: [number, string][], start = ''): string {
  let line = start
  for (const [end, text] of parts) line = line.padEnd(end - text.length) + text
  return line
}

export const SQLITE_BOX = ['┌────┬────────┐', '│ id │  name  │', '├────┼────────┤', '│ 1  │ Gent   │', '│ 2  │ Brugge │', '└────┴────────┘'].join('\n')

export const POLARS = [
  'shape: (5, 2)',
  '┌──────┬─────┐',
  '│ year ┆ sex │',
  '│ ---  ┆ --- │',
  '│ i64  ┆ str │',
  '╞══════╪═════╡',
  '│ 2022 ┆ F   │',
  '│ …    ┆ …   │',
  '│ 2026 ┆ M   │',
  '└──────┴─────┘',
].join('\n')

export const RICH = ['┏━━━━━━━━┳━━━━━━━┓', '┃ Region ┃ Count ┃', '┡━━━━━━━━╇━━━━━━━┩', '│ Gent   │    12 │', '│ Brugge │     7 │', '└────────┴───────┘'].join('\n')

export const MYSQL = [
  'mysql> select * from towns;',
  '+----+--------+',
  '| id | name   |',
  '+----+--------+',
  '|  1 | Gent   |',
  '|  2 | NULL   |',
  '+----+--------+',
  '2 rows in set (0.00 sec)',
].join('\n')

export const TABULATE_GRID = [
  '+--------+---------+',
  '| town   |   count |',
  '+========+=========+',
  '| Gent   |      12 |',
  '+--------+---------+',
  '| Sint-  |       7 |',
  '| Niklaas |        |',
  '+--------+---------+',
].join('\n')

export const PSQL = [' id | name', '----+-------', '  1 | Gent', '  2 | ', '(2 rows)'].join('\n')

export const GET_CHILD_ITEM = [
  '',
  '    Directory: C:\\git\\rv',
  '',
  placed([[0, 'Mode'], [21, 'LastWriteTime'], [43, 'Length'], [50, 'Name']]),
  placed([[0, '----'], [21, '-------------'], [43, '------'], [50, '----']]),
  placed([[0, 'd----'], [15, '22/10/2026    13:55'], [50, 'agent-config']]),
  placed([[0, '-a---'], [15, '21/10/2026    09:12'], [45, '1234'], [50, 'notes.txt']]),
  '',
].join('\n')

export const SQLCMD = ['name       rows', '---------- -----------', 'Gent                12', 'Brugge               7', '', '(2 rows affected)'].join('\n')

const PANDAS_ENDS = [9, 13, 25]

function pandasRow(index: string, values: string[]): string {
  return rightTo(values.map((value, c): [number, string] => [PANDAS_ENDS[c] ?? 0, value]), index)
}

export const PANDAS = [
  '     year sex  population',
  pandasRow('0', ['2022', 'F', '5875106']),
  pandasRow('1', ['2022', 'M', '5708902']),
  pandasRow('2', ['2023', 'F', '5936147']),
].join('\n')

export const PANDAS_TRUNCATED = [
  '     year sex  population',
  pandasRow('0', ['2022', 'F', '5875106']),
  pandasRow('1', ['2022', 'M', '5708902']),
  pandasRow('..', ['...', '..', '...']),
  pandasRow('58', ['2026', 'F', '6016477']),
  pandasRow('59', ['2026', 'M', '5851157']),
  '',
  '[60 rows x 3 columns]',
].join('\n')

export const HTML = [
  '<html><body><p>Towns</p>',
  '<table class="data"><thead><tr><th>Gemeente</th><th>Inwoners</th></tr></thead>',
  '<tbody><tr><td>Gent</td><td>265000</td></tr><tr><td>Sint-Niklaas &amp; Waas</td><td>80000</td></tr></tbody></table>',
  '</body></html>',
].join('\n')

export const REPLY = [
  'The query returns three regions.',
  '',
  'Population per region:',
  '',
  '| Region | Population |',
  '|---|---:|',
  '| **Brussels** | 1,234,567 |',
  '| Flanders \\| VL | 6,789,000 |',
  '',
  'Flanders is the largest.',
].join('\n')

export const CSV_IN_OUTPUT = ['Wrote 3 rows', 'year,sex,population', '2022,F,5875106', '2022,M,5708902', '2023,F,5936147', 'Done'].join('\n')

export const PROSE = [
  'First, we load the data, then we sort it.',
  'Next, we group it, then we count the rows.',
  'Finally, we check it, and we report back.',
].join('\n')

export const TSC_ERRORS = [
  "hooks/register.tsx(430,21): error TS2322: Type 'x' is not assignable to type 'y'.",
  "hooks/view.ts(12,4): error TS2304: Cannot find name 'z'.",
  "hooks/parse.ts(3,9): error TS2307: Cannot find module './nope'.",
].join('\n')

export const FENCED_JSON = ['Here are the rows:', '', '```json', '[{"town": "Gent", "n": 12}, {"town": "Brugge", "n": 7}]', '```'].join('\n')
