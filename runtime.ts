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
	getFinalOutput,
	getResultOutput,
	type CatalogModel,
	type CompletionDetails,
	type MessageLike,
	type TierConfig,
	type UsageStats,
} from "./core.ts";
import { boundOutput } from "./output.ts";
import type { LiveTrace } from "./live.ts";

// ── Types ────────────────────────────────────────────────────────────────────

export type TaskStatus = "running" | "completed" | "failed" | "aborted" | "paused" | "interrupted";
export type JobMode = "single" | "parallel" | "chain";

export interface JobCompletion {
	id: string;
	mode: JobMode;
	status: Job["status"];
	total: number;
	unsuccessful: number;
	notifyOnComplete: boolean;
}

export type RuntimeObservation =
	| { type: "status" }
	| { type: "trace"; taskId: string; generation: number }
	| { type: "job-finished"; completion: JobCompletion };

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
	/** Cumulative child usage already reported to Pi in successful tool results. */
	usageReported?: UsageStats;
	model?: string;
	/** Child model's context window in tokens; undefined when unknown. */
	contextWindow?: number;
	tierUsed?: string;
	requestedTier?: string;
	tierNote?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	/** Human-readable session name (slug); shown in the widget and reports. */
	name?: string;
	/** Logical dispatch state is separate from terminal/task status. */
	dispatchState?: "queued" | "running" | "paused" | "terminal";
	/** Set by subagent_pause: the next finalize marks the task `paused`. */
	pauseRequested?: boolean;
	/** Durable setup has not yet reached the scheduler queue. */
	setupPending?: boolean;
	/** Final status persistence is in flight; resume must not mutate this task. */
	finalizing?: boolean;
	/** Identifies the active child attempt so stale close callbacks cannot finalize a resume. */
	processGeneration?: number;
	/** Child session dir/file when running with a durable session. */
	sessionDir?: string;
	sessionFile?: string;
	finishedAt?: number;
	/** Attempt that produced the current final assistant text, if any. */
	outputProducedGeneration?: number;
	/** Readable full-output sidecar; compact messages/results reference this path. */
	outputPath?: string;
	outputBytes?: number;
	proc?: ChildProcess;
	tmpDir?: string;
	tmpPath?: string;
}

export interface Job {
	id: string;
	mode: JobMode;
	status: "running" | "completed" | "failed" | "aborted" | "interrupted";
	errorMessage?: string;
	tasks: Task[];
	chainTotal?: number;
	notifyOnComplete: boolean;
	notified: boolean;
	finished: boolean;
	chainRunnerDone: boolean;
	chainRunnerActive?: boolean;
	pendingSpawns: number;
	/** Parent session bucket this job persists under (undefined = legacy in-memory only). */
	parentSessionId?: string;
	/** Resolves false when the initial durable manifest could not be created. */
	persistenceReady?: Promise<boolean>;
	/** Dispatch is disabled while paused or after cancellation/shutdown. */
	dispatchAllowed?: boolean;
	/** Prevents overlapping resumes in this process. */
	resumeBusy?: boolean;
	/** Invalidates workers from an older parallel resume/pause epoch. */
	dispatchEpoch?: number;
	/** Set once a synchronous/background caller explicitly aborts the job. */
	abortRequested?: boolean;
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
	name?: string;
	finishedAt?: number;
	messages: MessageLike[];
	usage: UsageStats;
	model?: string;
	contextWindow?: number;
	tierUsed?: string;
	tierNote?: string;
	stopReason?: string;
	errorMessage?: string;
	outputPath?: string;
	outputBytes?: number;
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
type Waiter = (completed?: boolean) => void;
const taskWaiters = new Map<string, Waiter[]>();
const jobWaiters = new Map<string, Waiter[]>();

// Maps are exported read-write by convention: callers use .get/.set/.has
// (never reassign) so all modules share one registry instance.

export { jobs, tasks, taskWaiters };

// ── Session-scoped persistence holders (set by index.ts at session_start) ────

let parentSessionId: string | undefined;
let jobsRoot: string | undefined;

export function setParentSessionId(id: string | undefined): void {
	parentSessionId = id;
}
export function getParentSessionId(): string | undefined {
	return parentSessionId;
}
export function setJobsRoot(root: string | undefined): void {
	jobsRoot = root;
}
export function getJobsRoot(): string | undefined {
	return jobsRoot;
}

let runningCount = 0;
let statusChangedHook: (() => void) | undefined;
const runtimeObservers = new Set<(event: RuntimeObservation) => void | Promise<void>>();

/** Subscribe to additive lifecycle observations. Owners must unsubscribe explicitly. */
export function subscribeRuntimeObservations(listener: (event: RuntimeObservation) => void | Promise<void>): () => void {
	runtimeObservers.add(listener);
	return () => { runtimeObservers.delete(listener); };
}

function publishRuntimeObservation(event: RuntimeObservation): void {
	for (const listener of runtimeObservers) {
		try {
			const result = listener(event);
			if (result && typeof result.then === "function") void result.catch(() => {});
		} catch { /* observers must not affect lifecycle work */ }
	}
}


/** Install the UI refresh callback without introducing a runtime -> TUI edge. */
export function setStatusChangedHook(fn: (() => void) | undefined): void {
	statusChangedHook = fn;
}

export function notifyStatusChanged(): void {
	try { statusChangedHook?.(); } catch { /* UI may be tearing down */ }
	publishRuntimeObservation({ type: "status" });
}

/** Publish a trace update only for a caller-validated current process attempt. */
export function notifyTaskTraceChanged(taskId: string, generation: number): void {
	publishRuntimeObservation({ type: "trace", taskId, generation });
}

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
	const pendingWaiters = [...taskWaiters.values(), ...jobWaiters.values()].flat();
	taskWaiters.clear();
	jobWaiters.clear();
	for (const waiter of pendingWaiters) waiter(false);
	tasks.clear();
	jobs.clear();
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
	const finalText = t.status === "running" || t.status === "paused" ? "" : getFinalOutput(t.messages);
	const messages: MessageLike[] = finalText
		? [{
			role: "assistant",
			content: [{ type: "text", text: boundOutput(finalText, { artifactPath: t.outputPath }) }],
		}]
		: [];
	return {
		id: t.id,
		agent: t.agent,
		agentSource: t.agentSource,
		task: t.task,
		status: t.status,
		exitCode: t.exitCode,
		step: t.step,
		// Running details omit in-progress history; finalized details carry only the
		// bounded latest result, never thinking or a duplicate full transcript.
		messages,
		usage: t.usage,
		model: t.model,
		contextWindow: t.contextWindow,
		tierUsed: t.tierUsed,
		tierNote: t.tierNote,
		stopReason: t.stopReason,
		errorMessage: t.errorMessage,
		name: t.name,
		finishedAt: t.finishedAt,
		outputPath: t.outputPath,
		outputBytes: t.outputBytes,
	};
}

export function jobDetails(job: Job, jobIds: string[] = [job.id]): ToolDetails {
	return { mode: job.mode, jobIds, tasks: job.tasks.map(toTaskInfo) };
}

function addWaiter(map: Map<string, Waiter[]>, key: string, fn: Waiter) {
	const arr = map.get(key) ?? [];
	arr.push(fn);
	map.set(key, arr);
}

function removeWaiter(map: Map<string, Waiter[]>, key: string, fn: Waiter): void {
	const arr = map.get(key);
	if (!arr) return;
	const index = arr.indexOf(fn);
	if (index >= 0) arr.splice(index, 1);
	if (arr.length === 0) map.delete(key);
}

export function fireWaiters(map: Map<string, Waiter[]>, key: string) {
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

/** Node's maximum supported timer delay; larger values otherwise overflow to 1ms. */
const MAX_WAIT_TIMEOUT_MS = 2 ** 31 - 1;

/** Shared waiter: resolves when `isDone()` is true, the signal aborts, or the timeout fires. */
function waitFor(
	map: Map<string, Waiter[]>,
	key: string,
	isDone: () => boolean,
	opts: WaitOptions = {},
): Promise<boolean> {
	if (isDone()) return Promise.resolve(true);
	if (opts.timeoutMs !== undefined &&
		(!Number.isFinite(opts.timeoutMs) || opts.timeoutMs < 0 || opts.timeoutMs > MAX_WAIT_TIMEOUT_MS)) {
		return Promise.resolve(false);
	}
	if (opts.timeoutMs === 0 || opts.signal?.aborted) return Promise.resolve(false);
	return new Promise((resolve) => {
		let settled = false;
		let timer: NodeJS.Timeout | undefined;
		let onWake: Waiter;
		const onAbort = () => settle(false);
		function settle(completed: boolean) {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
			removeWaiter(map, key, onWake);
			resolve(completed);
		}
		onWake = (forcedResult) => {
			if (forcedResult === false) settle(false);
			else if (isDone()) settle(true);
			else addWaiter(map, key, onWake);
		};
		if (opts.signal) opts.signal.addEventListener("abort", onAbort, { once: true });
		if (opts.timeoutMs !== undefined) timer = setTimeout(() => settle(false), opts.timeoutMs);
		addWaiter(map, key, onWake);
	});
}

export function waitForTask(id: string, opts: WaitOptions = {}): Promise<boolean> {
	return waitFor(taskWaiters, id, () => {
		const task = tasks.get(id);
		return !task || (task.status !== "running" && task.status !== "paused");
	}, opts);
}

/** Wait until a task completes or pauses; ordinary task waiters still wait through pauses. */
export function waitForTaskOrPause(id: string, opts: WaitOptions = {}): Promise<boolean> {
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

function taskStatusLabel(t: Task): "completed" | "failed" | "aborted" | "interrupted" {
	if (t.status === "completed") return "completed";
	if (t.status === "aborted") return "aborted";
	if (t.status === "interrupted") return "interrupted";
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
				name: t.name,
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

/**
 * True when a registered job still blocks a resume attempt: it has in-flight
 * work (running/paused tasks, pending spawns, chain runner). Finished jobs —
 * including failed/interrupted ones — are stale registry entries and must not
 * block resuming their persisted manifest.
 */
export function blocksResume(job: Job | undefined): boolean {
	return job !== undefined && (
		job.resumeBusy === true || job.pendingSpawns > 0 ||
		job.tasks.some((t) => t.status === "running" || t.finalizing === true) ||
		(!job.finished && job.tasks.length === 0)
	);
}

export function checkJobComplete(job: Job) {
	if (job.finished) return;
	if (job.mode === "chain") {
		if (!job.chainRunnerDone) return;
	} else {
		if (job.pendingSpawns > 0) return;
		if (job.tasks.length === 0 || job.tasks.some((t) => t.status === "running" || t.status === "paused" || t.dispatchState === "queued" || t.finalizing === true)) return;
	}
	if (job.status === "running") job.status = "completed";
	job.finished = true;
	fireWaiters(jobWaiters, job.id);
	maybeNotifyJob(job);
	try { jobFinishedHook?.(); } catch { /* UI may be tearing down */ }
	const completion = Object.freeze({
		id: job.id,
		mode: job.mode,
		status: job.status,
		total: job.tasks.length,
		unsuccessful: job.tasks.filter((task) => task.status !== "completed").length,
		notifyOnComplete: job.notifyOnComplete,
	});
	publishRuntimeObservation({ type: "job-finished", completion });
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
