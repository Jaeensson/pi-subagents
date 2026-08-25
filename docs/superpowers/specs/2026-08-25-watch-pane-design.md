# Live subagent watch pane — design

**Date:** 2026-08-25
**Status:** Approved (spec stage)
**Feature:** Live visibility into running subagents: watch a chosen subagent's
reasoning/activity stream in real time from the pi TUI.

## Problem

Subagents run in their own `pi --mode json` child processes. Today the parent
can only see: a compact 1s-tick status widget (agent, elapsed, last 48-char
activity snippet), `subagent_status` (which says "(running, no output yet)"),
and completed results. There is no way to *watch* what a subagent is thinking
and doing while it runs.

## Key finding (drives the design)

The live data already flows. Children serialize **every** session event to
stdout as one JSON line per event (print-mode `--mode json` path). Empirically
verified on a real child capture (pi 0.84.1):

- `message_update` — fired token-by-token during streaming; on stdout it
  carries ONLY `{ type, assistantMessageEvent }` (the cumulative partial
  `message` exists only in-process; `toJsonEvent` drops it — rpc.md calls it
  the "former cumulative message"):
  - `text_start/delta/end`, `thinking_start/delta/end` (delta strings; `*_end`
    carries the accumulated `content`),
  - `toolcall_start/delta/end` — `toolcall_end` carries a COMPLETE
    `toolCall` `{ id, name, arguments }` (arguments may be an object or a
    JSON string), which is the live tool-call source.
- `tool_execution_start / _update / _end` — partial tool output. On stdout,
  `partialResult`/`result` are SNAPSHOT objects `{ content: [{ type:"text",
  text }] }` (each update repeats the cumulative output — REPLACE, never
  append); `_end` carries `isError`.
- `message_end` — carries the full `message` with `content` parts, including
  complete `toolCall` parts (reconcile source).

`applyEventLine` (core.ts) currently drops all of it — it only records
completed `message_end` messages and `tool_result_end`. The work is therefore
**consumption + presentation**, not plumbing.

Verified against pi 0.84.1 + `@earendil-works/pi-tui`:

- `matchesKey` is exported by pi-tui; `ui.onTerminalInput` (interactive mode
  only) runs before app keybind dispatch and can consume keys.
- `tui.showOverlay` supports `anchor`, `maxHeight` (number or %), and
  `nonCapturing` (display-only overlay, no focus capture). Overlay components
  are re-rendered on every TUI render cycle; output is defensively sliced to
  `maxHeight`; component `render(width)` receives only width, so the component
  computes its visible window from `tui.terminal` dimensions.
- `Ctrl+W` is taken (kill word). `shift+ctrl+w` is unbound.

## Requirements

1. Press `shift+ctrl+w` while ≥1 subagent runs → a bottom-anchored overlay
   pane (~90% height) shows the selected subagent's live reasoning/activity
   stream, updating in real time.
2. While the pane is open, its keys are captured (scroll, switch agent,
   close); the editor is undisturbed. `Esc` or the toggle key closes the pane.
3. Thinking is *shown* (dimmed) — unlike pi's normal hidden-thinking display —
   along with visible text, tool calls, and live tool output.
4. Scrolling up pauses auto-follow; `End` re-follows the live tail.
5. Reasoning is retained in-memory only (ring-buffer capped) and never
   re-enters model context.
6. The pane closes when the last watched agent finishes (the existing
   completion card announces results). Print/JSON modes are unaffected.

## Architecture

### Module layout (dependency graph stays acyclic)

Per-module dependencies (no cycles; watch.ts never imports process.ts):

```
live.ts    — pure; zero pi imports (node --test like core.ts); depends on nothing
runtime.ts — depends on core.ts (already does); gains Task.live field
process.ts — depends on runtime + core + live + tui (already depends on tui)
watch.ts   — depends on runtime + live + core + pi-tui; never imports process.ts
index.ts   — wires all of the above (input listener + teardown)
tui.ts     — depends on runtime + core; compact widget hint line only
```

### 1. `live.ts` — live-state core (new, pure)

Types:

```ts
type TraceSegment =
  | { kind: "thinking"; text: string }
  | { kind: "text"; text: string }
  | { kind: "toolCall"; name: string; args: Record<string, unknown> }
  | { kind: "toolOutput"; text: string; isError?: boolean };

interface LiveTrace {
  segments: TraceSegment[];                    // chronological
  bytes: number;                               // approx retained bytes
  dropped: number;                             // segments evicted from head
  pending: { kind: "thinking" | "text"; text: string } | null; // unsealed stream
}
```

- `applyLiveEvent(line: string, trace: LiveTrace): LiveTrace` — parses the
  JSON line; reduces only live-relevant events; everything else passes
  through unchanged (never throws on malformed lines).
  - `message_update` with `assistantMessageEvent.type` in
    `text_start | text_delta | text_end | thinking_start | thinking_delta |
    thinking_end | toolcall_start | toolcall_delta | toolcall_end`.
    Delta strings (`delta`) accumulate into `pending`; `*_start` events carry
    no delta but are **boundary signals that seal the previous stream**;
    `*_end` events carry `content`/`toolCall` and seal the current one.
    `toolcall_end` emits a `toolCall` segment from its `toolCall` field,
    deduped by `contentIndex` via a per-index emitted SET (not a monotonic
    watermark — skipped/reordered indices must stay recoverable at
    reconcile); a `messageSealed` flag (set at `message_end`, cleared by the
    next message's `*_start`) blocks straggling `toolcall_end` duplicates.
  - `tool_execution_start / _update / _end` → `toolOutput` segments. On the
    real wire `partialResult`/`result` are cumulative SNAPSHOT objects
    `{ content: [{ type: "text", text }] }` — the open segment's text is
    REPLACED by each new snapshot, never appended (`_end` also sets
    `isError`). Open segments are routed by `toolCallId` (fallback: newest
    toolOutput) so parallel or stale execution events can't misattribute
    output or error flags; the cap is enforced on the replace path too.
- **Sealing boundaries** (driven by the `*_start`/`toolcall_*` events above):
  `thinking_start` seals any pending text; `text_start` seals pending
  thinking; `toolcall_start`/`toolcall_delta`/`toolcall_end` seal pending
  thinking *and* text. The final `message_end` reconcile seals anything still
  pending.
- **Completeness reconcile**: on `message_end` (already consumed by
  core.ts `applyEventLine`), scan the full message's `toolCall` content parts
  and emit any content index not yet emitted (deltas/`toolcall_end` may have
  been missed), then reset the content index for the next message. The final
  truth also lives in core's own `messages`.
- **Ring-buffer cap**: `LIVE_TRACE_CAP_BYTES = 64 * 1024` per task. When over
  cap, drop whole segments from the head and count them in `dropped`. Memory
  stays bounded; reasoning never re-enters model context.

### 2. `process.ts` — capture

One new line in the child stdout handler, alongside the existing
`applyEventLine(line, task)`:

```ts
task.live = applyLiveEvent(line, task.live);
```

### 3. `runtime.ts` — state

- `Task` gains `live: LiveTrace` (initialized empty in `spawnTask`).
- `toTaskInfo` unchanged (live trace is not exposed to the model or
  `subagent_status` in this iteration).
- Trace freezes naturally when the task finalizes (no more line events).

### 4. `watch.ts` — watch pane (new, TUI-only)

State (module-level, mirroring the `tui.ts` widget pattern):

```ts
interface WatchState {
  open: boolean;
  selectedTaskId: string | null;
  scrollOffset: number;   // 0 = live tail
  follow: boolean;        // false once the user scrolls up; End re-enables
}
```

- **Toggle** (`shift+ctrl+w`): no-ops when no task is running; opens
  `tui.showOverlay(component, { anchor: "bottom-center", maxHeight: "90%",
  nonCapturing: true })`; closes via `OverlayHandle.hide()`.
  `nonCapturing: true` because the pane is a display surface — the
  extension's own input listener owns all pane keys (no focus-stealing, no
  overlay-focus edge cases).
- **Component** `render(width)`: reads terminal height from `tui.terminal`,
  computes the visible window (header + content + footer), builds lines from
  the selected task's `LiveTrace` via a pure trace→lines builder, and emits
  exactly the windowed lines (the TUI slices defensively to `maxHeight`).
- **Refresh**: while open, a ~150 ms ticker calls `tui.requestRender()`
  (the TUI coalesces render requests internally). Content re-renders every
  TUI cycle since overlays re-render per cycle.
- **Keys while open** (matched via `matchesKey`, consumed):
  `arrow_up`/`arrow_down` scroll; `pageup`/`pagedown` page; `tab` cycles
  running agents; `end` jumps to the live tail and re-enables follow; `escape`
  closes (also `shift+ctrl+w` closes).
- **Header**: `● watching: <agent> · k/n <elapsed> · <model tag>` reusing
  existing format helpers; verbosity slider not in scope. **Footer**:
  `● live  ↑↓ scroll · PgUp/PgDn · Tab agent · End tail · Esc close` (or a
  dimmed `↑ 83 lines above` indicator when scrolled back + `⋯ N segments
  dropped` when the ring buffer has evicted content).
- **Rendering** (pure builder, theme injected):
  - thinking → `theme.fg("dim", …)`
  - text → `theme.fg("toolOutput", …)`
  - tool calls → reuse `formatToolCall(name, args, theme.fg)`
  - tool output → dim, indented
- **Auto-close**: when the last watched agent finishes, close (completion
  card announces results as today). While other agents still run, a finished
  selected task KEEPS its final view — header `✓ done`, no counting elapsed
  clock, no `0/N` position; `Tab` still cycles to running agents.
- `closeWatch()` exported; called on session shutdown (with `disposeWidget()`).

### 5. `index.ts` + `tui.ts` — integration

- `index.ts`: on `session_start` (TUI only), register one
  `ui.onTerminalInput` handler: if the watch pane is open, handle pane keys
  (consume); else, match only the toggle key (consume). Teardown calls
  `closeWatch()` before `disposeWidget()`/kill sweep.
- `tui.ts`: compact widget header gains a muted hint when running:
  `⏳ 2 subagents running · shift+ctrl+w to watch`. No other changes.

## Renderer mockup

```
┌─ ● watching: scout · 1/2  3m 12s · claude-opus-4-5 ────────────────┐
│ ⠿ (thinking)                                                       │
│   let me check where settings are read… config.ts:14                │
│ → grep pattern="modelTiers" in src/                                 │
│   pages… done, 1 hit                                                │
│ hmm, but resolution happens at spawn time, so:                      │
│ → read path=src/jobs.ts                                             │
│                                                                    │
│ ● live   ↑↓ scroll · PgUp/PgDn · Tab agent · End tail · Esc close  │
└────────────────────────────────────────────────────────────────────┘
```

## Error handling & edge cases

- **Missed deltas**: `message_end` reconcile keeps final content truthful.
- **Toggle with nothing running**: no-op (optionally `ui.notify` — TUI only).
- **Terminal resize**: window recomputed per render from live dimensions.
- **Session shutdown/reload**: `closeWatch()` hides the overlay; children are
  killed by the existing sweep.
- **Huge thinking streams (e.g. Opus)**: 64 KB ring buffer bounds memory;
  rendering only walks the retained window.
- **Malformed/unknown lines**: `applyLiveEvent` never throws; ignores.

## Testing (TDD, red-first)

- `live.ts` reducer: synthetic event stream (text/thinking/toolcall deltas,
  tool execution start/update/end, `message_end` reconcile) → assert segment
  order/kinds, sealing boundaries, cap eviction + `dropped`, non-live lines
  ignored, malformed lines ignored.
- Trace→lines builder: given segments + theme stub → styled lines,
  wrapping/truncation, windowing for a given height, dropped-segment marker.
- Manual spike (flagged in the plan, before the reducer): confirm the exact
  `message_update` payload shape on real child output (event types, delta
  field names) with a one-off `pi --mode json` run; adjust reducer field
  names if the observed payload differs.

## Out of scope (future)

- `subagent_status` "current activity" enrichment from the trace.
- Reasoning logs to file for replay/audit.
- Live tails in the compact widget (user chose the keybind-only pane).
- Chat-streaming of reasoning (rejected approach).