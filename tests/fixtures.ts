export const COMPLETE = [
  '┌───────┬─────────┬────────────┐',
  '│ year  │   sex   │ population │',
  '│ int32 │ varchar │   int128   │',
  '├───────┼─────────┼────────────┤',
  '│  2022 │ F       │    5875106 │',
  '│  2022 │ M       │    5708902 │',
  '│  2023 │ F       │    5936147 │',
  '│  2023 │ M       │    5761410 │',
  '│  2024 │ F       │    5966425 │',
  '│  2024 │ M       │    5797225 │',
  '│  2025 │ F       │    5995529 │',
  '│  2025 │ M       │    5830022 │',
  '│  2026 │ F       │    6016477 │',
  '│  2026 │ M       │    5851157 │',
  '└───────┴─────────┴────────────┘',
  '  10 rows            3 columns',
].join('\n')

export const CAPPED = [
  '┌───────┬─────────┬────────────┐',
  '│ year  │   sex   │ population │',
  '│ int32 │ varchar │   int128   │',
  '├───────┼─────────┼────────────┤',
  '│  1992 │ F       │    5122765 │',
  '│  1992 │ M       │    4899232 │',
  '│  1993 │ F       │    5144847 │',
  '│    ·  │ ·       │       ·    │',
  '│    ·  │ ·       │       ·    │',
  '│    ·  │ ·       │       ·    │',
  '│  2025 │ M       │    5830022 │',
  '│  2026 │ F       │    6016477 │',
  '│  2026 │ M       │    5851157 │',
  '└───────┴─────────┴────────────┘',
  '  70 rows (20 shown) 3 columns',
].join('\n')

export const MISSING_VALUE = [
  '┌───────┬───────────┬────────┐',
  '│ year  │   state   │ births │',
  '│ int32 │  varchar  │ int64  │',
  '├───────┼───────────┼────────┤',
  '│  2024 │ measured  │ 116021 │',
  '│  2025 │ measured  │ 113870 │',
  '│  2026 │ projected │ 114220 │',
  '│  2027 │ projected │   NULL │',
  '└───────┴───────────┴────────┘',
  '  4 rows      3 columns',
].join('\n')

function duckbox(header: string[], types: string[], rows: string[][]): string {
  const widths = header.map((name, c) => Math.max(name.length, types[c]?.length ?? 0, ...rows.map(row => row[c]?.length ?? 0)) + 2)
  const rule = (left: string, middle: string, right: string) => left + widths.map(w => '─'.repeat(w)).join(middle) + right
  const line = (cells: string[]) => `│${cells.map((cell, c) => ` ${cell.padEnd((widths[c] ?? 2) - 2)} `).join('│')}│`
  return [
    rule('┌', '┬', '┐'),
    line(header),
    line(types),
    rule('├', '┼', '┤'),
    ...rows.map(line),
    rule('└', '┴', '┘'),
    `  ${rows.length} rows      ${header.length} columns`,
  ].join('\n')
}

export const SHARES = duckbox(
  ['region', 'share'],
  ['varchar', 'double'],
  [
    ['a', '0.1'],
    ['a', '0.2'],
    ['b', '0.25'],
    ['b', ''],
  ],
)

export const TALL = duckbox(
  ['year', 'name', 'amount'],
  ['int32', 'varchar', 'int64'],
  Array.from({ length: 50 }, (_, i) => [String(2000 + i), `row ${i + 1}`, String(1000000 + i)]),
)

export const PYTHON_CAPPED = [
  '┌────────────────────────┐',
  '│           n            │',
  '│         int64          │',
  '├────────────────────────┤',
  '│                      0 │',
  '│                      1 │',
  '│                      · │',
  '│                      · │',
  '│                   9998 │',
  '│                   9999 │',
  '└────────────────────────┘',
  '          ? rows        ',
  '  (>9999 rows, 20 shown)',
].join('\n')

export const POPULATION_CSV = [
  'year,sex,population',
  ...Array.from({ length: 60 }, (_, i) => `${1967 + Math.floor(i / 2)},${i % 2 === 0 ? 'F' : 'M'},${5000000 + i * 1000}`),
].join('\n')

export function powerBiRows(count: number): string {
  return JSON.stringify(Array.from({ length: count }, (_, i) => ({ 'Date[Year]': 2000 + i, '[Sales]': 100 + i })))
}
