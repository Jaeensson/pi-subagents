/**
 * watch.ts — Keybind-toggled overlay watch pane for running subagents.
 *
 * The pane is a non-capturing display surface (tui.showOverlay), refreshed on
 * a ~150ms ticker; all pane keys are handled here via ui.onTerminalInput
 * (see index.ts) — no overlay focus capture, no editor interference.
 */

import { matchesKey, type OverlayHandle, type TUI } from "@earendil-works/pi-tui";
import { buildTraceView, emptyLiveTrace, type LiveTrace } from "./live.ts";
import { formatElapsed, formatModelTag, WATCH_PANE_KEYBIND } from "./core.ts";
import { tasks, type Task } from "./runtime.ts";
import { formatToolCall, getWidgetTheme, getWidgetTui } from "./tui.ts";

const TICK_MS = 150;
const SCROLL_PAGE = 10;

interface WatchState {
	taskId: string;
	/** Lines scrolled up from the live tail (0 = tail). */
	linesBack: number;
}

let watchHandle: OverlayHandle | undefined;
let watchState: WatchState | undefined;
let watchTimer: NodeJS.Timeout | undefined;

export function isWatchOpen(): boolean {
	return watchState !== undefined;
}

function runningTasks(): Task[] {
	return [...tasks.values()].filter((t) => t.status === "running");
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
	watchState = { taskId: running[0].id, linesBack: 0 };
	const component = {
		render: (width: number) => renderWatchPane(tui, width),
		invalidate: () => {},
	};
	watchHandle = tui.showOverlay(component, {
		anchor: "bottom-center",
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
	stopWatchTicker();
}

/** Session teardown: close and drop all watch state. */
export function disposeWatch(): void {
	closeWatch();
}

/** Called from process.ts after task finalize: close when nothing is running. */
export function maybeAutoCloseWatch(): void {
	if (watchState && runningTasks().length === 0) closeWatch();
}

/**
 * Raw terminal input handler wired from index.ts. Consumes only watch-pane
 * keys; everything else passes through to the app/editor unchanged.
 */
export function handleWatchInput(data: string): { consume?: boolean } | undefined {
	if (!watchState) {
		if (matchesKey(data, WATCH_PANE_KEYBIND)) {
			toggleWatch();
			return { consume: true };
		}
		return undefined;
	}
	const state = watchState;
	if (matchesKey(data, "escape") || matchesKey(data, WATCH_PANE_KEYBIND)) {
		closeWatch();
		return { consume: true };
	}
	if (matchesKey(data, "up")) {
		state.linesBack++;
		return { consume: true };
	}
	if (matchesKey(data, "down")) {
		state.linesBack = Math.max(0, state.linesBack - 1);
		return { consume: true };
	}
	if (matchesKey(data, "pageUp")) {
		state.linesBack += SCROLL_PAGE;
		return { consume: true };
	}
	if (matchesKey(data, "pageDown")) {
		state.linesBack = Math.max(0, state.linesBack - SCROLL_PAGE);
		return { consume: true };
	}
	if (matchesKey(data, "end")) {
		state.linesBack = 0;
		return { consume: true };
	}
	if (matchesKey(data, "tab")) {
		cycleAgent(state);
		return { consume: true };
	}
	return undefined;
}

function cycleAgent(state: WatchState): void {
	const running = runningTasks();
	if (running.length === 0) return;
	const idx = running.findIndex((t) => t.id === state.taskId);
	const next = running[(idx + 1) % running.length];
	state.taskId = next.id;
	state.linesBack = 0;
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

function renderWatchPane(tui: TUI, width: number): string[] {
	const theme = getWidgetTheme();
	if (!theme) return [];
	const running = runningTasks();
	const state = watchState ?? { taskId: "", linesBack: 0 };
	let task = tasks.get(state.taskId);
	if (!task) {
		// Selected task vanished from the registry — fall back to the first running task.
		task = running[0] ?? null;
		if (task) {
			state.taskId = task.id;
			state.linesBack = 0;
		}
	}
	const paneH = Math.max(6, Math.floor(tui.terminal.rows * 0.9));
	const header = buildHeader(task, running, state, theme);
	const footer = buildFooter(state, theme);
	const trace: LiveTrace = task ? task.live : emptyLiveTrace();
	const content = buildTraceView(trace, {
		width,
		height: Math.max(1, paneH - 2),
		linesBack: state.linesBack,
		style: (color, text) => theme.fg(color, text),
		formatToolCall,
	});
	return [header, ...content, footer];
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

function buildFooter(state: WatchState, theme: any): string {
	const left =
		state.linesBack > 0
			? theme.fg("muted", `↑ ${state.linesBack} above`)
			: theme.fg("success", "● live");
	const hints = theme.fg("muted", "  ↑↓ scroll · PgUp/PgDn · Tab agent · End tail · Esc close");
	return left + hints;
}
