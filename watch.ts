/**
 * watch.ts — Keybind-toggled overlay watch pane for running subagents.
 *
 * The pane is a centered, bordered, non-capturing display surface
 * (tui.showOverlay), refreshed on a ~150ms ticker; all pane keys are handled
 * here via ui.onTerminalInput (see index.ts) — no overlay focus capture, no
 * editor interference.
 *
 * Scrolling is absolute-viewport based (pager semantics): scrolling up pins
 * the viewport where it is, so new tokens never shove the text you're
 * reading up and away; End (or scrolling down to the live edge) resumes
 * tailing.
 *
 * Key events: the terminal reports press/repeat/release (Kitty flag 2) and
 * matchesKey matches all three. A key release of the toggle key would
 * re-match `shift+ctrl+w` and undo the toggle, and held repeats would
 * flip-flop it — so releases are ignored entirely and repeats are ignored
 * for the toggle key (repeats of scroll keys are kept: holding ↑ scrolls).
 */

import {
	isKeyRelease,
	isKeyRepeat,
	matchesKey,
	truncateToWidth,
	type OverlayHandle,
	type TUI,
} from "@earendil-works/pi-tui";
import {
	buildTraceView,
	emptyLiveTrace,
	moveViewTop,
	traceLineCount,
	type LiveTrace,
} from "./live.ts";
import { formatElapsed, formatModelTag, WATCH_PANE_KEYBIND } from "./core.ts";
import { jobs, tasks, type Task } from "./runtime.ts";
import { formatToolCall, getWidgetTheme, getWidgetTui } from "./tui.ts";

const TICK_MS = 150;
const SCROLL_PAGE = 10;
/** Follow-the-tail sentinel for WatchState.viewTop. */
const FOLLOW_TAIL = -1;

interface WatchState {
	taskId: string;
	/**
	 * Absolute index of the first visible trace line; FOLLOW_TAIL (-1) = follow
	 * the live tail. A non-negative value pins the viewport while the trace
	 * grows (scrolling up pauses tailing).
	 */
	viewTop: number;
}

let watchHandle: OverlayHandle | undefined;
let watchState: WatchState | undefined;
let watchTimer: NodeJS.Timeout | undefined;
/** Overlay width captured at the last render (for input-time scroll math). */
let watchWidth = 0;

function runningTasks(): Task[] {
	return [...tasks.values()].filter((t) => t.status === "running");
}

/** Trace body rows inside the pane, excluding frame + header + footer. */
function contentHeight(tui: TUI): number {
	return Math.max(2, Math.floor(tui.terminal.rows * 0.9) - 4);
}

/** Content width inside the pane frame. */
function contentWidth(tui: TUI): number {
	return (watchWidth > 0 ? watchWidth : Math.floor(tui.terminal.columns * 0.98)) - 2;
}

/** Count the rendered trace lines of a task at the current pane width. */
function traceLength(task: Task | null, tui: TUI): number {
	if (!task) return 0;
	return traceLineCount(task.live, Math.max(1, contentWidth(tui)), formatToolCall);
}

/** Toggle the watch pane; no-op when no subagent is running. */
export function toggleWatch(): void {
	const tui = getWidgetTui();
	if (!tui) return;
	if (watchState) {
		closeWatch();
		return;
	}
	const running = runningTasks();
	if (running.length === 0) return;
	watchState = { taskId: running[0].id, viewTop: FOLLOW_TAIL };
	const component = {
		render: (width: number) => renderWatchPane(tui, width),
		invalidate: () => {},
	};
	watchHandle = tui.showOverlay(component, {
		anchor: "center",
		maxHeight: "90%",
		width: "98%",
		nonCapturing: true,
	});
	startWatchTicker(tui);
	tui.requestRender();
}

/** Close the watch pane (also called on session shutdown). */
export function closeWatch(): void {
	watchHandle?.hide();
	watchHandle = undefined;
	watchState = undefined;
	watchWidth = 0;
	stopWatchTicker();
}

/** Session teardown: close and drop all watch state. */
export function disposeWatch(): void {
	closeWatch();
}

/** Called when a job batch finishes: close the pane when nothing at all is running. */
export function maybeAutoCloseWatch(): void {
	if (!watchState) return;
	const anyRunning = [...tasks.values()].some((t) => t.status === "running");
	const anyJob = [...jobs.values()].some((j) => j.status === "running");
	if (!anyRunning && !anyJob) closeWatch();
}

/**
 * Raw terminal input handler wired from index.ts. Consumes only watch-pane
 * keys; everything else passes through to the app/editor unchanged.
 */
export function handleWatchInput(data: string): { consume?: boolean } | undefined {
	// Ignore key releases outright: with Kitty flag 2 the terminal reports
	// press/release pairs and matchesKey matches both — treating a release of
	// the toggle key as another press made the pane flash open and closed,
	// and close randomly while held. Releases of scroll keys must not scroll.
	if (isKeyRelease(data)) {
		return watchState ? { consume: true } : undefined;
	}
	const state = watchState;
	if (!state) {
		if (matchesKey(data, WATCH_PANE_KEYBIND) && !isKeyRepeat(data)) {
			toggleWatch();
			return { consume: true };
		}
		return undefined;
	}
	if (matchesKey(data, "escape")) {
		closeWatch();
		return { consume: true };
	}
	if (matchesKey(data, WATCH_PANE_KEYBIND)) {
		// A held key emits repeat events: toggle only on the initial press.
		if (!isKeyRepeat(data)) closeWatch();
		return { consume: true };
	}
	if (matchesKey(data, "up")) {
		scrollWatch(state, -1);
		return { consume: true };
	}
	if (matchesKey(data, "down")) {
		scrollWatch(state, 1);
		return { consume: true };
	}
	if (matchesKey(data, "pageUp")) {
		scrollWatch(state, -SCROLL_PAGE);
		return { consume: true };
	}
	if (matchesKey(data, "pageDown")) {
		scrollWatch(state, SCROLL_PAGE);
		return { consume: true };
	}
	if (matchesKey(data, "end")) {
		state.viewTop = FOLLOW_TAIL;
		return { consume: true };
	}
	if (matchesKey(data, "tab")) {
		cycleAgent(state);
		return { consume: true };
	}
	return undefined;
}

/** Scroll the pane by `delta` lines; reaching the live edge returns to tailing. */
function scrollWatch(state: WatchState, delta: number): void {
	if (delta === 0) return;
	const tui = getWidgetTui();
	if (!tui) return;
	state.viewTop = moveViewTop(traceLength(tasks.get(state.taskId) ?? null, tui), contentHeight(tui), state.viewTop, delta);
}

function cycleAgent(state: WatchState): void {
	const running = runningTasks();
	if (running.length === 0) return;
	const idx = running.findIndex((t) => t.id === state.taskId);
	const next = running[(idx + 1) % running.length];
	state.taskId = next.id;
	state.viewTop = FOLLOW_TAIL;
}

function startWatchTicker(tui: TUI): void {
	stopWatchTicker();
	watchTimer = setInterval(() => tui.requestRender(), TICK_MS);
	watchTimer.unref?.();
}

function stopWatchTicker(): void {
	if (watchTimer) {
		clearInterval(watchTimer);
		watchTimer = undefined;
	}
}

/**
 * Map a trace token onto the main conversation's palette. Thinking blocks and
 * assistant body text and tool output use the conversation's own colors
 * (thinkingText / text / toolOutput) instead of the generic dim/muted.
 */
function conversationColor(token: string): string {
	switch (token) {
		case "thinking":
			return "thinkingText";
		case "text":
			return "text";
		case "toolOutput":
			return "toolOutput";
		case "error":
			return "error";
		default:
			return token;
	}
}

/** Pad/truncate a styled line to exactly `width` visible columns. */
function padToWidth(styled: string, width: number): string {
	return truncateToWidth(styled, width, "", true);
}

function renderWatchPane(tui: TUI, width: number): string[] {
	watchWidth = width;
	const theme = getWidgetTheme();
	if (!theme) return [];
	const running = runningTasks();
	const state = watchState ?? ({ taskId: "", viewTop: FOLLOW_TAIL } as WatchState);
	let task = tasks.get(state.taskId);
	if (!task) {
		// Selected task vanished from the registry — fall back to the first running task.
		task = running[0] ?? null;
		if (task) {
			state.taskId = task.id;
			state.viewTop = FOLLOW_TAIL;
		}
	}
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
}

function buildHeader(task: Task | null, running: Task[], state: WatchState, theme: any): string {
	const pos = running.findIndex((t) => t.id === state.taskId);
	const label = task ? theme.fg("accent", task.agent) : theme.fg("muted", "—");
	const sel = pos >= 0 && running.length > 0 ? theme.fg("accent", `${pos + 1}/${running.length}`) : "";
	const elapsed = task?.status === "running" ? theme.fg("dim", formatElapsed((Date.now() - task.startedAt) / 1000)) : "";
	const model = task ? theme.fg("dim", formatModelTag(task.model)) : "";
	const status = task?.status === "running" ? theme.fg("warning", "● watching") : theme.fg("success", "✓ done");
	const meta = [label, sel, elapsed, model].filter(Boolean).join(theme.fg("dim", " · "));
	return `${status}  ${meta}`;
}

function buildFooter(atTail: boolean, above: number, theme: any): string {
	const left = atTail ? theme.fg("success", "● live") : theme.fg("warning", `↑ ${above} above`);
	const hints = theme.fg("muted", "  ↑↓ scroll · PgUp/PgDn · Tab agent · End tail · Esc close");
	return left + hints;
}
