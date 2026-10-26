# Design notes

The decisions behind the Data pane, each with its reason and the alternatives that were rejected. Read them before changing how the pane looks or behaves.

## Purpose

- The pane lets the user explore any data Claude Code ran into or received, to check that it meets basic assumptions. It offers basic table operations and aggregation, and leaves the judgement of what an operation means to the user.

## The filter hides rows

- Decision: the text filter hides the rows that do not match.
- Reason: the table scrolls below the pane's edge. Dimmed rows below the edge show nothing, and matching rows stay out of view under hundreds of dimmed ones.
- Rejected alternative: dim the non-matching rows in place and keep the row order.

## Sort

- The first click sorts names A to Z, and numbers, years and dates high to low. Later clicks reverse the order.
- A column head has no "unsorted" step. The sort is cleared in the list of view changes, with the other changes.

## Years are not greyed

- The pane greys a column of ISO dates as secondary information, but not a numeric column named year.
- Reason: in a query result the year is usually the key the rows are grouped by, not secondary information.

## Accent colour

- The chosen option, the sorted head and the "N changes" label use the theme key `claude`, the orange of the terminal theme.

## Fixed lines above the table

- Decision: the default view draws the same lines above the table for every result: status, query, filter, buttons, the columns line, the column heads and their ‹ › hide buttons. Each is one line. The list of view changes opens in place of the rows, with a "Back to table" button, so it never pushes the table down.
- The columns line reads "All N columns shown." or "N other columns:" followed by the names of the columns past the pane's edge. The caption keeps its full width; names that do not fit are cut at the edge.
- Reason: the pane is for eyeballing a result within reach. A control area whose height depends on the data moves the table on every query.
- Rejected alternative: value buttons for text columns with 2 to 8 values. Whether a column got them depended on the rows the query returned, so they appeared and disappeared between queries.
- Rejected alternative: a per-column list of values. A column of 100 municipalities takes about 10 lines.
- The text filter covers picking a value: typing "flanders" keeps the Flanders rows.

## Filter line

- "type a filter" sits on the filter line, before the field, and a ` × ` that clears the filter sits after it, where a search field has its clear button. A click on the field does not give the pane the keyboard; the button that does must sit where the user looks for it.
- The field has no "Filter:" label: the buttons beside it name it. Enter is labelled "done" because the platform always draws a label for Enter (default "submit") and the filter already applies with every keystroke.

## Column buttons

- Under each head: ` ‹ `, ` › ` and ` × `, each three columns wide so the pointer finds it. The minimum column width is 9 so the three fit.
- The × hides the column, and the column comes back from the columns line.
- Rejected alternative: the word `hide`. A symbol under every head takes less room than a word.

## Rejected alternatives

- A ↕ marker on every unsorted head: it puts ink on every head. Only the sorted head carries an arrow, and heads invert under the pointer.
- Dropping `Rows contain "…"` from the status line: the scope text names every active filter.
- Leaving the changes control blank in the default view: it reads "Default view".

## Data bars

- Off by default. The toggle counts as a view change, like any other display mode.
- Bars run from zero, so a column with negative values draws its bars left of the zero point.
- Year and code columns get no bars and no thousands separators.

## The pane scrolls its own rows

- The pane answers the wheel and the scroll keys itself: the lines above the table and the column heads stay put, and only the rows move. The last line says which rows the window shows ("6–17 of 50"), so it tells both whether rows lie above and how many lie below.
- A new sort, a new filter text, a reset and a new result go back to the first row. Moving or hiding a column keeps the scroll position.
- Every line is one terminal row high, so the pane can count how many rows fit. A row wider than the pane is cut at its edge.

## Text is not cut

- Table cells are not cut. Columns take the width of their longest value, and columns that do not fit move to the columns line. Only a single column wider than the pane is cut.
- Exception: the status line, the query line and the columns line are cut at the pane's edge, because the lines above the table keep a fixed height. The status line starts with the row count, so the count survives the cut, and the full query stays in the transcript.

## Group rows

- Decision: grouping is computed on the rows the pane holds. Every column offers off, group, sum, mean, min, max, count and distinct; sum and mean only on number columns. The pane does not judge whether an aggregation makes sense for a column: the user picks it and owns the conclusion.
- Reason: the pane is for any data. Caution that suits one warehouse (no sums on columns that might not add up) does not belong in a general tool.
- The "group rows" button opens a list in place of the rows, one line per column with its options, like the list of view changes. The lines above the table keep their height. The chosen option is in the accent colour; sum and mean are dim on a text column.
- The grouped table shows the group columns first, then `rows` (the number of rows in each group), then the other shown columns with the aggregation in the head: "population (sum)".
- Every column starts on off, as in an Excel pivot table, where a field shows only once the user adds it. Off comes first on each line because it is the default. Reason: columns the user did not ask for are noise, such as a count of a text column, which almost always repeats the rows count.
- Off leaves a column out of the grouped table only; the plain table keeps it. Hiding a column with × also leaves it out of the grouping, but hides it in the plain table too.
- With every column but the group columns off, the grouped table is a count of values: one line per value with its number of rows.
- With no group column the table shows one total row.
- The text filter picks the rows before grouping, as SQL `WHERE` does: typing "2024" groups only the rows that contain 2024. Rejected alternative: filtering the grouped rows, as SQL `HAVING` does; that cannot narrow on a column that is aggregated.
- A hidden column takes no part in the grouping. Choosing an option for it in the list shows it again.
- Sort, data bars, copy and the context sent to Claude act on the grouped table. Groups keep the order in which their first row appears until the user sorts.
- A sum keeps the decimals of its values, and a mean adds two, so float noise such as 0.30000000000000004 does not show.
- A new result sets the pane width to fit the list as well as the table, so opening the list never asks for more width.
- Rejected alternative: re-querying the engine for each grouping. Asking Claude costs a model turn per click; writing the query in the pane means parsing DAX and shell commands.
- Rejected alternative: a role control under each column head. A control that cycles through the options hides them, and the line under the heads has no room for seven words.

## Full rows

- Decision: the pane holds up to 100,000 rows, so sort, filter and grouping act on the whole result instead of the slice a shell printed.
- A CSV, TSV, JSON or JSON-lines file that Claude reads with the Read tool opens whole in the pane, also when Claude read only part of it. A JSON file opens only when its top level is an array, so settings files stay out.
- The `show_file` tool lets Claude put a file in the pane without reading the rows into its own context. The tool answers with the row and column count only.
- A capped Power BI result shows "load all rows" at the end of the status line. The pane runs the same DAX query again with maxRows 100,000 through the Power BI connector, without a model turn; the rows go to the pane only.
- Any other capped table that came from a command or tool call shows "ask Claude for all rows". The pane cannot run the query itself, because the printed table does not carry the SQL. The button sends Claude a prompt to write every row to a CSV file and show it with `show_file`; the file then replaces the capped table in the list.
- Loading all rows keeps the view (sort, filter, grouping) when the columns are the same.
- The button is the last thing on the status line and shows only for a capped result, so it moves nothing else.
- Files are read up to 4 MiB, the limit of the mod API's file read.
- A redraw reuses the table computed for the current view, so scrolling does no work. A view change on 100,000 rows takes about 0.4 s.
- Rejected alternative: reading the SQL out of the shell command and running it again. The SQL sits inside Python scripts, heredocs or files, and running a shell command again can have side effects.
- Rejected alternative: printing more rows in the shell. The rows would fill Claude's context.

## Every table Claude runs into

- Decision: the pane looks for tables in the result of every tool call (subagents' included), in every reply Claude writes in the main conversation, and in every message the user sends.
- Formats read in text: box tables (DuckDB, SQLite, Polars, Rich), `+---+` grid tables (MySQL, SQLite, tabulate), psql output, tables with a dashed rule under the header (PowerShell, sqlcmd, pip), pandas frames with a range index, markdown tables, HTML tables, JSON (arrays of objects, columns beside rows, JSON lines), and runs of CSV, TSV, semicolon or pipe lines.
- Files: CSV, TSV, JSON, JSON lines and the first sheet of an Excel workbook (.xlsx, .xlsm) open whole when Claude reads them or shows them with `show_file`. A Read of a markdown, text, log or HTML file adds the tables in it. Parquet is refused with the DuckDB `COPY` statement that turns it into CSV.
- A shell command that prints part of a table file, such as `head -6 data.csv`, loads the whole file when the printed table has the file's columns.
- Tools whose output is not data are skipped: Edit, Write, ToolSearch, Skill, the plan and worktree tools, the mods' own tools, and similar.
- Delimited runs in free text must look like a table: a header of short, distinct names that is not shaped like the row under it, and at least two rows for commas and semicolons (one for tabs). Prose with commas, compiler errors, log lines and `git diff --stat` do not count.
- Numbers with thousands separators in text tables ("1,234,567") are stored without them, so they sort and sum. Delimited text and JSON keep their values as written, because "1,5" in a semicolon CSV is a decimal.
- A text with more than five tables keeps the five largest.

## Which table the pane shows

- Decision: query results and data files are primary: box, grid, psql, pandas and delimited tables from Bash or PowerShell, Power BI results, and table files. They open the pane, unless the Open on a new table setting is off. Tables in replies, messages, documents, web pages, listings and other tools' JSON are secondary: they never open the pane.
- A new table takes the pane only while the user has not changed the view (default view, table showing). Otherwise it waits in the list. Reason: a capture must not take away a table the user is working on.
- A secondary table never replaces a primary one. Reason: Claude's reply often repeats a few rows of the query result as a markdown table; the full result is what the user explores.
- The same table from the same source again (same columns, row count, first and last row) adds nothing.
- `show_file`, "load all rows" and a pick from the list always show their table.

## List of tables

- The query line ends with a button that counts the tables: "3 tables", or "3 tables, 1 new" in the accent colour when tables arrived that the user has not seen. It sits at the end of the query line, so the button line keeps its single line at 80 columns.
- The button opens the list in place of the rows, like the other lists, newest first: source, rows × columns, "new", and the command or caption. A click shows that table with the view it had. Leaving the list clears "new".
- The pane keeps 12 tables and 300,000 rows in total; the oldest go first, never the one shown.
- The status line names the source: the tool ("Bash", "Microsoft 365", "File", "Power BI"), "Claude" for a reply, "Your message", with "in a subagent" when a subagent made the call. The query line shows the command, the file, the tool and its arguments, or for replies and messages the line above the table.
- Rejected alternative: a toast for each table that waits. Captures come in bursts while Claude works, and the counter says the same without moving anything.

## No hint sentences

- The pane has no "Click a header to sort" line. Buttons invert under the pointer, which shows what responds to a click.
