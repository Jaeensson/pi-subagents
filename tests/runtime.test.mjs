/**
 * Unit tests for runtime.ts — the job-finished hook that drives the
 * watch-pane auto-close (TUI glue in watch.ts, hook logic here).
 * Runs with: node --test tests/core.test.mjs tests/live.test.mjs tests/runtime.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { blocksResume, checkJobComplete, clearRegistry, jobs, setJobFinishedHook, setMessageSender, taskWaiters, tasks, toTaskInfo, waitForJob, waitForTask } from "../runtime.ts";

/** Minimal fake job; checkJobComplete only reads the fields it needs. */
function makeJob(id, mode = "single") {
	return {
		id,
		mode,
		status: "running",
		tasks: [],
		notifyOnComplete: false,
		notified: false,
		finished: false,
		chainRunnerDone: false,
		pendingSpawns: 0,
	};
}

test("task details retain only a bounded finalized result and strip thinking", () => {
	const task = {
		id: "details", agent: "worker", agentSource: "test", task: "work", status: "completed", exitCode: 0,
		messages: [
			{ role: "assistant", content: [{ type: "thinking", text: "private thought" }, { type: "text", text: "old history" }] },
			{ role: "assistant", content: [{ type: "thinking", text: "latest thought" }, { type: "text", text: "😀".repeat(40_000) }] },
		],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
	};
	const info = toTaskInfo(task);
	assert.equal(info.messages.length, 1);
	assert.ok(Buffer.byteLength(info.messages[0].content[0].text) <= 50 * 1024);
	assert.doesNotMatch(JSON.stringify(info.messages), /thought|old history/);
	assert.match(info.messages[0].content[0].text, /Output truncated/);
});

test("wait timeout zero is immediate and invalid timeout values resolve false", async () => {
	const task = { id: "wait-timeout", status: "running" };
	tasks.set(task.id, task);
	try {
		assert.equal(await waitForTask(task.id, { timeoutMs: 0 }), false);
		for (const timeoutMs of [-1, NaN, Infinity, 2 ** 31])
			assert.equal(await waitForTask(task.id, { timeoutMs }), false);
		assert.equal(taskWaiters.has(task.id), false);
	} finally { clearRegistry(); }
});

test("timeout and abort remove their waiter closures; clearRegistry settles remaining waiters", async () => {
	const task = { id: "wait-cleanup", status: "running" };
	tasks.set(task.id, task);
	const timed = waitForTask(task.id, { timeoutMs: 1 });
	assert.equal(await timed, false);
	assert.equal(taskWaiters.has(task.id), false);

	const controller = new AbortController();
	const aborted = waitForTask(task.id, { signal: controller.signal });
	controller.abort();
	assert.equal(await aborted, false);
	assert.equal(taskWaiters.has(task.id), false);

	const pendingTask = waitForTask(task.id);
	jobs.set("wait-cleanup-job", { id: "wait-cleanup-job", finished: false });
	const pendingJob = waitForJob("wait-cleanup-job");
	clearRegistry();
	assert.equal(await pendingTask, false);
	assert.equal(await pendingJob, false);
	assert.equal(taskWaiters.size, 0);
});

test("job-finished hook fires once when a non-chain job completes", () => {
	const calls = [];
	setJobFinishedHook(() => calls.push("fired"));
	try {
		const job = makeJob("j-single");
		job.tasks = [{ id: "t1", jobId: job.id, status: "completed" }];
		checkJobComplete(job);
		assert.equal(job.finished, true);
		assert.deepEqual(calls, ["fired"]);
		// Finished guard: a second check must not re-fire.
		checkJobComplete(job);
		assert.deepEqual(calls, ["fired"]);
	} finally {
		setJobFinishedHook(undefined);
	}
});

test("job-finished hook does NOT fire mid-chain (chainRunnerDone false) — the chain-gap regression", () => {
	const calls = [];
	setJobFinishedHook(() => calls.push("fired"));
	try {
		const job = makeJob("j-chain", "chain");
		job.tasks = [{ id: "t1", jobId: job.id, status: "completed" }];
		// Step i finalized: the chain runner has not yet flagged completion.
		checkJobComplete(job);
		assert.equal(job.finished, false);
		assert.deepEqual(calls, []);
	} finally {
		setJobFinishedHook(undefined);
	}
});

test("job-finished hook fires when the chain runner finishes the batch", () => {
	const calls = [];
	setJobFinishedHook(() => calls.push("fired"));
	try {
		const job = makeJob("j-chain-done", "chain");
		job.tasks = [{ id: "t1", jobId: job.id, status: "completed" }];
		job.chainRunnerDone = true;
		checkJobComplete(job);
		assert.equal(job.finished, true);
		assert.deepEqual(calls, ["fired"]);
	} finally {
		setJobFinishedHook(undefined);
	}
});
test("checkJobComplete stays open while tasks are paused", () => {
	const job = makeJob("j-paused");
	job.tasks = [
		{ id: "t1", jobId: job.id, status: "completed" },
		{ id: "t2", jobId: job.id, status: "paused" },
	];
	checkJobComplete(job);
	assert.equal(job.finished, false);
	job.tasks[1].status = "completed";
	checkJobComplete(job);
	assert.equal(job.finished, true);
});

test("blocksResume: only in-flight (unfinished) registry jobs block a resume", () => {
	// No registry entry → nothing blocks; the persisted manifest decides.
	assert.equal(blocksResume(undefined), false);
	// Finished job (failed or completed) → stale entry, resumable.
	assert.equal(blocksResume({ ...makeJob("j-done"), finished: true }), false);
	// An unfinished empty job may still be setting up its first spawn.
	assert.equal(blocksResume({ ...makeJob("j-live"), finished: false }), true);
	// Running children block; paused children are deliberately resumable.
	assert.equal(blocksResume({ ...makeJob("j-running"), tasks: [{ status: "running" }] }), true);
	assert.equal(blocksResume({ ...makeJob("j-paused"), tasks: [{ status: "paused" }] }), false);
});

test("completion notification includes the task name", () => {
	const seen = [];
	setMessageSender((text) => seen.push(text));
	try {
		const job = makeJob("j-named");
		job.notifyOnComplete = true;
		job.tasks = [
			{
				id: "t1", jobId: job.id, agent: "worker", name: "feat-1", status: "completed",
				exitCode: 0, stopReason: "end",
				messages: [{ role: "assistant", content: [{ type: "text", text: "done output" }] }],
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
			},
		];
		checkJobComplete(job);
		assert.match(seen[0], /\[worker\/feat-1\]/);
	} finally {
		setMessageSender(undefined);
	}
});
