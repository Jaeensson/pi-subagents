/**
 * process.ts — Child pi process lifecycle for subagent tasks.
 *
 * Owns everything around spawning and tearing down a child `pi --mode json`
 * process: CLI invocation discovery, temp system-prompt files, stdout event
 * streaming, and kill/finalize bookkeeping against the runtime registry.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import {
	applyEventLine,
	buildChildArgs,
	getFinalOutput,
	resolveContextWindow,
	resolveModel,
	type AgentSummary,
} from "./core.ts";
import { applyLiveEvent, emptyLiveTrace } from "./live.ts";
import {
	checkJobComplete,
	decRunningCount,
	emptyUsage,
	fireWaiters,
	incRunningCount,
	jobDetails,
	jobs,
	taskWaiters,
	tasks,
	waitForJob,
	type ModelContext,
	type Task,
} from "./runtime.ts";
import { updateStatusWidget } from "./tui.ts";

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
	decRunningCount();
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
	options: { step?: number; tier?: string; modelCtx: ModelContext },
): Promise<Task> {
	const resolution = resolveModel({
		callTier: options.tier,
		agentTier: agent.tier,
		tierConfig: options.modelCtx.tierConfig,
		defaultModel: options.modelCtx.defaultModel,
		catalog: options.modelCtx.catalog,
	});
	const contextWindow = resolveContextWindow(
		resolution.model ?? options.modelCtx.defaultModel,
		options.modelCtx.catalog,
	);
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
		live: emptyLiveTrace(),
		stderr: "",
		usage: emptyUsage(),
		model: resolution.model,
		contextWindow,
		tierUsed: resolution.tierUsed,
		tierNote: resolution.note,
		step: options.step,
	};
	tasks.set(task.id, task);
	const job = jobs.get(jobId);
	if (job) job.pendingSpawns++;
	if (job) job.tasks.push(task);
	incRunningCount();
	updateStatusWidget();

	try {
		let systemPromptFile: string | undefined;
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			task.tmpDir = tmp.dir;
			task.tmpPath = tmp.filePath;
			systemPromptFile = tmp.filePath;
		}

		const args = buildChildArgs({
			model: resolution.model,
			tools: agent.tools,
			extensions: agent.extensions,
			systemPromptFile,
			task: taskText,
		});
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
				task.live = applyLiveEvent(line, task.live);
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

/** Wait for a job to finish; on abort/timeout, kill still-running tasks and wait again. */
export async function waitForJobOrKill(jobId: string, signal?: AbortSignal, timeoutMs?: number): Promise<boolean> {
	const completed = await waitForJob(jobId, { signal, timeoutMs });
	if (completed) return true;
	const job = jobs.get(jobId);
	if (!job) return true;
	for (const t of job.tasks) if (t.status === "running") killTask(t);
	await waitForJob(jobId, {});
	return false;
}
