# Watch Pane Native Markdown Rendering — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render the watch pane's assistant text and thinking segments through pi's native `Markdown` component with pi's own theme (`getMarkdownTheme()`), so code blocks get the same syntax highlighting as the main conversation.

**Architecture:** A new leaf module `watch-render.ts` owns markdown-aware trace→lines rendering (pi-tui `Markdown` + pi-coding-agent `getMarkdownTheme`), memoized per segment via a pure `LineCache` added to `live.ts` so the 150 ms ticker only re-renders changed content. `watch.ts` keeps all pane/keybind/pager logic and uses the renderer as the single source of truth for both lines and line count (reusing the unchanged pure pager helpers from `live.ts`). `live.ts` stays pi-free and gains only pure helpers (`LineCache`, `isMarkdownSegment`, `resolveOptional`), unit-tested with `node --test`.

**Tech Stack:** TypeScript (erasable syntax only, `verbatimModuleSyntax`), `node --test` for pure unit tests, `@earendil-works/pi-tui` (`Markdown`, `type MarkdownTheme`, `type DefaultTextStyle`), `@earendil-works/pi-coding-agent` (`getMarkdownTheme`).

Design spec: `docs/superpowers/specs/2026-08-26-watch-pane-native-markdown-design.md`

---

### Task 1: Pure helpers in live.ts (TDD)

**Files:**
- Modify: `live.ts` (append at end)
- Test: `tests/live.test.mjs` (update imports + append tests)

- [ ] **Step 1: Write the failing tests**

Update the import line at the top of `tests/live.test.mjs`:

```js
import { LIVE_TRACE_CAP_BYTES, applyLiveEvent, buildTraceView, emptyLiveTrace, isMarkdownSegment, LineCache, linesAboveTail, moveViewTop, reduceLiveEvent, resolveOptional, resolveViewTop, traceLineCount, traceToLines, wrapToWidth } from "../live.ts";
```

Append these tests at the end of `tests/live.test.mjs`:

```js
// ── Native-markdown rendering helpers (watch pane) ──────────────────────────

test("isMarkdownSegment classifies text and thinking as markdown, the rest plain", () => {
	assert.equal(isMarkdownSegment({ kind: "text", text: "x" }), true);
	assert.equal(isMarkdownSegment({ kind: "thinking", text: "x" }), true);
	assert.equal(isMarkdownSegment({ kind: "toolCall", name: "bash", args: {} }), false);
	assert.equal(isMarkdownSegment({ kind: "toolOutput", text: "x", isError: false }), false);
});

test("LineCache reuses built lines on same width/key/text", () => {
	const cache = new LineCache(40);
	let builds = 0;
	const build = (w) => { builds++; return [`line@${w}`]; };
	assert.deepEqual(cache.get(0, "text", build), ["line@40"]);
	assert.deepEqual(cache.get(0, "text", build), ["line@40"]); // cached
	assert.equal(builds, 1);
});

test("LineCache rebuilds when the text under a key changes (eviction reuses indices)", () => {
	const cache = new LineCache(40);
	let builds = 0;
	const build = (w) => { builds++; return [`@${w}`]; };
	cache.get(0, "old", build);
	cache.get(0, "new", build);
	assert.equal(builds, 2);
});

test("LineCache keeps separate entries per key (segment index vs pending -1)", () => {
	const cache = new LineCache(40);
	const keyed = (key) => (w) => [`${key}@${w}`];
	assert.deepEqual(cache.get(0, "same", keyed(0)), ["0@40"]);
	assert.deepEqual(cache.get(1, "same", keyed(1)), ["1@40"]);
	assert.deepEqual(cache.get(0, "same", keyed(0)), ["0@40"]); // key 0 still cached
});

test("LineCache invalidates all entries when the width changes", () => {
	const cache = new LineCache(40);
	let builds = 0;
	const build = (w) => { builds++; return [`@${w}`]; };
	cache.get(0, "x", build);
	cache.setWidth(50);
	cache.get(0, "x", build);
	cache.setWidth(50); // same width → no invalidation
	cache.get(0, "x", build);
	assert.equal(builds, 2);
	assert.equal(cache.width, 50);
});

test("resolveOptional returns the factory result and undefined on throw", () => {
	assert.equal(resolveOptional(() => "theme"), "theme");
	assert.equal(resolveOptional(() => { throw new Error("not initialized"); }), undefined);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/live.test.mjs`
Expected: FAIL — type-stripping import error for `isMarkdownSegment` / `LineCache` / `resolveOptional` (not exported from `live.ts`).

- [ ] **Step 3: Implement the minimal code**

Append to the end of `live.ts`:

```ts
/**
 * Whether a segment takes the native-markdown render path (text and thinking
 * are markdown; tool calls and tool output are plain).
 */
export function isMarkdownSegment(seg: TraceSegment): boolean {
	return seg.kind === "text" || seg.kind === "thinking";
}

/**
 * Safely resolve a renderer dependency that may throw (e.g. pi's markdown
 * theme factory, which throws when its global theme singleton is not
 * initialized). undefined → callers fall back to plain rendering so the
 * watch pane never blanks.
 */
export function resolveOptional<T>(factory: () => T): T | undefined {
	try {
		return factory();
	} catch {
		return undefined;
	}
}

/**
 * Rendered-line cache scoped to one render width. Entries are keyed by
 * content key (segment index; -1 for the pending stream) and guarded by the
 * exact source text: the trace ring buffer can evict the head and reuse an
 * index with different text, and only a text change needs a rebuild.
 */
export class LineCache {
	width: number;
	private entries = new Map<number, { text: string; lines: string[] }>();

	constructor(width: number) {
		this.width = width;
	}

	/** Change the render width; any width change invalidates all entries. */
	setWidth(width: number): void {
		if (width === this.width) return;
		this.width = width;
		this.entries.clear();
	}

	/** Cached lines for `key` + `text`, or build-and-cache via `build`. */
	get(key: number, text: string, build: (width: number) => string[]): string[] {
		const hit = this.entries.get(key);
		if (hit && hit.text === text) return hit.lines;
		const lines = build(this.width);
		this.entries.set(key, { text, lines });
		return lines;
	}
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/live.test.mjs`
Expected: PASS (all existing + new tests green).

- [ ] **Step 5: Commit**

```bash
git add tests/live.test.mjs live.ts
git commit -m "feat(watch): pure render helpers for markdown watch pane (LineCache, classification)"
```

---

### Task 2: TraceRenderer in watch-render.ts

**Files:**
- Create: `watch-render.ts`
- Modify: `tsconfig.json` (add to `include`)

- [ ] **Step 1: Create watch-render.ts**

```ts
/**
 * watch-render.ts — Markdown-aware trace rendering for the watch pane.
 *
 * Renders sealed + pending text and thinking segments through pi's native
 * Markdown component with pi's own theme (getMarkdownTheme: headings, lists,
 * inline code, tables, and syntax-highlighted code blocks using the theme's
 * syntax* tokens) — the same rendering the main conversation shows. Tool
 * calls and tool output keep the plain per-kind styling.
 *
 * Cost: live.ts's LineCache memoizes rendered lines per segment, keyed by
 * width + text, so the pane's 150ms ticker re-renders only changed content.
 * The markdown theme is resolved lazily via resolveOptional: when pi's theme
 * singleton is unavailable the renderer degrades to plain traceToLines so
 * the pane never blanks.
 */

import { Markdown, type DefaultTextStyle, type MarkdownTheme } from "@earendil-works/pi-tui";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import {
	LineCache,
	isMarkdownSegment,
	resolveOptional,
	traceToLines,
	wrapToWidth,
	type FormatToolCallFn,
	type LiveTrace,
	type StyleFn,
	type TraceSegment,
} from "./live.ts";

export interface TraceRenderOptions {
	/** Content width (columns) the pane body renders at. */
	width: number;
	/** (token, text) → styled text; abstract tokens like traceToLines. */
	style: StyleFn;
	formatToolCall: FormatToolCallFn;
}

/**
 * Renders one trace to styled lines. Markdown kinds go through `Markdown`
 * (cached per segment); without a markdown theme it degrades to the plain
 * `traceToLines` path.
 *
 * NOT unit-tested with node --test (imports pi-tui); its testable core —
 * LineCache, isMarkdownSegment, resolveOptional — lives in live.ts and is
 * covered by tests/live.test.mjs.
 */
export class TraceRenderer {
	private readonly cache: LineCache;
	private readonly style: StyleFn;
	private readonly formatToolCall: FormatToolCallFn;
	private readonly md: MarkdownTheme | undefined;

	constructor(opts: TraceRenderOptions) {
		this.cache = new LineCache(opts.width);
		this.style = opts.style;
		this.formatToolCall = opts.formatToolCall;
		this.md = resolveOptional(() => getMarkdownTheme());
	}

	/** Change the render width (invalidates the cache only when it changed). */
	setWidth(width: number): void {
		this.cache.setWidth(width);
	}

	/** Full styled line list for the trace (not windowed to a height). */
	lines(trace: LiveTrace): string[] {
		if (!this.md) {
			return traceToLines(trace, { width: this.cache.width, style: this.style, formatToolCall: this.formatToolCall });
		}
		const width = this.cache.width;
		const out: string[] = [];
		if (trace.dropped > 0) {
			out.push(this.style("muted", `⋯ ${trace.dropped} earlier segment${trace.dropped === 1 ? "" : "s"} dropped`));
		}
		trace.segments.forEach((seg, i) => {
			if (isMarkdownSegment(seg)) {
				out.push(...this.cache.get(i, seg.text, () => this.renderMarkdown(seg, width)));
				return;
			}
			if (seg.kind === "toolCall") {
				out.push(this.formatToolCall(seg.name, seg.args, this.style));
				return;
			}
			if (seg.text) {
				out.push(...this.plainLines(seg.isError ? "error" : "toolOutput", "└ ", seg.text, width));
			}
		});
		const pending = trace.pending
			? ({ kind: trace.pending.kind, text: trace.pending.text } as TraceSegment)
			: null;
		if (pending && pending.text.trim()) {
			out.push(...this.cache.get(-1, pending.text, () => this.renderMarkdown(pending, width)));
		}
		return out;
	}

	/** Render one text/thinking segment through pi's native Markdown component. */
	private renderMarkdown(seg: TraceSegment, width: number): string[] {
		const md = this.md!;
		const defaultTextStyle: DefaultTextStyle | undefined =
			seg.kind === "thinking"
				? { color: (text) => this.style("thinkingText", text), italic: true }
				: undefined;
		try {
			// pi's conversation renders exactly: new Markdown(text, pad, 0, getMarkdownTheme(), defaultStyle).
			return new Markdown(seg.text, 0, 0, md, defaultTextStyle).render(width);
		} catch {
			// Defensive: never blank the pane; degrade to the plain per-line path.
			return this.plainLines(
				seg.kind === "thinking" ? "thinking" : "text",
				seg.kind === "thinking" ? "⠿ " : "",
				seg.text,
				width,
			);
		}
	}

	/** Plain wrapped lines with an optional first-line prefix (like traceToLines). */
	private plainLines(color: string, prefix: string, text: string, width: number): string[] {
		const lines: string[] = [];
		let first = true;
		for (const raw of wrapToWidth(text, Math.max(1, width - prefix.length))) {
			lines.push(this.style(color, (first ? prefix : "") + raw));
			first = false;
		}
		return lines;
	}
}
```

- [ ] **Step 2: Register the module in tsconfig.json**

Modify `tsconfig.json` — add `"watch-render.ts"` to the `include` array (alphabetical, after `"tui.ts"`):

```json
  "include": ["index.ts", "agents.ts", "core.ts", "live.ts", "runtime.ts", "process.ts", "jobs.ts", "tui.ts", "watch-render.ts", "watch.ts", "tools/*.ts"]
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no unused locals, no type errors).

- [ ] **Step 4: Commit**

```bash
git add watch-render.ts tsconfig.json
git commit -m "feat(watch): TraceRenderer — native markdown + syntax highlighting for the watch pane"
```

---

### Task 3: Rewire watch.ts to the TraceRenderer

**Files:**
- Modify: `watch.ts`

- [ ] **Step 1: Update imports**

Replace the `live.ts` import block and add the renderer import. From:

```ts
import {
	buildTraceView,
	emptyLiveTrace,
	moveViewTop,
	traceLineCount,
	type LiveTrace,
} from "./live.ts";
```

to:

```ts
import {
	emptyLiveTrace,
	maxTraceTop,
	moveViewTop,
	resolveViewTop,
	type LiveTrace,
} from "./live.ts";
```

and add after the `./tui.ts` import:

```ts
import { TraceRenderer } from "./watch-render.ts";
```

- [ ] **Step 2: Add renderer module state**

After the existing module state block:

```ts
let watchHandle: OverlayHandle | undefined;
let watchState: WatchState | undefined;
let watchTimer: NodeJS.Timeout | undefined;
/** Overlay width captured at the last render (for input-time scroll math). */
let watchWidth = 0;
```

add:

```ts
/** Markdown-aware trace renderer, rebuilt when the widget theme instance changes. */
let traceRenderer: TraceRenderer | undefined;
let traceRendererTheme: any | undefined;
let traceRendererWidth = 0;
```

- [ ] **Step 3: Add the accessor**

Add after `traceLength`:

```ts
/**
 * Lazy, theme-latched TraceRenderer: rebuilt only when the widget theme
 * instance changes (theme hot-reload); width changes invalidate the line
 * cache without rebuilding state.
 */
function getTraceRenderer(width: number): TraceRenderer | undefined {
	const theme = getWidgetTheme();
	if (!theme) return undefined;
	if (!traceRenderer || traceRendererTheme !== theme) {
		const style = (token: string, text: string) => theme.fg(conversationColor(token), text);
		traceRenderer = new TraceRenderer({ width, style, formatToolCall });
		traceRendererTheme = theme;
		traceRendererWidth = width;
	} else if (traceRendererWidth !== width) {
		traceRenderer.setWidth(width);
		traceRendererWidth = width;
	}
	return traceRenderer;
}
```

- [ ] **Step 4: Switch traceLength to the renderer**

From:

```ts
/** Count the rendered trace lines of a task at the current pane width. */
function traceLength(task: Task | null, tui: TUI): number {
	if (!task) return 0;
	return traceLineCount(task.live, Math.max(1, contentWidth(tui)), formatToolCall);
}
```

to:

```ts
/** Count the rendered trace lines of a task at the current pane width. */
function traceLength(task: Task | null, tui: TUI): number {
	if (!task) return 0;
	const renderer = getTraceRenderer(Math.max(1, contentWidth(tui)));
	if (!renderer) return 0;
	return renderer.lines(task.live).length;
}
```

- [ ] **Step 5: Replace the buildTraceView call in renderWatchPane**

From:

```ts
	const bodyW = Math.max(1, width - 2);
	const height = contentHeight(tui);
	const trace: LiveTrace = task ? task.live : emptyLiveTrace();
	const view = buildTraceView(trace, {
		width: bodyW,
		height,
		viewTop: state.viewTop,
		style: (token, text) => theme.fg(conversationColor(token), text),
		formatToolCall,
	});
	const header = buildHeader(task, running, state, theme);
	const footer = buildFooter(view.atTail, view.maxTop - view.top, theme);

	const frame = theme.fg("border", "│");
	const boxed = (line: string) => frame + padToWidth(line, bodyW) + frame;
	const topBorder = theme.fg("border", `┌${"─".repeat(bodyW)}┐`);
	const bottomBorder = theme.fg("border", `└${"─".repeat(bodyW)}┘`);
	return [topBorder, boxed(header), ...view.lines.map(boxed), boxed(footer), bottomBorder];
```

to:

```ts
	const bodyW = Math.max(1, width - 2);
	const height = contentHeight(tui);
	const trace: LiveTrace = task ? task.live : emptyLiveTrace();
	const renderer = getTraceRenderer(bodyW);
	if (!renderer) return []; // theme vanished — nothing to style
	const lines = renderer.lines(trace);
	const maxTop = maxTraceTop(lines.length, height);
	const top = resolveViewTop(lines.length, height, state.viewTop);
	const visible: string[] = [];
	for (let i = 0; i < height; i++) visible.push(lines[top + i] ?? "");
	const header = buildHeader(task, running, state, theme);
	const footer = buildFooter(top === maxTop, maxTop - top, theme);

	const frame = theme.fg("border", "│");
	const boxed = (line: string) => frame + padToWidth(line, bodyW) + frame;
	const topBorder = theme.fg("border", `┌${"─".repeat(bodyW)}┐`);
	const bottomBorder = theme.fg("border", `└${"─".repeat(bodyW)}┘`);
	return [topBorder, boxed(header), ...visible.map(boxed), boxed(footer), bottomBorder];
```

- [ ] **Step 6: Reset the renderer in closeWatch**

From:

```ts
export function closeWatch(): void {
	watchHandle?.hide();
	watchHandle = undefined;
	watchState = undefined;
	watchWidth = 0;
	stopWatchTicker();
}
```

to:

```ts
export function closeWatch(): void {
	watchHandle?.hide();
	watchHandle = undefined;
	watchState = undefined;
	watchWidth = 0;
	traceRenderer = undefined;
	traceRendererTheme = undefined;
	traceRendererWidth = 0;
	stopWatchTicker();
}
```

- [ ] **Step 7: Typecheck and run the unit tests**

Run: `npm run typecheck` — Expected: PASS.
Run: `npm test` — Expected: PASS (all three suites, including the new live.ts tests).

- [ ] **Step 8: Commit**

```bash
git add watch.ts
git commit -m "feat(watch): render watch pane through TraceRenderer (native markdown, cached)"
```

---

### Task 4: Documentation

**Files:**
- Modify: `AGENTS.md`
- Modify: `README.md`
- Modify: `watch.ts` (header comment)

- [ ] **Step 1: Update AGENTS.md module layout**

From:

```markdown
  - `watch.ts` — keybind-toggled watch pane: overlay component, keys, ticker
    (depends on runtime + live + core + tui; never on process/jobs)
```

to:

```markdown
  - `watch-render.ts` — markdown-aware trace→lines rendering for the watch
    pane: sealed + pending text/thinking through pi's native Markdown +
    getMarkdownTheme, memoized via live.ts's LineCache. Leaf module;
    depends only on live + pi-tui + pi-coding-agent (never process/jobs)
  - `watch.ts` — keybind-toggled watch pane: overlay component, keys, ticker,
    renderer latching (depends on runtime + watch-render + live + core + tui;
    never on process/jobs)
```

And from:

```markdown
- Keep the dependency graph acyclic: live → runtime → process → jobs → tools;
  tui depends on runtime + core; watch depends on runtime + live + core + tui.
```

to:

```markdown
- Keep the dependency graph acyclic: live → runtime → process → jobs → tools;
  tui depends on runtime + core; watch-render depends on live; watch depends
  on runtime + watch-render + live + core + tui.
```

- [ ] **Step 2: Update README watch-pane section**

From:

```markdown
showing a subagent's reasoning stream in real time — thinking, visible text,
tool calls, and in-progress tool output, colored like the main conversation
(thinkingText / text / toolOutput):
```

to:

```markdown
showing a subagent's reasoning stream in real time — thinking, visible text,
tool calls, and in-progress tool output, rendered with the same native
markdown as the main conversation: headings, lists, tables, and
syntax-highlighted code blocks (thinking stays italic thinkingText):
```

And in the ASCII mock, replace the thinking line:

```markdown
    │⠿ let me check where settings are read…                      │
```

with (no prefix — thinking renders like the conversation):

```markdown
    │Let me check where settings are read… (thinking, italic)      │
```

- [ ] **Step 3: Update the watch.ts header comment**

In the file-head doc block, append a line about rendering after the existing scrolling paragraph:

```ts
 * Rendering: assistant text and thinking segments go through pi's native
 * Markdown component (getMarkdownTheme) — syntax-highlighted code blocks,
 * headings, lists, tables — memoized per segment via a LineCache so the
 * ticker re-renders only changed content (see watch-render.ts).
```

- [ ] **Step 4: Verify and commit**

Run: `npm test` — Expected: PASS.
Run: `npm run typecheck` — Expected: PASS.

```bash
git add AGENTS.md README.md watch.ts
git commit -m "docs(watch): document native markdown rendering in the watch pane"
```

---

### Task 5: Manual verification (no commit)

- [ ] **Step 1: Reload and spawn**

In a pi session: `/reload`, then spawn a background subagent that will produce markdown-heavy output, e.g. `subagent` with `wait: false` and a task like "write a plan for X including code blocks, a table, and a heading".

- [ ] **Step 2: Open the pane**

Press `shift+ctrl+w` while the subagent runs. Verify:
- Sealed assistant text renders as markdown: headings colored with `mdHeading`, inline code with `mdCode`, and fenced code blocks syntax-highlighted using the theme's `syntax*` tokens (e.g. keywords/strings/functions differ in color).
- While a code fence is still open, the tail shows as a code block until the closing fence arrives (native streaming behavior), then snaps to highlighted form.
- Thinking segments render with the `thinkingText` color and italic, no `⠿ ` prefix.
- Tool calls and tool output look as before (`→ …`, `└ …`).

- [ ] **Step 3: Scroll/pager consistency**

While streaming: scroll up (`↑`/`PgUp`) — the viewport pins and new tokens arrive below; footer shows `↑ N above`; `End` (or scrolling to the live edge) resumes tailing (`● live`). Confirm the numbers match the visible content and nothing jumps or repeats due to renderer/line-count drift.

- [ ] **Step 4: Idle cost**

Stop the subagent (or wait for a stall in output) and confirm the pane still renders (no blank) and the ticker does not visibly spin CPU (renderer hits the cache; nothing changes → equality checks only).

- [ ] **Step 5: Lifecycle**

`Tab` cycles running agents; `Esc` / toggle closes the pane; spawn another batch and reopen — the pane still renders correctly (renderer rebuilt on open). Finish all agents — pane auto-closes. No console errors in the session log related to watch rendering.

---

## Self-Review Notes (verified at plan time)

- **Spec coverage:** sealed text ✓ (Task 2/3), pending text via Markdown each tick ✓ (Task 2 `lines()` pending branch, cached by key -1), thinking markdown + thinkingText italic + no ⠿ ✓ (`renderMarkdown` default style; prefix only in the defensive catch), toolCall/toolOutput/marker unchanged ✓, memoization width-keyed ✓ (LineCache), single source of truth for lines+count ✓ (Task 3 `traceLength` + `renderWatchPane`), fallback on theme failure ✓ (`resolveOptional`, tested), pager math unchanged ✓ (Task 3 reuses `maxTraceTop`/`resolveViewTop`/`moveViewTop`), docs ✓ (Task 4).
- **Placeholder scan:** every step contains concrete code/commands; no TBDs.
- **Type consistency:** `TraceRenderer` (methods `setWidth`, `lines`) matches all call sites in Task 3; `LineCache` (`width`, `setWidth`, `get`) matches `TraceRenderer` usage; `resolveOptional`/`isMarkdownSegment` used where defined.