/**
 * Unit tests for runtime.ts — the job-finished hook that drives the
 * watch-pane auto-close (TUI glue in watch.ts, hook logic here).
 * Runs with: node --test tests/core.test.mjs tests/live.test.mjs tests/runtime.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkJobComplete, setJobFinishedHook } from "../runtime.ts";

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