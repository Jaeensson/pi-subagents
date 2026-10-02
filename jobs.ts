/**
 * jobs.ts — Job orchestration for the subagent tools.
 *
 * Owns job creation and teardown flows shared by the tool modes: job
 * records, the chain runner, concurrency-limited parallel dispatch, result
 * text builders, and the model-tier context snapshot per tool call.
 */

import { randomUUID } from "node:crypto";
import {
	boundOutput,
	DEFAULT_OUTPUT_CAP_BYTES,
	DEFAULT_OUTPUT_CAP_LINES,
	readOutputArtifact,
	writeOutputArtifact,
} from "./output.ts";
import * as path from "node:path";
import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatAgentList } from "./agents.ts";
import {
	formatStatusReport,
	getFinalOutput,
	getResultOutput,
	isFailedState,
	isResumableStatus,
	normalizeTierConfig,
	resolveAgent,
	safeModelPin,
	type AgentSummary,
	type CatalogModel,
	type TierConfig,
} from "./core.ts";
import { flushJobStatus, killTask, pauseJobTasks, spawnTask } from "./process.ts";
import { emptyLiveTrace } from "./live.ts";
import { readSettingsJson, updateSettingsJson, type WriteSettingsResult } from "./settings.ts";
export type { WriteSettingsResult } from "./settings.ts";
import {
	isResumableJob,
	isResumableJobView,
	listJobManifests,
	MANIFEST_VERSION,
	claimManifest,
	currentManifestOwner,
	mergeJobListings,
	readManifest,
	resumePlan,
	upsertManifestTask,
	toManifestTask,
	taskSessionDir,
	updateManifest,
	writeManifest,
	type ManifestChainStep,
} from "./store.ts";
import {
	blocksResume,
	checkJobComplete,
	tasks,
	emptyUsage,
	getParentSessionId,
	getJobsRoot,
	jobs,
	waitForTask,
	waitForTaskOrPause,
	type Job,
	type JobMode,
	type ModelContext,
	type Task,
	type TaskInfo,
	type ToolDetails,
} from "./runtime.ts";

/** Max concurrently running tasks in parallel mode. */
export const MAX_CONCURRENCY = 4;

// ── Model tier context ───────────────────────────────────────────────────────

/** Read model tiers, defaults, and retention from the user's settings.json. */
function readSettingsFile(): { tierConfig?: TierConfig; defaultModel?: string; defaultProvider?: string; jobRetentionDays?: number } {
	const settings = readSettingsJson(path.join(getAgentDir(), "settings.json"));
	if (!settings) return {};
	const subagent = settings.subagent;
	const subagentObj = subagent && typeof subagent === "object" && !Array.isArray(subagent)
		? (subagent as Record<string, unknown>)
		: undefined;
	const modelTiers = subagentObj?.modelTiers;
	const rawRetention = subagentObj?.jobRetentionDays;
	return {
		tierConfig: normalizeTierConfig(modelTiers),
		defaultModel:
			typeof settings.defaultModel === "string" && settings.defaultModel.trim() !== ""
				? settings.defaultModel.trim()
				: undefined,
		defaultProvider:
			typeof settings.defaultProvider === "string" && settings.defaultProvider.trim() !== ""
				? settings.defaultProvider.trim()
				: undefined,
		jobRetentionDays:
			typeof rawRetention === "number" && Number.isFinite(rawRetention) && rawRetention >= 0
				? Math.floor(rawRetention)
				: undefined,
	};
}

/** `subagent.jobRetentionDays` (days before finished/interrupted jobs are GC'd). Default 7; 0 = never delete. */
export function readJobRetentionDays(): number {
	return readSettingsFile().jobRetentionDays ?? 7;
}

/** Root of the durable job store: `~/.pi/agent/subagent-jobs`. */
export function getDefaultJobsRoot(): string {
	return path.join(getAgentDir(), "subagent-jobs");
}

/**
 * Persist `subagent.modelTiers` in the user's settings.json (read-modify-write,
 * temp-file + rename). All other settings keys are preserved untouched. Passing
 * `undefined` removes the `modelTiers` key entirely. Fails without writing when
 * the existing file is unparseable — never clobber a broken file silently.
 */
export function writeModelTiers(next: TierConfig | undefined): WriteSettingsResult {
	const settingsPath = path.join(getAgentDir(), "settings.json");
	return updateSettingsJson(settingsPath, (settings) => {
		if (next) {
			const subagent =
				settings.subagent && typeof settings.subagent === "object" && !Array.isArray(settings.subagent)
					? settings.subagent as Record<string, unknown>
					: {};
			subagent.modelTiers = next;
			settings.subagent = subagent;
		} else if (settings.subagent && typeof settings.subagent === "object" && !Array.isArray(settings.subagent)) {
			const subagent = settings.subagent as Record<string, unknown>;
			delete subagent.modelTiers;
			if (Object.keys(subagent).length === 0) delete settings.subagent;
		}
	});
}

/** Build the model context for one tool call from the extension context. */
export function buildModelContext(ctx: ExtensionContext): ModelContext {
	const settings = readSettingsFile();
	const scopedModels = new Set(ctx.scopedModels.map((s) => `${s.model.provider}/${s.model.id}`));
	const catalog: CatalogModel[] = ctx.modelRegistry
		.getAvailable()
		.filter((m) => scopedModels.size === 0 || scopedModels.has(`${m.provider}/${m.id}`))
		.map((m) => ({ id: m.id, provider: m.provider, inputCost: m.cost.input, contextWindow: m.contextWindow }));
	const defaultModel = settings.defaultModel ?? ctx.model?.id;
	const defaultProvider = settings.defaultModel ? settings.defaultProvider : ctx.model?.provider;
	const matchingDefaults = defaultModel ? catalog.filter((model) => model.id === defaultModel) : [];
	const inferredProvider = matchingDefaults.length === 1 ? matchingDefaults[0].provider : undefined;
	const providerForDefault = defaultProvider ?? inferredProvider;
	const qualifiedDefault = defaultModel && providerForDefault
		? (defaultModel.startsWith(`${providerForDefault}/`) ? defaultModel : `${providerForDefault}/${defaultModel}`)
		: defaultModel;
	return {
		tierConfig: settings.tierConfig,
		defaultModel: qualifiedDefault,
		catalog,
	};
}

// ── Job lifecycle ────────────────────────────────────────────────────────────

/** Store an explicit cwd on every chain step so resumes keep the original default. */
export function persistChainSteps(
	chain: Array<{ agent?: string; task: string; cwd?: string; tier?: string; name?: string }>,
	defaultCwd: string,
): ManifestChainStep[] {
	return chain.map((step) => ({ ...step, cwd: step.cwd ?? defaultCwd }));
}

export function createJob(
	mode: JobMode,
	notifyOnComplete: boolean,
	emit?: (content: string, details: ToolDetails) => void,
	chainTotal?: number,
	persist?: { parentSessionId: string; chain?: ManifestChainStep[] },
): Job {
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
		dispatchAllowed: true,
		emit,
		parentSessionId: persist?.parentSessionId,
	};
	jobs.set(job.id, job);
	if (persist) {
		// Every spawn awaits this attempt before opening its transcript directory.
		// Store failures remain best-effort and fall back to an ephemeral child.
		const now = Date.now();
		const manifest = {
			version: MANIFEST_VERSION,
			jobId: job.id,
			parentSessionId: persist.parentSessionId,
			mode,
			createdAt: now,
			updatedAt: now,
			notifyOnComplete,
			status: "running" as const,
			owner: currentManifestOwner(),
			...(chainTotal !== undefined ? { chainTotal } : {}),
			...(persist.chain ? { chain: persist.chain } : {}),
			tasks: [],
		};
		job.persistenceReady = writeManifest(getDefaultJobsRoot(), persist.parentSessionId, manifest)
			.then(() => true, () => false);
	}
	return job;
}

/** Append/update one task entry in a job's manifest (best-effort). */
export function flushManifestTask(parentSessionId: string, jobId: string, task: Parameters<typeof toManifestTask>[0]): void {
	void updateManifest(getDefaultJobsRoot(), parentSessionId, jobId, (m) => {
		upsertManifestTask(m, toManifestTask(task));
	}).catch(() => {
		/* best-effort */
	});
}

// ── Chain runner ─────────────────────────────────────────────────────────────

export function runChain(
	job: Job,
	chain: Array<{ agent?: string; task: string; cwd?: string; tier?: string; name?: string }>,
	agents: AgentSummary[],
	defaultCwd: string,
	modelCtx: ModelContext,
	signal?: AbortSignal,
) {
	runChainFrom(job, chain, 0, "", agents, defaultCwd, modelCtx, signal);
}

/** Chain runner core: starts at `startIndex` (0-based) with `initialPrevious` for `{previous}`. */
export function runChainFrom(
	job: Job,
	chain: Array<{ agent?: string; task: string; cwd?: string; tier?: string; name?: string }>,
	startIndex: number,
	initialPrevious: string,
	agents: AgentSummary[],
	defaultCwd: string,
	modelCtx: ModelContext,
	signal?: AbortSignal,
	spawnProcess?: ResumeInit["spawnProcess"],
) {
	// Exactly one runner owns advancement at a time. A paused runner releases
	// ownership so resume can install the continuation after the current step.
	if (job.chainRunnerActive) return;
	job.chainRunnerActive = true;
	void (async () => {
		let previousOutput = initialPrevious;
		let shouldFinish = true;
		try {
			for (let i = startIndex; i < chain.length; i++) {
				if (signal?.aborted) {
					job.abortRequested = true;
					job.dispatchAllowed = false;
					job.status = "aborted";
					job.errorMessage = `Chain aborted before step ${i + 1}`;
					break;
				}
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
					name: step.name,
					modelCtx,
					spawnProcess,
				});
				const completed = await waitForTaskOrPause(task.id, { signal });
				if (!completed && signal?.aborted) {
					job.abortRequested = true;
					job.dispatchAllowed = false;
					killTask(task);
					await waitForTask(task.id, {});
					job.status = "aborted";
					job.errorMessage = `Chain aborted at step ${i + 1} (${step.agent})`;
					break;
				}
				if (task.status === "paused") {
					shouldFinish = false;
					return;
				}
				if (task.status === "interrupted") {
					job.status = "interrupted";
					job.errorMessage = `Chain interrupted at step ${i + 1} (${step.agent}): ${task.errorMessage || "child did not finish"}`;
					break;
				}
				if (isFailedState(task)) {
					job.status = "failed";
					job.errorMessage = `Chain stopped at step ${i + 1} (${step.agent}): ${getResultOutput(task)}`;
					break;
				}
				previousOutput = readOutputArtifact(task.outputPath) ?? getFinalOutput(task.messages);
			}
			if (job.status === "running") job.status = "completed";
		} catch (err) {
			job.status = "failed";
			job.errorMessage = `Chain runner failed: ${err instanceof Error ? err.message : String(err)}`;
		} finally {
			job.chainRunnerActive = false;
			if (shouldFinish) {
				job.chainRunnerDone = true;
				await flushJobStatus(job);
				checkJobComplete(job);
			}
		}
	})();
}

// ── Concurrency-limited parallel helper ──────────────────────────────────────

export async function mapWithConcurrencyLimit<TIn, TOut>(
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

export function taskResultText(task: Task, output = getResultOutput(task)): string {
	const text = output || "(no output)";
	return boundOutput(task.outputPath ? `${text}\n\nFull output: ${task.outputPath}` : text, { artifactPath: task.outputPath });
}

export function spawnResultText(job: Job, label: string): string {
	return boundOutput([
		`Spawned ${job.tasks.length} background subagent(s) (${label}).`,
		`jobId: ${job.id}`,
		"",
		"They will run in the background while you continue working. A summary is delivered when the batch finishes (disable with notifyOnComplete: false).",
		"Collect results with subagent_wait; check progress with subagent_status (use this jobId).",
	].join("\n"));
}

export function collectResultText(jobIds: string[], timeoutNote?: string): { text: string; anyFailed: boolean } {
	const collected: Array<Task | TaskInfo> = [];
	let anyFailed = false;
	const unknown: string[] = [];
	for (const id of jobIds) {
		const job = jobs.get(id);
		const rows = job?.tasks ?? persistedTaskInfos(id);
		if (!job && rows.length === 0) unknown.push(id);
		for (const task of rows) {
			collected.push(task);
			if (isFailedState(task) || task.status === "interrupted") anyFailed = true;
		}
	}
	const parts: string[] = [];
	if (collected.length > 0) parts.push(formatStatusReport(collected, {
		maxOutputBytes: Number.MAX_SAFE_INTEGER,
		maxOutputLines: Number.MAX_SAFE_INTEGER,
	}));
	if (unknown.length > 0) parts.push(`Unknown job id(s) (not found in this session): ${unknown.join(", ")}`);
	if (timeoutNote) parts.push(timeoutNote);
	const fullText = parts.join("\n\n---\n\n");
	const lineCount = fullText.length === 0 ? 0 : (fullText.match(/\n/g)?.length ?? 0) + 1;
	let artifactPath: string | undefined;
	if (Buffer.byteLength(fullText, "utf8") > DEFAULT_OUTPUT_CAP_BYTES || lineCount > DEFAULT_OUTPUT_CAP_LINES) {
		try { artifactPath = writeOutputArtifact(fullText, { taskId: `collect-${randomUUID()}` }).path; }
		catch { /* bounded output still reports artifact unavailable */ }
	}
	return { text: boundOutput(fullText, { artifactPath }), anyFailed };
}

// ── Pause & resume ───────────────────────────────────────────────────────────

export function pauseJob(jobId: string): { job: Job; paused: Task[] } | undefined {
	const job = jobs.get(jobId);
	if (!job) return undefined;
	return { job, paused: pauseJobTasks(job) };
}

const resumeAdmissions = new Set<string>();

export interface ResumeInit {
	spawnProcess?: typeof import("node:child_process").spawn;
	agents: AgentSummary[];
	defaultCwd: string;
	modelCtx: ModelContext;
	wait: boolean;
	notifyOnComplete: boolean;
	emit?: (content: string, details: ToolDetails) => void;
	signal?: AbortSignal;
}

/**
 * Rebuild a persisted job into the live registry and re-spawn its resumable
 * tasks (on their session files) plus any fresh chain steps. Returns the live
 * job plus advisory notes, or an error string.
 */
export async function resumeJob(
	jobId: string,
	init: ResumeInit,
): Promise<{ job?: Job; notes?: string[]; error?: string }> {
	// Admission is claimed synchronously, before any disk/manifest await. The
	// in-memory job may not exist yet (e.g. after reload), so it cannot be the
	// sole same-process exclusion mechanism.
	if (resumeAdmissions.has(jobId)) return { error: `Job ${jobId} is already being resumed.` };
	const existing = jobs.get(jobId);
	if (blocksResume(existing)) return { error: `Job ${jobId} is still active in this session; pause or wait for it to finish first.` };
	resumeAdmissions.add(jobId);
	if (existing) existing.resumeBusy = true;
	try {
		return await resumeJobClaimed(jobId, init);
	} finally {
		resumeAdmissions.delete(jobId);
		if (existing) existing.resumeBusy = false;
	}
}

async function resumeJobClaimed(
	jobId: string,
	init: ResumeInit,
): Promise<{ job?: Job; notes?: string[]; error?: string }> {
	const root = getJobsRoot();
	const psid = getParentSessionId();
	if (!root || !psid) return { error: "No durable job store for this session." };
	let manifest = readManifest(root, psid, jobId);
	if (!manifest) {
		return { error: `No persisted job "${jobId}" for this session (jobs are bound to the session that spawned them).` };
	}
	const existing = jobs.get(jobId);
	if (!resumePlan(manifest)) {
		return { error: `Job ${jobId} is not resumable (status: ${manifest.status}).` };
	}
	// Claim under the manifest transaction lock before rebuilding/spawning. This
	// prevents a second live parent process from resuming the same durable job.
	let claimed;
	try { claimed = await claimManifest(root, psid, jobId); } catch {
		return { error: `Job ${jobId} could not be claimed.` };
	}
	if (!claimed) {
		return { error: `Job ${jobId} is owned by another live process or could not be claimed.` };
	}
	manifest = claimed;
	const plan = resumePlan(manifest);
	if (!plan) {
		return { error: `Job ${jobId} is not resumable (status: ${manifest.status}).` };
	}

	// Rebuild the registry job. Completed tasks come back with their manifest
	// finalOutput as a synthetic assistant message so every existing render
	// path (getFinalOutput, task lists, usage) works unchanged.
	const job: Job = existing && !existing.finished ? existing : {
		id: manifest.jobId,
		mode: manifest.mode,
		status: "running",
		tasks: [],
		chainTotal: manifest.chainTotal,
		notifyOnComplete: !init.wait && init.notifyOnComplete,
		notified: false,
		finished: false,
		chainRunnerDone: false,
		pendingSpawns: 0,
		emit: init.emit,
		parentSessionId: psid,
		persistenceReady: Promise.resolve(true),
		dispatchAllowed: true,
	};
	if (job === existing) {
		job.notifyOnComplete = !init.wait && init.notifyOnComplete;
		job.notified = false;
		job.emit = init.emit;
		job.chainRunnerDone = false;
		job.chainRunnerActive = false;
		job.dispatchEpoch = (job.dispatchEpoch ?? 0) + 1;
		job.status = "running";
		job.dispatchAllowed = true;
		job.abortRequested = false;
		job.finished = false;
	} else for (const t of manifest.tasks) {
		const restored: Task = {
			id: t.taskId,
			jobId: job.id,
			agent: t.agent,
			agentSource: "manifest",
			task: t.task,
			cwd: t.cwd,
			status: t.status,
			dispatchState: t.dispatchState ?? (t.status === "running" ? "queued" : t.status === "completed" || t.status === "failed" || t.status === "aborted" ? "terminal" : "paused"),
			startedAt: t.startedAt,
			finishedAt: t.finishedAt,
			exitCode: t.exitCode,
			name: t.name,
			messages: t.finalOutput ? [{ role: "assistant", content: [{ type: "text", text: t.finalOutput }] }] : [],
			live: emptyLiveTrace(),
			stderr: "",
			usage: { ...emptyUsage(), ...t.usage },
			model: t.model,
			requestedTier: t.tier,
			step: t.step,
			sessionFile: t.sessionFile,
			sessionDir: t.sessionFile ? path.dirname(t.sessionFile) : (t.dispatchState === "queued" || isResumableJob(manifest) ? taskSessionDir(root, psid, job.id) : undefined),
			stopReason: t.stopReason,
			errorMessage: t.errorMessage,
			outputPath: t.outputPath,
			outputBytes: t.outputBytes,
		};
		tasks.set(restored.id, restored);
		job.tasks.push(restored);
	}
	jobs.set(job.id, job);

	await updateManifest(root, psid, job.id, (m) => {
		m.status = "running";
		m.notifyOnComplete = !init.wait && init.notifyOnComplete;
	}).catch(() => {
		/* best-effort */
	});

	const notes: string[] = [];
	// Spawn one resumable task on its session transcript. Shared by the
	// fire-and-forget path (single/chain) and the rate-limited path (parallel).
	const respawn = (t: (typeof plan.respawnTasks)[number]) => {
		const agent = resolveAgent(t.agent, init.agents);
		if (!agent) {
			notes.push(`agent "${t.agent}" no longer defined; task ${t.name ?? t.taskId} runs on the default agent`);
		}
		const sessionFile = t.sessionFile;
		const shouldContinue = t.dispatchState !== "queued" && isResumableStatus(t.status) && !!sessionFile;
		if (!sessionFile) {
			notes.push(`session file missing for task ${t.name ?? t.taskId}; re-running from scratch`);
		}
		// Child sessions self-report bare model ids; pinning one on a resume can
		// be ambiguous across providers. Qualify when unique, drop otherwise.
		const pin = safeModelPin(t.model, init.modelCtx.catalog);
		if (t.model && !pin) {
			notes.push(`model "${t.model}" is ambiguous or unknown; task ${t.name ?? t.taskId} re-resolves its model`);
		}
		return spawnTask(agent ?? resolveAgent(undefined, init.agents)!, t.task, t.cwd, job.id, {
			taskId: t.taskId,
			step: t.step,
			tier: pin ? undefined : t.tier,
			modelOverride: pin,
			name: t.name,
			modelCtx: init.modelCtx,
			spawnProcess: init.spawnProcess,
			resume: shouldContinue ? { sessionFile, originalTask: t.task } : undefined,
		});
	};

	if (manifest.mode === "parallel" && plan.respawnTasks.length > 1) {
		// Each resume owns one dispatch epoch. Pausing invalidates it synchronously;
		// workers also wake on pause instead of remaining attached to a later resume.
		const epoch = job.dispatchEpoch ?? 0;
		job.dispatchEpoch = epoch;
		const drained = mapWithConcurrencyLimit(plan.respawnTasks, MAX_CONCURRENCY, async (t) => {
			if (job.dispatchEpoch !== epoch || job.abortRequested) return;
			const task = await respawn(t);
			const completed = await waitForTaskOrPause(task.id, { signal: init.signal });
			if (!completed || task.status === "paused" || job.dispatchEpoch !== epoch || job.abortRequested) return;
		});
		void drained.catch(() => {});
	} else if (manifest.mode !== "chain") {
		for (const t of plan.respawnTasks) void respawn(t);
	}

	if (manifest.mode === "chain") {
		// A resumed chain step owns advancement only if that exact step completes.
		// Its newly produced output, not the pre-resume plan snapshot, feeds {previous}.
		const current = plan.respawnTasks[0];
		const priorCompleted = manifest.tasks.find((entry) => entry.status === "completed" && entry.step === plan.freshStartStep - 1);
		const fullPreviousOutput = readOutputArtifact(priorCompleted?.outputPath) ?? plan.previousOutput;
		if (current) {
			void (async () => {
				const launched = await respawn(current);
				const completed = await waitForTaskOrPause(launched.id, { signal: init.signal });
				if (!completed && init.signal?.aborted) {
					job.abortRequested = true;
					job.dispatchAllowed = false;
					if (launched.status === "running") killTask(launched);
					await waitForTask(launched.id, {});
					job.status = "aborted";
					job.errorMessage = `Chain aborted at resumed step ${launched.step ?? current.step ?? 1}`;
					job.chainRunnerDone = true;
					await flushJobStatus(job);
					checkJobComplete(job);
					return;
				}
				if (launched.status === "paused") return;
				if (launched.status !== "completed") {
					job.status = launched.status === "interrupted" ? "interrupted" : launched.status === "aborted" ? "aborted" : "failed";
					job.errorMessage = `Chain stopped at resumed step ${launched.step ?? current.step ?? 1} (${launched.agent}): ${launched.errorMessage || getResultOutput(launched) || launched.status}`;
					job.chainRunnerDone = true;
					await flushJobStatus(job);
					checkJobComplete(job);
					return;
				}
				runChainFrom(job, manifest.chain ?? [], (launched.step ?? current.step ?? 1), readOutputArtifact(launched.outputPath) ?? getFinalOutput(launched.messages), init.agents, init.defaultCwd, init.modelCtx, init.signal, init.spawnProcess);
			})();
		} else {
			runChainFrom(job, manifest.chain ?? [], plan.freshStartStep - 1, fullPreviousOutput, init.agents, init.defaultCwd, init.modelCtx, init.signal, init.spawnProcess);
		}
	}

	return { job, notes: notes.length ? notes : undefined };
}

// ── Job listings (registry ∪ disk) ─────────────────────────────────────────

export interface JobListing {
	id: string;
	mode: JobMode;
	jobStatus: string;
	createdAt: number;
	updatedAt: number;
	resumable: boolean;
	tasks: Array<{ taskId: string; name?: string; agent: string; status: string; step?: number }>;
	source: "registry" | "disk";
}

/** Registry jobs + persisted jobs for the current parent session, deduped (registry wins). */
export function listJobsForCurrentSession(): JobListing[] {
	const root = getJobsRoot();
	const psid = getParentSessionId();
	const registry: JobListing[] = [...jobs.values()].map((j) => ({
		id: j.id,
		mode: j.mode,
		jobStatus: j.finished ? j.status : "running",
		createdAt: j.tasks.length > 0 ? Math.min(...j.tasks.map((t) => t.startedAt)) : Date.now(),
		updatedAt: Date.now(),
		resumable: isResumableJobView({
			status: j.finished ? j.status : "running",
			mode: j.mode,
			chainTotal: j.chainTotal,
			tasks: j.tasks,
		}),
		tasks: j.tasks.map((t) => ({ taskId: t.id, name: t.name, agent: t.agent, status: t.status, step: t.step })),
		source: "registry" as const,
	}));
	const persisted: JobListing[] =
		root && psid
			? listJobManifests(root)
					.filter((e) => e.parentSessionId === psid)
					.map((e) => ({
						id: e.jobId,
						mode: e.manifest.mode,
						jobStatus: e.manifest.status,
						createdAt: e.manifest.createdAt,
						updatedAt: e.manifest.updatedAt,
						resumable: isResumableJob(e.manifest),
						tasks: e.manifest.tasks.map((t) => ({
							taskId: t.taskId, name: t.name, agent: t.agent, status: t.status, step: t.step,
						})),
						source: "disk" as const,
					}))
			: [];
	return mergeJobListings(registry, persisted);
}

export function formatJobListings(list: JobListing[]): string {
	if (list.length === 0) return "(no subagent jobs for this session)";
	return boundOutput(list
		.map((j) => {
			const done = j.tasks.filter((t) => t.status === "completed").length;
			const names = j.tasks.map((t) => `${t.agent}${t.name ? `/${t.name}` : ""}(${t.status})`).join(", ") || "(no tasks)";
			return `- ${j.id} [${j.mode}] ${j.jobStatus} ${done}/${j.tasks.length} done${j.resumable ? " · resumable" : ""} · ${names} · source: ${j.source}`;
		})
		.join("\n"));
}

export function hasPersistedJob(jobId: string): boolean {
	const root = getJobsRoot();
	const psid = getParentSessionId();
	return Boolean(root && psid && readManifest(root, psid, jobId));
}

/** Map a persisted job's manifest tasks to TaskInfo-shaped rows for status rendering. */
export function persistedTaskInfos(jobId: string): TaskInfo[] {
	const root = getJobsRoot();
	const psid = getParentSessionId();
	const m = root && psid ? readManifest(root, psid, jobId) : undefined;
	if (!m) return [];
	return m.tasks.map((t) => ({
		id: t.taskId,
		agent: t.agent,
		agentSource: "manifest",
		task: t.task,
		status: t.status,
		exitCode: t.exitCode,
		step: t.step,
		name: t.name,
		messages: t.finalOutput ? [{ role: "assistant", content: [{ type: "text", text: t.finalOutput }] }] : [],
		usage: { ...emptyUsage(), ...t.usage },
		model: t.model,
		stopReason: t.stopReason,
		errorMessage: t.errorMessage,
		finishedAt: t.finishedAt,
		outputPath: t.outputPath,
		outputBytes: t.outputBytes,
	}));
}
