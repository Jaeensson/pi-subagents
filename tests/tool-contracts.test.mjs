import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { wrapRegisteredTool } from "@earendil-works/pi-coding-agent";
import { subagentTool } from "../tools/subagent.ts";
import { subagentStatusTool } from "../tools/subagent-status.ts";
import { subagentWaitTool } from "../tools/subagent-wait.ts";
import { subagentPauseTool } from "../tools/subagent-pause.ts";
import { subagentResumeTool } from "../tools/subagent-resume.ts";
import { jobs, setJobsRoot, setParentSessionId } from "../runtime.ts";
import { writeManifest, readManifest } from "../store.ts";

const context = {
	cwd: process.cwd(),
	scopedModels: [],
	modelRegistry: { getAvailable: () => [] },
};
function hostWrapped(tool) {
	return wrapRegisteredTool({ definition: tool }, { createContext: () => context });
}
function run(tool, params) {
	return hostWrapped(tool).execute("tool-call", params, undefined, undefined, undefined);
}

test("invalid subagent mode rejects through Pi's registered-tool wrapper", async () => {
	await assert.rejects(run(subagentTool, {}), /exactly one mode/);
});

test("missing task and unknown agent reject rather than returning an isError-shaped success", async () => {
	await assert.rejects(run(subagentTool, { agent: "worker" }), /Missing task/);
	await assert.rejects(run(subagentTool, { agent: "no-such-agent", task: "do it" }), /Unknown agent/);
});

test("parallel arrays above the supported limit reject before any spawn", async () => {
	const tasks = Array.from({ length: 9 }, (_, i) => ({ task: `task ${i}` }));
	await assert.rejects(run(subagentTool, { tasks }), /Too many parallel tasks/);
});

test("unknown job identifiers consistently reject from status, wait, pause, and resume", async () => {
	await assert.rejects(run(subagentStatusTool, { jobIds: ["missing-status"] }), /Unknown job id/);
	await assert.rejects(run(subagentWaitTool, { jobIds: ["missing-wait"] }), /Unknown job id/);
	await assert.rejects(run(subagentPauseTool, { jobId: "missing-pause" }), /Unknown job id/);
	await assert.rejects(run(subagentResumeTool, { jobId: "missing-resume" }), /No durable job store|No persisted job/);
});

test("disk-only subagent_wait restores final output and claims persisted usage once", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-disk-only-test-"));
	const parentSessionId = "wait-disk-parent";
	const jobId = "wait-disk-job";
	setJobsRoot(root);
	setParentSessionId(parentSessionId);
	const totals = { input: 31, output: 12, cacheRead: 4, cacheWrite: 2, cost: 0.75, contextTokens: 43, turns: 3 };
	try {
		await writeManifest(root, parentSessionId, {
			version: 1, jobId, parentSessionId, mode: "single", createdAt: 1, updatedAt: 1,
			notifyOnComplete: false, status: "completed", tasks: [{
				taskId: "wait-disk-task", agent: "worker", task: "saved work", cwd: "/tmp", status: "completed",
				exitCode: 0, startedAt: 1, usage: totals, finalOutput: "persisted final answer",
			}],
		});
		const first = await run(subagentWaitTool, { jobIds: [jobId] });
		const firstText = first.content.map((item) => item.text ?? "").join("\\n");
		assert.match(firstText, /persisted final answer/);
		assert.equal(first.usage.input, 31);
		assert.equal(first.usage.output, 12);
		assert.equal(first.usage.totalTokens, 49);
		assert.deepEqual(readManifest(root, parentSessionId, jobId).tasks[0].reportedUsage, totals);
		const second = await run(subagentWaitTool, { jobIds: [jobId] });
		assert.equal(second.usage.totalTokens, 0);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		setJobsRoot(undefined);
		setParentSessionId(undefined);
	}
});

test("failed-job collection returns failure details and unreported usage", async () => {
	const task = {
		id: "failed-task", jobId: "failed-job", agent: "worker", agentSource: "user", task: "work", cwd: process.cwd(),
		status: "failed", startedAt: 1, exitCode: 1, stopReason: "error", messages: [], live: { segments: [] }, stderr: "",
		usage: { input: 7, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.1, contextTokens: 9, turns: 1 },
	};
	jobs.set("failed-job", { id: "failed-job", status: "failed", finished: true, tasks: [task] });
	try {
		await assert.rejects(run(subagentWaitTool, { jobIds: ["failed-job", "unknown-job"] }), /Unknown job id/);
		assert.equal(task.usageReported, undefined, "a rejected operation must not claim usage");

		const first = await run(subagentWaitTool, { jobIds: ["failed-job"] });
		const firstText = first.content.map((item) => item.text ?? "").join("\\n");
		assert.match(firstText, /failed-task/);
		assert.match(firstText, /failed|error/i);
		assert.equal(first.usage.input, 7);
		assert.equal(first.usage.output, 2);
		assert.equal(first.usage.totalTokens, 9);

		const second = await run(subagentWaitTool, { jobIds: ["failed-job"] });
		assert.equal(second.usage.totalTokens, 0, "repeated collection reports no usage delta");
	} finally {
		jobs.delete("failed-job");
	}
});
