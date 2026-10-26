# Agent rules for this repository

## Code

- Write no code comments, in any language or file.
- Before every commit that touches the mod, run `claude plugin validate .`, `claude plugin test .` and `npx -y -p typescript@5.6.3 tsc -p .`. The type check needs the types Claude Code writes to `.claude-plugin/types/` when it loads the mod from this folder (`claude --plugin-dir .`).
- Read `DESIGN.md` before changing how the pane looks or behaves. A change that departs from it updates `DESIGN.md` in the same commit, with the reason.
- On Team and Enterprise accounts and on machines with managed settings, Claude Code can skip a user plugin's hook on an event its built-in security plugin also hooks, `classic.*` and `prompt.attachment` among them. Before hooking a new event, run a session with `claude --debug` there and check the log has no `bypassed by cc-plugin-sec-default` line for it.

## Data

- Test fixtures hold made-up rows or public open data only.
- Never run a Power BI query against a semantic model to test the parser unless the user names the model.
