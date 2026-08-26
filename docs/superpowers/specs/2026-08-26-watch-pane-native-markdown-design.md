# Watch Pane: Native Markdown Rendering — Design

Date: 2026-08-26
Status: Approved (pending spec review)

## Problem

The watch pane (`watch.ts` + `tui.ts` + `live.ts`) renders live subagent traces as
plain, single-color-per-kind lines. The main conversation renders assistant text
and thinking through pi's native `Markdown` component with theme-driven syntax
highlighting (the `syntax*` color tokens), inline code, headings, lists, and
tables. The user wants the watch pane to show the same rendering.

## Feasibility finding

Both building blocks are **public exports** of packages this extension already
depends on (verified against `@earendil-works/pi-coding-agent` and
`@earendil-works/pi-tui` 0.84.1; ESM, importable at runtime):

- `@earendil-works/pi-coding-agent` re-exports from
  `dist/modes/interactive/theme/theme.js` (commented "Theme utilities for custom
  tools and extensions"):
  - `getMarkdownTheme(): MarkdownTheme` — the exact theme object used by the
    conversation, with `highlightCode` wired to cli-highlight + the theme's
    `syntax*` tokens, and fallback via `theme.fg("mdCodeBlock", ...)` when no
    valid language is given (no auto-detection, so no miscolored prose).
  - `highlightCode(code, lang?)` — the standalone highlighter.
  - `getLanguageFromPath(path)` — extension → language mapping.
- `@earendil-works/pi-tui` exports the `Markdown` component
  (`constructor(text, paddingX, paddingY, theme, defaultTextStyle?, options?)`,
  `render(width): string[]`, `setText`, `invalidate`). pi's own
  `AssistantMessageComponent` renders exactly
  `new Markdown(text.trim(), outputPad, 0, getMarkdownTheme(), ...)`.

Native behavior confirmed in pi's code (`assistant-message.js`):

- Assistant text → `Markdown` with default styling.
- Thinking blocks → `Markdown` with
  `defaultTextStyle = { color: (t) => theme.fg("thinkingText", t), italic: true }`.
- Streaming: pi re-renders the accumulating text through `Markdown` on every
  update, so an unclosed ``` fence renders the remainder as a code block until
  the closing fence arrives. That transient look is "native" and accepted here.

## Decisions (user-confirmed)

1. **Scope**: full native markdown rendering (option b) — not just code-block
   highlighting.
2. **Pending (still-streaming) text**: render through `Markdown` every tick,
   with memoization to neutralize the 150 ms ticker cost.
3. **Thinking segments**: mirror pi — `Markdown` with `thinkingText` + italic
   default style. The current `⠿ ` prefix is dropped (pane shows one task at a
   time; pi shows no prefix).

Rejected alternatives:

- *Plain while streaming, markdown when sealed*: cheaper, no transient
  artifacts, but content visibly "pops" into styling at segment end.
- *Fence-aware hybrid* (render only complete fences, tail plain): smoothest
  look, but diverges from native streaming behavior and adds logic.

## Architecture

New module **`watch-render.ts`** — single responsibility: trace → styled lines,
markdown-aware, memoized. Dependency graph addition:

```
live → watch-render → watch
       (pi-tui: Markdown)
       (pi-coding-agent: getMarkdownTheme)
```

- `watch.ts` keeps all pane/keybind/pager logic. It stops calling
  `traceToLines` / `traceLineCount` / `buildTraceView` and uses the watch
  renderer as the **single source of truth for both lines and line count**, so
  scroll math can never drift from rendering.
- `live.ts` stays untouched and pi-free (AGENTS.md constraint). Its exported
  helpers remain for existing unit tests; `watch.ts` simply stops using them.
  The pure pager helpers (`maxTraceTop`, `resolveViewTop`, `moveViewTop`,
  `linesAboveTail`) are reused unchanged.

## Rendering rules

| Segment | Renderer |
|---|---|
| `text` (sealed) | `new Markdown(text, 0, 0, mdTheme)` → `.render(width)` |
| `text` (pending stream) | same, each tick, on the growing text |
| `thinking` (sealed + pending) | `Markdown` + `defaultTextStyle { color: thinkingText, italic: true }` |
| `toolCall` | `formatToolCall` (unchanged) |
| `toolOutput` | current plain `└ ` styled lines (unchanged). pi's diff-aware tool box (`ToolExecutionComponent` / `renderDiff`) is out of scope — future work. |
| dropped-segments marker | current muted `⋯` line (unchanged) |

- `mdTheme = getMarkdownTheme()` — resolves against the user's active theme via
  pi's global singleton (custom themes + hot-reload included). Resolved on each
  line rebuild (it is a cheap object of closures); the returned theme functions
  read colors lazily through the theme singleton's proxy and `getCliHighlightTheme`
  caches by Theme instance identity, so a hot-reloaded theme propagates on the
  next render with no extra work.
- `codeBlockIndent` uses the `Markdown` default (`"  "`); the conversation's
  `settingsManager.getCodeBlockIndent()` is not reachable from the extension
  process. Accepted limitation.

## Memoization & performance

The pane ticker fires every 150 ms even when nothing changed. Renderer keeps
per-task state:

- `segments: Map<index, { text, lines }>` — sealed segments are immutable in
  `live.ts`, so cache hits are exact; `text` equality is checked as a guard.
- `pending: { text, lines } | null` — keyed on the pending string; identical
  text → reuse lines, no re-parse/highlight.
- Width change invalidates the whole cache.

Result: per-frame cost is O(changed content); a fully idle pane costs only an
equality check per segment. Only changed content ever re-parses/re-highlights —
strictly cheaper than pi's conversation, which re-renders everything per delta
without caching.

## Pager integration

- `traceLength` in `watch.ts` switches from `traceLineCount` to the watch
  renderer's cached line count.
- `renderWatchPane` slices the renderer's full line list to the
  `[top, top+height)` window reusing `maxTraceTop` / `resolveViewTop` and the
  existing `view.top` / `maxTop` / `atTail` derived values. Line count used by
  the footer ("N above") is the renderer's count.

## Error handling

- `getMarkdownTheme()` throws if the theme singleton was never initialized
  (should not happen in interactive mode; child processes never load the
  extension because they run `--no-extensions`). The renderer guards the theme
  factory with try/catch and falls back to the current per-line
  `theme.fg("text"|"thinkingText", …)` path, so the pane never goes blank.
- `Markdown.render` internally try/catches highlighting (unknown/absent
  languages fall back to `mdCodeBlock` lines) — no action needed.

## Testing

The renderer (watch-render.ts) is thin glue over pi's Markdown component and
ships no dedicated node --test suite: it imports pi-tui at module top, so it
cannot run under Node's type stripping, and the no-theme / render-throw
fallback branches have no injection seam (resolved via resolveOptional in the
constructor). The testable core lives in live.ts and is covered by
tests/live.test.mjs (TDD, fail → pass):

1. Segment-kind classification (`isMarkdownSegment`) — text/thinking → markdown,
   toolCall/toolOutput → plain.
2. LineCache behavior via injected fake builders — same key+kind+text reuse
   (builder not called again), text change rebuilds, kind change rebuilds
   (thinking↔text collision), per-key separation incl. the -1 pending key,
   width change invalidates, same-width no-op.
3. Fallback primitive (`resolveOptional`) — factory throws → undefined.

The never-blank guarantees (no-theme → traceToLines, Markdown.render throw →
plain per-line) are verified by a headless smoke run in Task 5 (real pi
theme: syntax-highlighted fences emit distinct syntax* ANSI, headings/mdHeading
colors, tables, memoized re-renders, line-count parity) and by the interactive
pane checklist. This deviation is deliberate: the pure paradigm of this repo
(core.ts/live.ts run under node --test) leaves TUI-glue untested by design.

## Out of scope

- Tool-output diff rendering (`renderDiff`, `ToolExecutionComponent`).
- `codeBlockIndent` from settings.
- Anything in `live.ts` (state model unchanged).