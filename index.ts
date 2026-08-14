/**
 * Subagent Tool — delegate tasks to specialized agents with isolated context.
 *
 * Spawns a separate `pi --mode json` process per subagent, giving each an
 * isolated context window. Supports:
 *
 *   - Single:   { agent?, task }                 (omit agent for a raw prompt → built-in default agent)
 *   - Parallel: { tasks: [{agent?, task}, ...] }  (concurrent; agent optional → default agent)
 *   - Chain:    { chain: [{agent?, task, ...}] }  (sequential, {previous} placeholder; agent optional)
 *
 * Two execution modes per call:
 *   - wait: true  (default) — blocks until the subagent(s) finish, returns results.
 *   - wait: false — spawns background subagents and returns jobIds immediately,
 *                   so the parent can keep working in parallel. Collect results
 *                   with `subagent_wait`, check progress with `subagent_status`.
 *                   A compact summary is delivered into the conversation when a
 *                   batch finishes (unless notifyOnComplete: false).
 *
 * Children run with --no-extensions/--no-skills/--no-prompt-templates (lean,
 * no recursion). Agent definitions: ~/.pi/agent/agents/*.md (see agents.ts).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { discoverUserAgents, formatAgentList, getUserAgentsDir } from "./agents.ts";
import {
	applyEventLine,
	buildChildArgs,
	displayAgentName,
	formatCompletionNotification,
	formatElapsed,
	formatStatusReport,
	formatUsageStats,
	getFinalOutput,
	getResultOutput,
	isFailedState,
	normalizeTierConfig,
	resolveAgent,
	resolveModel,
	shouldNotify,
	truncateOutput,
	type AgentSummary,
	type CatalogModel,
	type MessageLike,
	type TierConfig,
	type UsageStats,
} from "./core.ts";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;

// Set when the extension loads; used by async completion notifications.
let api: ExtensionAPI;

// ── Types ────────────────────────────────────────────────────────────────────

type TaskStatus = "running" | "completed" | "failed" | "aborted";
type JobMode = "single" | "parallel" | "chain";

interface Task {
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
	stderr: string;
	usage: UsageStats;
	model?: string;
	tierUsed?: string;
	tierNote?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	proc?: ChildProcess;
	tmpDir?: string;
	tmpPath?: string;
}

interface Job {
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

interface TaskInfo {
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
	tierUsed?: string;
	tierNote?: string;
	stopReason?: string;
	errorMessage?: string;
}

interface ToolDetails {
	mode: JobMode | "collect";
	jobIds: string[];
	tasks: TaskInfo[];
}

// ── Model tier context ───────────────────────────────────────────────────────

/** Per-tool-call snapshot of tier config, default model, and catalog models. */
interface ModelContext {
	tierConfig?: TierConfig;
	defaultModel?: string;
	catalog: CatalogModel[];
}

/** Read `subagent.modelTiers` and `defaultModel` from the user's settings.json. */
function readSettingsFile(): { tierConfig?: TierConfig; defaultModel?: string } {
	let raw: string;
	try {
		raw = fs.readFileSync(path.join(getAgentDir(), "settings.json"), "utf-8");
	} catch {
		return {};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return {};
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
	const settings = parsed as Record<string, unknown>;
	const subagent = settings.subagent;
	const modelTiers =
		subagent && typeof subagent === "object" && !Array.isArray(subagent)
			? (subagent as Record<string, unknown>).modelTiers
			: undefined;
	return {
		tierConfig: normalizeTierConfig(modelTiers),
		defaultModel:
			typeof settings.defaultModel === "string" && settings.defaultModel.trim() !== ""
				? settings.defaultModel
				: undefined,
	};
}

/** Build the model context for one tool call from the extension context. */
function buildModelContext(ctx: ExtensionContext): ModelContext {
	const settings = readSettingsFile();
	const scopedIds = new Set(ctx.scopedModels.map((s) => s.model.id));
	const catalog: CatalogModel[] = ctx.modelRegistry
		.getAvailable()
		.filter((m) => scopedIds.size === 0 || scopedIds.has(m.id))
		.map((m) => ({ id: m.id, provider: m.provider, inputCost: m.cost.input }));
	return {
		tierConfig: settings.tierConfig,
		defaultModel: settings.defaultModel ?? ctx.model?.id,
		catalog,
	};
}

// ── Registry (in-memory; children are killed on session shutdown) ───────────

const tasks = new Map<string, Task>();
const jobs = new Map<string, Job>();
const taskWaiters = new Map<string, Array<() => void>>();
const jobWaiters = new Map<string, Array<() => void>>();

let runningCount = 0;

function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

function toTaskInfo(t: Task): TaskInfo {
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
		tierUsed: t.tierUsed,
		tierNote: t.tierNote,
		stopReason: t.stopReason,
		errorMessage: t.errorMessage,
	};
}

function jobDetails(job: Job, jobIds: string[] = [job.id]): ToolDetails {
	return { mode: job.mode, jobIds, tasks: job.tasks.map(toTaskInfo) };
}

function addWaiter(map: Map<string, Array<() => void>>, key: string, fn: () => void) {
	const arr = map.get(key) ?? [];
	arr.push(fn);
	map.set(key, arr);
}

function fireWaiters(map: Map<string, Array<() => void>>, key: string) {
	const arr = map.get(key);
	if (arr) {
		map.delete(key);
		for (const fn of arr) fn();
	}
}

// ── Task lifecycle ───────────────────────────────────────────────────────────

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}
	return { command: "pi", args };
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

function cleanupTaskTemp(task: Task) {
	if (task.tmpPath)
		try {
			fs.unlinkSync(task.tmpPath);
		} catch {
			/* ignore */
		}
	if (task.tmpDir)
		try {
			fs.rmdirSync(task.tmpDir);
		} catch {
			/* ignore */
		}
}

function finalizeTask(task: Task, code: number | null) {
	if (task.status !== "running") return;
	task.exitCode = code ?? 1;
	const sr = task.stopReason;
	task.status = code === 0 && sr !== "error" && sr !== "aborted" ? "completed" : sr === "aborted" ? "aborted" : "failed";
	cleanupTaskTemp(task);
	runningCount = Math.max(0, runningCount - 1);
	updateStatusWidget();
	fireWaiters(taskWaiters, task.id);

	const job = jobs.get(task.jobId);
	if (job) {
		if (task.status !== "completed" && job.status === "running") job.status = "failed";
		job.emit?.(
			job.mode === "parallel"
				? `Parallel: ${job.tasks.filter((t) => t.status !== "running").length}/${job.tasks.length} done...`
				: getFinalOutput(task.messages) || "(running...)",
			jobDetails(job),
		);
		checkJobComplete(job);
	}
}

function killTask(task: Task) {
	task.stopReason = "aborted";
	const proc = task.proc;
	if (!proc || proc.exitCode !== null) return;
	try {
		proc.kill("SIGTERM");
	} catch {
		/* ignore */
	}
	const timer = setTimeout(() => {
		try {
			if (proc.exitCode === null && !proc.signalCode) proc.kill("SIGKILL");
		} catch {
			/* ignore */
		}
	}, 5000);
	timer.unref?.();
}

async function spawnTask(
	agent: AgentSummary,
	taskText: string,
	cwd: string,
	jobId: string,
	options: { step?: number; tier?: string; modelCtx: ModelContext },
): Promise<Task> {
	const resolution = resolveModel({
		callTier: options.tier,
		agentModel: agent.model,
		agentTier: agent.tier,
		tierConfig: options.modelCtx.tierConfig,
		defaultModel: options.modelCtx.defaultModel,
		catalog: options.modelCtx.catalog,
	});
	const task: Task = {
		id: randomUUID(),
		jobId,
		agent: agent.name,
		agentSource: agent.source,
		task: taskText,
		cwd,
		status: "running",
		startedAt: Date.now(),
		exitCode: -1,
		messages: [],
		stderr: "",
		usage: emptyUsage(),
		model: resolution.model,
		tierUsed: resolution.tierUsed,
		tierNote: resolution.note,
		step: options.step,
	};
	tasks.set(task.id, task);
	const job = jobs.get(jobId);
	if (job) job.pendingSpawns++;
	if (job) job.tasks.push(task);
	runningCount++;
	updateStatusWidget();

	try {
		let systemPromptFile: string | undefined;
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			task.tmpDir = tmp.dir;
			task.tmpPath = tmp.filePath;
			systemPromptFile = tmp.filePath;
		}

		const args = buildChildArgs({ model: resolution.model, tools: agent.tools, systemPromptFile, task: taskText });
		const invocation = getPiInvocation(args);
		const proc = spawn(invocation.command, invocation.args, {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});
		task.proc = proc;

		let buffer = "";
		proc.stdout.on("data", (data) => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				applyEventLine(line, task);
				job?.emit?.(getFinalOutput(task.messages) || "(running...)", jobDetails(job));
			}
		});
		proc.stderr.on("data", (data) => {
			task.stderr += data.toString();
		});
		proc.on("close", (code) => finalizeTask(task, code));
		proc.on("error", (err) => {
			task.stderr += `spawn error: ${err.message}\n`;
			finalizeTask(task, 1);
		});
	} catch (err) {
		task.stderr += `failed to spawn: ${err instanceof Error ? err.message : String(err)}\n`;
		finalizeTask(task, 1);
	} finally {
		if (job) job.pendingSpawns--;
	}
	return task;
}

// ── Job lifecycle ────────────────────────────────────────────────────────────

function createJob(mode: JobMode, notifyOnComplete: boolean, emit?: (content: string, details: ToolDetails) => void, chainTotal?: number): Job {
	const job: Job = {
		id: randomUUID(),
		mode,
		status: "running",
		tasks: [],
		chainTotal,
		notifyOnComplete,
		notified: false,
		finished: false,
		chainRunnerDone: false,
		pendingSpawns: 0,
		emit,
	};
	jobs.set(job.id, job);
	return job;
}

function checkJobComplete(job: Job) {
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
}

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
		// eslint-disable-next-line @typescript-eslint/no-floating-promises
		api.sendUserMessage(text, { deliverAs: "steer" });
	} catch {
		/* ignore: session may be shutting down */
	}
}

// ── Waiting ──────────────────────────────────────────────────────────────────

interface WaitOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
}

function waitForTask(id: string, opts: WaitOptions = {}): Promise<boolean> {
	const task = tasks.get(id);
	if (!task || task.status !== "running") return Promise.resolve(true);
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
		addWaiter(taskWaiters, id, () => settle(true));
	});
}

function waitForJob(jobId: string, opts: WaitOptions = {}): Promise<boolean> {
	const job = jobs.get(jobId);
	if (!job || job.finished) return Promise.resolve(true);
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
		addWaiter(jobWaiters, jobId, () => settle(true));
	});
}

/** Wait for a job to finish; on abort/timeout, kill still-running tasks and wait again. */
async function waitForJobOrKill(jobId: string, signal?: AbortSignal, timeoutMs?: number): Promise<boolean> {
	const completed = await waitForJob(jobId, { signal, timeoutMs });
	if (completed) return true;
	const job = jobs.get(jobId);
	if (!job) return true;
	for (const t of job.tasks) if (t.status === "running") killTask(t);
	await waitForJob(jobId, {});
	return false;
}

// ── Chain runner ─────────────────────────────────────────────────────────────

function runChain(
	job: Job,
	chain: Array<{ agent?: string; task: string; cwd?: string; tier?: string }>,
	agents: AgentSummary[],
	defaultCwd: string,
	modelCtx: ModelContext,
	signal?: AbortSignal,
) {
	// Kick off without awaiting — the job's completion drives callers.
	void (async () => {
		let previousOutput = "";
		for (let i = 0; i < chain.length; i++) {
			const step = chain[i];
			const agent = resolveAgent(step.agent, agents);
			if (!agent) {
				job.status = "failed";
				job.errorMessage = `Chain stopped at step ${i + 1}: unknown agent "${step.agent}". Available agents: ${formatAgentList(agents).text}.`;
				break;
			}
			const task = await spawnTask(agent, step.task.replace(/\{previous\}/g, previousOutput), step.cwd ?? defaultCwd, job.id, {
				step: i + 1,
				tier: step.tier,
				modelCtx,
			});
			const completed = await waitForTask(task.id, { signal });
			if (!completed && signal?.aborted) {
				killTask(task);
				await waitForTask(task.id, {});
				job.status = "aborted";
				job.errorMessage = `Chain aborted at step ${i + 1} (${step.agent})`;
				break;
			}
			if (isFailedState(task)) {
				job.status = "failed";
				job.errorMessage = `Chain stopped at step ${i + 1} (${step.agent}): ${getResultOutput(task)}`;
				break;
			}
			previousOutput = getFinalOutput(task.messages);
		}
		if (job.status === "running") job.status = "completed";
		job.chainRunnerDone = true;
		checkJobComplete(job);
	})();
}

// ── Concurrency-limited parallel helper ──────────────────────────────────────

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

// ── Result builders ──────────────────────────────────────────────────────────

function spawnResultText(job: Job, label: string): string {
	return [
		`Spawned ${job.tasks.length} background subagent(s) (${label}).`, 
		`jobId: ${job.id}`,
		"",
		"They will run in the background while you continue working. A summary is delivered when the batch finishes (disable with notifyOnComplete: false).",
		"Collect full results with subagent_wait; check progress with subagent_status (use this jobId).",
	].join("\n");
}

function collectResultText(jobIds: string[], timeoutNote?: string): { text: string; anyFailed: boolean } {
	const collected: Task[] = [];
	let anyFailed = false;
	for (const id of jobIds) {
		const job = jobs.get(id);
		if (job) {
			for (const t of job.tasks) {
				collected.push(t);
				if (isFailedState(t)) anyFailed = true;
			}
		}
	}
	const unknown = jobIds.filter((id) => !jobs.has(id));
	const parts: string[] = [];
	if (collected.length > 0) parts.push(formatStatusReport(collected, { maxOutputBytes: 50 * 1024 }));
	if (unknown.length > 0) parts.push(`Unknown job id(s) (not found in this session): ${unknown.join(", ")}`);
	if (timeoutNote) parts.push(timeoutNote);
	return { text: parts.join("\n\n---\n\n"), anyFailed };
}

// ── TUI rendering helpers ────────────────────────────────────────────────────

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, unknown> };

function getDisplayItems(messages: MessageLike[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text ?? "" });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name ?? "?", args: (part.arguments as Record<string, unknown>) ?? {} });
			}
		}
	}
	return items;
}

function formatToolCall(toolName: string, args: Record<string, unknown>, themeFg: (color: string, text: string) => string): string {
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

function renderTaskList(tasks: DisplayItem[], limit: number, theme: any): string {
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
	if (runningCount > 0 && !widgetTimer && widgetTui) {
		widgetTimer = setInterval(() => requestWidgetRender(), 1000);
		widgetTimer.unref?.();
	} else if (runningCount === 0) {
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
function updateStatusWidget() {
	if (!uiRef) return;
	const running = runningCount > 0;
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

// ── Extension entry ──────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	api = pi;

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		uiRef = ctx.ui;
	});

	pi.on("session_shutdown", async () => {
		// Drop UI references first so task-close callbacks during teardown no-op.
		uiRef = undefined;
		widgetTui = undefined;
		widgetRegistered = false;
		stopWidgetTimer();
		for (const t of tasks.values()) if (t.status === "running") killTask(t);
		tasks.clear();
		jobs.clear();
		taskWaiters.clear();
		jobWaiters.clear();
		runningCount = 0;
	});

	const tierParam = Type.Optional(
		Type.Union([Type.Literal("fast"), Type.Literal("balanced"), Type.Literal("deep")], {
			description:
				"Model tier for this task: fast (small/cheap model), balanced (default model), deep (large/capable model). Resolved via subagent.modelTiers in settings.json; unmapped tiers fall back to the agent's model/tier, then the parent's default model.",
		}),
	);
	const singleTierParam = Type.Optional(
		Type.Union([Type.Literal("fast"), Type.Literal("balanced"), Type.Literal("deep")], {
			description:
				"Model tier for the subagent (single mode): fast, balanced, or deep. Resolved via subagent.modelTiers in settings.json; falls back to the agent's configured model/tier, then the parent's default model.",
		}),
	);

	const TaskItem = Type.Object({
		agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (from ~/.pi/agent/agents). Omit for a raw prompt using the built-in default agent." })),
		task: Type.String({ description: "Task to delegate to the agent" }),
		cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
		tier: tierParam,
	});

	const ChainItem = Type.Object({
		agent: Type.Optional(Type.String({ description: "Name of the agent to invoke. Omit for a raw prompt using the built-in default agent." })),
		task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
		cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
		tier: tierParam,
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context windows (each runs in its own pi process).",
			"Modes (exactly one): single {agent?, task} (omit agent for a raw prompt using the built-in default agent),",
			"parallel {tasks: [{agent?, task}]}, chain {chain: [{agent?, task}]} (sequential, {previous} placeholder; agent optional in both).",
			"wait: true (default) blocks until done and returns results. wait: false spawns background subagents and",
			"returns jobIds immediately so you can keep working; a summary is delivered on completion, full results via subagent_wait.",
			`Agent definitions live in ${getUserAgentsDir()} (*.md with YAML frontmatter: name, description, tools, model).`,
			"List available agents with subagent_agents.",
		].join(" "),
		promptSnippet:
			"Delegate isolated tasks to subagent processes (single/parallel/chain; wait:false to keep working in parallel, subagent_wait to collect)",
		promptGuidelines: [
			"Use subagent with wait:false to run background work while continuing your own turn; collect with subagent_wait.",
			"Use subagent with wait:true (default) when you need the delegated result before doing anything else.",
		],
		parameters: Type.Object({
			agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (single mode). Omit for a raw prompt using the built-in default agent." })),
			task: Type.Optional(Type.String({ description: "Task to delegate, or the raw prompt when no agent is given (single mode)" })),
			tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent?, task} for parallel execution (max 8); omit agent for a raw prompt using the built-in default agent" })),
			chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent?, task} for sequential execution; use {previous} in a task to reference the prior output; omit agent for a raw prompt using the built-in default agent" })),
			wait: Type.Optional(Type.Boolean({ description: "true (default): block until done and return results. false: spawn in background and return jobIds immediately.", default: true })),
			notifyOnComplete: Type.Optional(Type.Boolean({ description: "When wait: false, deliver a summary message when the batch finishes. Default: true.", default: true })),
			cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
			tier: singleTierParam,
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agents = discoverUserAgents();
			const modelCtx = buildModelContext(ctx);
			const wait = params.wait ?? true;
			const notifyOnComplete = params.notifyOnComplete ?? true;
			const emit = onUpdate
				? (content: string, details: ToolDetails) => onUpdate({ content: [{ type: "text", text: content }], details })
				: undefined;

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = params.task !== undefined || params.agent !== undefined;
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			if (modeCount !== 1) {
				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [{ type: "text", text: `Invalid parameters: provide exactly one mode (single, parallel, or chain).\nAvailable agents: ${available}\nRaw prompts: omit the agent field to use the built-in default agent.` }],
					details: { mode: "single" as const, jobIds: [], tasks: [] },
				};
			}

			// Pre-validate agents so we never spawn a partial batch with an unknown agent.
			const unknownAgents = new Set<string>();
			if (params.agent !== undefined && !resolveAgent(params.agent, agents)) unknownAgents.add(params.agent);
			if (params.tasks) for (const t of params.tasks) if (t.agent !== undefined && !resolveAgent(t.agent, agents)) unknownAgents.add(t.agent);
			if (params.chain) for (const c of params.chain) if (c.agent !== undefined && !resolveAgent(c.agent, agents)) unknownAgents.add(c.agent);
			if (unknownAgents.size > 0) {
				const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
				return {
					content: [{ type: "text", text: `Unknown agent(s): ${Array.from(unknownAgents).join(", ")}. Available agents: ${available}.` }],
					details: { mode: "single" as const, jobIds: [], tasks: [] },
					isError: true,
				};
			}

			// ── Chain mode ──
			if (hasChain) {
				const job = createJob("chain", shouldNotify(wait, notifyOnComplete), emit, params.chain!.length);
				runChain(job, params.chain!, agents, params.cwd ?? ctx.cwd, modelCtx, wait ? signal : undefined);
				if (!wait) {
					return { content: [{ type: "text", text: spawnResultText(job, "chain") }], details: jobDetails(job) };
				}
				const completed = await waitForJobOrKill(job.id, signal);
				if (!completed) {
					return {
						content: [{ type: "text", text: `Chain ${job.status}: ${job.errorMessage || "(aborted)"}` }],
						details: jobDetails(job),
						isError: true,
					};
				}
				const last = job.tasks[job.tasks.length - 1];
				if (job.status === "failed") {
					return {
						content: [{ type: "text", text: job.errorMessage || "Chain failed." }],
						details: jobDetails(job),
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: getFinalOutput(last?.messages ?? []) || "(no output)" }],
					details: jobDetails(job),
				};
			}

			// ── Parallel mode ──
			if (hasTasks) {
				const tasksParam = params.tasks!;
				if (tasksParam.length > MAX_PARALLEL_TASKS) {
					return {
						content: [{ type: "text", text: `Too many parallel tasks (${tasksParam.length}). Max is ${MAX_PARALLEL_TASKS}.` }],
						details: { mode: "parallel" as const, jobIds: [], tasks: [] },
					};
				}
				const job = createJob("parallel", shouldNotify(wait, notifyOnComplete), emit);
				if (wait) {
					await mapWithConcurrencyLimit(tasksParam, MAX_CONCURRENCY, async (t) => {
						const agent = resolveAgent(t.agent, agents)!;
						const task = await spawnTask(agent, t.task, t.cwd ?? ctx.cwd, job.id, { tier: t.tier, modelCtx });
						const completed = await waitForTask(task.id, { signal });
						if (!completed && signal?.aborted) {
							killTask(task);
							await waitForTask(task.id, {});
						}
					});
					if (signal?.aborted) {
						return {
							content: [{ type: "text", text: "Parallel run aborted." }],
							details: jobDetails(job),
							isError: true,
						};
					}
					const successCount = job.tasks.filter((t) => !isFailedState(t)).length;
					const summaries = job.tasks.map((t) => {
						const output = truncateOutput(getResultOutput(t), 50 * 1024);
						const status = isFailedState(t) ? `failed${t.stopReason && t.stopReason !== "end" ? ` (${t.stopReason})` : ""}` : "completed";
						return `### [${t.agent}] ${status}\n\n${output}`;
					});
					return {
						content: [{ type: "text", text: `Parallel: ${successCount}/${job.tasks.length} succeeded\n\n${summaries.join("\n\n---\n\n")}` }],
						details: jobDetails(job),
						isError: successCount !== job.tasks.length,
					};
				}
				for (const t of tasksParam) {
					const agent = resolveAgent(t.agent, agents)!;
					void spawnTask(agent, t.task, t.cwd ?? ctx.cwd, job.id, { tier: t.tier, modelCtx });
				}
				return { content: [{ type: "text", text: spawnResultText(job, "parallel") }], details: jobDetails(job) };
			}

			// ── Single mode ──
			const agent = resolveAgent(params.agent, agents)!;
			const job = createJob("single", shouldNotify(wait, notifyOnComplete), emit);
			const task = await spawnTask(agent, params.task ?? "", params.cwd ?? ctx.cwd, job.id, { tier: params.tier, modelCtx });
			if (!wait) {
				return { content: [{ type: "text", text: spawnResultText(job, "single") }], details: jobDetails(job) };
			}
			const completed = await waitForJobOrKill(job.id, signal);
			if (!completed) {
				return {
					content: [{ type: "text", text: `Subagent ${job.status}: ${job.errorMessage || "(aborted)"}` }],
					details: jobDetails(job),
					isError: true,
				};
			}
			if (isFailedState(task)) {
				return {
					content: [{ type: "text", text: `Agent ${task.stopReason || "failed"}: ${getResultOutput(task)}` }],
					details: jobDetails(job),
					isError: true,
				};
			}
			return { content: [{ type: "text", text: getFinalOutput(task.messages) || "(no output)" }], details: jobDetails(job) };
		},

		renderCall(args, theme, _context) {
			if (args.chain && args.chain.length > 0) {
				let text = theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", `chain (${args.chain.length} steps)`) + theme.fg("muted", args.wait === false ? " [async]" : "");
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					text += "\n  " + theme.fg("muted", `${i + 1}.`) + " " + theme.fg("accent", displayAgentName(step.agent)) + theme.fg("dim", ` ${preview}`);
				}
				if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				let text = theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", `parallel (${args.tasks.length} tasks)`) + theme.fg("muted", args.wait === false ? " [async]" : "");
				for (const t of args.tasks.slice(0, 3)) {
					const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					text += `\n  ${theme.fg("accent", displayAgentName(t.agent))}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			const agentName = args.agent || "default";
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
			let text = theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", agentName) + theme.fg("muted", args.wait === false ? " [async]" : "");
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as ToolDetails | undefined;
			if (!details || details.tasks.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			if (details.mode === "collect") {
				const lines: string[] = [];
				for (const t of details.tasks) {
					const icon = t.status === "completed" ? theme.fg("success", "✓") : t.status === "running" ? theme.fg("warning", "⏳") : theme.fg("error", "✗");
					lines.push(`${icon} ${theme.fg("accent", t.agent)}${theme.fg("dim", ` (${t.status})`)}`);
					if (!expanded) {
						const preview = getFinalOutput(t.messages).split("\n").slice(0, 2).join("\n");
						if (preview) lines.push(theme.fg("toolOutput", preview));
					}
				}
				const usageAgg = details.tasks.reduce((acc, t) => {
					acc.input += t.usage.input;
					acc.output += t.usage.output;
					acc.cost += t.usage.cost;
					acc.turns += t.usage.turns;
					return acc;
				}, { input: 0, output: 0, cost: 0, turns: 0 });
				const usageStr = formatUsageStats(usageAgg);
				if (usageStr) lines.push(theme.fg("dim", usageStr));
				return new Text(lines.join("\n"), 0, 0);
			}

			const renderItems = (t: TaskInfo) => {
				if (expanded) return getDisplayItems(t.messages);
				return getDisplayItems(t.messages).slice(-COLLAPSED_ITEM_COUNT);
			};

			const lines: string[] = [];
			if (details.mode === "chain") {
				const successCount = details.tasks.filter((t) => t.status === "completed").length;
				const icon = successCount === details.tasks.length ? theme.fg("success", "✓") : theme.fg("error", "✗");
				lines.push(`${icon} ${theme.fg("toolTitle", theme.bold("chain "))}${theme.fg("accent", `${successCount}/${details.tasks.length} steps`)}`);
				for (const t of details.tasks) {
					const tIcon = t.status === "completed" ? theme.fg("success", "✓") : t.status === "running" ? theme.fg("warning", "⏳") : theme.fg("error", "✗");
					lines.push(`\n${theme.fg("muted", `─── Step ${t.step ?? "?"}: `)}${theme.fg("accent", t.agent)} ${tIcon}`);
					lines.push(renderTaskList(renderItems(t) as DisplayItem[], expanded ? Infinity : 5, theme));
					const output = getFinalOutput(t.messages);
					if (expanded && output) lines.push(theme.fg("toolOutput", output));
				}
			} else if (details.mode === "parallel") {
				const running = details.tasks.filter((t) => t.status === "running").length;
				const successCount = details.tasks.filter((t) => t.status === "completed").length;
				const failCount = details.tasks.filter((t) => t.status === "failed" || t.status === "aborted").length;
				const isRunning = running > 0;
				const icon = isRunning ? theme.fg("warning", "⏳") : failCount > 0 ? theme.fg("warning", "◐") : theme.fg("success", "✓");
				const status = isRunning ? `${successCount + failCount}/${details.tasks.length} done, ${running} running` : `${successCount}/${details.tasks.length} tasks`;
				lines.push(`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`);
				for (const t of details.tasks) {
					const tIcon = t.status === "completed" ? theme.fg("success", "✓") : t.status === "running" ? theme.fg("warning", "⏳") : theme.fg("error", "✗");
					lines.push(`\n${theme.fg("muted", "─── ")}${theme.fg("accent", t.agent)} ${tIcon}`);
					lines.push(renderTaskList(renderItems(t) as DisplayItem[], expanded ? Infinity : 5, theme));
					const output = getFinalOutput(t.messages);
					if (expanded && output) lines.push(theme.fg("toolOutput", output));
				}
			} else {
				const t = details.tasks[0];
				const isError = isFailedState(t);
				const icon = isError ? theme.fg("error", "✗") : t.status === "running" ? theme.fg("warning", "⏳") : theme.fg("success", "✓");
				lines.push(`${icon} ${theme.fg("toolTitle", theme.bold(t.agent))}${theme.fg("muted", ` (${t.agentSource})`)}`);
				if (t.status === "running") {
					lines.push(theme.fg("muted", "(running in background...)"));
				} else if (isError && t.errorMessage) {
					lines.push(theme.fg("error", `Error: ${t.errorMessage}`));
				} else {
					lines.push(renderTaskList(renderItems(t) as DisplayItem[], COLLAPSED_ITEM_COUNT, theme));
					if (expanded) {
						const output = getFinalOutput(t.messages);
						if (output) lines.push(theme.fg("toolOutput", output));
					}
				}
			}
			const usageAgg = details.tasks.reduce((acc, t) => {
				acc.input += t.usage.input;
				acc.output += t.usage.output;
				acc.cost += t.usage.cost;
				acc.turns += t.usage.turns;
				return acc;
			}, { input: 0, output: 0, cost: 0, turns: 0 });
			const usageStr = formatUsageStats(usageAgg);
			if (usageStr && details.tasks.every((t) => t.status !== "running")) {
				lines.push(`\n${theme.fg("dim", usageStr)}`);
			}
			if (details.tasks.some((t) => t.status !== "running") && !expanded) {
				lines.push(theme.fg("muted", "(Ctrl+O to expand)"));
			}
			return new Text(lines.join("\n"), 0, 0);
		},
	});

	pi.registerTool({
		name: "subagent_wait",
		label: "Subagent Wait",
		description:
			"Block until previously spawned background subagents (from subagent with wait: false) finish, returning their full results. Returns immediately for already-completed jobs.",
		promptSnippet: "Wait for background subagents to finish and return their full results (takes jobIds from subagent wait:false)",
		promptGuidelines: [
			"Use subagent_wait when you need the results of background subagents you spawned with subagent wait:false.",
			"While subagent_wait is running you can only wait; use subagent_status instead to keep working.",
		],
		parameters: Type.Object({
			jobIds: Type.Array(Type.String({ description: "Job ids returned by subagent (wait: false)" })),
			timeoutSeconds: Type.Optional(Type.Number({ description: "Maximum seconds to wait. Returns partial results if exceeded. Default: wait indefinitely." })),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			const timeoutMs = params.timeoutSeconds !== undefined ? params.timeoutSeconds * 1000 : undefined;
			const results = await Promise.all(params.jobIds.map((id) => waitForJob(id, { signal, timeoutMs })));
			const timedOut = results.some((completed) => !completed && !signal?.aborted);
			const aborted = Boolean(signal?.aborted && !results.every(Boolean));
			const timeoutNote = timedOut ? `\n\n(Timed out after ${params.timeoutSeconds}s; still-running jobs continue in the background — call subagent_wait again or subagent_status.)` : aborted ? "\n\n(Wait aborted; background jobs continue running — call subagent_wait or subagent_status later.)" : undefined;
			const { text, anyFailed } = collectResultText(params.jobIds, timeoutNote);
			return {
				content: [{ type: "text", text }],
				details: { mode: "collect" as const, jobIds: params.jobIds, tasks: params.jobIds.flatMap((id) => jobs.get(id)?.tasks.map(toTaskInfo) ?? []) },
				isError: anyFailed && !timedOut && !aborted,
			};
		},

		renderCall(_args, theme, _context) {
			return new Text(theme.fg("toolTitle", theme.bold("subagent_wait ")) + theme.fg("muted", "(collect results)"), 0, 0);
		},
	});

	pi.registerTool({
		name: "subagent_status",
		label: "Subagent Status",
		description:
			"Non-blocking progress check for background subagents spawned with subagent (wait: false). Returns current status, partial output, and usage without waiting.",
		promptSnippet: "Check progress of background subagents without blocking",
		parameters: Type.Object({
			jobIds: Type.Array(Type.String({ description: "Job ids returned by subagent (wait: false)" })),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const tasksList = params.jobIds.flatMap((id) => jobs.get(id)?.tasks ?? []);
			const unknown = params.jobIds.filter((id) => !jobs.has(id));
			const parts: string[] = [];
			if (tasksList.length > 0) parts.push(formatStatusReport(tasksList, { maxOutputBytes: 2000 }));
			if (unknown.length > 0) parts.push(`Unknown job id(s) (not found in this session): ${unknown.join(", ")}`);
			return {
				content: [{ type: "text", text: parts.join("\n\n---\n\n") || "(no tasks)" }],
				details: { mode: "collect" as const, jobIds: params.jobIds, tasks: tasksList.map(toTaskInfo) },
			};
		},

		renderCall(_args, theme, _context) {
			return new Text(theme.fg("toolTitle", theme.bold("subagent_status ")) + theme.fg("muted", "(check progress)"), 0, 0);
		},
	});

	pi.registerTool({
		name: "subagent_agents",
		label: "Subagent Agents",
		description: `List available subagent definitions from ${getUserAgentsDir()}. Each is a markdown file with YAML frontmatter (name, description, tools, model) and a system prompt body.`,
		promptSnippet: "List available subagent definitions",
		parameters: Type.Object({}),

		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			const agents = discoverUserAgents();
			const lines = agents.map((a) => {
				const parts = [`- **${a.name}** — ${a.description}`];
				if (a.tools) parts.push(`  - tools: ${a.tools.join(", ")}`);
				if (a.model) parts.push(`  - model: ${a.model}`);
				return parts.join("\n");
			});
			const text = [
				`Available agents (${agents.length}):`,
				...lines,
				"",
				`Agent files: ${getUserAgentsDir()}`,
				"Raw prompts: call subagent with just {task} to use the built-in default agent.",
			].join("\n");
			return {
				content: [{ type: "text", text }],
				details: { mode: "collect" as const, jobIds: [], tasks: [] },
			};
		},

		renderCall(_args, theme, _context) {
			return new Text(theme.fg("toolTitle", theme.bold("subagent_agents ")) + theme.fg("muted", "(list)"), 0, 0);
		},
	});
}
