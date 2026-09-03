/**
 * store.ts — Durable job store for subagent tasks.
 *
 * Owns the on-disk layout ~/<agentDir>/subagent-jobs/<parentSessionId>/<jobId>/
 * ({manifest.json, tasks/}) and every pure helper around it: path derivation,
 * manifest schema (version 1), atomic writes, session-file globbing, GC
 * planning, resumability analysis, and registry∪disk listing merge.
 *
 * No pi-package imports: fully unit-testable with `node --test`. Call sites
 * (jobs.ts/process.ts/index.ts) wrap the fs operations in try/catch so an
 * unwritable store degrades to in-memory behavior and never breaks spawning.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getFinalOutput, isResumableStatus, truncateOutput } from "./core.ts";

export const MANIFEST_VERSION = 1;
/** Cap for `finalOutput` stored in manifests (mirrors the tool-output cap). */
const FINAL_OUTPUT_CAP_BYTES = 50 * 1024;

// ── Schema ───────────────────────────────────────────────────────────────────

export type ManifestJobStatus = "running" | "completed" | "failed" | "aborted" | "interrupted";
export type ManifestTaskStatus = "running" | "completed" | "failed" | "aborted" | "paused" | "interrupted";

export interface ManifestTaskUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface ManifestTask {
	taskId: string;
	name?: string;
	agent: string;
	task: string;
	cwd: string;
	status: ManifestTaskStatus;
	model?: string;
	/** Tier as originally requested (used to re-resolve when no model was recorded). */
	tier?: string;
	step?: number;
	sessionFile?: string;
	exitCode: number;
	stopReason?: string;
	errorMessage?: string;
	usage: ManifestTaskUsage;
	finalOutput?: string;
	startedAt: number;
	finishedAt?: number;
}

export interface ManifestChainStep {
	agent?: string;
	task: string;
	cwd?: string;
	tier?: string;
	name?: string;
}

export interface ManifestV1 {
	version: number;
	jobId: string;
	parentSessionId: string;
	mode: "single" | "parallel" | "chain";
	createdAt: number;
	updatedAt: number;
	notifyOnComplete: boolean;
	/** Job status stays "running" while tasks are paused; pause is per-task. */
	status: ManifestJobStatus;
	errorMessage?: string;
	chainTotal?: number;
	chain?: ManifestChainStep[];
	tasks: ManifestTask[];
}

// ── Path derivation (pure) ───────────────────────────────────────────────────

export function jobDir(root: string, parentSessionId: string, jobId: string): string {
	return path.join(root, parentSessionId, jobId);
}
export function manifestPath(root: string, parentSessionId: string, jobId: string): string {
	return path.join(jobDir(root, parentSessionId, jobId), "manifest.json");
}
export function taskSessionDir(root: string, parentSessionId: string, jobId: string): string {
	return path.join(jobDir(root, parentSessionId, jobId), "tasks");
}

// ── Session file resolution ──────────────────────────────────────────────────

/** Find `<ts>_<taskId>.jsonl` in a directory listing (exact id after the underscore). */
export function matchSessionFile(entries: string[], taskId: string): string | undefined {
	const suffix = `_${taskId}.jsonl`;
	return entries.find((e) => e.endsWith(suffix));
}

export function resolveSessionFile(tasksDir: string, taskId: string): string | undefined {
	try {
		const hit = matchSessionFile(fs.readdirSync(tasksDir), taskId);
		return hit ? path.join(tasksDir, hit) : undefined;
	} catch {
		return undefined;
	}
}

// ── GC planning (pure) ───────────────────────────────────────────────────────

export function isJobExpired(updatedAtMs: number, nowMs: number, retentionDays: number): boolean {
	if (!(retentionDays > 0)) return false;
	return nowMs - updatedAtMs > retentionDays * 24 * 60 * 60 * 1000;
}

// ── Manifest I/O ─────────────────────────────────────────────────────────────

export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
	const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	await fs.promises.writeFile(tmp, JSON.stringify(value, null, "\t"), "utf-8");
	await fs.promises.rename(tmp, filePath);
}

function ensureDirs(root: string, parentSessionId: string, jobId: string): void {
	fs.mkdirSync(taskSessionDir(root, parentSessionId, jobId), { recursive: true });
}

export async function writeManifest(root: string, parentSessionId: string, manifest: ManifestV1): Promise<void> {
	ensureDirs(root, parentSessionId, manifest.jobId);
	await writeJsonAtomic(manifestPath(root, parentSessionId, manifest.jobId), manifest);
}

export function readManifest(root: string, parentSessionId: string, jobId: string): ManifestV1 | undefined {
	try {
		const parsed = JSON.parse(fs.readFileSync(manifestPath(root, parentSessionId, jobId), "utf-8"));
		return parsed && typeof parsed === "object" && parsed.version === MANIFEST_VERSION ? (parsed as ManifestV1) : undefined;
	} catch {
		return undefined;
	}
}

/** Read-modify-write a manifest; stamps `updatedAt`. No-op when the manifest is missing. */
export async function updateManifest(
	root: string,
	parentSessionId: string,
	jobId: string,
	mutate: (m: ManifestV1) => void,
): Promise<void> {
	const m = readManifest(root, parentSessionId, jobId);
	if (!m) return;
	mutate(m);
	m.updatedAt = Date.now();
	await writeManifest(root, parentSessionId, m);
}

/** Insert-or-replace a task entry by taskId (in place). */
export function upsertManifestTask(m: ManifestV1, task: ManifestTask): void {
	const i = m.tasks.findIndex((t) => t.taskId === task.taskId);
	if (i >= 0) m.tasks[i] = task;
	else m.tasks.push(task);
}

/** Map a registry-shaped task (structural subset) to a manifest entry. */
export function toManifestTask(input: {
	id: string;
	name?: string;
	agent: string;
	task: string;
	cwd: string;
	status: ManifestTaskStatus;
	model?: string;
	tier?: string;
	step?: number;
	sessionFile?: string;
	exitCode: number;
	stopReason?: string;
	errorMessage?: string;
	usage: ManifestTaskUsage;
	messages: Array<{ role: string; content: Array<{ type: string; text?: string }> }>;
	startedAt: number;
	finishedAt?: number;
}): ManifestTask {
	const raw = getFinalOutput(input.messages);
	return {
		taskId: input.id,
		name: input.name,
		agent: input.agent,
		task: input.task,
		cwd: input.cwd,
		status: input.status,
		model: input.model,
		tier: input.tier,
		step: input.step,
		sessionFile: input.sessionFile,
		exitCode: input.exitCode,
		stopReason: input.stopReason,
		errorMessage: input.errorMessage,
		usage: input.usage,
		finalOutput: raw ? truncateOutput(raw, FINAL_OUTPUT_CAP_BYTES) : undefined,
		startedAt: input.startedAt,
		finishedAt: input.finishedAt,
	};
}

export interface ListedJob {
	root: string;
	parentSessionId: string;
	jobId: string;
	manifest: ManifestV1;
	dir: string;
	mtimeMs: number;
}

/** Two-level scan of the store; unreadable dirs are skipped silently. */
export function listJobManifests(root: string): ListedJob[] {
	const out: ListedJob[] = [];
	let buckets: string[];
	try {
		buckets = fs.readdirSync(root);
	} catch {
		return out;
	}
	for (const psid of buckets) {
		let jobIds: string[];
		try {
			jobIds = fs.readdirSync(path.join(root, psid));
		} catch {
			continue;
		}
		for (const jobId of jobIds) {
			try {
				const dir = jobDir(root, psid, jobId);
				const m = readManifest(root, psid, jobId);
				if (!m) continue;
				out.push({ root, parentSessionId: psid, jobId, manifest: m, dir, mtimeMs: fs.statSync(dir).mtimeMs });
			} catch {
				continue;
			}
		}
	}
	return out;
}

export async function deletePath(dir: string): Promise<void> {
	await fs.promises.rm(dir, { recursive: true, force: true });
}

/** Remove parent-session buckets that contain no job dirs anymore. */
export async function pruneEmptyBuckets(root: string): Promise<void> {
	let buckets: string[];
	try {
		buckets = fs.readdirSync(root);
	} catch {
		return;
	}
	for (const b of buckets) {
		try {
			const p = path.join(root, b);
			if (fs.readdirSync(p).length === 0) await fs.promises.rmdir(p);
		} catch {
			/* ignore */
		}
	}
}

// ── Resumability (pure) ──────────────────────────────────────────────────────

const RESUMABLE_JOB_STATUSES: readonly string[] = ["running", "interrupted", "aborted"];

/**
 * A job is resumable when it is non-terminal, no task has failed, and there is
 * work left: a resumable task, or (chain mode) unstarted steps beyond the last
 * completed one.
 */
export function isResumableJob(m: ManifestV1): boolean {
	if (!RESUMABLE_JOB_STATUSES.includes(m.status)) return false;
	if (m.tasks.some((t) => t.status === "failed")) return false;
	if (m.tasks.some((t) => isResumableStatus(t.status))) return true;
	if (m.mode === "chain" && m.chain && m.chainTotal) {
		const highestCompleted = Math.max(0, ...m.tasks.filter((t) => t.status === "completed" && t.step).map((t) => t.step ?? 0));
		return highestCompleted < m.chainTotal;
	}
	return false;
}

export interface ResumePlan {
	/** Tasks to re-spawn on their existing session files. */
	respawnTasks: ManifestTask[];
	/** Chain steps to run fresh (never started). */
	freshChainSteps: ManifestChainStep[];
	/** 1-based step number of the first fresh chain step. */
	freshStartStep: number;
	/** finalOutput of the highest completed chain step (for `{previous}`). */
	previousOutput: string;
}

/**
 * Compute what a resume needs to do. Chain semantics: the lowest incomplete
 * step either resumes via its session (resumable status) or starts fresh; all
 * steps after it that never started run fresh; `{previous}` comes from the
 * highest completed step's finalOutput.
 */
export function resumePlan(m: ManifestV1): ResumePlan | undefined {
	if (!isResumableJob(m)) return undefined;
	const respawnTasks = m.tasks.filter((t) => isResumableStatus(t.status));
	const highestCompleted = Math.max(0, ...m.tasks.filter((t) => t.status === "completed" && t.step).map((t) => t.step ?? 0));
	const previousOutput =
		m.tasks.filter((t) => t.status === "completed" && t.step === highestCompleted).map((t) => t.finalOutput ?? "")[0] ?? "";
	if (m.mode !== "chain" || !m.chain) {
		return { respawnTasks, freshChainSteps: [], freshStartStep: 0, previousOutput };
	}
	const incomplete = m.tasks.filter((t) => t.status !== "completed").map((t) => t.step ?? highestCompleted + 1);
	const firstIncomplete = incomplete.length > 0 ? Math.min(...incomplete) : highestCompleted + 1;
	const firstTaskAt = m.tasks.find((t) => (t.step ?? 0) === firstIncomplete);
	const freshStartStep = firstTaskAt && isResumableStatus(firstTaskAt.status) ? firstIncomplete + 1 : firstIncomplete;
	return {
		respawnTasks,
		freshChainSteps: m.chain.slice(freshStartStep - 1),
		freshStartStep,
		previousOutput,
	};
}

// ── Listing merge (pure) ─────────────────────────────────────────────────────

/** Registry rows win over disk rows; both are kept otherwise. */
export function mergeJobListings<T extends { id: string }>(registry: T[], persisted: T[]): T[] {
	const registryIds = new Set(registry.map((r) => r.id));
	return [...registry, ...persisted.filter((r) => !registryIds.has(r.id))];
}
