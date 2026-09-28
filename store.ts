/**
 * store.ts — Durable job store for subagent tasks.
 *
 * Owns the on-disk layout ~/<agentDir>/subagent-jobs/<parentSessionId>/<jobId>/
 * and serialized manifest transactions. No pi-package imports: all filesystem
 * behavior is testable with `node --test`.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { getFinalOutput, isResumableStatus } from "./core.ts";
import { boundOutput } from "./output.ts";

export const MANIFEST_VERSION = 1;
const FINAL_OUTPUT_CAP_BYTES = 50 * 1024;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const LOCK_RETRY_MS = 15;
const LOCK_TIMEOUT_MS = 30_000;
const LOCK_STALE_MS = 60_000;

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
	dispatchState?: "queued" | "running" | "paused" | "terminal";
	model?: string;
	tier?: string;
	step?: number;
	sessionFile?: string;
	exitCode: number;
	stopReason?: string;
	errorMessage?: string;
	usage: ManifestTaskUsage;
	/** Cumulative usage already included in a successful parent tool result. */
	reportedUsage?: ManifestTaskUsage;
	finalOutput?: string;
	outputPath?: string;
	outputBytes?: number;
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

export interface ManifestOwner {
	pid: number;
	host: string;
}

export interface ManifestV1 {
	version: number;
	jobId: string;
	parentSessionId: string;
	mode: "single" | "parallel" | "chain";
	createdAt: number;
	updatedAt: number;
	notifyOnComplete: boolean;
	status: ManifestJobStatus;
	errorMessage?: string;
	chainTotal?: number;
	chain?: ManifestChainStep[];
	tasks: ManifestTask[];
	/** PID/host that currently owns this job. Missing on older manifests. */
	owner?: ManifestOwner;
}

export function isSafeStoreId(id: unknown): id is string {
	return typeof id === "string" && ID_PATTERN.test(id) && id !== "." && id !== "..";
}

function isRecord(value: unknown): value is Record<string, any> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
function isOptionalString(value: unknown): boolean {
	return value === undefined || typeof value === "string";
}
function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

/** Strict shape validation before any stored values are used by lifecycle code. */
export function validateManifest(value: unknown, expected?: { parentSessionId: string; jobId: string; tasksDir?: string }): value is ManifestV1 {
	if (!isRecord(value) || value.version !== MANIFEST_VERSION) return false;
	if (!isSafeStoreId(value.jobId) || !isSafeStoreId(value.parentSessionId)) return false;
	if (expected && (value.jobId !== expected.jobId || value.parentSessionId !== expected.parentSessionId)) return false;
	if (!["single", "parallel", "chain"].includes(value.mode)) return false;
	if (!["running", "completed", "failed", "aborted", "interrupted"].includes(value.status)) return false;
	if (!isFiniteNumber(value.createdAt) || !isFiniteNumber(value.updatedAt) || typeof value.notifyOnComplete !== "boolean") return false;
	if (!Array.isArray(value.tasks)) return false;
	if (value.errorMessage !== undefined && typeof value.errorMessage !== "string") return false;
	if (value.chainTotal !== undefined && (!Number.isInteger(value.chainTotal) || value.chainTotal < 1)) return false;
	if (value.chain !== undefined && (!Array.isArray(value.chain) || !value.chain.every((s: unknown) =>
		isRecord(s) && typeof s.task === "string" && isOptionalString(s.agent) && isOptionalString(s.cwd) && isOptionalString(s.tier) && isOptionalString(s.name)))) return false;
	if (value.owner !== undefined && (!isRecord(value.owner) || !Number.isInteger(value.owner.pid) || value.owner.pid < 1 || typeof value.owner.host !== "string" || value.owner.host.length === 0)) return false;
	const taskIds = new Set<string>();
	for (const t of value.tasks) {
		if (!isRecord(t) || !isSafeStoreId(t.taskId) || taskIds.has(t.taskId)) return false;
		taskIds.add(t.taskId);
		if (typeof t.agent !== "string" || typeof t.task !== "string" || typeof t.cwd !== "string") return false;
		if (!["running", "completed", "failed", "aborted", "paused", "interrupted"].includes(t.status)) return false;
		if (!isFiniteNumber(t.exitCode) || !isFiniteNumber(t.startedAt) || (t.finishedAt !== undefined && !isFiniteNumber(t.finishedAt))) return false;
		if (!isOptionalString(t.name) || !isOptionalString(t.model) || !isOptionalString(t.tier) || !isOptionalString(t.stopReason) || !isOptionalString(t.errorMessage) || !isOptionalString(t.finalOutput) || !isOptionalString(t.outputPath)) return false;
		if (t.outputBytes !== undefined && (!isFiniteNumber(t.outputBytes) || t.outputBytes < 0)) return false;
		if (t.outputPath !== undefined) {
			if (!path.isAbsolute(t.outputPath) || path.basename(t.outputPath) !== `${t.taskId}-output.txt` ||
				(expected?.tasksDir && path.resolve(path.dirname(t.outputPath)) !== path.resolve(expected.tasksDir))) return false;
		}
		if (t.dispatchState !== undefined && !["queued", "running", "paused", "terminal"].includes(t.dispatchState)) return false;
		if (t.step !== undefined && (!Number.isInteger(t.step) || t.step < 1)) return false;
		if (t.sessionFile !== undefined) {
			if (typeof t.sessionFile !== "string" || !path.isAbsolute(t.sessionFile) || !path.basename(t.sessionFile).endsWith(`_${t.taskId}.jsonl`)) return false;
			if (expected?.tasksDir && path.resolve(path.dirname(t.sessionFile)) !== path.resolve(expected.tasksDir)) return false;
		}
		if (!isRecord(t.usage) || !["input", "output", "cacheRead", "cacheWrite", "cost", "contextTokens", "turns"].every((k) => isFiniteNumber(t.usage[k]))) return false;
		if (t.reportedUsage !== undefined && (!isRecord(t.reportedUsage) || !["input", "output", "cacheRead", "cacheWrite", "cost", "contextTokens", "turns"].every((k) => isFiniteNumber(t.reportedUsage[k])))) return false;
	}
	return true;
}

// ── Path derivation ──────────────────────────────────────────────────────────

function assertStoreIds(parentSessionId: string, jobId: string): void {
	if (!isSafeStoreId(parentSessionId) || !isSafeStoreId(jobId)) throw new Error("Invalid subagent store identifier");
}
export function jobDir(root: string, parentSessionId: string, jobId: string): string {
	assertStoreIds(parentSessionId, jobId);
	return path.join(root, parentSessionId, jobId);
}
export function manifestPath(root: string, parentSessionId: string, jobId: string): string {
	return path.join(jobDir(root, parentSessionId, jobId), "manifest.json");
}
export function taskSessionDir(root: string, parentSessionId: string, jobId: string): string {
	return path.join(jobDir(root, parentSessionId, jobId), "tasks");
}

// ── Session file resolution ──────────────────────────────────────────────────

export function matchSessionFile(entries: string[], taskId: string): string | undefined {
	if (!isSafeStoreId(taskId)) return undefined;
	const suffix = `_${taskId}.jsonl`;
	return entries.find((e) => e.endsWith(suffix) && path.basename(e) === e);
}
export function resolveSessionFile(tasksDir: string, taskId: string): string | undefined {
	try {
		const hit = matchSessionFile(fs.readdirSync(tasksDir), taskId);
		return hit ? path.join(tasksDir, hit) : undefined;
	} catch {
		return undefined;
	}
}

// ── GC planning ──────────────────────────────────────────────────────────────

export function isJobExpired(updatedAtMs: number, nowMs: number, retentionDays: number): boolean {
	if (!(retentionDays > 0)) return false;
	return nowMs - updatedAtMs > retentionDays * 24 * 60 * 60 * 1000;
}

// ── Serialized manifest I/O ──────────────────────────────────────────────────

// Lock files coordinate separate processes, but filesystem lock acquisition is
// not FIFO within this process. Queue complete transactions before they start
// acquiring the lock, especially so updates cannot overtake initial creation.
const manifestQueues = new Map<string, Promise<void>>();

function withManifestQueue<T>(filePath: string, transaction: () => Promise<T>): Promise<T> {
	const previous = manifestQueues.get(filePath) ?? Promise.resolve();
	const result = previous.then(transaction);
	const tail = result.then(() => undefined, () => undefined);
	manifestQueues.set(filePath, tail);
	return result.finally(() => {
		if (manifestQueues.get(filePath) === tail) manifestQueues.delete(filePath);
	});
}

function lockPath(filePath: string): string { return `${filePath}.lock`; }

async function acquireManifestLock(filePath: string): Promise<() => Promise<void>> {
	const lock = lockPath(filePath);
	const started = Date.now();
	while (true) {
		try {
			const handle = await fs.promises.open(lock, "wx", 0o600);
			try {
				await handle.writeFile(JSON.stringify({ pid: process.pid, host: os.hostname(), createdAt: Date.now() }));
			} catch (err) {
				await handle.close().catch(() => {});
				await fs.promises.unlink(lock).catch(() => {});
				throw err;
			}
			await handle.close();
			return async () => { await fs.promises.unlink(lock).catch(() => {}); };
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
			try {
				const stat = await fs.promises.stat(lock);
				if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
					let owner: unknown;
					try { owner = JSON.parse(await fs.promises.readFile(lock, "utf8")); } catch { owner = undefined; }
					const stale = isRecord(owner) && owner.host === os.hostname() && Number.isInteger(owner.pid)
						? !isProcessAlive(owner.pid)
						: !owner;
					if (stale) await fs.promises.unlink(lock).catch(() => {});
				}
			} catch (statErr) {
				if ((statErr as NodeJS.ErrnoException).code !== "ENOENT") throw statErr;
			}
			if (Date.now() - started >= LOCK_TIMEOUT_MS) throw new Error(`Timed out waiting for manifest lock: ${filePath}`);
			await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS + Math.floor(Math.random() * LOCK_RETRY_MS)));
		}
	}
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
	const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
	try {
		await fs.promises.writeFile(tmp, JSON.stringify(value, null, "\t"), { encoding: "utf-8", mode: 0o600, flag: "wx" });
		await fs.promises.rename(tmp, filePath);
	} catch (err) {
		await fs.promises.unlink(tmp).catch(() => {});
		throw err;
	}
}

function ensureDirs(root: string, parentSessionId: string, jobId: string): void {
	fs.mkdirSync(taskSessionDir(root, parentSessionId, jobId), { recursive: true, mode: 0o700 });
}
function readManifestAt(filePath: string, root: string, parentSessionId: string, jobId: string): ManifestV1 | undefined {
	try {
		if (!fs.lstatSync(filePath).isFile()) return undefined;
		const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf-8"));
		return validateManifest(parsed, { parentSessionId, jobId, tasksDir: taskSessionDir(root, parentSessionId, jobId) }) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/** Write an initial/full manifest under the same per-manifest transaction lock. */
export async function writeManifest(root: string, parentSessionId: string, manifest: ManifestV1): Promise<void> {
	assertStoreIds(parentSessionId, manifest.jobId);
	if (!validateManifest(manifest, { parentSessionId, jobId: manifest.jobId, tasksDir: taskSessionDir(root, parentSessionId, manifest.jobId) }))
		throw new Error("Refusing to write an invalid subagent manifest");
	const filePath = manifestPath(root, parentSessionId, manifest.jobId);
	return withManifestQueue(filePath, async () => {
		ensureDirs(root, parentSessionId, manifest.jobId);
		const unlock = await acquireManifestLock(filePath);
		try { await writeJsonAtomic(filePath, manifest); } finally { await unlock(); }
	});
}

export function readManifest(root: string, parentSessionId: string, jobId: string): ManifestV1 | undefined {
	try {
		assertStoreIds(parentSessionId, jobId);
		return readManifestAt(manifestPath(root, parentSessionId, jobId), root, parentSessionId, jobId);
	} catch { return undefined; }
}

/** Whole read-modify-write transaction, serialized across concurrent processes. */
export async function updateManifest(
	root: string,
	parentSessionId: string,
	jobId: string,
	mutate: (m: ManifestV1) => void,
): Promise<void> {
	assertStoreIds(parentSessionId, jobId);
	const filePath = manifestPath(root, parentSessionId, jobId);
	return withManifestQueue(filePath, async () => {
		if (!fs.existsSync(path.dirname(filePath))) return;
		const unlock = await acquireManifestLock(filePath);
		try {
			const m = readManifestAt(filePath, root, parentSessionId, jobId);
			if (!m) return;
			mutate(m);
			m.updatedAt = Date.now();
			if (!validateManifest(m, { parentSessionId, jobId, tasksDir: taskSessionDir(root, parentSessionId, jobId) }))
				throw new Error("Manifest transaction produced an invalid subagent manifest");
			ensureDirs(root, parentSessionId, jobId);
			await writeJsonAtomic(filePath, m);
		} finally { await unlock(); }
	});
}

export function upsertManifestTask(m: ManifestV1, task: ManifestTask): void {
	const i = m.tasks.findIndex((t) => t.taskId === task.taskId);
	if (i >= 0) {
		// Ordinary lifecycle snapshots must not erase the usage-claim ledger.
		if (task.reportedUsage === undefined) task.reportedUsage = m.tasks[i].reportedUsage;
		m.tasks[i] = task;
	} else m.tasks.push(task);
}

export function toManifestTask(input: {
	id: string; name?: string; agent: string; task: string; cwd: string; status: ManifestTaskStatus;
	model?: string; tier?: string; requestedTier?: string; step?: number; dispatchState?: ManifestTask["dispatchState"]; sessionFile?: string; exitCode: number;
	stopReason?: string; errorMessage?: string; outputPath?: string; outputBytes?: number; usage: ManifestTaskUsage;
	messages: Array<{ role: string; content: Array<{ type: string; text?: string }> }>;
	startedAt: number; finishedAt?: number;
}): ManifestTask {
	const raw = getFinalOutput(input.messages);
	return {
		taskId: input.id, name: input.name, agent: input.agent, task: input.task, cwd: input.cwd, status: input.status,
		model: input.model, tier: input.tier ?? input.requestedTier, step: input.step, dispatchState: input.dispatchState, sessionFile: input.sessionFile,
		exitCode: input.exitCode, stopReason: input.stopReason, errorMessage: input.errorMessage, usage: input.usage,
		outputPath: input.outputPath, outputBytes: input.outputBytes,
		finalOutput: raw ? boundOutput(raw, { maxBytes: FINAL_OUTPUT_CAP_BYTES, artifactPath: input.outputPath }) : undefined,
		startedAt: input.startedAt, finishedAt: input.finishedAt,
	};
}

export interface ListedJob {
	root: string; parentSessionId: string; jobId: string; manifest: ManifestV1; dir: string; mtimeMs: number;
}

/** Two-level scan; invalid identifiers, symlinks, and malformed manifests are skipped. */
export function listJobManifests(root: string): ListedJob[] {
	const out: ListedJob[] = [];
	let buckets: fs.Dirent[];
	try { buckets = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
	for (const bucket of buckets) {
		const psid = bucket.name;
		if (!bucket.isDirectory() || !isSafeStoreId(psid)) continue;
		let jobs: fs.Dirent[];
		try { jobs = fs.readdirSync(path.join(root, psid), { withFileTypes: true }); } catch { continue; }
		for (const entry of jobs) {
			const jobId = entry.name;
			if (!entry.isDirectory() || !isSafeStoreId(jobId)) continue;
			try {
				const dir = jobDir(root, psid, jobId);
				const m = readManifest(root, psid, jobId);
				if (m) out.push({ root, parentSessionId: psid, jobId, manifest: m, dir, mtimeMs: fs.statSync(dir).mtimeMs });
			} catch { /* malformed or inaccessible entry */ }
		}
	}
	return out;
}

export async function deletePath(dir: string): Promise<void> { await fs.promises.rm(dir, { recursive: true, force: true }); }

/** Re-check retention and ownership under the same lock used by resume claims. */
export async function deleteExpiredJob(
	root: string,
	parentSessionId: string,
	jobId: string,
	nowMs: number,
	retentionDays: number,
): Promise<boolean> {
	assertStoreIds(parentSessionId, jobId);
	const dir = jobDir(root, parentSessionId, jobId);
	const filePath = manifestPath(root, parentSessionId, jobId);
	return withManifestQueue(filePath, async () => {
		if (!fs.existsSync(dir)) return false;
		const unlock = await acquireManifestLock(filePath);
		try {
			const manifest = readManifestAt(filePath, root, parentSessionId, jobId);
			if (!manifest) return false;
			const active = manifest.status === "running" && isManifestOwnerLive(manifest.owner);
			if (active || !isJobExpired(manifest.updatedAt, nowMs, retentionDays)) return false;
			await fs.promises.rm(dir, { recursive: true, force: true });
			return true;
		} finally { await unlock(); }
	});
}

export async function pruneEmptyBuckets(root: string): Promise<void> {
	let buckets: fs.Dirent[];
	try { buckets = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
	for (const b of buckets) {
		if (!b.isDirectory() || !isSafeStoreId(b.name)) continue;
		try { const p = path.join(root, b.name); if (fs.readdirSync(p).length === 0) await fs.promises.rmdir(p); } catch { /* ignore */ }
	}
}

// ── Ownership and recovery ───────────────────────────────────────────────────

function isProcessAlive(pid: number): boolean {
	try { process.kill(pid, 0); return true; }
	catch (err) { return (err as NodeJS.ErrnoException).code === "EPERM"; }
}
export function isManifestOwnerLive(owner: ManifestOwner | undefined): boolean {
	if (!owner) return false;
	// A remote owner cannot be probed safely; prefer retaining its work.
	return owner.host !== os.hostname() || isProcessAlive(owner.pid);
}
export function currentManifestOwner(): ManifestOwner { return { pid: process.pid, host: os.hostname() }; }

/**
 * Normalize a dead owner's running job to interrupted and locate any child
 * transcripts using task IDs, all in one locked transaction. Live owners are
 * left untouched so concurrent Pi processes cannot recover each other's work.
 */
export async function reconcileManifest(root: string, parentSessionId: string, jobId: string): Promise<ManifestV1 | undefined> {
	assertStoreIds(parentSessionId, jobId);
	const filePath = manifestPath(root, parentSessionId, jobId);
	return withManifestQueue(filePath, async () => {
		const unlock = await acquireManifestLock(filePath);
		try {
			const m = readManifestAt(filePath, root, parentSessionId, jobId);
			if (!m || isManifestOwnerLive(m.owner)) return m;
			let changed = false;
			const tasksDir = taskSessionDir(root, parentSessionId, jobId);
			for (const task of m.tasks) {
				if (!task.sessionFile) {
					const found = resolveSessionFile(tasksDir, task.taskId);
					if (found) { task.sessionFile = found; changed = true; }
				}
				if (task.status === "running") {
					task.status = "interrupted";
					task.finishedAt = Date.now();
					changed = true;
				}
			}
			if (m.status === "running") { m.status = "interrupted"; changed = true; }
			if (changed) {
				m.updatedAt = Date.now();
				if (!validateManifest(m, { parentSessionId, jobId, tasksDir })) throw new Error("Recovery produced invalid manifest");
				await writeJsonAtomic(filePath, m);
			}
			return m;
		} finally { await unlock(); }
	});
}

/** Atomically take ownership before rebuilding/resuming a persisted job. */
export async function claimManifest(root: string, parentSessionId: string, jobId: string): Promise<ManifestV1 | undefined> {
	assertStoreIds(parentSessionId, jobId);
	const filePath = manifestPath(root, parentSessionId, jobId);
	return withManifestQueue(filePath, async () => {
		const unlock = await acquireManifestLock(filePath);
		try {
			const m = readManifestAt(filePath, root, parentSessionId, jobId);
			const owner = m?.owner;
			const alreadyOwnedHere = owner?.pid === process.pid && owner.host === os.hostname();
			if (!m || (isManifestOwnerLive(owner) && !alreadyOwnedHere)) return undefined;
			m.owner = currentManifestOwner();
			m.updatedAt = Date.now();
			await writeJsonAtomic(filePath, m);
			return m;
		} finally { await unlock(); }
	});
}

// ── Resumability ──────────────────────────────────────────────────────────────

const RESUMABLE_JOB_STATUSES: readonly string[] = ["running", "interrupted", "aborted"];
export interface ResumabilityView { status: string; mode: string; chain?: unknown; chainTotal?: number; tasks: Array<{ status: string; step?: number }>; }
export function isResumableJobView(v: ResumabilityView): boolean {
	if (!RESUMABLE_JOB_STATUSES.includes(v.status)) return false;
	if (v.tasks.some((t) => t.status === "failed")) return false;
	if (v.tasks.some((t) => isResumableStatus(t.status))) return true;
	if (v.mode === "chain" && v.chain && v.chainTotal) {
		const highestCompleted = Math.max(0, ...v.tasks.filter((t) => t.status === "completed" && t.step).map((t) => t.step ?? 0));
		return highestCompleted < v.chainTotal;
	}
	return false;
}
export function isResumableJob(m: ManifestV1): boolean { return isResumableJobView(m); }

export interface ResumePlan { respawnTasks: ManifestTask[]; freshChainSteps: ManifestChainStep[]; freshStartStep: number; previousOutput: string; }
export function resumePlan(m: ManifestV1): ResumePlan | undefined {
	if (!isResumableJob(m)) return undefined;
	const respawnTasks = m.tasks.filter((t) => isResumableStatus(t.status) || t.dispatchState === "queued");
	const highestCompleted = Math.max(0, ...m.tasks.filter((t) => t.status === "completed" && t.step).map((t) => t.step ?? 0));
	const previousOutput = m.tasks.filter((t) => t.status === "completed" && t.step === highestCompleted).map((t) => t.finalOutput ?? "")[0] ?? "";
	if (m.mode !== "chain" || !m.chain) return { respawnTasks, freshChainSteps: [], freshStartStep: 0, previousOutput };
	const incomplete = m.tasks.filter((t) => t.status !== "completed").map((t) => t.step ?? highestCompleted + 1);
	const firstIncomplete = incomplete.length > 0 ? Math.min(...incomplete) : highestCompleted + 1;
	const firstTaskAt = m.tasks.find((t) => (t.step ?? 0) === firstIncomplete);
	const freshStartStep = firstTaskAt && isResumableStatus(firstTaskAt.status) ? firstIncomplete + 1 : firstIncomplete;
	return { respawnTasks, freshChainSteps: m.chain.slice(freshStartStep - 1), freshStartStep, previousOutput };
}

// ── Listing merge ────────────────────────────────────────────────────────────

export function mergeJobListings<T extends { id: string }>(registry: T[], persisted: T[]): T[] {
	const registryIds = new Set(registry.map((r) => r.id));
	return [...registry, ...persisted.filter((r) => !registryIds.has(r.id))];
}
