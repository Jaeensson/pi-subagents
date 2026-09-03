/**
 * runtime.ts — In-memory registry for tasks and jobs, plus waiting helpers.
 *
 * Owns the shared state (tasks/jobs maps, waiters, running counter) and the
 * pure bookkeeping around it: completion checks, notification dispatch, and
 * the waiter maps used by the wait: true / subagent_wait flows.
 *
 * Children are killed on session shutdown by the extension entry (index.ts).
 * This module has no imports from sibling modules, so it is safe to import
 * from anywhere in the extension.
 */

import type { ChildProcess } from "node:child_process";
import {
	formatCompletionNotification,
	getResultOutput,
	type CatalogModel,
	type CompletionDetails,
	type MessageLike,
	type TierConfig,
	type UsageStats,
} from "./core.ts";
import type { LiveTrace } from "./live.ts";

// ── Types ────────────────────────────────────────────────────────────────────

export type TaskStatus = "running" | "completed" | "failed" | "aborted";
export type JobMode = "single" | "parallel" | "chain";

export interface Task {
	id: string;
	jobId: string;
	agent: string;
	agentSource: string;
	task: string;
	cwd: string;
	status: TaskStatus;
	startedAt: number;
	exitCode: number;
	messages: MessageLike[];
	/** Live streaming trace (thinking/text/tool activity) for the watch pane. */
	live: LiveTrace;
	stderr: string;
	usage: UsageStats;
	model?: string;
	/** Child model's context window in tokens; undefined when unknown. */
	contextWindow?: number;
	tierUsed?: string;
	tierNote?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	proc?: ChildProcess;
	tmpDir?: string;
	tmpPath?: string;
}

export interface Job {
	id: string;
	mode: JobMode;
	status: "running" | "completed" | "failed" | "aborted";
	errorMessage?: string;
	tasks: Task[];
	chainTotal?: number;
	notifyOnComplete: boolean;
	notified: boolean;
	finished: boolean;
	chainRunnerDone: boolean;
	pendingSpawns: number;
	emit?: (content: string, details: ToolDetails) => void;
}

export interface TaskInfo {
	id: string;
	agent: string;
	agentSource: string;
	task: string;
	status: TaskStatus;
	exitCode: number;
	step?: number;
	messages: MessageLike[];
	usage: UsageStats;
	model?: string;
	contextWindow?: number;
	tierUsed?: string;
	tierNote?: string;
	stopReason?: string;
	errorMessage?: string;
}

export interface ToolDetails {
	mode: JobMode | "collect";
	jobIds: string[];
	tasks: TaskInfo[];
}

/** Per-tool-call snapshot of tier config, default model, and catalog models. */
export interface ModelContext {
	tierConfig?: TierConfig;
	defaultModel?: string;
	catalog: CatalogModel[];
}

// ── Registry (in-memory; children are killed on session shutdown) ───────────

const tasks = new Map<string, Task>();
const jobs = new Map<string, Job>();
const taskWaiters = new Map<string, Array<() => void>>();
const jobWaiters = new Map<string, Array<() => void>>();

// Maps are exported read-write by convention: callers use .get/.set/.has
// (never reassign) so all modules share one registry instance.

export { jobs, tasks, taskWaiters };

let runningCount = 0;

/** Live count of running tasks (used by the status widget and shutdown sweep). */
export function getRunningCount(): number {
	return runningCount;
}

export function incRunningCount(): void {
	runningCount++;
}

export function decRunningCount(): void {
	runningCount = Math.max(0, runningCount - 1);
}

/** All tasks currently in "running" state (used by the session-shutdown sweep). */
export function listRunningTasks(): Task[] {
	return [...tasks.values()].filter((t) => t.status === "running");
}

/** Drop all registry state (session shutdown). */
export function clearRegistry(): void {
	tasks.clear();
	jobs.clear();
	taskWaiters.clear();
	jobWaiters.clear();
	runningCount = 0;
}

// ── Completion notification hook ─────────────────────────────────────────────
//
// The extension entry installs the real sender (api.sendMessage) via
// setMessageSender; kept as a hook so runtime.ts stays free of pi imports.

let sendMessage: ((text: string, details: CompletionDetails) => void) | undefined;
let jobFinishedHook: (() => void) | undefined;

export function setMessageSender(fn: (text: string, details: CompletionDetails) => void): void {
	sendMessage = fn;
}

/** Install a callback fired when a job batch finishes (drives the watch-pane auto-close). */
export function setJobFinishedHook(fn: (() => void) | undefined): void {
	jobFinishedHook = fn;
}

export function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

export function toTaskInfo(t: Task): TaskInfo {
	return {
		id: t.id,
		agent: t.agent,
		agentSource: t.agentSource,
		task: t.task,
		status: t.status,
		exitCode: t.exitCode,
		step: t.step,
		messages: t.messages,
		usage: t.usage,
		model: t.model,
		contextWindow: t.contextWindow,
		tierUsed: t.tierUsed,
		tierNote: t.tierNote,
		stopReason: t.stopReason,
		errorMessage: t.errorMessage,
	};
}

export function jobDetails(job: Job, jobIds: string[] = [job.id]): ToolDetails {
	return { mode: job.mode, jobIds, tasks: job.tasks.map(toTaskInfo) };
}

function addWaiter(map: Map<string, Array<() => void>>, key: string, fn: () => void) {
	const arr = map.get(key) ?? [];
	arr.push(fn);
	map.set(key, arr);
}

export function fireWaiters(map: Map<string, Array<() => void>>, key: string) {
	const arr = map.get(key);
	if (arr) {
		map.delete(key);
		for (const fn of arr) fn();
	}
}

// ── Waiting ──────────────────────────────────────────────────────────────────

export interface WaitOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
}

/** Shared waiter: resolves when `isDone()` is true, the signal aborts, or the timeout fires. */
function waitFor(
	map: Map<string, Array<() => void>>,
	key: string,
	isDone: () => boolean,
	opts: WaitOptions = {},
): Promise<boolean> {
	if (isDone()) return Promise.resolve(true);
	return new Promise((resolve) => {
		let settled = false;
		let timer: NodeJS.Timeout | undefined;
		const onAbort = () => settle(false);
		function settle(completed: boolean) {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
			resolve(completed);
		}
		if (opts.signal) {
			if (opts.signal.aborted) return settle(false);
			opts.signal.addEventListener("abort", onAbort, { once: true });
		}
		if (opts.timeoutMs) timer = setTimeout(() => settle(false), opts.timeoutMs);
		addWaiter(map, key, () => settle(true));
	});
}

export function waitForTask(id: string, opts: WaitOptions = {}): Promise<boolean> {
	return waitFor(taskWaiters, id, () => {
		const task = tasks.get(id);
		return !task || task.status !== "running";
	}, opts);
}

export function waitForJob(jobId: string, opts: WaitOptions = {}): Promise<boolean> {
	return waitFor(jobWaiters, jobId, () => {
		const job = jobs.get(jobId);
		return !job || job.finished;
	}, opts);
}

// ── Job completion ───────────────────────────────────────────────────────────

function taskStatusLabel(t: Task): "completed" | "failed" | "aborted" {
	if (t.status === "completed") return "completed";
	if (t.status === "aborted") return "aborted";
	return "failed";
}

function maybeNotifyJob(job: Job) {
	if (job.notified) return;
	job.notified = true;
	if (!job.notifyOnComplete) return;

	let text: string;
	if (job.tasks.length === 0) {
		text = `## Subagent batch failed\n\n${job.errorMessage || "(no output)"}\n\nJob id: ${job.id}`;
	} else {
		text = formatCompletionNotification(
			job.tasks.map((t) => ({
				agent: t.agent,
				status: taskStatusLabel(t),
				output: getResultOutput(t),
				errorMessage: t.errorMessage,
			})),
			[job.id],
		);
	}
	try {
		sendMessage?.(text, {
			total: job.tasks.length,
			failed: job.tasks.filter((t) => t.status !== "completed").length,
		});
	} catch {
		/* ignore: session may be shutting down */
	}
}

export function checkJobComplete(job: Job) {
	if (job.finished) return;
	if (job.mode === "chain") {
		if (!job.chainRunnerDone) return;
	} else {
		if (job.pendingSpawns > 0) return;
		if (job.tasks.length === 0 || job.tasks.some((t) => t.status === "running")) return;
	}
	if (job.status === "running") job.status = "completed";
	job.finished = true;
	fireWaiters(jobWaiters, job.id);
	maybeNotifyJob(job);
	jobFinishedHook?.();
}

// ── Aggregation ──────────────────────────────────────────────────────────────

/** Sum usage across tasks (used by TUI result rendering). */
export function aggregateUsage(tasks: TaskInfo[]): { input: number; output: number; cost: number; turns: number } {
	return tasks.reduce(
		(acc, t) => {
			acc.input += t.usage.input;
			acc.output += t.usage.output;
			acc.cost += t.usage.cost;
			acc.turns += t.usage.turns;
			return acc;
		},
		{ input: 0, output: 0, cost: 0, turns: 0 },
	);
}
