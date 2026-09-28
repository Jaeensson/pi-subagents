import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	beginTaskShutdown,
	holdTaskDispatch,
	killTask,
	markInterruptedSweep,
	resumeTaskSpawning,
	resolvePiInvocation,
	shutdownTaskProcesses,
	spawnTask,
	waitForJobOrKill,
	pauseJobTasks,
} from "../process.ts";
import { resumeJob } from "../jobs.ts";
import { clearRegistry, jobs, listRunningTasks, setJobsRoot, setParentSessionId, tasks, waitForJob, waitForTask } from "../runtime.ts";
import { manifestPath, readManifest, writeManifest } from "../store.ts";

function makeJob(id) {
	return {
		id,
		mode: "single",
		status: "running",
		tasks: [],
		notifyOnComplete: false,
		notified: false,
		finished: false,
		chainRunnerDone: false,
		pendingSpawns: 0,
	};
}

function modelContext() {
	return { catalog: [] };
}

function cleanup() {
	const oldTasks = [...tasks.values()];
	clearRegistry();
	for (const task of oldTasks) {
		if (task.proc?.emit && task.proc.exitCode === null) {
			task.proc.exitCode = 0;
			task.proc.emit("close", 0, null);
		}
	}
	setJobsRoot(undefined);
	setParentSessionId(undefined);
	resumeTaskSpawning();
}

function fakeChild(onKill) {
	const proc = new EventEmitter();
	proc.stdout = new EventEmitter();
	proc.stderr = new EventEmitter();
	proc.exitCode = null;
	proc.signalCode = null;
	proc.kill = (signal) => {
		onKill?.(signal, proc);
		return true;
	};
	return proc;
}

async function waitUntil(predicate, message = "condition did not become true") {
	for (let i = 0; i < 500; i++) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
	assert.fail(message);
}

function testAgent() {
	return { name: "worker", source: "user", systemPrompt: "", tools: [], extensions: [] };
}

async function createParallelFixture(root, jobId, psid = "scheduler-parent") {
	setJobsRoot(root);
	setParentSessionId(psid);
	const job = { ...makeJob(jobId), mode: "parallel", parentSessionId: psid, persistenceReady: Promise.resolve(true), dispatchAllowed: true };
	jobs.set(job.id, job);
	await writeManifest(root, psid, {
		version: 1, jobId, parentSessionId: psid, mode: "parallel", createdAt: 1, updatedAt: 1,
		notifyOnComplete: false, status: "running", tasks: [],
	});
	return { job, psid };
}

function closeChild(proc, code = 0, signal = null) {
	proc.exitCode = code;
	proc.signalCode = signal;
	proc.emit("close", code, signal);
}

test("resolvePiInvocation finds the installed pi CLI rather than re-running a harness script", () => {
	const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cli-path-test-"));
	try {
		const cli = path.join(binDir, "pi");
		fs.writeFileSync(cli, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		fs.chmodSync(cli, 0o755);
		assert.deepEqual(resolvePiInvocation(["--mode", "json"], {
			execPath: "/usr/bin/node", pathValue: binDir, platform: "linux", pathDelimiter: ":",
		}), { command: cli, args: ["--mode", "json"] });
		assert.deepEqual(resolvePiInvocation(["-p"], { execPath: "/opt/pi-standalone" }), {
			command: "/opt/pi-standalone", args: ["-p"],
		});
	} finally {
		fs.rmSync(binDir, { recursive: true, force: true });
	}
});

test("shutdown captures process ownership before marking tasks interrupted and cleans temp files", async () => {
	cleanup();
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-process-shutdown-test-"));
	try {
		const job = makeJob("shutdown-job");
		jobs.set(job.id, job);
		const task = {
			id: "shutdown-task",
			jobId: job.id,
			status: "running",
			tmpDir: tempDir,
			tmpPath: path.join(tempDir, "prompt.md"),
			proc: { exitCode: null, signalCode: null, kill(signal) { this.killed = signal; } },
		};
		fs.writeFileSync(task.tmpPath, "temporary system prompt");
		tasks.set(task.id, task);
		job.tasks.push(task);

		const captured = await markInterruptedSweep();
		assert.deepEqual(captured, [task]);
		assert.equal(task.status, "interrupted");
		assert.deepEqual(listRunningTasks(), []);
		for (const ownedTask of captured) killTask(ownedTask);
		assert.equal(task.proc.killed, "SIGTERM");
		assert.equal(fs.existsSync(task.tmpPath), false);
		assert.equal(fs.existsSync(tempDir), false);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
		cleanup();
	}
});

test("task manifest entry is flushed before the child process starts", async () => {
	cleanup();
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-process-persist-test-"));
	const psid = "parent-session";
	const job = { ...makeJob("persist-job"), parentSessionId: psid, persistenceReady: Promise.resolve(true) };
	jobs.set(job.id, job);
	setJobsRoot(root);
	setParentSessionId(psid);
	await writeManifest(root, psid, {
		version: 1, jobId: job.id, parentSessionId: psid, mode: "single", createdAt: 1, updatedAt: 1,
		notifyOnComplete: false, status: "running", tasks: [],
	});
	let sawFlushedTask = false;
	const fakeSpawn = (_command, args) => {
		sawFlushedTask = readManifest(root, psid, job.id).tasks.length === 1;
		assert.ok(args.includes("--session-dir"));
		const proc = new EventEmitter();
		proc.stdout = new EventEmitter();
		proc.stderr = new EventEmitter();
		proc.exitCode = null;
		proc.signalCode = null;
		proc.kill = () => true;
		return proc;
	};
	try {
		await spawnTask(
			{ name: "worker", source: "user", systemPrompt: "", tools: [], extensions: [] },
			"do work", process.cwd(), job.id, { modelCtx: modelContext(), spawnProcess: fakeSpawn },
		);
		assert.equal(sawFlushedTask, true);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		cleanup();
	}
});

test("single job persists completed status before waitForJob settles, even when emit throws", async () => {
	cleanup();
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-process-single-complete-test-"));
	const psid = "single-complete-parent";
	const job = { ...makeJob("single-complete"), parentSessionId: psid, persistenceReady: Promise.resolve(true) };
	job.emit = () => { throw new Error("UI update failed"); };
	jobs.set(job.id, job);
	setJobsRoot(root);
	setParentSessionId(psid);
	await writeManifest(root, psid, {
		version: 1, jobId: job.id, parentSessionId: psid, mode: "single", createdAt: 1, updatedAt: 1,
		notifyOnComplete: false, status: "running", tasks: [],
	});
	let child;
	try {
		await spawnTask(testAgent(), "finish", process.cwd(), job.id, {
			modelCtx: modelContext(), spawnProcess: () => (child = fakeChild()),
		});
		closeChild(child);
		assert.equal(await waitForJob(job.id), true);
		const manifest = readManifest(root, psid, job.id);
		assert.equal(manifest.status, "completed");
		assert.equal(manifest.tasks.length, 1);
		assert.equal(manifest.tasks[0].status, "completed");
		assert.equal(job.tasks[0].finalizing, false);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		cleanup();
	}
});

test("oversized Unicode output is private, exact, and persisted before task waiters release", async () => {
	cleanup();
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-process-output-artifact-test-"));
	const psid = "output-artifact-parent";
	const job = { ...makeJob("output-artifact"), parentSessionId: psid, persistenceReady: Promise.resolve(true) };
	jobs.set(job.id, job);
	setJobsRoot(root);
	setParentSessionId(psid);
	await writeManifest(root, psid, {
		version: 1, jobId: job.id, parentSessionId: psid, mode: "single", createdAt: 1, updatedAt: 1,
		notifyOnComplete: false, status: "running", tasks: [],
	});
	const output = "😀漢字🙂".repeat(24_000);
	let child;
	try {
		const task = await spawnTask(testAgent(), "large output", process.cwd(), job.id, {
			modelCtx: modelContext(), spawnProcess: () => (child = fakeChild()),
		});
		const waiter = waitForTask(task.id);
		child.stdout.emit("data", Buffer.from(`${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: output }] } })}\n`));
		closeChild(child);
		assert.equal(await waiter, true);
		const manifestTask = readManifest(root, psid, job.id).tasks[0];
		assert.equal(manifestTask.outputBytes, Buffer.byteLength(output));
		assert.equal(fs.readFileSync(manifestTask.outputPath, "utf8"), output);
		assert.equal(fs.statSync(manifestTask.outputPath).mode & 0o777, 0o600);
		assert.ok(task.messages.length <= 100);
		assert.ok(Buffer.byteLength(task.messages.at(-1).content[0].text) < Buffer.byteLength(output));
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		cleanup();
	}
});

test("resuming without a new assistant result preserves the existing full-output sidecar", async () => {
	cleanup();
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-process-resume-artifact-test-"));
	const job = makeJob("resume-artifact");
	jobs.set(job.id, job);
	const tasksDir = path.join(root, "tasks");
	fs.mkdirSync(tasksDir, { recursive: true });
	const taskId = "artifact-resume-task";
	const outputPath = path.join(tasksDir, `${taskId}-output.txt`);
	const originalOutput = "x".repeat(100_000);
	fs.writeFileSync(outputPath, originalOutput);
	const synthetic = "bounded restored preview";
	const task = {
		id: taskId, jobId: job.id, agent: "worker", agentSource: "manifest", task: "continue", cwd: process.cwd(),
		status: "paused", startedAt: 1, exitCode: 143,
		messages: [{ role: "assistant", content: [{ type: "text", text: synthetic }] }],
		live: { segments: [] }, stderr: "", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		sessionDir: tasksDir, sessionFile: path.join(tasksDir, `20260101_000000_${taskId}.jsonl`),
		outputPath, outputBytes: Buffer.byteLength(originalOutput),
	};
	jobs.get(job.id).tasks.push(task);
	tasks.set(task.id, task);
	let child;
	try {
		await spawnTask(testAgent(), task.task, task.cwd, job.id, {
			taskId, modelCtx: modelContext(), resume: { sessionFile: task.sessionFile, originalTask: task.task },
			spawnProcess: () => (child = fakeChild()),
		});
		closeChild(child);
		await waitForJob(job.id);
		assert.equal(fs.readFileSync(outputPath, "utf8"), originalOutput);
		assert.equal(task.outputPath, outputPath);
		assert.equal(task.outputBytes, Buffer.byteLength(originalOutput));
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		cleanup();
	}
});

test("overlapping parallel finalizations persist completed status with every final task snapshot", async () => {
	cleanup();
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-process-parallel-complete-test-"));
	const { job, psid } = await createParallelFixture(root, "parallel-complete");
	const children = [];
	try {
		await Promise.all(["parallel-a", "parallel-b"].map((taskId) => spawnTask(testAgent(), taskId, process.cwd(), job.id, {
			taskId, modelCtx: modelContext(), spawnProcess: () => {
				const child = fakeChild();
				children.push(child);
				return child;
			},
		})));
		children.forEach((child) => closeChild(child));
		assert.equal(await waitForJob(job.id), true);
		const manifest = readManifest(root, psid, job.id);
		assert.equal(manifest.status, "completed");
		assert.deepEqual(manifest.tasks.map((task) => task.status).sort(), ["completed", "completed"]);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		cleanup();
	}
});

test("failed initial persistence falls back to an ephemeral child session", async () => {
	cleanup();
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-process-ephemeral-test-"));
	const psid = "parent-session";
	const job = { ...makeJob("ephemeral-job"), parentSessionId: psid, persistenceReady: Promise.resolve(false) };
	jobs.set(job.id, job);
	setJobsRoot(root);
	setParentSessionId(psid);
	let argsSeen;
	const fakeSpawn = (_command, args) => {
		argsSeen = args;
		const proc = new EventEmitter();
		proc.stdout = new EventEmitter();
		proc.stderr = new EventEmitter();
		proc.exitCode = null;
		proc.signalCode = null;
		proc.kill = () => true;
		return proc;
	};
	try {
		await spawnTask(
			{ name: "worker", source: "user", systemPrompt: "", tools: [], extensions: [] },
			"do work", process.cwd(), job.id, { modelCtx: modelContext(), spawnProcess: fakeSpawn },
		);
		assert.equal(argsSeen.includes("--session-dir"), false);
		assert.equal(fs.existsSync(path.join(root, psid, job.id)), false);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		cleanup();
	}
});

test("single job pauses and resumes twice on the same task ID and transcript; a pre-pause waiter waits through pause", async () => {
	cleanup();
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-process-resume-test-"));
	const psid = "resume-parent";
	setJobsRoot(root);
	setParentSessionId(psid);
	const job = { ...makeJob("resume-job"), parentSessionId: psid, persistenceReady: Promise.resolve(true), dispatchAllowed: true };
	jobs.set(job.id, job);
	await writeManifest(root, psid, {
		version: 1, jobId: job.id, parentSessionId: psid, mode: "single", createdAt: 1, updatedAt: 1,
		notifyOnComplete: false, status: "running", tasks: [],
	});
	const children = [];
	const spawnFake = (_command, args) => {
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
		const sessionIndex = args.indexOf("--session-dir");
		const sessionDir = sessionIndex >= 0 ? args[sessionIndex + 1] : undefined;
		if (sessionDir) {
			fs.mkdirSync(sessionDir, { recursive: true });
			fs.writeFileSync(path.join(sessionDir, `20260101_000000_${args[args.indexOf("--session-id") + 1]}.jsonl`), "{}");
		}
		children.push({ proc, args, sessionDir });
		return proc;
	};
	const agent = { name: "worker", source: "user", systemPrompt: "", tools: [], extensions: [] };
	const modelCtx = modelContext();
	try {
		const first = await spawnTask(agent, "do work", process.cwd(), job.id, { modelCtx, spawnProcess: spawnFake });
		const taskId = first.id;
		const waiter = waitForTask(taskId);
		pauseJobTasks(job);
		await waitUntil(() => first.status === "paused" && !first.finalizing);
		assert.equal(first.status, "paused");
		const taskFile = first.sessionFile;
		assert.ok(taskFile);
		assert.equal(await Promise.race([waiter, Promise.resolve("pending")]), "pending");

		for (let resumeNumber = 0; resumeNumber < 2; resumeNumber++) {
			const resumed = await resumeJob(job.id, {
				agents: [agent], defaultCwd: process.cwd(), modelCtx, wait: false, notifyOnComplete: false,
				spawnProcess: spawnFake,
			});
			assert.equal(resumed.error, undefined);
			for (let spin = 0; spin < 50 && children.length < resumeNumber + 2; spin++)
				await new Promise((resolve) => setTimeout(resolve, 2));
			assert.equal(children.length, resumeNumber + 2);
			assert.equal(job.tasks.length, 1);
			assert.equal(job.tasks[0].id, taskId);
			assert.equal(job.tasks[0].sessionFile, taskFile);
			const child = children.at(-1);
			assert.ok(child.args.includes("--session"));
			assert.equal(child.args[child.args.indexOf("--session") + 1], taskFile);
			if (resumeNumber === 0) {
				pauseJobTasks(job);
				await waitUntil(() => job.tasks[0].status === "paused" && !job.tasks[0].finalizing);
				assert.equal(job.tasks[0].status, "paused");
			} else {
				child.proc.exitCode = 0;
				child.proc.stdout.emit("data", Buffer.from(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "finished" }] } }) + "\n"));
				child.proc.emit("close", 0, null);
			}
		}
		assert.equal(await waiter, true);
		assert.equal(job.tasks[0].status, "completed");
		assert.equal(job.tasks[0].id, taskId);
		assert.equal(job.tasks.length, 1);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		cleanup();
	}
});

test("fresh parallel dispatch records all eight durable tasks before starting at most four children", async () => {
	cleanup();
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-parallel-scheduler-test-"));
	const { job, psid } = await createParallelFixture(root, "fresh-parallel");
	const release = holdTaskDispatch();
	const children = [];
	let active = 0;
	let peak = 0;
	const fakeSpawn = (_command, args) => {
		const proc = fakeChild();
		children.push(proc);
		active++;
		peak = Math.max(peak, active);
		return proc;
	};
	try {
		const pending = Array.from({ length: 8 }, (_, i) => spawnTask(testAgent(), `fresh ${i}`, process.cwd(), job.id, {
			taskId: `fresh-${i}`, modelCtx: modelContext(), spawnProcess: fakeSpawn,
		}));
		await Promise.all(pending);
		assert.equal(job.tasks.length, 8);
		assert.equal(readManifest(root, psid, job.id).tasks.length, 8);
		assert.equal(children.length, 0, "dispatch hold must prevent the first child from starting");
		release();
		await waitUntil(() => children.length === 4);
		for (let i = 0; i < 8; i++) {
			active--;
			closeChild(children[i]);
			if (i < 7) await waitUntil(() => children.length === Math.min(8, i + 5));
		}
		await Promise.all(job.tasks.map((task) => waitForTask(task.id)));
		assert.equal(peak, 4);
		assert.equal(active, 0);
	} finally {
		release();
		fs.rmSync(root, { recursive: true, force: true });
		cleanup();
	}
});

test("resumed parallel batch of eight is limited to four live child processes", async () => {
	cleanup();
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-parallel-resume-test-"));
	const psid = "resume-parallel-parent";
	setJobsRoot(root);
	setParentSessionId(psid);
	const jobId = "resumed-parallel";
	const manifestTasks = Array.from({ length: 8 }, (_, i) => ({
		taskId: `resume-${i}`, agent: "worker", task: `original ${i}`, cwd: process.cwd(),
		status: "interrupted", dispatchState: "terminal", startedAt: i + 1, exitCode: 1,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
	}));
	await writeManifest(root, psid, {
		version: 1, jobId, parentSessionId: psid, mode: "parallel", createdAt: 1, updatedAt: 1,
		notifyOnComplete: false, status: "interrupted", tasks: manifestTasks,
	});
	const children = [];
	let active = 0;
	let peak = 0;
	const fakeSpawn = (_command, args) => {
		const proc = fakeChild();
		children.push({ proc, args });
		active++;
		peak = Math.max(peak, active);
		return proc;
	};
	try {
		const result = await resumeJob(jobId, {
			agents: [testAgent()], defaultCwd: process.cwd(), modelCtx: modelContext(), wait: false,
			notifyOnComplete: false, spawnProcess: fakeSpawn,
		});
		assert.equal(result.error, undefined);
		await waitUntil(() => children.length === 4);
		assert.equal(result.job.tasks.length, 8);
		for (let i = 0; i < 8; i++) {
			active--;
			closeChild(children[i].proc);
			if (i < 7) await waitUntil(() => children.length === Math.min(8, i + 5));
		}
		await waitUntil(() => result.job.finished);
		assert.equal(peak, 4);
		assert.equal(active, 0);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		cleanup();
	}
});

test("pause and abort cancel queued parallel dispatch without losing resumable task entries", async () => {
	cleanup();
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-parallel-cancel-test-"));
	const { job, psid } = await createParallelFixture(root, "paused-parallel");
	const release = (await import("../process.ts")).holdTaskDispatch();
	let spawnCalls = 0;
	try {
		await Promise.all(Array.from({ length: 8 }, (_, i) => spawnTask(testAgent(), `pause ${i}`, process.cwd(), job.id, {
			taskId: `pause-${i}`, modelCtx: modelContext(), spawnProcess: () => { spawnCalls++; return fakeChild(); },
		})));
		pauseJobTasks(job);
		release();
		await waitUntil(() => job.tasks.every((task) => !task.finalizing));
		assert.equal(spawnCalls, 0);
		assert.ok(job.tasks.every((task) => task.status === "paused"));
		const pausedManifest = readManifest(root, psid, job.id);
		assert.equal(pausedManifest.status, "running", "paused task snapshots must prevent terminal job status");
		assert.equal(pausedManifest.tasks.filter((task) => task.status === "paused").length, 8);
	} finally {
		release();
		fs.rmSync(root, { recursive: true, force: true });
		cleanup();
	}

	cleanup();
	const abortRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-parallel-abort-test-"));
	const { job: abortJob, psid: abortPsid } = await createParallelFixture(abortRoot, "aborted-parallel");
	const releaseAbort = holdTaskDispatch();
	const controller = new AbortController();
	try {
		await Promise.all(Array.from({ length: 8 }, (_, i) => spawnTask(testAgent(), `abort ${i}`, process.cwd(), abortJob.id, {
			taskId: `abort-${i}`, modelCtx: modelContext(), spawnProcess: () => { spawnCalls++; return fakeChild(); },
		})));
		controller.abort();
		const completed = await waitForJobOrKill(abortJob.id, controller.signal);
		assert.equal(completed, false);
		releaseAbort();
		assert.ok(abortJob.tasks.every((task) => task.status === "aborted"));
		const manifest = readManifest(abortRoot, abortPsid, abortJob.id);
		assert.equal(manifest.status, "aborted");
		assert.ok(manifest.tasks.every((task) => task.status === "aborted"));
		assert.equal(spawnCalls, 0);
	} finally {
		releaseAbort();
		fs.rmSync(abortRoot, { recursive: true, force: true });
		cleanup();
	}
});

test("synchronous spawn errors free a scheduler slot and settle task waiters", async () => {
	cleanup();
	const job = { ...makeJob("spawn-error-job"), mode: "parallel", dispatchAllowed: true };
	jobs.set(job.id, job);
	const calls = [];
	const fakeSpawn = (_command, args) => {
		calls.push(args);
		if (calls.length === 1) throw new Error("injected spawn failure");
		return fakeChild();
	};
	try {
		await Promise.all(Array.from({ length: 5 }, (_, i) => spawnTask(testAgent(), `task ${i}`, process.cwd(), job.id, {
			taskId: `throw-${i}`, modelCtx: modelContext(), spawnProcess: fakeSpawn,
		})));
		await waitUntil(() => calls.length === 5);
		assert.equal(job.tasks.filter((task) => task.status === "failed").length, 1);
		for (const task of job.tasks) if (task.proc) closeChild(task.proc);
		await Promise.all(job.tasks.map((task) => waitForTask(task.id)));
		assert.equal(job.tasks.filter((task) => task.status === "completed").length, 4);
	} finally { cleanup(); }
});

test("resuming an unstarted queued task replays its original prompt instead of a continuation", async () => {
	cleanup();
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-queued-resume-test-"));
	const psid = "queued-resume-parent";
	const jobId = "queued-resume-job";
	setJobsRoot(root);
	setParentSessionId(psid);
	const taskDir = path.join(root, psid, jobId, "tasks");
	fs.mkdirSync(taskDir, { recursive: true });
	const sessionFile = path.join(taskDir, "20260101_000000_queued-resume-task.jsonl");
	fs.writeFileSync(sessionFile, "{}\n");
	await writeManifest(root, psid, {
		version: 1, jobId, parentSessionId: psid, mode: "single", createdAt: 1, updatedAt: 1,
		notifyOnComplete: false, status: "interrupted", tasks: [{
			taskId: "queued-resume-task", agent: "worker", task: "perform the original work", cwd: process.cwd(),
			status: "interrupted", dispatchState: "queued", sessionFile, startedAt: 1, exitCode: 1,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		}],
	});
	let child;
	let spawnArgs;
	try {
		const resumed = await resumeJob(jobId, {
			agents: [testAgent()], defaultCwd: process.cwd(), modelCtx: modelContext(), wait: false,
			notifyOnComplete: false, spawnProcess: (_command, args) => { spawnArgs = args; return (child = fakeChild()); },
		});
		assert.equal(resumed.error, undefined);
		await waitUntil(() => child !== undefined);
		assert.equal(spawnArgs.includes("--session"), false);
		assert.ok(spawnArgs.at(-1).includes("perform the original work"));
		assert.equal(spawnArgs.at(-1).includes("Continue"), false);
		closeChild(child);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		cleanup();
	}
});

test("resume is blocked while final task persistence is unsettled", async () => {
	cleanup();
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-finalize-race-test-"));
	const psid = "finalize-parent";
	const job = { ...makeJob("finalize-race"), parentSessionId: psid, persistenceReady: Promise.resolve(true), dispatchAllowed: true };
	jobs.set(job.id, job);
	setJobsRoot(root);
	setParentSessionId(psid);
	await writeManifest(root, psid, {
		version: 1, jobId: job.id, parentSessionId: psid, mode: "single", createdAt: 1, updatedAt: 1,
		notifyOnComplete: false, status: "running", tasks: [],
	});
	let child;
	try {
		const task = await spawnTask(testAgent(), "race", process.cwd(), job.id, {
			modelCtx: modelContext(), spawnProcess: () => (child = fakeChild()),
		});
		const lockPath = `${manifestPath(root, psid, job.id)}.lock`;
		fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, host: os.hostname(), createdAt: Date.now() }));
		closeChild(child, 143, "SIGTERM");
		await waitUntil(() => task.finalizing === true);
		assert.equal(task.status, "interrupted");
		const rejected = await resumeJob(job.id, {
			agents: [testAgent()], defaultCwd: process.cwd(), modelCtx: modelContext(), wait: false, notifyOnComplete: false,
		});
		assert.match(rejected.error, /still active/);
		fs.unlinkSync(lockPath);
		await waitUntil(() => task.finalizing === false);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		cleanup();
	}
});

test("shutdown reaps owned children, releases all four slots, and permits next-session dispatch", async () => {
	cleanup();
	const first = { ...makeJob("shutdown-first"), mode: "parallel", dispatchAllowed: true };
	jobs.set(first.id, first);
	const oldChildren = [];
	const stubbornSpawn = () => {
		const proc = fakeChild((signal, self) => {
			if (signal === "SIGKILL") queueMicrotask(() => closeChild(self, 137, signal));
		});
		oldChildren.push(proc);
		return proc;
	};
	const started = Array.from({ length: 8 }, (_, i) => spawnTask(testAgent(), `old ${i}`, process.cwd(), first.id, {
		taskId: `old-${i}`, modelCtx: modelContext(), spawnProcess: stubbornSpawn,
	}));
	await Promise.all(started);
	await waitUntil(() => oldChildren.length === 4);
	const staleRelease = holdTaskDispatch();
	beginTaskShutdown();
	const interrupted = await markInterruptedSweep();
	assert.equal(interrupted.length, 8);
	await shutdownTaskProcesses(5, 100);
	assert.ok(oldChildren.every((child) => child.signalCode === "SIGKILL"));
	clearRegistry();
	resumeTaskSpawning();

	const next = { ...makeJob("shutdown-next"), mode: "parallel", dispatchAllowed: true };
	jobs.set(next.id, next);
	const newChildren = [];
	const releaseNext = holdTaskDispatch();
	try {
		await Promise.all(Array.from({ length: 8 }, (_, i) => spawnTask(testAgent(), `new ${i}`, process.cwd(), next.id, {
			taskId: `new-${i}`, modelCtx: modelContext(), spawnProcess: () => {
				const proc = fakeChild();
				newChildren.push(proc);
				return proc;
			},
		})));
		assert.equal(newChildren.length, 0);
		staleRelease();
		assert.equal(newChildren.length, 0, "old session's hold cannot release the new batch");
		releaseNext();
		await waitUntil(() => newChildren.length === 4);
		assert.equal(newChildren.length, 4);
		assert.ok(next.tasks.every((task) => task.status === "running"));
		for (const child of newChildren) closeChild(child);
	} finally { releaseNext(); cleanup(); }
});

test("stdout preserves split UTF-8, parses final unterminated JSON, and bounds stderr flood", async () => {
	cleanup();
	const job = makeJob("stream-bounds-job");
	jobs.set(job.id, job);
	let child;
	try {
		const task = await spawnTask(testAgent(), "stream", process.cwd(), job.id, {
			modelCtx: modelContext(), spawnProcess: () => (child = fakeChild()),
		});
		const event = Buffer.from(JSON.stringify({
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: "left-😀-right" }] },
		}));
		const emojiAt = event.indexOf(Buffer.from("😀"));
		child.stdout.emit("data", event.subarray(0, emojiAt + 2));
		child.stdout.emit("data", event.subarray(emojiAt + 2)); // split inside the four-byte UTF-8 sequence
		child.stdout.emit("data", Buffer.from("\n[]\nnull\n")); // value-shaped events must be harmless
		child.stdout.emit("data", Buffer.from(JSON.stringify({
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: "unterminated-final" }] },
		})));
		child.stderr.emit("data", Buffer.from("e".repeat(200_000)));
		closeChild(child);
		assert.equal(await waitForTask(task.id), true);
		assert.deepEqual(task.messages.map((message) => message.content[0].text), ["left-😀-right", "unterminated-final"]);
		assert.ok(Buffer.byteLength(task.stderr, "utf8") <= 64 * 1024);
		assert.ok(task.stderr.endsWith("e".repeat(64 * 1024)));
	} finally { cleanup(); }
});

test("task message history is bounded while the newest full assistant output survives", async () => {
	cleanup();
	const job = makeJob("message-history-bounds-job");
	jobs.set(job.id, job);
	let child;
	try {
		const task = await spawnTask(testAgent(), "many turns", process.cwd(), job.id, {
			modelCtx: modelContext(), spawnProcess: () => (child = fakeChild()),
		});
		const lines = Array.from({ length: 130 }, (_, index) => JSON.stringify({
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: index === 129 ? "final-full-answer" : `turn-${index}` }] },
		}));
		child.stdout.emit("data", Buffer.from(`${lines.join("\n")}\n`));
		assert.equal(task.messages.length, 100);
		assert.equal(task.messages.at(-1).content[0].text, "final-full-answer");
		closeChild(child);
		assert.equal(await waitForTask(task.id), true);
	} finally { cleanup(); }
});

test("shutdown prevents an in-flight prompt setup from spawning a child and cleans its temp directory", async () => {
	cleanup();
	const job = makeJob("pending-spawn-job");
	jobs.set(job.id, job);
	let spawnCalls = 0;
	const fakeSpawn = () => {
		spawnCalls++;
		const proc = new EventEmitter();
		proc.stdout = new EventEmitter();
		proc.stderr = new EventEmitter();
		proc.exitCode = null;
		proc.signalCode = null;
		proc.kill = () => true;
		return proc;
	};
	try {
		const pending = spawnTask(
			{ name: "worker", source: "user", systemPrompt: "temporary prompt", tools: [], extensions: [] },
			"do work",
			process.cwd(),
			job.id,
			{ modelCtx: modelContext(), spawnProcess: fakeSpawn },
		);
		beginTaskShutdown();
		const captured = await markInterruptedSweep();
		const [task] = await Promise.all([pending]);

		assert.deepEqual(captured, [task]);
		assert.equal(task.status, "interrupted");
		assert.equal(spawnCalls, 0);
		assert.equal(fs.existsSync(task.tmpPath), false);
		assert.equal(fs.existsSync(task.tmpDir), false);
	} finally {
		cleanup();
	}
});
