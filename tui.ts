/**
 * tui.ts — TUI rendering helpers for the subagent tools.
 *
 * Owns message → display-item conversion, tool-call formatting, the shared
 * task list renderer, and the persistent status widget shown while subagents
 * are running.
 */

import * as os from "node:os";
import { truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatElapsed, type MessageLike } from "./core.ts";
import { getRunningCount, jobs, tasks, type Task } from "./runtime.ts";

export type DisplayItem =
	| { type: "text"; text: string }
	| { type: "toolCall"; name: string; args: Record<string, unknown> };

export function getDisplayItems(messages: MessageLike[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text ?? "" });
				else if (part.type === "toolCall")
					items.push({
						type: "toolCall",
						name: part.name ?? "?",
						args: (part.arguments as Record<string, unknown>) ?? {},
					});
			}
		}
	}
	return items;
}

export function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: string, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};
	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", shortenPath(rawPath));
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", shortenPath(rawPath));
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "grep ") + themeFg("accent", `/${pattern}/`) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

export function renderTaskList(tasks: DisplayItem[], limit: number, theme: any): string {
	const toShow = tasks.slice(-limit);
	const skipped = tasks.length - toShow.length;
	let text = "";
	if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
	for (const item of toShow) {
		if (item.type === "text") {
			text += `${theme.fg("toolOutput", item.text.split("\n").slice(0, 3).join("\n"))}\n`;
		} else {
			text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
		}
	}
	return text.trimEnd();
}

// ── Persistent status widget ────────────────────────────────────────────────
//
// A minimal widget above the editor, visible only while subagents are running:
//
//   ⏳ 2 subagents running
//     ▸ scout     12s   → bash: npm test
//     ▸ planner    4s   step 2/3  "Refactor the core loop"
//
// The widget factory captures the TUI so lifecycle changes (spawn/finish/kill)
// can request re-renders; a 1s ticker keeps elapsed times live while running.

const STATUS_WIDGET_KEY = "subagent-status";

let uiRef: ExtensionContext["ui"] | undefined;
let widgetTui: TUI | undefined;
let widgetRegistered = false;
let widgetTimer: NodeJS.Timeout | undefined;

/** Attach/detach the UI reference (extension entry, session lifecycle). */
export function setUi(ui: ExtensionContext["ui"] | undefined): void {
	uiRef = ui;
}

/** Drop all widget state (session shutdown). */
export function disposeWidget(): void {
	uiRef = undefined;
	widgetTui = undefined;
	widgetRegistered = false;
	stopWidgetTimer();
}

function stopWidgetTimer() {
	if (widgetTimer) {
		clearInterval(widgetTimer);
		widgetTimer = undefined;
	}
}

function requestWidgetRender() {
	widgetTui?.requestRender();
}

/** Keep a 1s ticker alive while any task is running so elapsed times stay live. */
function ensureWidgetTicker() {
	if (getRunningCount() > 0 && !widgetTimer && widgetTui) {
		widgetTimer = setInterval(() => requestWidgetRender(), 1000);
		widgetTimer.unref?.();
	} else if (getRunningCount() === 0) {
		stopWidgetTimer();
	}
}

function truncatePreview(s: string, max = 48): string {
	return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Last activity of a running task: most recent tool call, else its latest text, else the task description. */
function lastActivity(t: Task, theme: any): string {
	const items = getDisplayItems(t.messages);
	const last = items[items.length - 1];
	if (!last) return theme.fg("dim", truncatePreview(t.task));
	if (last.type === "toolCall") return formatToolCall(last.name, last.args, theme.fg.bind(theme));
	const text = last.text.split("\n").find((l) => l.trim()) ?? "";
	return theme.fg("toolOutput", truncatePreview(text));
}

/** Build the widget lines from the live registry. Returns [] when idle. */
function runningTaskLines(theme: any, width: number): string[] {
	const running = [...tasks.values()].filter((t) => t.status === "running");
	if (running.length === 0) return [];

	const now = Date.now();
	const lines: string[] = [
		theme.fg("warning", `⏳ ${running.length} subagent${running.length === 1 ? "" : "s"} running`),
	];
	for (const t of running) {
		const elapsed = formatElapsed((now - t.startedAt) / 1000);
		const job = jobs.get(t.jobId);
		const step =
			job?.mode === "chain" && job.chainTotal && t.step
				? theme.fg("muted", ` step ${t.step}/${job.chainTotal}`)
				: "";
		lines.push(`  ${theme.fg("warning", "▸")} ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${elapsed}`)}${step}  ${lastActivity(t, theme)}`);
	}
	return lines.map((line) => truncateToWidth(line, width));
}

/** Register/refresh/remove the widget based on the running count. */
export function updateStatusWidget() {
	if (!uiRef) return;
	const running = getRunningCount() > 0;
	if (running && !widgetRegistered) {
		uiRef.setWidget(STATUS_WIDGET_KEY, (tui, theme) => {
			widgetTui = tui;
			return {
				render: (width) => runningTaskLines(theme, width),
				invalidate: () => {},
				dispose: () => {
					widgetTui = undefined;
					widgetRegistered = false;
					stopWidgetTimer();
				},
			};
		});
		widgetRegistered = true;
		ensureWidgetTicker();
	} else if (!running && widgetRegistered) {
		uiRef.setWidget(STATUS_WIDGET_KEY, undefined);
		widgetRegistered = false;
		stopWidgetTimer();
	} else {
		requestWidgetRender();
		ensureWidgetTicker();
	}
}
