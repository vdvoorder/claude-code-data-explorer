import { expect, test } from 'claude-code/testing'
import type { Engine as TestEngine, Mounted } from 'claude-code/testing'
import type { On } from 'claude-code'

import { REPLY } from './find-fixtures'
import { CAPPED, COMPLETE, MISSING_VALUE, POPULATION_CSV, SHARES, TALL, powerBiRows } from './fixtures'
import { HAND_BUILT } from './xlsx-fixtures'

const PANE_PROPS = {
  title: 'Data',
  isFocused: false,
  bodyColumns: 80,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
} as const

const SURFACES = ['terminal', 'desktop'] as const

const ROW = /^ *(\d{1,3}(,\d{3})+|20\d\d) {2}/

type Engine = {
  opened: string[]
  focusAsks: number
  toasts: string[]
  copied: string[]
  grantsFocus: boolean
  prompts: string[]
  files: Record<string, string>
  bytes: Record<string, string>
  sizes: Record<string, number>
  mcpCalls: unknown[]
  daxRows: number
  stdout: string
  mcpText: string
  answer: string
}

function engineBeneath(on: On, stdout: string): Engine {
  const engine: Engine = {
    opened: [],
    focusAsks: 0,
    toasts: [],
    copied: [],
    grantsFocus: false,
    prompts: [],
    files: {},
    bytes: {},
    sizes: {},
    mcpCalls: [],
    daxRows: 400,
    stdout,
    mcpText: '',
    answer: '',
  }
  const named = (path: string) => path.split(/[\\/]/).pop() ?? path
  const size = (name: string) => engine.sizes[name] ?? (engine.files[name] ?? engine.bytes[name] ?? '').length
  on('fs.stat', (_$, e) => ({ value: { kind: 'file', size: size(named(e.path)), mtimeMs: 0, isLink: false } }))
  on('fs.read', (_$, e) => ({ value: e.as === 'bytes' ? { base64: engine.bytes[named(e.path)] ?? '' } : engine.files[named(e.path)] ?? '' }))
  on('tool.call', { tool: /^mcp__(claude_ai_Microsoft_365|trace-waterfall)__/ }, () => ({ result: { content: [{ type: 'text', text: engine.mcpText }] } }))
  on('turn.step', async function* (_$, e) {
    const usage = { model: e.model, input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    return { turnId: e.turnId, index: e.index, answer: engine.answer, toolUses: [], stopReason: 'end_turn' as const, usage }
  })
  on('mcp.call', (_$, e) => {
    engine.mcpCalls.push(e)
    return { value: { content: [{ type: 'text', text: powerBiRows(engine.daxRows) }], isError: false } }
  })
  on('tool.call', { tool: 'Read' }, () => ({ result: 'read' }))
  on('tool.call', { tool: 'mcp__claude_ai_Power_BI__ExecuteQuery' }, () => ({ result: { content: [{ type: 'text', text: powerBiRows(250) }] } }))
  on('ui.open', (_$, e) => {
    engine.opened.push(e.id)
    if (e.focus) engine.focusAsks += 1
    return { value: { isPlaced: true } }
  })
  on('ui.panes', () => ({
    value: [{ id: 'data-explorer', title: 'Data', isShown: true, isFocused: engine.grantsFocus, isPlaced: true }],
  }))
  on('ui.toast', (_$, e) => {
    engine.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.copy', (_$, e) => {
    engine.copied.push(e.text)
    return { value: { isCopied: true } }
  })
  on('ui.status', () => ({ value: undefined }))
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: engine.stdout, stderr: '', interrupted: false } }))
  on('prompt.submit', (_$, e) => {
    engine.prompts.push(e.text)
    return { text: e.text, context: e.context }
  })
  return engine
}


function reader(ui: Mounted<(typeof SURFACES)[number], 'Pane'>) {
  const rows = async () => (await ui.findAll({ type: 'Text' })).filter(found => ROW.test(found.text))
  return {
    rows,
    row: async (n: number) => (await rows())[n]?.text ?? '',
    status: async () => (await ui.find({ type: 'Text', text: /^Bash:/ }))?.text,
    control: async () => (await ui.find({ key: 'view-state' }))?.text,
  }
}

async function showFile($: TestEngine, id: string, path: string) {
  const input = { tool: 'mcp__data-explorer__show_file', tool_use_id: id, path }
  return $.tool.call(input as unknown as Parameters<TestEngine['tool']['call']>[0])
}

async function filterKey(ui: Mounted<(typeof SURFACES)[number], 'Pane'>): Promise<string> {
  return (await ui.find({ type: 'Input' }))?.key ?? ''
}

async function mount($: TestEngine, surface: (typeof SURFACES)[number], props: object = PANE_PROPS) {
  return $.ui.mount({ plugin: 'data-explorer', surface, component: 'Pane', requestId: 'data-explorer', props: { ...PANE_PROPS, ...props } })
}

for (const surface of SURFACES) test(`a DuckDB table printed by Bash opens the pane, and sort, filter, hide, move and reset act in place (${surface})`, async ($, on) => {
  const engine = engineBeneath(on, COMPLETE)

  {
    await $.tool.call({ tool: 'Bash', tool_use_id: `call-${surface}`, command: 'uv run python q.py' })
    expect(engine.opened.at(-1)).toBe('data-explorer')
    const ui = await mount($, surface)
    const { rows, row, status, control } = reader(ui)

    expect(await status()).toBe('Bash: 10 rows, complete.')
    expect(await row(0)).toMatch(/^ *2022 {2}F +5,875,106$/)
    expect(await rows()).toHaveLength(10)
    expect(await control()).toBe('Default view')

    await ui.press({ key: 'sort-2' })
    expect(await row(0)).toContain('6,016,477')
    expect((await ui.find({ key: 'sort-2' }))?.text).toContain('▼ population')
    await ui.press({ key: 'sort-2' })
    expect(await row(0)).toContain('5,708,902')
    expect((await ui.find({ key: 'sort-2' }))?.text).toContain('▲ population')
    await ui.press({ key: 'sort-2' })
    expect(await row(0)).toContain('6,016,477')
    expect(await control()).toBe('1 change')

    await ui.press({ key: 'view-state' })
    expect((await ui.find({ key: 'clear-sort' }))?.text).toContain('sorted by population, high to low')
    await ui.press({ key: 'clear-sort' })
    expect(await row(0)).toContain('5,875,106')
    expect(await control()).toBe('Default view')
    expect(await ui.find({ key: 'clear-sort' })).toBeUndefined()

    for (const typed of ['2', '20', '202', '2024']) {
      await ui.input({ key: await filterKey(ui), text: typed, kind: 'change' })
      expect((await ui.find({ key: await filterKey(ui) }))?.props.value).toBe(typed)
    }
    expect(await status()).toBe('Bash: 2 of 10 rows, complete. Rows contain "2024".')
    const filtered = await rows()
    expect(filtered).toHaveLength(2)
    expect(filtered.every(found => found.text.includes('2024'))).toBe(true)

    await ui.input({ key: await filterKey(ui), text: 'nothing like this', kind: 'change' })
    expect(await rows()).toHaveLength(0)
    expect(await ui.find({ type: 'Text', text: 'No row matches the filter.' })).toBeDefined()
    await ui.input({ key: await filterKey(ui), text: '2024', kind: 'change' })

    const submitted = await $.prompt.submit({ text: 'explain the top rows', wait: false, origin: { kind: 'composer' } })
    const context = (submitted.context ?? []).join('\n')
    expect(context).toContain('rows contain "2024"')
    expect(context).toContain('2 of 10 rows match')
    const again = await $.prompt.submit({ text: 'and now?', wait: false, origin: { kind: 'composer' } })
    expect(again.context ?? []).toHaveLength(0)

    await ui.press({ key: 'clear-filter' })
    expect(await status()).toBe('Bash: 10 rows, complete.')
    expect((await ui.find({ key: await filterKey(ui) }))?.props.value).toBe('')
    expect((await ui.find({ key: 'clear-filter' }))?.props.dimColor).toBe(true)

    expect(await ui.find({ type: 'Text', text: 'All 3 columns shown.' })).toBeDefined()
    await ui.press({ key: 'hide-1' })
    expect(await ui.find({ key: 'sort-1' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'All 2 columns shown.' })).toBeDefined()
    expect(await row(0)).toMatch(/^ *2022 +5,875,106$/)
    expect(await control()).toBe('1 change')

    await ui.press({ key: 'right-0' })
    expect(await row(0)).toMatch(/^ *5,875,106 +2022$/)
    expect(await control()).toBe('2 changes')

    await ui.press({ key: 'view-state' })
    expect(await rows()).toHaveLength(0)
    await ui.press({ key: 'clear-hidden-1' })
    expect(await control()).toBe('1 change')
    await ui.press({ key: 'back-to-table' })
    expect(await row(0)).toMatch(/^ *5,875,106 +2022 {2}F *$/)

    await ui.press({ key: 'view-state' })
    await ui.press({ key: 'reset' })
    expect(await control()).toBe('Undo reset')
    expect(await row(0)).toMatch(/^ *2022 {2}F +5,875,106$/)
    await ui.press({ key: 'view-state' })
    expect(await row(0)).toMatch(/^ *5,875,106 +2022 {2}F *$/)
    expect(await control()).toBe('1 change')

    await ui.unmount()
  }
})

test('data bars draw behind the numbers, and copy puts the visible rows on the clipboard', async ($, on) => {
  const engine = engineBeneath(on, COMPLETE)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'bars', command: 'uv run python q.py' })
  const ui = await mount($, 'terminal')
  const { rows } = reader(ui)

  expect(JSON.stringify((await rows())[0]?.children)).not.toContain('backgroundColor')
  await ui.press({ key: 'bars' })
  expect((await ui.find({ key: 'bars' }))?.props.label).toBe('hide data bars')
  expect(JSON.stringify((await rows())[0]?.children)).toContain('"backgroundColor":"subtle"')

  await ui.press({ key: 'sort-2' })
  await ui.input({ key: await filterKey(ui), text: 'F', kind: 'change' })
  await ui.press({ key: 'copy' })
  const lines = (engine.copied[0] ?? '').split('\n')
  expect(lines).toHaveLength(6)
  expect(lines[0]).toBe('year\tsex\tpopulation')
  expect(lines[1]).toBe('2026\tF\t6016477')
  expect(engine.toasts.at(-1)).toBe('Copied 5 rows and 3 columns, tab-separated')
  await ui.unmount()
})

test('a missing value shows a dash, and a column named state draws no row faint', async ($, on) => {
  engineBeneath(on, MISSING_VALUE)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'missing', command: 'uv run python q.py' })
  const ui = await mount($, 'terminal')
  const { rows, status } = reader(ui)

  const drawn = await rows()
  expect(drawn).toHaveLength(4)
  expect(drawn[0]?.text).toMatch(/^ *2024 {2}measured +116,021$/)
  expect(drawn.every(found => !found.props.dimColor)).toBe(true)
  expect(drawn[3]?.text).toMatch(/projected +–$/)
  expect(await status()).toBe('Bash: 4 rows, complete.')
  await ui.unmount()
})

function grouped(ui: Mounted<(typeof SURFACES)[number], 'Pane'>) {
  return {
    lines: async () => {
      const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text)
      const heads = (await ui.findAll({})).filter(found => found.key?.startsWith('sort-')).map(found => found.text)
      return texts.slice(texts.lastIndexOf(heads.at(-1) ?? '') + 1, -1)
    },
    head: async (c: number) => (await ui.find({ key: `sort-${c}` }))?.text.trim(),
    pick: async (c: number, option: string) => {
      await ui.press({ key: 'group' })
      await ui.press({ key: `role-${c}-${option}` })
      await ui.press({ key: 'back-to-table' })
    },
  }
}

for (const surface of SURFACES) test(`group rows: keys first, a rows count, sums by default, and every aggregation on the rows the pane holds (${surface})`, async ($, on) => {
  const engine = engineBeneath(on, COMPLETE)

  {
    await $.tool.call({ tool: 'Bash', tool_use_id: `group-${surface}`, command: 'uv run python q.py' })
    const ui = await mount($, surface)
    const { rows, status, control } = reader(ui)
    const { lines, head, pick } = grouped(ui)

    await ui.press({ key: 'group' })
    expect(await rows()).toHaveLength(0)
    expect((await ui.find({ key: 'ungroup' }))?.props.dimColor).toBe(true)
    expect((await ui.find({ key: 'role-1-sum' }))?.props.dimColor).toBe(true)
    expect((await ui.find({ key: 'role-2-sum' }))?.props.dimColor).toBe(false)
    await ui.press({ key: 'role-1-sum' })
    expect(await control()).toBe('Default view')
    await ui.press({ key: 'role-1-group' })
    expect(await control()).toBe('1 change')
    await ui.press({ key: 'back-to-table' })

    expect(await status()).toBe('Bash: 10 rows, complete. Grouped by sex: 2 groups.')
    expect(await head(1)).toBe('sex')
    expect(await head(3)).toBe('rows')
    expect(await head(0)).toBeUndefined()
    expect(await head(2)).toBeUndefined()
    expect(await lines()).toEqual([expect.stringMatching(/^F +5$/), expect.stringMatching(/^M +5$/)])
    await pick(2, 'sum')
    expect(await head(2)).toBe('population (sum)')
    expect(await lines()).toEqual([
      expect.stringMatching(/^F +5 +29,789,684$/),
      expect.stringMatching(/^M +5 +28,948,716$/),
    ])

    await ui.press({ key: 'sort-2' })
    await ui.press({ key: 'sort-2' })
    expect((await lines())[0]).toMatch(/^M /)
    await ui.press({ key: 'sort-3' })
    expect((await lines())[0]).toMatch(/^F /)

    await pick(2, 'mean')
    expect(await head(2)).toBe('population (mean)')
    expect((await lines())[0]).toMatch(/5,957,936\.8$/)
    await pick(0, 'max')
    expect(await head(0)).toBe('year (max)')
    expect((await lines())[0]).toMatch(/^F +5 +2026 /)

    await ui.input({ key: await filterKey(ui), text: '2024', kind: 'change' })
    expect(await status()).toBe('Bash: 2 of 10 rows, complete. Rows contain "2024". Grouped by sex: 2 groups.')
    expect(await lines()).toEqual([expect.stringMatching(/^F +1 +2024 +5,966,425$/), expect.stringMatching(/^M +1 +2024 +5,797,225$/)])

    const submitted = await $.prompt.submit({ text: 'what do the groups say?', wait: false, origin: { kind: 'composer' } })
    const context = (submitted.context ?? []).join('\n')
    expect(context).toContain('grouped by sex')
    expect(context).toContain('sex | rows | year (max) | population (mean)')
    expect(context).toContain('F | 1 | 2024 | 5966425')

    await ui.press({ key: 'copy' })
    expect((engine.copied.at(-1) ?? '').split('\n')).toEqual(['sex\trows\tyear (max)\tpopulation (mean)', 'F\t1\t2024\t5966425', 'M\t1\t2024\t5797225'])

    await ui.press({ key: 'view-state' })
    expect((await ui.find({ key: 'clear-group' }))?.text).toContain('grouped by sex')
    expect((await ui.find({ key: 'clear-sort' }))?.text).toContain('sorted by rows, high to low')
    await ui.press({ key: 'clear-group' })
    await ui.press({ key: 'back-to-table' })
    expect(await status()).toBe('Bash: 2 of 10 rows, complete. Rows contain "2024".')
    expect(await head(2)).toBe('population')
    expect(await ui.find({ key: 'sort-3' })).toBeUndefined()
    expect(await control()).toBe('1 change')

    await ui.unmount()
  }
})

test('group rows: one total row without a key, distinct and min on text, and a hidden key leaves the grouping', async ($, on) => {
  engineBeneath(on, COMPLETE)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'total', command: 'uv run python q.py' })
  const ui = await mount($, 'terminal')
  const { status } = reader(ui)
  const { lines, head, pick } = grouped(ui)

  await pick(2, 'sum')
  expect(await status()).toBe('Bash: 10 rows, complete. Grouped into one total row.')
  expect(await lines()).toEqual([expect.stringMatching(/^ *10 +58,738,400$/)])

  await pick(0, 'group')
  await pick(1, 'distinct')
  expect(await head(1)).toBe('sex (distinct)')
  expect(await lines()).toHaveLength(5)
  expect((await lines())[0]).toMatch(/^ *2022 +2 +2 +11,584,008$/)
  await pick(1, 'min')
  expect((await lines())[0]).toMatch(/^ *2022 +2 +F +11,584,008$/)

  await ui.press({ key: 'right-1' })
  expect((await lines())[0]).toMatch(/^ *2022 +2 +11,584,008 +F *$/)
  await ui.press({ key: 'left-0' })
  expect((await lines())[0]).toMatch(/^ *2022 +2 +11,584,008 +F *$/)

  await ui.press({ key: 'hide-0' })
  expect(await status()).toBe('Bash: 10 rows, complete. Grouped into one total row.')
  await pick(0, 'group')
  expect(await status()).toBe('Bash: 10 rows, complete. Grouped by year: 5 groups.')
  await ui.unmount()
})

test('group rows: "off" leaves a column out of the grouped table and keeps it in the plain table', async ($, on) => {
  engineBeneath(on, COMPLETE)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'off', command: 'uv run python q.py' })
  const ui = await mount($, 'terminal')
  const { lines, head, pick } = grouped(ui)

  await pick(1, 'group')
  expect(await head(2)).toBeUndefined()
  await pick(2, 'sum')
  await ui.press({ key: 'sort-2' })
  await pick(2, 'off')
  expect(await head(2)).toBeUndefined()
  expect(await lines()).toEqual([expect.stringMatching(/^F +5$/), expect.stringMatching(/^M +5$/)])
  await ui.press({ key: 'view-state' })
  expect(await ui.find({ key: 'clear-group' })).toBeDefined()
  expect(await ui.find({ key: 'clear-sort' })).toBeUndefined()
  await ui.press({ key: 'back-to-table' })

  await pick(0, 'min')
  expect(await head(0)).toBe('year (min)')
  await pick(0, 'off')
  expect(await head(0)).toBeUndefined()

  await ui.press({ key: 'group' })
  await ui.press({ key: 'ungroup' })
  await ui.press({ key: 'back-to-table' })
  expect(await head(0)).toBe('year')
  expect(await head(2)).toBe('population')
  await ui.unmount()
})

test('group rows: a sum of decimals keeps the precision of its values, and missing values are skipped', async ($, on) => {
  engineBeneath(on, SHARES)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'shares', command: 'uv run python q.py' })
  const ui = await mount($, 'terminal')
  const { lines, pick } = grouped(ui)

  await pick(0, 'group')
  expect(await lines()).toEqual([expect.stringMatching(/^a +2$/), expect.stringMatching(/^b +2$/)])
  await pick(1, 'sum')
  expect(await lines()).toEqual([expect.stringMatching(/^a +2 +0\.3$/), expect.stringMatching(/^b +2 +0\.25$/)])
  await pick(1, 'count')
  expect(await lines()).toEqual([expect.stringMatching(/^a +2 +2$/), expect.stringMatching(/^b +2 +1$/)])
  await pick(1, 'mean')
  expect(await lines()).toEqual([expect.stringMatching(/^a +2 +0\.15$/), expect.stringMatching(/^b +2 +0\.25$/)])
  await ui.unmount()
})

test('"type a filter" asks for the keyboard, and says what to do when the prompt keeps it', async ($, on) => {
  const engine = engineBeneath(on, COMPLETE)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'focus', command: 'uv run python q.py' })
  const ui = await mount($, 'terminal')

  await ui.press({ key: 'type-filter' })
  expect(engine.focusAsks).toBe(1)
  expect(engine.toasts).toHaveLength(1)
  expect(engine.toasts[0]).toContain('empty the prompt box')

  engine.grantsFocus = true
  await ui.press({ key: 'type-filter' })
  expect(engine.focusAsks).toBe(2)
  expect(engine.toasts).toHaveLength(1)
  await ui.unmount()

  const focused = await mount($, 'terminal', { isFocused: true })
  expect((await focused.find({ key: 'type-filter' }))?.props.dimColor).toBe(true)
  expect((await focused.find({ key: await filterKey(focused) }))?.props.autoFocus).toBe(true)
  const keys = async () =>
    (await focused.findAll({}))
      .filter(found => found.type === 'Button' || found.type === 'Input')
      .map(found => found.key)
      .filter(key => key !== undefined)
  const before = await keys()
  expect(before).toContain('clear-filter')
  await focused.input({ key: await filterKey(focused), text: 'F', kind: 'change' })
  expect(await keys()).toEqual(before)
  await focused.unmount()
})

test('the pane scrolls its own rows under fixed heads, and the last line counts the rows below', async ($, on) => {
  engineBeneath(on, TALL)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'tall', command: 'uv run python q.py' })
  const ui = await mount($, 'terminal', { scroll: { offset: 0, bodyRows: 20 } })
  const { rows, row } = reader(ui)
  const footer = async () => (await ui.find({ type: 'Text', text: /^\d+–\d+ of \d+$/ }))?.text
  const scroll = (by: number) =>
    $.ui.scroll({ component: 'Pane', requestId: 'data-explorer', offset: Math.max(0, by), by, bodyRows: 20, contentRows: 20, origin: { kind: 'person' } })

  expect(await rows()).toHaveLength(12)
  expect(await row(0)).toMatch(/^ *2000 /)
  expect(await footer()).toBe('1–12 of 50')

  await scroll(5)
  expect(await row(0)).toMatch(/^ *2005 /)
  expect(await footer()).toBe('6–17 of 50')
  expect(await ui.find({ key: 'sort-0' })).toBeDefined()

  await scroll(100)
  expect(await row(0)).toMatch(/^ *2038 /)
  expect(await rows()).toHaveLength(12)
  expect(await footer()).toBe('39–50 of 50')

  await ui.press({ key: 'sort-0' })
  expect(await row(0)).toMatch(/^ *2049 /)
  expect(await footer()).toBe('1–12 of 50')

  await scroll(-3)
  expect(await row(0)).toMatch(/^ *2049 /)
  await ui.unmount()
})

test('the pane says what it waits for before any result', async $ => {
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    expect(await ui.find({ type: 'Text', text: 'No table yet.' })).toBeDefined()
    await ui.unmount()
  }
})

test('Bash output without a box table leaves the pane closed and empty', async ($, on) => {
  const engine = engineBeneath(on, 'On branch main')
  await $.tool.call({ tool: 'Bash', tool_use_id: 'git-status', command: 'git status' })
  expect(engine.opened).toHaveLength(0)
  const ui = await mount($, 'terminal')
  expect(await ui.find({ type: 'Text', text: 'No table yet.' })).toBeDefined()
  await ui.unmount()
})

test('Open on a new table off: a query result waits in the pane unopened, and show_file still opens it', { options: { open: 'off' } }, async ($, on) => {
  const engine = engineBeneath(on, COMPLETE)
  engine.files['population.csv'] = POPULATION_CSV
  await $.tool.call({ tool: 'Bash', tool_use_id: 'quiet-1', command: 'uv run python q.py' })
  expect(engine.opened).toHaveLength(0)
  const ui = await mount($, 'terminal')
  expect((await ui.find({ type: 'Text', text: /^Bash:/ }))?.text).toBe('Bash: 10 rows, complete.')
  await ui.unmount()
  await showFile($, 'quiet-2', 'C:/tmp/population.csv')
  expect(engine.opened.at(-1)).toBe('data-explorer')
})

test('the show_file tool shows every row of a file and answers with counts only; a file over 4 MiB is refused', { timeoutMs: 15000 }, async ($, on) => {
  const engine = engineBeneath(on, '')
  engine.files['population.csv'] = POPULATION_CSV
  const answer = await showFile($, 'file-1', 'C:/tmp/population.csv')
  expect(answer.result).toBe('The data explorer pane shows 60 rows and 3 columns of C:/tmp/population.csv.')
  expect(engine.opened.at(-1)).toBe('data-explorer')
  const ui = await mount($, 'terminal')
  expect((await ui.find({ type: 'Text', text: /^File:/ }))?.text).toBe('File: 60 rows, complete.')
  expect(await ui.find({ key: 'all-rows' })).toBeUndefined()
  await ui.unmount()

  engine.files['big.csv'] = ['n,m', ...Array.from({ length: 100005 }, (_, i) => `${i},x`)].join('\n')
  const big = await showFile($, 'file-2', 'C:/tmp/big.csv')
  expect(big.result).toBe('The data explorer pane shows the first 100,000 of 100,005 rows and 2 columns of C:/tmp/big.csv.')
  const tall = await mount($, 'terminal')
  expect((await tall.find({ type: 'Text', text: /^File:/ }))?.text).toBe('File: 100,000 rows, capped, the file has 100,005.')
  expect((await tall.findAll({ type: 'Text' })).map(found => found.text).filter(text => / of 100/.test(text))).toEqual([expect.stringMatching(/^1–\d+ of 100,000$/)])
  await tall.press({ key: 'sort-0' })
  expect((await tall.findAll({ type: 'Text' })).some(found => /^ *99,999 {2}x/.test(found.text))).toBe(true)
  await tall.unmount()

  engine.sizes['huge.csv'] = 5 * 1024 * 1024
  const refused = await showFile($, 'file-3', 'C:/tmp/huge.csv')
  expect(JSON.stringify(refused)).toContain('5.0 MiB; the data explorer reads files up to 4 MiB')
})

test('a CSV file Claude reads opens whole in the pane; a JSON settings file does not', async ($, on) => {
  const engine = engineBeneath(on, '')
  engine.files['population.csv'] = POPULATION_CSV
  engine.files['settings.json'] = JSON.stringify({ hooks: { Stop: [{ matcher: '', command: 'x' }] } })
  await $.tool.call({ tool: 'Read', tool_use_id: 'read-1', file_path: 'data/population.csv', limit: 5 })
  expect(engine.opened).toHaveLength(1)
  const ui = await mount($, 'terminal')
  expect((await ui.find({ type: 'Text', text: /^File:/ }))?.text).toBe('File: 60 rows, complete.')
  await $.tool.call({ tool: 'Read', tool_use_id: 'read-2', file_path: '.claude/settings.json' })
  expect(engine.opened).toHaveLength(1)
  expect((await ui.find({ type: 'Text', text: /^File:/ }))?.text).toBe('File: 60 rows, complete.')
  await ui.unmount()
})

test('a Power BI result that reached maxRows loads all rows from the pane and keeps the view', async ($, on) => {
  const engine = engineBeneath(on, '')
  await $.tool.call({ tool: 'mcp__claude_ai_Power_BI__ExecuteQuery', tool_use_id: 'dax-1', artifactId: 'model-1', daxQueries: ['EVALUATE Sales'] })
  const ui = await mount($, 'terminal')
  const status = async () => (await ui.find({ type: 'Text', text: /^Power BI:/ }))?.text ?? ''
  expect(await status()).toMatch(/^Power BI: 250 rows, capped\./)
  await ui.press({ key: 'sort-1' })
  expect((await ui.find({ key: 'all-rows' }))?.text).toBe('load all rows')
  await ui.press({ key: 'all-rows' })
  expect(engine.mcpCalls).toEqual([
    { server: 'claude_ai_Power_BI', tool: 'ExecuteQuery', args: { artifactId: 'model-1', daxQueries: ['EVALUATE Sales'], maxRows: 100000 } },
  ])
  expect(await status()).toBe('Power BI: 400 rows, complete.')
  expect(await ui.find({ key: 'all-rows' })).toBeUndefined()
  expect((await ui.find({ key: 'sort-1' }))?.text).toContain('▼')
  expect(await reader(ui).control()).toBe('1 change')
  await ui.unmount()
})

test('a capped DuckDB table asks Claude for all rows, and the file Claude shows keeps the view', async ($, on) => {
  const engine = engineBeneath(on, CAPPED)
  engine.files['all.csv'] = POPULATION_CSV
  await $.tool.call({ tool: 'Bash', tool_use_id: 'capped', command: 'uv run python q.py' })
  const ui = await mount($, 'terminal')
  expect(await reader(ui).status()).toBe('Bash: 6 rows, capped, the result has 70.')
  await ui.press({ key: 'sort-2' })
  expect((await ui.find({ key: 'all-rows' }))?.text).toBe('ask Claude for all rows')
  await ui.press({ key: 'all-rows' })
  expect(engine.prompts.at(-1)).toContain('uv run python q.py')
  expect(engine.prompts.at(-1)).toContain('show_file')
  expect((await ui.find({ key: 'all-rows' }))?.text).toBe('asked Claude for all rows')
  await showFile($, 'all', 'C:/tmp/all.csv')
  expect((await ui.find({ type: 'Text', text: /^File:/ }))?.text).toBe('File: 60 rows, complete.')
  expect((await ui.find({ key: 'sort-2' }))?.text).toContain('▼')
  expect(await reader(ui).control()).toBe('1 change')
  await ui.unmount()
})

test('a narrow pane lists the columns past its edge and brings one to the front', async ($, on) => {
  engineBeneath(on, COMPLETE)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'narrow', command: 'uv run python q.py' })
  const ui = await mount($, 'terminal', { bodyColumns: 20 })
  expect(await ui.find({ key: 'sort-2' })).toBeUndefined()
  expect(await ui.find({ key: 'front-2' })).toBeDefined()
  const texts = await ui.findAll({ type: 'Text' })
  const caption = texts.findIndex(found => /^\d+ other columns?:$/.test(found.text))
  expect(caption).toBeGreaterThan(-1)
  expect(caption).toBeLessThan(texts.findIndex(found => /^ *20\d\d/.test(found.text)))
  await ui.press({ key: 'front-2' })
  expect(await ui.find({ key: 'sort-2' })).toBeDefined()
  await ui.unmount()
})

const MAIL = JSON.stringify({ value: [{ subject: 'Q3 numbers', from: 'Ann', size: 1200 }, { subject: 'Lunch', from: 'Bo', size: 300 }] })

async function callTool($: TestEngine, input: Record<string, unknown>) {
  return $.tool.call(input as unknown as Parameters<TestEngine['tool']['call']>[0])
}

async function reply($: TestEngine, turnId: string) {
  for await (const chunk of $.turn.step({ turnId, index: 0, model: 'claude-opus-5-5', messageCount: 1 })) void chunk
}

function statusOf(ui: Mounted<(typeof SURFACES)[number], 'Pane'>) {
  return async () => (await ui.findAll({ type: 'Text' })).map(found => found.text).find(text => /^[^:]+: [\d,]+ (of [\d,]+ )?rows?, /.test(text))
}

test('a JSON result from another tool waits in the list beside a query result, and the list switches tables with their views', async ($, on) => {
  const engine = engineBeneath(on, COMPLETE)
  engine.mcpText = MAIL
  await callTool($, { tool: 'Bash', tool_use_id: 'q', command: 'uv run python q.py' })
  expect(engine.opened).toHaveLength(1)
  await callTool($, { tool: 'mcp__claude_ai_Microsoft_365__outlook_email_search', tool_use_id: 'mail', query: 'numbers' })
  expect(engine.opened).toHaveLength(1)
  const ui = await mount($, 'terminal')
  const status = statusOf(ui)
  expect(await status()).toBe('Bash: 10 rows, complete.')
  expect((await ui.find({ key: 'tables' }))?.text).toBe('2 tables, 1 new')

  await ui.press({ key: 'sort-2' })
  await ui.press({ key: 'tables' })
  expect(await reader(ui).rows()).toHaveLength(0)
  expect((await ui.find({ key: 'table-0' }))?.text).toMatch(/^Microsoft 365: 2 rows × 3 columns new {2}outlook_email_search/)
  expect((await ui.find({ key: 'table-1' }))?.text).toMatch(/^Bash: 10 rows × 3 columns {2}uv run python q\.py/)
  await ui.press({ key: 'table-0' })
  expect(await status()).toBe('Microsoft 365: 2 rows, complete.')
  expect((await ui.find({ key: 'tables' }))?.text).toBe('2 tables')
  expect((await ui.find({ key: 'view-state' }))?.text).toBe('Default view')

  await ui.press({ key: 'tables' })
  await ui.press({ key: 'table-1' })
  expect(await status()).toBe('Bash: 10 rows, complete.')
  expect((await ui.find({ key: 'sort-2' }))?.text).toContain('▼')
  await ui.unmount()
})

test('a new query result waits in the list while the view is changed, and shows once the view is back to default', async ($, on) => {
  const engine = engineBeneath(on, COMPLETE)
  await callTool($, { tool: 'Bash', tool_use_id: 'one', command: 'python one.py' })
  const ui = await mount($, 'terminal')
  const status = statusOf(ui)
  await ui.press({ key: 'sort-2' })

  engine.stdout = TALL
  await callTool($, { tool: 'Bash', tool_use_id: 'two', command: 'python two.py' })
  expect(await status()).toBe('Bash: 10 rows, complete.')
  expect((await ui.find({ key: 'tables' }))?.text).toBe('2 tables, 1 new')

  await ui.press({ key: 'view-state' })
  await ui.press({ key: 'reset' })
  engine.stdout = SHARES
  await callTool($, { tool: 'Bash', tool_use_id: 'three', command: 'python three.py' })
  expect(await status()).toBe('Bash: 4 rows, complete.')
  expect((await ui.find({ key: 'tables' }))?.text).toBe('3 tables, 1 new')

  await callTool($, { tool: 'Bash', tool_use_id: 'again', command: 'python three.py' })
  expect((await ui.find({ key: 'tables' }))?.text).toBe('3 tables, 1 new')
  await ui.unmount()
})

test("a table in Claude's reply shows while nothing else does, never replaces a query result, and a pasted table joins the list", async ($, on) => {
  const engine = engineBeneath(on, COMPLETE)
  engine.answer = REPLY
  await reply($, 't1')
  expect(engine.opened).toHaveLength(0)
  const ui = await mount($, 'terminal')
  const status = statusOf(ui)
  expect(await status()).toBe('Claude: 2 rows, complete.')
  expect((await ui.findAll({ type: 'Text' })).some(found => found.text === 'Population per region:')).toBe(true)

  await callTool($, { tool: 'Bash', tool_use_id: 'q', command: 'uv run python q.py' })
  expect(engine.opened).toHaveLength(1)
  expect(await status()).toBe('Bash: 10 rows, complete.')

  engine.answer = REPLY.replace('6,789,000', '6,789,001')
  await reply($, 't2')
  expect(await status()).toBe('Bash: 10 rows, complete.')
  expect((await ui.find({ key: 'tables' }))?.text).toBe('3 tables, 1 new')

  await $.prompt.submit({ text: 'compare with this:\ntown\tcount\nGent\t12', wait: false, origin: { kind: 'composer' } })
  expect((await ui.find({ key: 'tables' }))?.text).toBe('4 tables, 2 new')
  await ui.press({ key: 'tables' })
  expect((await ui.find({ key: 'table-0' }))?.text).toMatch(/^Your message: 1 row × 2 columns new/)
  await ui.unmount()
})

test('head of a CSV file in a shell command loads the whole file', async ($, on) => {
  const engine = engineBeneath(on, POPULATION_CSV.split('\n').slice(0, 6).join('\n'))
  engine.files['population.csv'] = POPULATION_CSV
  await callTool($, { tool: 'Bash', tool_use_id: 'head', command: 'head -6 "data/population.csv"' })
  const ui = await mount($, 'terminal')
  expect(await statusOf(ui)()).toBe('File: 60 rows, complete.')
  expect((await ui.findAll({ type: 'Text' })).some(found => found.text === 'data/population.csv')).toBe(true)
  await ui.unmount()
})

test('an Excel file Claude reads opens whole, a Parquet file is refused with the way round, and quiet tools add nothing', async ($, on) => {
  const engine = engineBeneath(on, '')
  engine.bytes['sales.xlsx'] = HAND_BUILT
  await callTool($, { tool: 'Read', tool_use_id: 'xlsx', file_path: 'C:/data/sales.xlsx' })
  expect(engine.opened).toHaveLength(1)
  const ui = await mount($, 'terminal')
  expect(await statusOf(ui)()).toMatch(/^File: 4 rows, complete\. Sheet 1 of 2 \(Sales & Costs\)\.$/)

  const refused = await showFile($, 'pq', 'C:/data/big.parquet')
  expect(JSON.stringify(refused)).toContain('write it to CSV first')

  engine.mcpText = MAIL
  await callTool($, { tool: 'mcp__trace-waterfall__open_pane', tool_use_id: 'quiet' })
  expect((await ui.find({ key: 'tables' }))?.text).toBe('1 table')
  await callTool($, { tool: 'mcp__claude_ai_Microsoft_365__outlook_email_search', tool_use_id: 'sub', agentId: 'agent-7', query: 'x' })
  expect((await ui.find({ key: 'tables' }))?.text).toBe('2 tables, 1 new')
  await ui.press({ key: 'tables' })
  expect((await ui.find({ key: 'table-0' }))?.text).toMatch(/^Microsoft 365 in a subagent: 2 rows/)
  await ui.unmount()
})
