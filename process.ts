/**
 * process.ts — Child pi process lifecycle for subagent tasks.
 *
 * Owns everything around spawning and tearing down a child `pi --mode json`
 * process: CLI invocation discovery, temp system-prompt files, stdout event
 * streaming, and kill/finalize bookkeeping against the runtime registry.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	applyEventLine,
	buildChildArgs,
	classifyTaskExit,
	continuationPrompt,
	deriveTaskName,
	getFinalOutput,
	resolveContextWindow,
	resolveModel,
	rollupTaskDeathToJob,
	type AgentSummary,
} from "./core.ts";
import { applyLiveEvent, emptyLiveTrace } from "./live.ts";
import {
	checkJobComplete,
	decRunningCount,
	emptyUsage,
	fireWaiters,
	getJobsRoot,
	incRunningCount,
	jobDetails,
	jobs,
	taskWaiters,
	tasks,
	notifyStatusChanged,
	waitForJob,
	type Job,
	type ModelContext,
	type Task,
} from "./runtime.ts";
import { readManifest, resolveSessionFile, taskSessionDir, toManifestTask, updateManifest, upsertManifestTask } from "./store.ts";
import { boundOutput, writeOutputArtifact } from "./output.ts";

let taskSpawnGeneration = 0;
let acceptingTaskSpawns = true;
let dispatchHolds = 0;
let activeChildren = 0;
const dispatchQueue: Array<{ task: Task; launch: () => void; resolve: () => void }> = [];
const activeSlots = new Set<Task>();
const ownedChildren = new Set<{ task: Task; proc: ChildProcess; settled: Promise<void>; settle: () => void }>();
// JSON-mode events above 8 MiB are discarded through their newline; subsequent events continue normally.
const MAX_STDOUT_LINE_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const STDERR_TRIM_TARGET_BYTES = 48 * 1024;
const MAX_TASK_MESSAGES = 100;
const MAX_TASK_HISTORY_BYTES = 256 * 1024;

function pumpDispatchQueue(): void {
	if (dispatchHolds > 0 || !acceptingTaskSpawns) return;
	while (activeChildren < 4) {
		const index = dispatchQueue.findIndex(({ task }) => {
			const job = jobs.get(task.jobId);
			return task.status === "running" && !task.pauseRequested && !job?.abortRequested && job?.dispatchAllowed !== false;
		});
		if (index < 0) return;
		const item = dispatchQueue.splice(index, 1)[0];
		activeChildren++;
		activeSlots.add(item.task);
		item.task.dispatchState = "running";
		try { item.launch(); } finally { item.resolve(); }
	}
}

function releaseDispatchSlot(task: Task): void {
	if (!activeSlots.delete(task)) return;
	activeChildren = Math.max(0, activeChildren - 1);
	pumpDispatchQueue();
}

/** Hold launches while a batch records all planned task entries. */
export function holdTaskDispatch(): () => void {
	const generation = taskSpawnGeneration;
	dispatchHolds++;
	let released = false;
	return () => {
		if (released) return;
		released = true;
		// A hold from a shut-down session must not release a newer session's batch.
		if (generation !== taskSpawnGeneration) return;
		dispatchHolds = Math.max(0, dispatchHolds - 1);
		pumpDispatchQueue();
	};
}

/** Close the spawn gate synchronously before any asynchronous shutdown work. */
export function beginTaskShutdown(): void {
	acceptingTaskSpawns = false;
	taskSpawnGeneration++;
	dispatchHolds = 0;
	for (const item of dispatchQueue.splice(0)) item.resolve();
	// Release queued and running scheduler capacity immediately. Actual child
	// ownership is tracked separately until shutdown has reaped each process.
	for (const task of activeSlots) activeSlots.delete(task);
	activeChildren = 0;
}

/** Permit task spawning for a subsequent session without reviving stale pending spawns. */
export function resumeTaskSpawning(): void {
	acceptingTaskSpawns = true;
	dispatchHolds = 0;
	dispatchQueue.length = 0;
	for (const task of activeSlots) activeSlots.delete(task);
	activeChildren = 0;
	taskSpawnGeneration++;
}

function canSpawnInGeneration(generation: number): boolean {
	return acceptingTaskSpawns && generation === taskSpawnGeneration;
}

export function resolvePiInvocation(
	args: string[],
	options: { execPath?: string; pathValue?: string; pathDelimiter?: string; platform?: string } = {},
): { command: string; args: string[] } {
	const execPath = options.execPath ?? process.execPath;
	const execName = path.basename(execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(execName)) return { command: execPath, args };

	const delimiter = options.pathDelimiter ?? path.delimiter;
	const platform = options.platform ?? process.platform;
	const extensions = platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
	for (const entry of (options.pathValue ?? process.env.PATH ?? "").split(delimiter)) {
		const directory = entry || process.cwd();
		for (const extension of extensions) {
			const candidate = path.resolve(directory, `pi${extension}`);
			try {
				if (!fs.statSync(candidate).isFile()) continue;
				if (platform !== "win32") fs.accessSync(candidate, fs.constants.X_OK);
				return { command: candidate, args };
			} catch { /* try the next PATH candidate */ }
		}
	}
	// Let spawn's normal PATH lookup produce the standard missing-command error.
	return { command: "pi", args };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	return resolvePiInvocation(args);
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	try {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
		return { dir: tmpDir, filePath };
	} catch (err) {
		await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
		throw err;
	}
}

function updateStatus(): void { notifyStatusChanged(); }

/** Bound transcript history after message additions, without scanning/encoding it on token deltas. */
function boundTaskMessages(task: Task, compactLatest = false): void {
	if (!Array.isArray(task.messages)) return;
	let latestAssistantIndex = -1;
	for (let i = task.messages.length - 1; i >= 0; i--) {
		if (task.messages[i].role === "assistant") { latestAssistantIndex = i; break; }
	}
	if (compactLatest && latestAssistantIndex >= 0) {
		const latest = task.messages[latestAssistantIndex];
		const text = getFinalOutput([latest]);
		latest.content = [{ type: "text", text: boundOutput(text, { artifactPath: task.outputPath }) }];
	}
	const latest = latestAssistantIndex >= 0 ? task.messages[latestAssistantIndex] : undefined;
	if (compactLatest) {
		for (const message of task.messages) {
			message.content = message.content.filter((part) => part.type !== "thinking");
		}
	}
	const messageBytes = (message: Task["messages"][number]) => 128 + message.content.reduce((sum, part) =>
		sum + (typeof part.text === "string" ? Buffer.byteLength(part.text, "utf8") : 64), 0);
	let historyBytes = task.messages.reduce((sum, message) => sum + (message === latest ? 0 : messageBytes(message)), 0);
	while (task.messages.length > (latest ? 1 : 0) && (task.messages.length > MAX_TASK_MESSAGES || historyBytes > MAX_TASK_HISTORY_BYTES)) {
		const index = task.messages.findIndex((message) => message !== latest);
		if (index < 0) break;
		const [removed] = task.messages.splice(index, 1);
		historyBytes -= messageBytes(removed);
	}
}

/** Save the unabridged final text before transcript/result compaction. */
function captureTaskOutput(task: Task): void {
	if (!Array.isArray(task.messages)) task.messages = [];
	if (task.outputProducedGeneration !== task.processGeneration) return;
	const output = getFinalOutput(task.messages);
	if (!output) return;
	try {
		const artifact = writeOutputArtifact(output, { taskId: task.id, tasksDir: task.sessionDir });
		task.outputPath = artifact.path;
		task.outputBytes = artifact.bytes;
	} catch {
		// Preserve a prior attempt's artifact metadata if this attempt could not
		// replace it; the existing sidecar remains the authoritative full output.
	}
}

/** Return a tail no larger than maxBytes, cutting only at UTF-8 code-point boundaries. */
function utf8Tail(text: string, maxBytes: number): string {
	let removedBytes = 0;
	let offset = 0;
	const removeUntil = Math.max(0, Buffer.byteLength(text, "utf8") - maxBytes);
	for (const char of text) {
		if (removedBytes >= removeUntil) break;
		offset += char.length;
		removedBytes += Buffer.byteLength(char, "utf8");
	}
	return Buffer.from(text.slice(offset), "utf8").toString("utf8");
}

function emitJobUpdate(job: Job, content: string): void {
	try { job.emit?.(content, jobDetails(job)); } catch { /* UI callbacks must not block lifecycle work */ }
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

async function persistTaskSnapshot(task: Task, job: Job | undefined, finalizeJobStatus = false, snapshot = toManifestTask(task)): Promise<void> {
	const root = getJobsRoot();
	const psid = job?.parentSessionId;
	if (!root || !psid) return;
	try {
		await updateManifest(root, psid, task.jobId, (m) => {
			upsertManifestTask(m, snapshot);
			const chainDone = job?.mode === "chain" && job.chainRunnerDone;
			const tasksRecorded = job?.tasks.every((entry) => m.tasks.some((persisted) => persisted.taskId === entry.id));
			const batchDone = job && job.mode !== "chain" && tasksRecorded;
			if (finalizeJobStatus && job && (chainDone || batchDone) && m.tasks.every((entry) => entry.status !== "running" && entry.status !== "paused")) {
				let status = job.status;
				if (status === "running") {
					for (const entry of m.tasks) status = rollupTaskDeathToJob(status, entry.status);
					if (status === "running") status = "completed";
				}
				m.status = status;
				if (job.errorMessage) m.errorMessage = job.errorMessage;
			}
		});
	} catch { /* best-effort */ }
}

function cancelQueuedTask(task: Task, status: "paused" | "aborted" | "interrupted"): void {
	for (let i = dispatchQueue.length - 1; i >= 0; i--) {
		if (dispatchQueue[i].task === task) dispatchQueue.splice(i, 1)[0].resolve();
	}
	task.status = status;
	task.dispatchState = status === "paused" ? "paused" : "terminal";
	if (status === "aborted") task.stopReason = "aborted";
	if (!task.setupPending) void settleUnlaunchedTask(task, status);
}

async function settleUnlaunchedTask(task: Task, status: "paused" | "aborted" | "interrupted"): Promise<void> {
	if ([...ownedChildren].some((child) => child.task === task) || task.finalizing) return;
	task.finalizing = true;
	const job = jobs.get(task.jobId);
	try {
		task.status = status;
		task.dispatchState = status === "paused" ? "paused" : "terminal";
		task.finishedAt = Date.now();
		if (status === "aborted") task.stopReason = "aborted";
		cleanupTaskTemp(task);
		captureTaskOutput(task);
		boundTaskMessages(task, true);
		const snapshot = toManifestTask(task);
		await persistTaskSnapshot(task, job, true, snapshot);
	} finally {
		task.finalizing = false;
	}
	fireWaiters(taskWaiters, task.id);
	if (job) checkJobComplete(job);
}

async function finalizeTask(task: Task, code: number | null, signal: string | null = null, generation = task.processGeneration) {
	if (tasks.get(task.id) !== task || generation !== task.processGeneration || task.status !== "running" || task.finalizing) return;
	task.finalizing = true;
	task.exitCode = code ?? 1;
	task.finishedAt = Date.now();
	task.status = classifyTaskExit({ pauseRequested: task.pauseRequested, stopReason: task.stopReason, code, signal });
	task.dispatchState = task.status === "paused" ? "paused" : "terminal";
	cleanupTaskTemp(task);
	captureTaskOutput(task);
	boundTaskMessages(task, true);
	decRunningCount();
	releaseDispatchSlot(task);
	updateStatus();

	const job = jobs.get(task.jobId);
	if (job) {
		if (task.status !== "completed" && task.status !== "paused")
			job.status = rollupTaskDeathToJob(job.status, task.status);
		emitJobUpdate(
			job,
			job.mode === "parallel"
				? `Parallel: ${job.tasks.filter((t) => t.status !== "running").length}/${job.tasks.length} done...`
				: getFinalOutput(task.messages) || "(running...)",
		);
	}

	// Freeze the task record before entering the serialized manifest queue. A
	// resume cannot mutate the same Task until this write has settled.
	const root = getJobsRoot();
	const psid = job?.parentSessionId;
	if (!task.sessionFile && task.sessionDir) task.sessionFile = resolveSessionFile(task.sessionDir, task.id);
	const manifestTask = toManifestTask(task);
	if (root && psid) {
		try {
			await persistTaskSnapshot(task, job, true, manifestTask);
		} catch { /* best-effort */ }
	}
	task.finalizing = false;
	// Wake chain orchestration on pause, while waitForTask re-registers and
	// continues waiting until the task is actually terminal.
	fireWaiters(taskWaiters, task.id);
	if (job) checkJobComplete(job);
}

export function killTask(task: Task) {
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

export async function spawnTask(
	agent: AgentSummary,
	taskText: string,
	cwd: string,
	jobId: string,
	options: {
		step?: number;
		taskId?: string;
		requestedTier?: string;
		tier?: string;
		name?: string;
		modelOverride?: string;
		resume?: { sessionFile?: string; originalTask: string };
		modelCtx: ModelContext;
		spawnProcess?: typeof spawn;
	},
): Promise<Task> {
	const spawnGeneration = taskSpawnGeneration;
	const resolution = resolveModel({
		callTier: options.modelOverride ? undefined : options.tier,
		agentTier: options.modelOverride ? undefined : agent.tier,
		tierConfig: options.modelCtx.tierConfig,
		defaultModel: options.modelCtx.defaultModel,
		catalog: options.modelCtx.catalog,
	});
	// A resume is pinned to the model recorded in its manifest.
	const effectiveModel = options.modelOverride ?? resolution.model;
	const contextWindow = resolveContextWindow(
		effectiveModel ?? options.modelCtx.defaultModel,
		options.modelCtx.catalog,
	);
	const taskId = options.taskId ?? randomUUID();
	const priorTask = tasks.get(taskId);
	const task: Task = priorTask ?? {
		id: taskId,
		jobId,
		agent: agent.name,
		agentSource: agent.source,
		task: taskText,
		cwd,
		status: "running",
		dispatchState: "queued",
		setupPending: true,
		startedAt: Date.now(),
		exitCode: -1,
		messages: [],
		live: emptyLiveTrace(),
		stderr: "",
		usage: emptyUsage(),
		model: effectiveModel,
		contextWindow,
		tierUsed: resolution.tierUsed,
		tierNote: resolution.note,
		step: options.step,
		requestedTier: options.requestedTier ?? options.tier,
	};
	if (priorTask) {
		priorTask.status = "running";
		priorTask.dispatchState = "queued";
		priorTask.setupPending = true;
		priorTask.finalizing = false;
		priorTask.startedAt = Date.now();
		priorTask.finishedAt = undefined;
		priorTask.exitCode = -1;
		priorTask.stopReason = undefined;
		priorTask.errorMessage = undefined;
		priorTask.pauseRequested = false;
		priorTask.proc = undefined;
		priorTask.tierUsed = resolution.tierUsed;
		priorTask.tierNote = resolution.note;
	}
	const processGeneration = (task.processGeneration ?? 0) + 1;
	task.processGeneration = processGeneration;
	task.outputProducedGeneration = undefined;
	task.dispatchState = "queued";
	tasks.set(task.id, task);
	const job = jobs.get(jobId);
	if (job) job.pendingSpawns++;
	if (job && !priorTask) job.tasks.push(task);
	updateStatus();

	// Durable session setup: the manifest entry is flushed BEFORE the child
	// spawns (write-ordering invariant), so a session file can never exist
	// without its manifest entry.
	const root = getJobsRoot();
	const psid = job?.parentSessionId;
	let sessionDir: string | undefined;
	if (root && psid) {
		// Wait for the initial manifest transaction before exposing a task to pi.
		// Failed/unwritable persistence degrades to an ephemeral child session.
		let persistenceReady = true;
		try { if (job.persistenceReady) persistenceReady = await job.persistenceReady; } catch { persistenceReady = false; }
		if (persistenceReady) {
			const candidate = priorTask?.sessionDir ?? taskSessionDir(root, psid, jobId);
			const probe = path.join(candidate, `.write-test-${process.pid}-${randomUUID()}`);
			try {
				await fs.promises.mkdir(candidate, { recursive: true, mode: 0o700 });
				await fs.promises.writeFile(probe, "", { flag: "wx", mode: 0o600 });
				await fs.promises.unlink(probe);
				task.name = priorTask?.name ?? deriveTaskName(options.name, taskText, task.id);
				task.sessionDir = candidate;
				sessionDir = candidate;
				const queuedSnapshot = toManifestTask({ ...task, dispatchState: "queued" });
				await updateManifest(root, psid, jobId, (m) => {
					upsertManifestTask(m, queuedSnapshot);
				});
				if (!readManifest(root, psid, jobId)?.tasks.some((entry) => entry.taskId === task.id))
					throw new Error("task manifest flush was not committed");
			} catch {
				await fs.promises.unlink(probe).catch(() => {});
				// No transcript directory or manifest entry: spawn without --session-dir.
				task.sessionDir = undefined;
				sessionDir = undefined;
			}
		}
	}

	try {
		let systemPromptFile: string | undefined;
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			task.tmpDir = tmp.dir;
			task.tmpPath = tmp.filePath;
			systemPromptFile = tmp.filePath;
		}

		task.setupPending = false;
		if (!canSpawnInGeneration(spawnGeneration)) {
			cleanupTaskTemp(task);
			if (task.status === "running") await settleUnlaunchedTask(task, "interrupted");
			else await persistTaskSnapshot(task, job);
			return task;
		}
		if (task.status !== "running" || task.pauseRequested || job?.abortRequested || job?.dispatchAllowed === false) {
			const status = task.status === "aborted" || job?.abortRequested ? "aborted" : "paused";
			await settleUnlaunchedTask(task, status);
			return task;
		}

		const effectiveTask = options.resume ? continuationPrompt(options.resume.originalTask) : taskText;
		const args = buildChildArgs({
			model: effectiveModel,
			tools: agent.tools,
			extensions: agent.extensions,
			systemPromptFile,
			task: effectiveTask,
			sessionDir,
			sessionId: task.id,
			resumeSessionFile: options.resume?.sessionFile,
		});
		const invocation = getPiInvocation(args);
		const launch = () => {
			if (!canSpawnInGeneration(spawnGeneration) || task.status !== "running" || job?.abortRequested || job?.dispatchAllowed === false || task.pauseRequested) {
				releaseDispatchSlot(task);
				const status = task.status === "aborted" || job?.abortRequested ? "aborted" : "paused";
				void settleUnlaunchedTask(task, status);
				return;
			}
			task.dispatchState = "running";
			incRunningCount();
			try {
				const proc = (options.spawnProcess ?? spawn)(invocation.command, invocation.args, {
					cwd,
					shell: false,
					stdio: ["ignore", "pipe", "pipe"],
				});
				task.proc = proc;
				let resolveOwned!: () => void;
				const owned = { task, proc, settled: new Promise<void>((resolve) => { resolveOwned = resolve; }), settle: () => {} };
				owned.settle = () => { ownedChildren.delete(owned); resolveOwned(); };
				ownedChildren.add(owned);
				const stdoutDecoder = new StringDecoder("utf8");
				const stderrDecoder = new StringDecoder("utf8");
				let lineParts: string[] = [];
				let lineBytes = 0;
				let discardingOversizedLine = false;
				let stderrBytes = Buffer.byteLength(task.stderr, "utf8");
				const parseLine = (line: string) => {
					if (tasks.get(task.id) !== task || task.processGeneration !== processGeneration) return;
					try {
						task.live = applyLiveEvent(line, task.live);
						const messageCount = task.messages.length;
						applyEventLine(line, task);
						try {
							const event = JSON.parse(line);
							const message = event?.type === "message_end" ? event.message : undefined;
							if (message?.role === "assistant" && Array.isArray(message.content) && getFinalOutput([message]))
								task.outputProducedGeneration = processGeneration;
						} catch { /* applyEventLine already ignored malformed events */ }
						if (task.messages.length !== messageCount) boundTaskMessages(task);
						if (job) emitJobUpdate(job, getFinalOutput(task.messages) || "(running...)");
					} catch { /* malformed/value-shaped child events must not crash the parent */ }
				};
				const feedStdout = (text: string) => {
					let start = 0;
					while (start <= text.length) {
						const newline = text.indexOf("\n", start);
						const hasNewline = newline >= 0;
						const end = hasNewline ? newline : text.length;
						const piece = text.slice(start, end);
						if (!discardingOversizedLine) {
						const pieceBytes = Buffer.byteLength(piece, "utf8");
						if (lineBytes + pieceBytes > MAX_STDOUT_LINE_BYTES) {
							lineParts = [];
						lineBytes = 0;
						discardingOversizedLine = !hasNewline;
						} else {
						if (piece) {
							const last = lineParts[lineParts.length - 1];
						if (last && last.length + piece.length <= 4096) lineParts[lineParts.length - 1] = last + piece;
							else lineParts.push(piece);
						}
						lineBytes += pieceBytes;
						if (hasNewline) parseLine(lineParts.join(""));
					}
					} else if (hasNewline) {
						discardingOversizedLine = false;
					}
					if (hasNewline) {
						lineParts = [];
						lineBytes = 0;
						start = newline + 1;
						if (start > text.length) break;
					} else break;
					}
				};
				const appendStderr = (text: string) => {
					if (!text) return;
					const bytes = Buffer.byteLength(text, "utf8");
					if (bytes >= MAX_STDERR_BYTES) {
						task.stderr = utf8Tail(text, MAX_STDERR_BYTES);
						stderrBytes = Buffer.byteLength(task.stderr, "utf8");
					} else {
						task.stderr += text;
						stderrBytes += bytes;
						if (stderrBytes > MAX_STDERR_BYTES) {
							task.stderr = utf8Tail(task.stderr, STDERR_TRIM_TARGET_BYTES);
						stderrBytes = Buffer.byteLength(task.stderr, "utf8");
						}
					}
				};
				const flushStdout = () => {
					feedStdout(stdoutDecoder.end());
					if (!discardingOversizedLine && (lineParts.length > 0 || lineBytes > 0)) parseLine(lineParts.join(""));
					lineParts = [];
					lineBytes = 0;
				};
				proc.stdout.on("data", (data) => {
					if (tasks.get(task.id) !== task || task.processGeneration !== processGeneration) return;
					feedStdout(stdoutDecoder.write(Buffer.isBuffer(data) ? data : Buffer.from(String(data))));
				});
				proc.stderr.on("data", (data) => {
					if (task.processGeneration === processGeneration) appendStderr(stderrDecoder.write(Buffer.isBuffer(data) ? data : Buffer.from(String(data))));
				});
				proc.on("close", (code, signal) => {
					if (tasks.get(task.id) === task && task.processGeneration === processGeneration) {
						flushStdout();
						appendStderr(stderrDecoder.end());
					}
					void finalizeTask(task, code, signal, processGeneration).finally(owned.settle);
				});
				proc.on("error", (err) => {
					if (task.processGeneration === processGeneration) appendStderr(`spawn error: ${err.message}\\n`);
					void finalizeTask(task, 1, null, processGeneration).finally(owned.settle);
				});
			} catch (err) {
				task.stderr += `failed to spawn: ${err instanceof Error ? err.message : String(err)}\n`;
				void finalizeTask(task, 1, null, processGeneration);
			}
		};
		dispatchQueue.push({ task, launch, resolve: () => {} });
		pumpDispatchQueue();
	} catch (err) {
		task.stderr += `failed to spawn: ${err instanceof Error ? err.message : String(err)}\n`;
		finalizeTask(task, 1, null, processGeneration);
	} finally {
		if (job) {
			job.pendingSpawns--;
			checkJobComplete(job);
		}
	}
	return task;
}

/** Wait for a job to finish; on abort/timeout, kill still-running tasks and wait again. */
export async function waitForJobOrKill(jobId: string, signal?: AbortSignal, timeoutMs?: number): Promise<boolean> {
	const completed = await waitForJob(jobId, { signal, timeoutMs });
	if (completed) return true;
	const job = jobs.get(jobId);
	if (!job) return true;
	job.abortRequested = true;
	job.dispatchAllowed = false;
	job.status = "aborted";
	for (const t of job.tasks) {
		if (t.status === "running" && t.proc) killTask(t);
		else if (t.status === "running" || t.status === "paused") cancelQueuedTask(t, "aborted");
	}
	checkJobComplete(job);
	await waitForJob(jobId, {});
	return false;
}

// ── Pause & durable shutdown ─────────────────────────────────────────────────

/** Graceful pause: flag + SIGTERM; finalize marks affected tasks `paused`. */
export function pauseJobTasks(job: Job): Task[] {
	job.dispatchAllowed = false;
	job.dispatchEpoch = (job.dispatchEpoch ?? 0) + 1;
	const affected = job.tasks.filter((t) => t.status === "running");
	for (const t of affected) {
		t.pauseRequested = true;
		if (!t.proc) cancelQueuedTask(t, "paused");
		else killTask(t);
	}
	return affected;
}

/** Flush the job-level status to its manifest (best-effort; used by the chain runner). */
export async function flushJobStatus(job: Job): Promise<void> {
	const root = getJobsRoot();
	if (!root || !job.parentSessionId) return;
	try {
		await updateManifest(root, job.parentSessionId, job.id, (m) => {
			m.status = job.status;
			if (job.errorMessage) m.errorMessage = job.errorMessage;
		});
	} catch { /* best-effort */ }
}

/**
 * Shutdown sweep: mark every non-terminal task `interrupted` and flush its
 * manifest entry, then the job as `interrupted`. Called by index.ts BEFORE the
 * kill sweep — finalizeTask's `status !== "running"` guard makes the later
 * child-exit events no-ops, so the interrupted record survives. Paused tasks
 * keep their status (they are already finalized) and are re-flushed so
 * `sessionFile`/`finalOutput` are current.
 */
export async function shutdownTaskProcesses(termGraceMs = 5000, killWaitMs = 1000): Promise<void> {
	const owned = [...ownedChildren.values()];
	if (owned.length === 0) return;
	for (const child of owned) {
		try { if (child.proc.exitCode === null && !child.proc.signalCode) child.proc.kill("SIGTERM"); } catch { /* best-effort */ }
	}
	let timer: NodeJS.Timeout | undefined;
	const settled = Promise.all(owned.map((child) => child.settled));
	const graceElapsed = await Promise.race([
		settled.then(() => false),
		new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(true), termGraceMs); }),
	]);
	if (timer) clearTimeout(timer);
	if (!graceElapsed) return;
	for (const child of owned) {
		try { if (child.proc.exitCode === null && !child.proc.signalCode) child.proc.kill("SIGKILL"); } catch { /* best-effort */ }
	}
	timer = undefined;
	await Promise.race([
		settled,
		new Promise<void>((resolve) => { timer = setTimeout(resolve, killWaitMs); }),
	]);
	if (timer) clearTimeout(timer);
}

export async function markInterruptedSweep(): Promise<Task[]> {
	// Capture ownership before changing statuses; listRunningTasks() no longer
	// includes these tasks after the durable interruption mark below.
	const running = [...tasks.values()].filter((t) => t.status === "running");
	const root = getJobsRoot();
	for (const t of tasks.values()) {
		if (t.status !== "running" && t.status !== "paused") continue;
		const wasRunning = t.status === "running";
		if (wasRunning) {
			t.status = "interrupted";
			// Keep the queued marker for work that never owned a child process;
			// resume must replay its original task, not a continuation prompt.
			t.dispatchState = t.dispatchState === "queued" && !t.proc ? "queued" : "terminal";
			t.finishedAt = Date.now();
			cleanupTaskTemp(t);
		}
		if (wasRunning) captureTaskOutput(t);
		boundTaskMessages(t, true);
		if (!t.sessionFile && t.sessionDir) t.sessionFile = resolveSessionFile(t.sessionDir, t.id);
		const interruptedSnapshot = toManifestTask(t);
		if (!root) continue;
		const psid = jobs.get(t.jobId)?.parentSessionId;
		if (!psid) continue;
		try {
			await updateManifest(root, psid, t.jobId, (m) => {
				upsertManifestTask(m, interruptedSnapshot);
				m.status = "interrupted";
			});
		} catch {
			/* best-effort */
		}
	}
	return running;
}
