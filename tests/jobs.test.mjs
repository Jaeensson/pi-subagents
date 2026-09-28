import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { collectResultText, persistChainSteps, resumeJob, runChainFrom } from "../jobs.ts";
import { pauseJobTasks } from "../process.ts";
import { writeOutputArtifact } from "../output.ts";
import { clearRegistry, jobs, setJobsRoot, setParentSessionId, waitForJob, waitForTask } from "../runtime.ts";
import { readManifest, writeManifest } from "../store.ts";

const parentSessionId = "chain-parent";
const jobId = "chain-resume-job";
const agent = { name: "worker", source: "user", systemPrompt: "", tools: [], extensions: [] };
const modelCtx = { catalog: [] };
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };

function cleanup() {
	clearRegistry();
	setJobsRoot(undefined);
	setParentSessionId(undefined);
}

function makeFixture() {
	cleanup();
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-chain-resume-test-"));
	setJobsRoot(root);
	setParentSessionId(parentSessionId);
	const taskDir = path.join(root, parentSessionId, jobId, "tasks");
	fs.mkdirSync(taskDir, { recursive: true });
	const sessionFile = path.join(taskDir, "20260101_000000_step-two.jsonl");
	fs.writeFileSync(sessionFile, "{}\n");
	const manifest = {
		version: 1,
		jobId,
		parentSessionId,
		mode: "chain",
		createdAt: 1,
		updatedAt: 1,
		notifyOnComplete: false,
		status: "interrupted",
		chainTotal: 3,
		chain: [
			{ agent: "worker", task: "first", cwd: "/effective/default" },
			{ agent: "worker", task: "second based on {previous}", cwd: "/effective/default" },
			{ agent: "worker", task: "third based on {previous}", cwd: "/effective/default" },
		],
		tasks: [
			{
				taskId: "step-one", agent: "worker", task: "first", cwd: "/effective/default", status: "completed",
				dispatchState: "terminal", step: 1, exitCode: 0, usage, finalOutput: "old output",
				startedAt: 1, finishedAt: 2,
			},
			{
				taskId: "step-two", agent: "worker", task: "second based on old output", cwd: "/effective/default", status: "paused",
				dispatchState: "paused", step: 2, sessionFile, exitCode: 143, usage,
				startedAt: 2, finishedAt: 3,
			},
		],
	};
	return { root, manifest, sessionFile };
}

function makeFakeSpawner(children) {
	return (_command, args, options) => {
		const proc = new EventEmitter();
		proc.stdout = new EventEmitter();
		proc.stderr = new EventEmitter();
		proc.exitCode = null;
		proc.signalCode = null;
		proc.kill = (signal) => {
			proc.signalCode = signal;
			proc.exitCode = signal === "SIGTERM" ? 143 : 137;
			queueMicrotask(() => proc.emit("close", proc.exitCode, signal));
			return true;
		};
		const sessionIdIndex = args.indexOf("--session-id");
		const resumedFileIndex = args.indexOf("--session");
		const taskId = sessionIdIndex >= 0
			? args[sessionIdIndex + 1]
			: path.basename(args[resumedFileIndex + 1]).match(/_([^_]+)\.jsonl$/)?.[1];
		const child = { proc, args, options, taskId };
		children.push(child);
		return proc;
	};
}

function finishChild(child, text, code = 0) {
	child.proc.exitCode = code;
	if (text !== undefined) {
		child.proc.stdout.emit("data", Buffer.from(`${JSON.stringify({
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text }] },
		})}\n`));
	}
	child.proc.emit("close", code, null);
}

async function until(predicate) {
	for (let i = 0; i < 200; i++) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	assert.fail("timed out waiting for asynchronous job state");
}

test("truncated multi-task collection points to a combined report containing every task artifact", () => {
	cleanup();
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-collect-report-test-"));
	const jobId = "combined-report-job";
	const taskRows = [];
	try {
		for (let index = 0; index < 2; index++) {
			const id = `combined-task-${index + 1}`;
			const outputPath = path.join(root, `${id}-output.txt`);
			fs.writeFileSync(outputPath, `${id} full artifact`);
			taskRows.push({
				id, jobId, agent: "worker", agentSource: "test", task: `task ${index + 1}`, cwd: "/tmp",
				status: "completed", startedAt: index + 1, exitCode: 0,
				messages: [{ role: "assistant", content: [{ type: "text", text: `${String(index + 1).repeat(30_000)} output` }] }],
				live: { segments: [] }, stderr: "", usage,
				outputPath, outputBytes: 30_000,
			});
		}
		jobs.set(jobId, { id: jobId, mode: "parallel", status: "completed", finished: true, tasks: taskRows });
		const { text } = collectResultText([jobId]);
		const reportPath = text.slice(text.lastIndexOf("Full output: ") + "Full output: ".length).split("]")[0];
		assert.ok(reportPath, "truncation note points to a full combined report artifact");
		const report = fs.readFileSync(reportPath, "utf8");
		assert.ok(report.includes(`${path.join(root, "combined-task-1-output.txt")}`));
		assert.ok(report.includes(`${path.join(root, "combined-task-2-output.txt")}`));
		assert.ok(text.includes(reportPath));
		fs.rmSync(path.dirname(reportPath), { recursive: true, force: true });
	} finally {
		jobs.delete(jobId);
		fs.rmSync(root, { recursive: true, force: true });
		cleanup();
	}
});

test("persistChainSteps freezes each effective cwd into the durable chain", () => {
	assert.deepEqual(persistChainSteps([
		{ agent: "worker", task: "default cwd" },
		{ agent: "worker", task: "explicit cwd", cwd: "/step/cwd" },
	], "/call/cwd"), [
		{ agent: "worker", task: "default cwd", cwd: "/call/cwd" },
		{ agent: "worker", task: "explicit cwd", cwd: "/step/cwd" },
	]);
});

function resumeOptions(spawnProcess, overrides = {}) {
	return {
		agents: [agent], defaultCwd: "/effective/default", modelCtx, wait: false,
		notifyOnComplete: true, spawnProcess, ...overrides,
	};
}

test("three-step chain pauses and resumes the same step repeatedly, then advances with fresh output", async () => {
	const { root, manifest, sessionFile } = makeFixture();
	const children = [];
	const spawnProcess = makeFakeSpawner(children);
	try {
		await writeManifest(root, parentSessionId, manifest);
		const first = await resumeJob(jobId, resumeOptions(spawnProcess));
		assert.equal(first.error, undefined);
		await until(() => children.length === 1);
		const job = first.job;
		assert.ok(job);
		const jobWaiter = waitForJob(jobId);
		const taskWaiter = waitForTask("step-two");

		pauseJobTasks(job);
		await until(() => {
			const task = job.tasks.find((entry) => entry.id === "step-two");
			return task?.status === "paused" && task.finalizing !== true && job.pendingSpawns === 0 && !job.chainRunnerActive;
		});
		assert.equal(await Promise.race([taskWaiter, Promise.resolve("pending")]), "pending");
		assert.equal(await Promise.race([jobWaiter, Promise.resolve("pending")]), "pending");
		assert.equal(children.length, 1, "the old runner must not dispatch step three after pausing step two");

		const second = await resumeJob(jobId, resumeOptions(spawnProcess));
		assert.equal(second.error, undefined);
		await until(() => children.length === 2);
		assert.equal(children[1].taskId, "step-two", "resume reuses the current task ID");
		assert.ok(children[1].args.includes("--session"));
		assert.equal(children[1].args[children[1].args.indexOf("--session") + 1], sessionFile);
		pauseJobTasks(job);
		await until(() => {
			const task = job.tasks.find((entry) => entry.id === "step-two");
			return task?.status === "paused" && task.finalizing !== true && job.pendingSpawns === 0 && !job.chainRunnerActive;
		});
		assert.equal(children.length, 2);

		const third = await resumeJob(jobId, resumeOptions(spawnProcess, { wait: true }));
		assert.equal(third.error, undefined);
		assert.equal(job.notifyOnComplete, false, "wait:true suppresses completion notification on a reused job");
		assert.ok(children.every((child) => child.taskId === "step-two"), "step three must not launch before the resumed step completes");
		await until(() => children.length === 3);
		assert.equal(children[2].taskId, "step-two", "resume starts a fresh child attempt for the paused task");
		finishChild(children[2], "new step output");
		await until(() => children.length === 4);
		assert.notEqual(children[3].taskId, "step-two");
		assert.match(children[3].args.join(" "), /third based on new step output/);
		assert.equal(children[3].options.cwd, "/effective/default");
		finishChild(children[3], "third output");
		await until(() => job.finished);
		assert.equal(await taskWaiter, true);
		assert.equal(await jobWaiter, true);
		assert.equal(job.tasks.map((task) => task.step).join(","), "1,2,3");
		assert.equal(job.tasks[2].task, "third based on new step output");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		cleanup();
	}
});

test("fresh chain passes full oversized artifact output and persists final status before waiters", async () => {
	cleanup();
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-chain-output-test-"));
	setJobsRoot(root);
	setParentSessionId(parentSessionId);
	const freshJobId = "fresh-chain-output";
	const chain = [
		{ agent: "worker", task: "produce" },
		{ agent: "worker", task: "consume {previous}" },
	];
	const job = {
		id: freshJobId, mode: "chain", status: "running", tasks: [], chainTotal: 2, notifyOnComplete: false,
		notified: false, finished: false, chainRunnerDone: false, pendingSpawns: 0,
		parentSessionId, persistenceReady: Promise.resolve(true), dispatchAllowed: true,
	};
	jobs.set(job.id, job);
	const children = [];
	const spawnProcess = makeFakeSpawner(children);
	const output = "Ω😀鏈".repeat(20_000);
	try {
		await writeManifest(root, parentSessionId, {
			version: 1, jobId: freshJobId, parentSessionId, mode: "chain", createdAt: 1, updatedAt: 1,
			notifyOnComplete: false, status: "running", chainTotal: 2, chain, tasks: [],
		});
		const waiter = waitForJob(freshJobId);
		runChainFrom(job, chain, 0, "", [agent], "/tmp", modelCtx, undefined, spawnProcess);
		await until(() => children.length === 1);
		finishChild(children[0], output);
		await until(() => children.length === 2);
		assert.ok(children[1].args.join(" ").includes(output), "step two receives complete prior output rather than the compact preview");
		finishChild(children[1], "final result");
		assert.equal(await waiter, true);
		const persisted = readManifest(root, parentSessionId, freshJobId);
		assert.equal(persisted.status, "completed", "chain manifest is complete before job waiters resolve");
		assert.equal(persisted.tasks[0].outputBytes, Buffer.byteLength(output));
		assert.equal(fs.readFileSync(persisted.tasks[0].outputPath, "utf8"), output);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		cleanup();
	}
});

test("resumed fresh chain step reads full prior output artifact after reload", async () => {
	const { root } = makeFixture();
	const resumedJobId = "reload-chain-output";
	const taskDir = path.join(root, parentSessionId, resumedJobId, "tasks");
	fs.mkdirSync(taskDir, { recursive: true });
	const output = "previous full output 😀".repeat(4_000);
	const artifact = writeOutputArtifact(output, { taskId: "completed-one", tasksDir: taskDir });
	const manifest = {
		version: 1, jobId: resumedJobId, parentSessionId, mode: "chain", createdAt: 1, updatedAt: 1,
		notifyOnComplete: false, status: "interrupted", chainTotal: 2,
		chain: [
			{ agent: "worker", task: "first", cwd: "/effective/default" },
			{ agent: "worker", task: "second receives {previous}", cwd: "/effective/default" },
		],
		tasks: [{
			taskId: "completed-one", agent: "worker", task: "first", cwd: "/effective/default", status: "completed",
			dispatchState: "terminal", step: 1, exitCode: 0, usage, finalOutput: "compact preview",
			outputPath: artifact.path, outputBytes: artifact.bytes, startedAt: 1, finishedAt: 2,
		}],
	};
	const children = [];
	try {
		await writeManifest(root, parentSessionId, manifest);
		const result = await resumeJob(resumedJobId, resumeOptions(makeFakeSpawner(children), { wait: true }));
		assert.equal(result.error, undefined);
		await until(() => children.length === 1);
		assert.ok(children[0].args.join(" ").includes(output));
		finishChild(children[0], "final after reload");
		assert.equal(await waitForJob(resumedJobId), true);
		assert.equal(readManifest(root, parentSessionId, resumedJobId).status, "completed");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		cleanup();
	}
});

test("a failed resumed chain step does not dispatch later steps", async () => {
	const { root, manifest } = makeFixture();
	const children = [];
	try {
		await writeManifest(root, parentSessionId, manifest);
		const result = await resumeJob(jobId, resumeOptions(makeFakeSpawner(children)));
		assert.equal(result.error, undefined);
		await until(() => children.length === 1);
		finishChild(children[0], "partial resumed output", 1);
		await until(() => result.job.finished);
		assert.equal(result.job.status, "failed");
		assert.equal(children.length, 1);
		assert.match(result.job.errorMessage, /resumed step 2/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		cleanup();
	}
});

test("resuming a paused parallel batch gives dispatch ownership only to the newest resume", async () => {
	cleanup();
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-parallel-resume-epoch-test-"));
	setJobsRoot(root);
	setParentSessionId(parentSessionId);
	const parallelJobId = "parallel-epoch-job";
	const taskDir = path.join(root, parentSessionId, parallelJobId, "tasks");
	fs.mkdirSync(taskDir, { recursive: true });
	const taskRecords = Array.from({ length: 8 }, (_, index) => {
		const taskId = `epoch-task-${index + 1}`;
		const paused = index < 4;
		const sessionFile = paused ? path.join(taskDir, `20260101_00000${index}_${taskId}.jsonl`) : undefined;
		if (sessionFile) fs.writeFileSync(sessionFile, "{}\\n");
		return {
			taskId, agent: "worker", task: `task ${index + 1}`, cwd: "/tmp",
			status: paused ? "paused" : "interrupted", dispatchState: paused ? "paused" : "queued",
			exitCode: 143, usage, ...(sessionFile ? { sessionFile } : {}), startedAt: index + 1,
		};
	});
	const manifest = {
		version: 1, jobId: parallelJobId, parentSessionId, mode: "parallel", createdAt: 1, updatedAt: 1,
		notifyOnComplete: false, status: "interrupted", tasks: taskRecords,
	};
	const children = [];
	const spawnProcess = makeFakeSpawner(children);
	try {
		await writeManifest(root, parentSessionId, manifest);
		const first = await resumeJob(parallelJobId, resumeOptions(spawnProcess));
		assert.equal(first.error, undefined);
		await until(() => children.length === 4);
		pauseJobTasks(first.job);
		await until(() => first.job.tasks.filter((task) => task.status === "paused").length === 4 &&
			first.job.tasks.every((task) => task.finalizing !== true) && first.job.pendingSpawns === 0);

		const second = await resumeJob(parallelJobId, resumeOptions(spawnProcess));
		assert.equal(second.error, undefined);
		await until(() => children.length === 8);
		for (const child of children.slice(4)) finishChild(child, `result ${child.taskId}`);
		await until(() => children.length >= 12);
		for (const child of children.slice(8, 12)) finishChild(child, `result ${child.taskId}`);
		await until(() => second.job.finished || children.length > 12);
		const counts = new Map();
		for (const child of children) counts.set(child.taskId, (counts.get(child.taskId) ?? 0) + 1);
		assert.equal(children.length, 12, "stale workers must not dispatch queued tasks after resume");
		assert.deepEqual([...counts.values()], [2, 2, 2, 2, 1, 1, 1, 1]);
	} finally {
		for (const child of children) if (child.proc.exitCode === null) finishChild(child, "cleanup");
		fs.rmSync(root, { recursive: true, force: true });
		cleanup();
	}
});

test("same-process concurrent resume is admitted once without an existing registry job", async () => {
	const { root, manifest } = makeFixture();
	const children = [];
	try {
		await writeManifest(root, parentSessionId, manifest);
		assert.equal(jobs.has(jobId), false);
		const options = resumeOptions(makeFakeSpawner(children));
		const [first, second] = await Promise.all([resumeJob(jobId, options), resumeJob(jobId, options)]);
		assert.ok(first.job);
		assert.match(second.error, /already being resumed/);
		await until(() => children.length === 1);
		assert.equal(children.length, 1);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		cleanup();
	}
});
