/**
 * Usage accounting shared by synchronous results and later job collection.
 * Claims are cumulative per task, so repeated job IDs and resumed collections
 * report only usage not already included in an earlier successful result.
 */

import { emptyUsage, getJobsRoot, getParentSessionId, type Task } from "./runtime.ts";
import { updateManifest, type ManifestTaskUsage } from "./store.ts";
import type { UsageStats } from "./core.ts";

let claimQueue: Promise<void> = Promise.resolve();

function delta(current: UsageStats, reported: UsageStats): UsageStats {
	return {
		input: Math.max(0, current.input - reported.input),
		output: Math.max(0, current.output - reported.output),
		cacheRead: Math.max(0, current.cacheRead - reported.cacheRead),
		cacheWrite: Math.max(0, current.cacheWrite - reported.cacheWrite),
		cost: Math.max(0, current.cost - reported.cost),
		contextTokens: Math.max(0, current.contextTokens - reported.contextTokens),
		turns: Math.max(0, current.turns - reported.turns),
	};
}

function usageCopy(value: UsageStats): UsageStats {
	return { ...value };
}

function maxUsage(left: UsageStats, right: UsageStats): UsageStats {
	return {
		input: Math.max(left.input, right.input),
		output: Math.max(left.output, right.output),
		cacheRead: Math.max(left.cacheRead, right.cacheRead),
		cacheWrite: Math.max(left.cacheWrite, right.cacheWrite),
		cost: Math.max(left.cost, right.cost),
		contextTokens: Math.max(left.contextTokens, right.contextTokens),
		turns: Math.max(left.turns, right.turns),
	};
}

function asManifestUsage(value: UsageStats): ManifestTaskUsage {
	return usageCopy(value);
}

function usageResult(sum: UsageStats) {
	return {
		input: sum.input,
		output: sum.output,
		cacheRead: sum.cacheRead,
		cacheWrite: sum.cacheWrite,
		totalTokens: sum.input + sum.output + sum.cacheRead + sum.cacheWrite,
		// Child events expose total cost, not the provider's per-category split.
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: sum.cost },
	};
}

async function claim(tasks: Task[]) {
	const unique = new Map<string, Task>();
	for (const task of tasks) unique.set(`${task.jobId}\0${task.id}`, task);
	// Capture usage synchronously before any manifest I/O. A child may continue
	// producing events while a claim waits for the durable manifest lock.
	const snapshots = new Map([...unique.values()].map((task) => [task, usageCopy(task.usage)]));
	const sum = emptyUsage();
	const root = getJobsRoot();
	const parentSessionId = getParentSessionId();
	const byJob = new Map<string, Task[]>();
	for (const task of unique.values()) {
		const group = byJob.get(task.jobId) ?? [];
		group.push(task);
		byJob.set(task.jobId, group);
	}

	for (const [jobId, jobTasks] of byJob) {
		let persistedIds = new Set<string>();
		if (root && parentSessionId) {
			try {
				await updateManifest(root, parentSessionId, jobId, (manifest) => {
					for (const task of jobTasks) {
						const record = manifest.tasks.find((entry) => entry.taskId === task.id);
						if (!record) continue;
						const snapshot = snapshots.get(task)!;
						const reported = record.reportedUsage ?? task.usageReported ?? emptyUsage();
						const increment = delta(snapshot, reported);
						for (const key of Object.keys(sum) as Array<keyof UsageStats>) sum[key] += increment[key];
						record.usage = asManifestUsage(maxUsage(record.usage, snapshot));
						record.reportedUsage = asManifestUsage(maxUsage(reported, snapshot));
						persistedIds.add(task.id);
					}
				});
			} catch {
				// Persistence is best-effort, matching the job store's lifecycle policy.
			}
		}
		for (const task of jobTasks) {
			if (persistedIds.has(task.id)) {
				const reported = task.usageReported ?? emptyUsage();
				task.usageReported = maxUsage(reported, snapshots.get(task)!);
				continue;
			}
			const snapshot = snapshots.get(task)!;
			const reported = task.usageReported ?? emptyUsage();
			const increment = delta(snapshot, reported);
			for (const key of Object.keys(sum) as Array<keyof UsageStats>) sum[key] += increment[key];
			task.usageReported = usageCopy(snapshot);
		}
	}

	return usageResult(sum);
}

/** Atomically claim cumulative usage directly from persisted manifests (disk-only wait). */
async function claimPersisted(jobIds: string[]) {
	const sum = emptyUsage();
	const root = getJobsRoot();
	const parentSessionId = getParentSessionId();
	if (!root || !parentSessionId) return usageResult(sum);
	for (const jobId of new Set(jobIds)) {
		try {
			await updateManifest(root, parentSessionId, jobId, (manifest) => {
				for (const task of manifest.tasks) {
					const reported = task.reportedUsage ?? emptyUsage();
					const current = task.usage;
					const increment = delta(current, reported);
					for (const key of Object.keys(sum) as Array<keyof UsageStats>) sum[key] += increment[key];
					task.reportedUsage = asManifestUsage(maxUsage(reported, current));
				}
			});
		} catch {
			// A failed durable claim must not turn a wait result into a tool error.
		}
	}
	return usageResult(sum);
}

/** Mark usage reported only when the caller is returning a successful result. */
export function reportTaskUsage(tasks: Task[]) {
	const result = claimQueue.then(() => claim(tasks));
	claimQueue = result.then(() => undefined, () => undefined);
	return result;
}

/** Claim persisted usage for jobs that have not been materialized in this process. */
export function reportPersistedTaskUsage(jobIds: string[]) {
	const result = claimQueue.then(() => claimPersisted(jobIds));
	claimQueue = result.then(() => undefined, () => undefined);
	return result;
}
