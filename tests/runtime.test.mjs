/**
 * Unit tests for runtime.ts — the job-finished hook that drives the
 * watch-pane auto-close (TUI glue in watch.ts, hook logic here).
 * Runs with: node --test tests/core.test.mjs tests/live.test.mjs tests/runtime.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkJobComplete, setJobFinishedHook, setMessageSender } from "../runtime.ts";

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
