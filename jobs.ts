/**
 * jobs.ts — Job orchestration for the subagent tools.
 *
 * Owns job creation and teardown flows shared by the tool modes: job
 * records, the chain runner, concurrency-limited parallel dispatch, result
 * text builders, and the model-tier context snapshot per tool call.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
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
	type AgentSummary,
	type CatalogModel,
	type TierConfig,
} from "./core.ts";
import { flushJobStatus, killTask, pauseJobTasks, spawnTask } from "./process.ts";
import { emptyLiveTrace } from "./live.ts";
import {
	isResumableJob,
	listJobManifests,
	MANIFEST_VERSION,
	mergeJobListings,
	readManifest,
	resumePlan,
	upsertManifestTask,
	toManifestTask,
	updateManifest,
	writeManifest,
	type ManifestChainStep,
} from "./store.ts";
import {
	blocksResume,
	checkJobComplete,
	emptyUsage,
	getParentSessionId,
	getJobsRoot,
	jobs,
	waitForTask,
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

/** Read `subagent.modelTiers` and `defaultModel` from the user's settings.json. */
function readSettingsFile(): { tierConfig?: TierConfig; defaultModel?: string; jobRetentionDays?: number } {
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
	const subagentObj = subagent && typeof subagent === "object" && !Array.isArray(subagent)
		? (subagent as Record<string, unknown>)
		: undefined;
	const modelTiers = subagentObj?.modelTiers;
	const rawRetention = subagentObj?.jobRetentionDays;
	return {
		tierConfig: normalizeTierConfig(modelTiers),
		defaultModel:
			typeof settings.defaultModel === "string" && settings.defaultModel.trim() !== ""
				? settings.defaultModel
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

/** Outcome of a settings.json write attempt. */
export type WriteSettingsResult = { ok: true } | { ok: false; error: string };

/**
 * Persist `subagent.modelTiers` in the user's settings.json (read-modify-write,
 * temp-file + rename). All other settings keys are preserved untouched. Passing
 * `undefined` removes the `modelTiers` key entirely. Fails without writing when
 * the existing file is unparseable — never clobber a broken file silently.
 */
export function writeModelTiers(next: TierConfig | undefined): WriteSettingsResult {
	const settingsPath = path.join(getAgentDir(), "settings.json");
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
	} catch (err) {
		return {
			ok: false,
			error: `settings.json is unreadable (${err instanceof Error ? err.message : String(err)}); not overwriting`,
		};
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { ok: false, error: "settings.json is not a JSON object; not overwriting" };
	}
	const settings = parsed as Record<string, unknown>;
	if (next) {
		const subagent =
			settings.subagent && typeof settings.subagent === "object" && !Array.isArray(settings.subagent)
				? (settings.subagent as Record<string, unknown>)
				: {};
		subagent.modelTiers = next;
		settings.subagent = subagent;
	} else if (settings.subagent && typeof settings.subagent === "object" && !Array.isArray(settings.subagent)) {
		const subagent = settings.subagent as Record<string, unknown>;
		delete subagent.modelTiers;
		if (Object.keys(subagent).length === 0) delete settings.subagent;
	}
	try {
		const tmp = `${settingsPath}.tmp-${process.pid}`;
		fs.writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`);
		fs.renameSync(tmp, settingsPath);
	} catch (err) {
		return { ok: false, error: `failed to write settings.json: ${err instanceof Error ? err.message : String(err)}` };
	}
	return { ok: true };
}

/** Build the model context for one tool call from the extension context. */
export function buildModelContext(ctx: ExtensionContext): ModelContext {
	const settings = readSettingsFile();
	const scopedIds = new Set(ctx.scopedModels.map((s) => s.model.id));
	const catalog: CatalogModel[] = ctx.modelRegistry
		.getAvailable()
		.filter((m) => scopedIds.size === 0 || scopedIds.has(m.id))
		.map((m) => ({ id: m.id, provider: m.provider, inputCost: m.cost.input, contextWindow: m.contextWindow }));
	return {
		tierConfig: settings.tierConfig,
		defaultModel: settings.defaultModel ?? ctx.model?.id,
		catalog,
	};
}

// ── Job lifecycle ────────────────────────────────────────────────────────────

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
		emit,
		parentSessionId: persist?.parentSessionId,
	};
	jobs.set(job.id, job);
	if (persist) {
		// Write-ordering invariant: the manifest exists before any child spawns.
		const manifest = {
			version: MANIFEST_VERSION,
			jobId: job.id,
			parentSessionId: persist.parentSessionId,
			mode,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			notifyOnComplete,
			status: "running" as const,
			...(chainTotal !== undefined ? { chainTotal } : {}),
			...(persist.chain ? { chain: persist.chain } : {}),
			tasks: [],
		};
		void writeManifest(getDefaultJobsRoot(), persist.parentSessionId, manifest).catch(() => {
			/* best-effort: store problems never break spawning */
		});
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
) {
	// Kick off without awaiting — the job's completion drives callers.
	void (async () => {
		let previousOutput = initialPrevious;
		for (let i = startIndex; i < chain.length; i++) {
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
		flushJobStatus(job);
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

export function spawnResultText(job: Job, label: string): string {
	return [
		`Spawned ${job.tasks.length} background subagent(s) (${label}).`,
		`jobId: ${job.id}`,
		"",
		"They will run in the background while you continue working. A summary is delivered when the batch finishes (disable with notifyOnComplete: false).",
		"Collect full results with subagent_wait; check progress with subagent_status (use this jobId).",
	].join("\n");
}

export function collectResultText(jobIds: string[], timeoutNote?: string): { text: string; anyFailed: boolean } {
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

// ── Pause & resume ───────────────────────────────────────────────────────────

export function pauseJob(jobId: string): { job: Job; paused: Task[] } | undefined {
	const job = jobs.get(jobId);
	if (!job) return undefined;
	return { job, paused: pauseJobTasks(job) };
}

export interface ResumeInit {
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
	const root = getJobsRoot();
	const psid = getParentSessionId();
	if (!root || !psid) return { error: "No durable job store for this session." };
	const manifest = readManifest(root, psid, jobId);
	if (!manifest) {
		return { error: `No persisted job "${jobId}" for this session (jobs are bound to the session that spawned them).` };
	}
	if (blocksResume(jobs.get(jobId)))
		return { error: `Job ${jobId} is still active in this session; pause or wait for it to finish first.` };
	const plan = resumePlan(manifest);
	if (!plan) return { error: `Job ${jobId} is not resumable (status: ${manifest.status}).` };

	// Rebuild the registry job. Completed tasks come back with their manifest
	// finalOutput as a synthetic assistant message so every existing render
	// path (getFinalOutput, task lists, usage) works unchanged.
	const job: Job = {
		id: manifest.jobId,
		mode: manifest.mode,
		status: "running",
		tasks: [],
		chainTotal: manifest.chainTotal,
		notifyOnComplete: init.notifyOnComplete,
		notified: false,
		finished: false,
		chainRunnerDone: false,
		pendingSpawns: 0,
		emit: init.emit,
		parentSessionId: psid,
	};
	for (const t of manifest.tasks) {
		if (t.status === "completed") {
			job.tasks.push({
				id: t.taskId,
				jobId: job.id,
				agent: t.agent,
				agentSource: "manifest",
				task: t.task,
				cwd: t.cwd,
				status: "completed",
				startedAt: t.startedAt,
				finishedAt: t.finishedAt,
				exitCode: 0,
				name: t.name,
				messages: t.finalOutput
					? [{ role: "assistant", content: [{ type: "text", text: t.finalOutput }] }]
					: [],
				live: emptyLiveTrace(),
				stderr: "",
				usage: { ...emptyUsage(), ...t.usage },
				model: t.model,
				step: t.step,
				sessionFile: t.sessionFile,
			});
		}
	}
	jobs.set(job.id, job);

	// Flush the manifest back to running before spawning (write-ordering).
	void updateManifest(root, psid, job.id, (m) => {
		m.status = "running";
		m.notifyOnComplete = init.notifyOnComplete;
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
		if (!sessionFile) {
			notes.push(`session file missing for task ${t.name ?? t.taskId}; re-running from scratch`);
		}
		return spawnTask(agent ?? resolveAgent(undefined, init.agents)!, t.task, t.cwd, job.id, {
			step: t.step,
			tier: t.model ? undefined : t.tier,
			modelOverride: t.model,
			name: t.name,
			modelCtx: init.modelCtx,
			resume: sessionFile ? { sessionFile, originalTask: t.task } : undefined,
		});
	};

	if (manifest.mode === "parallel" && plan.respawnTasks.length > 1) {
		// Parallel: spawn + wait inside the same concurrency limit as fresh runs.
		const drained = mapWithConcurrencyLimit(plan.respawnTasks, MAX_CONCURRENCY, async (t) => {
			await respawn(t);
			await waitForTask(t.taskId, { signal: init.signal });
		});
		if (init.wait) await drained;
		else void drained.catch(() => {});
	} else {
		for (const t of plan.respawnTasks) void respawn(t);
	}

	if (manifest.mode === "chain") {
		// The respawned current step must finish before fresh steps run.
		const current = plan.respawnTasks[0];
		if (current) {
			void (async () => {
				await waitForTask(current.taskId, { signal: init.signal });
				runChainFrom(job, manifest.chain ?? [], plan.freshStartStep - 1, plan.previousOutput, init.agents, init.defaultCwd, init.modelCtx, init.signal);
			})();
		} else {
			runChainFrom(job, manifest.chain ?? [], plan.freshStartStep - 1, plan.previousOutput, init.agents, init.defaultCwd, init.modelCtx, init.signal);
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
		resumable: j.tasks.some((t) => isResumableStatus(t.status)),
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
	return list
		.map((j) => {
			const done = j.tasks.filter((t) => t.status === "completed").length;
			const names = j.tasks.map((t) => `${t.agent}${t.name ? `/${t.name}` : ""}(${t.status})`).join(", ") || "(no tasks)";
			return `- ${j.id} [${j.mode}] ${j.jobStatus} ${done}/${j.tasks.length} done${j.resumable ? " · resumable" : ""} · ${names} · source: ${j.source}`;
		})
		.join("\n");
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
	}));
}
