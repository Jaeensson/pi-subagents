import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setJobsRoot, setParentSessionId } from "../runtime.ts";
import { readManifest, writeManifest, updateManifest, upsertManifestTask } from "../store.ts";
import { reportTaskUsage } from "../usage.ts";

const usage = (input = 0, output = 0, cost = 0) => ({
	input, output, cacheRead: 0, cacheWrite: 0, cost, contextTokens: input + output, turns: input + output > 0 ? 1 : 0,
});
const task = (jobId, id, totals) => ({ id, jobId, usage: totals, usageReported: undefined });

afterEach(() => {
	setParentSessionId(undefined);
	setJobsRoot(undefined);
});

test("usage claims report only deltas and dedupe repeated task/job IDs", async () => {
	const t = task("ephemeral-job", "task-1", usage(10, 3, 0.25));
	const first = await reportTaskUsage([t, t]);
	assert.deepEqual(first, {
		input: 10, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 13,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.25 },
	});
	assert.equal((await reportTaskUsage([t])).totalTokens, 0);
	t.usage = usage(14, 5, 0.4);
	const delta = await reportTaskUsage([t]);
	assert.equal(delta.input, 4);
	assert.equal(delta.output, 2);
	assert.ok(Math.abs(delta.cost.total - 0.15) < 1e-10);
});

test("totalTokens includes cache reads and writes", async () => {
	const totals = usage(4, 3);
	totals.cacheRead = 5;
	totals.cacheWrite = 2;
	const result = await reportTaskUsage([task("cache-job", "cache-task", totals)]);
	assert.equal(result.cacheRead, 5);
	assert.equal(result.cacheWrite, 2);
	assert.equal(result.totalTokens, 14);
});

test("running collection persists totals so resumed usage reports only its new delta", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-usage-"));
	setJobsRoot(root);
	setParentSessionId("parent-session");
	try {
		const initial = usage();
		await writeManifest(root, "parent-session", {
			version: 1, jobId: "running-job", parentSessionId: "parent-session", mode: "single",
			createdAt: 1, updatedAt: 1, notifyOnComplete: false, status: "running", tasks: [{
				taskId: "task-1", agent: "worker", task: "do work", cwd: "/tmp", status: "running",
				exitCode: 0, startedAt: 1, usage: initial,
			}],
		});

		const collecting = task("running-job", "task-1", usage(100, 20, 0.5));
		assert.equal((await reportTaskUsage([collecting])).totalTokens, 120);
		const claimed = readManifest(root, "parent-session", "running-job").tasks[0];
		assert.deepEqual(claimed.usage, collecting.usage);
		assert.deepEqual(claimed.reportedUsage, collecting.usage);

		// Restore from the persisted cumulative totals after a parent crash, then
		// append usage accumulated by the resumed child attempt.
		const resumed = task("running-job", "task-1", { ...claimed.usage });
		resumed.usageReported = { ...claimed.reportedUsage };
		resumed.usage = usage(resumed.usage.input + 30, resumed.usage.output + 10, resumed.usage.cost + 0.2);
		const increment = await reportTaskUsage([resumed]);
		assert.equal(increment.totalTokens, 40);
		assert.ok(Math.abs(increment.cost.total - 0.2) < 1e-10);
		assert.deepEqual(readManifest(root, "parent-session", "running-job").tasks[0].usage, resumed.usage);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("usage arriving during a delayed manifest write remains available for the next claim", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-usage-"));
	setJobsRoot(root);
	setParentSessionId("parent-session");
	const lock = path.join(root, "parent-session", "delayed-job", "manifest.json.lock");
	try {
		await writeManifest(root, "parent-session", {
			version: 1, jobId: "delayed-job", parentSessionId: "parent-session", mode: "single",
			createdAt: 1, updatedAt: 1, notifyOnComplete: false, status: "running", tasks: [{
				taskId: "task-1", agent: "worker", task: "do work", cwd: "/tmp", status: "running",
				exitCode: 0, startedAt: 1, usage: usage(),
			}],
		});
		fs.writeFileSync(lock, "deliberate test lock");
		const collecting = task("delayed-job", "task-1", usage(10, 2));
		const pending = reportTaskUsage([collecting]);
		await new Promise((resolve) => setTimeout(resolve, 50));
		collecting.usage = usage(15, 3);
		fs.unlinkSync(lock);

		assert.equal((await pending).totalTokens, 12);
		const later = await reportTaskUsage([collecting]);
		assert.equal(later.totalTokens, 6);
		assert.equal(later.input, 5);
		assert.equal(later.output, 1);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("durable usage claims survive restored task objects and preserve later resume deltas", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-usage-"));
	setJobsRoot(root);
	setParentSessionId("parent-session");
	try {
		const initial = usage(10, 2, 0.2);
		await writeManifest(root, "parent-session", {
			version: 1, jobId: "job-1", parentSessionId: "parent-session", mode: "single",
			createdAt: 1, updatedAt: 1, notifyOnComplete: false, status: "completed", tasks: [{
				taskId: "task-1", agent: "worker", task: "do work", cwd: "/tmp", status: "completed",
				exitCode: 0, startedAt: 1, usage: initial,
			}],
		});
		const first = task("job-1", "task-1", initial);
		assert.equal((await reportTaskUsage([first])).totalTokens, 12);
		assert.deepEqual(readManifest(root, "parent-session", "job-1").tasks[0].reportedUsage, initial);

		// Simulate a resumed registry task reconstructed without its in-memory
		// ledger; the durable claim remains authoritative.
		const resumed = task("job-1", "task-1", usage(15, 4, 0.3));
		await updateManifest(root, "parent-session", "job-1", (manifest) => {
			upsertManifestTask(manifest, { ...manifest.tasks[0], usage: resumed.usage, reportedUsage: undefined });
		});
		assert.deepEqual(readManifest(root, "parent-session", "job-1").tasks[0].reportedUsage, initial);
		const increment = await reportTaskUsage([resumed, resumed]);
		assert.equal(increment.totalTokens, 7);
		assert.ok(Math.abs(increment.cost.total - 0.1) < 1e-10);
		assert.deepEqual(readManifest(root, "parent-session", "job-1").tasks[0].reportedUsage, resumed.usage);
		assert.equal((await reportTaskUsage([resumed])).totalTokens, 0);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
