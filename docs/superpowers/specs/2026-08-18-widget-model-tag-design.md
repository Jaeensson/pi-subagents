# Design: show each subagent's model in the TUI status widget

Date: 2026-08-18
Status: Approved (2026-08-18)

## Problem

The persistent status widget (`tui.ts`) shows one line per running subagent
(`▸ agent  elapsed  step X/Y  activity`), but not which model the subagent is
running with. Users watching long-running parallel batches can't tell whether
a task got the cheap/fast model or the deep model without opening results.

## Requirements

1. The running-task widget shows each subagent's model next to its name.
2. If the model is not yet known (task inherited the parent default and the
   child hasn't reported its actual model yet), show nothing — the line looks
   exactly like today until the model is known.
3. Long model ids truncate with `…` (~32 chars) so the trailing activity stays
   visible.
4. Scope is limited to the running-task status widget. Completed-task output
   (status reports, completion notifications) is unchanged.

## Design

### Data

`Task.model` already exists on the runtime registry entry (`runtime.ts`) and is
populated twice:

- at spawn, from `resolveModel()` (`process.ts`) — may be `undefined` when the
  task inherits the parent's default;
- live, from the child's actual message stream via `applyEventLine()`
  (`core.ts`) once the first assistant message with a model arrives.

No plumbing changes are needed; the widget just reads `t.model`.

### Rendering (`tui.ts`, `runningTaskLines`)

Line format becomes:

```
▸ scout [claude-sonnet-4-5] 12s → bash: npm test
▸ planner 4s step 2/3 "Refactor the core loop"     ← no tag until model known
```

- Model tag renders only when `t.model` is set: `[<model>]` placed after the
  agent name, before the elapsed time.
- Tag is styled with the theme's muted/dim color (distinct from the
  accent-colored agent name).
- Model ids longer than 32 chars are truncated with `…`.

### Pure helper (`core.ts` + unit tests)

Add `formatModelTag(model: string | undefined): string` to `core.ts`:

- `undefined` → `""`
- id ≤ 32 chars → `[id]`
- id > 32 chars → `[first 31 chars…]`

Unit tests in `tests/core.test.mjs` cover the three cases (missing, short,
long). This follows the AGENTS.md convention of keeping new pure logic in
`core.ts` with tests; `tui.ts` is not under `node --test` (it imports pi
packages at runtime).

## Edge cases

- **Long model ids** (`opencode-go/deepseek-v4-pro:high`): truncated tag keeps
  activity visible; the model id is at the start of the line so the final
  `truncateToWidth` pass never cuts it.
- **Model briefly unknown at spawn**: no tag until the first reported message;
  widget re-renders on the 1s ticker so the tag appears without extra wiring.

## Out of scope

- Status reports / completion notifications (still show model in tier
  sections where they already do).
- Changing which model a task runs with — display only.
