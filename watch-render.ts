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
 * width + kind + text, so the pane's 150ms ticker re-renders only changed
 * content (a kind or text change at the same index rebuilds that segment).
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
		if (!this.md) {
			console.warn("watch: markdown theme unavailable; watch pane uses plain rendering");
		}
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
				out.push(...this.cache.get(i, seg.kind, seg.text, () => this.renderMarkdown(seg, width)));
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
		const pending = trace.pending;
		if (pending && pending.text.trim()) {
			out.push(...this.cache.get(-1, pending.kind, pending.text, () => this.renderMarkdown(pending, width)));
		}
		return out;
	}

	/** Render one text/thinking segment through pi's native Markdown component. */
	private renderMarkdown(seg: { kind: "thinking" | "text"; text: string }, width: number): string[] {
		const md = this.md!;
		const defaultTextStyle: DefaultTextStyle | undefined =
			seg.kind === "thinking"
				? { color: (text) => this.style("thinkingText", text), italic: true }
				: undefined;
		// pi's conversation renders exactly: new Markdown(text.trim(), pad, 0, getMarkdownTheme(), defaultStyle).
		const text = seg.text.trim();
		try {
			return new Markdown(text, 0, 0, md, defaultTextStyle).render(width);
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
