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
	normalizeTierConfig,
	resolveAgent,
	type AgentSummary,
	type CatalogModel,
	type TierConfig,
} from "./core.ts";
import { killTask, spawnTask } from "./process.ts";
import {
	checkJobComplete,
	jobs,
	waitForTask,
	type Job,
	type JobMode,
	type ModelContext,
	type Task,
	type ToolDetails,
} from "./runtime.ts";

// ── Model tier context ───────────────────────────────────────────────────────

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
	};
	jobs.set(job.id, job);
	return job;
}

// ── Chain runner ─────────────────────────────────────────────────────────────

export function runChain(
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
