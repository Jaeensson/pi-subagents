import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { wrapRegisteredTool } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
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
// pi 1.5.0's wrapRegisteredTool resolves each call's context through
// runner.createToolContext(toolCallId, signal) instead of runner.createContext(),
// so the stand-in must supply that factory or the wrapper throws before the tool runs.
function hostWrapped(tool) {
	return wrapRegisteredTool({ definition: tool }, { createToolContext: () => context });
}
function run(tool, params) {
	return hostWrapped(tool).execute("tool-call", params, undefined, undefined, undefined);
}
function executeSubagent(params) {
	return subagentTool.execute("tool-call", params, undefined, undefined, context);
}

test("subagent schema accepts one explicit mode and rejects ambiguous shapes", () => {
	const validCalls = [
		{ mode: "single", task: "do work", wait: false },
		{ mode: "parallel", tasks: [{ task: "do work" }], wait: false },
		{ mode: "chain", chain: [{ task: "do work" }], wait: false },
	];
	for (const params of validCalls) assert.equal(Check(subagentTool.parameters, params), true);

	assert.equal(Check(subagentTool.parameters, { agent: "worker", task: "legacy single" }), false);
	assert.equal(Check(subagentTool.parameters, { tasks: [{ task: "legacy parallel" }] }), false);
	assert.equal(Check(subagentTool.parameters, { chain: [{ task: "legacy chain" }] }), false);
	assert.equal(Check(subagentTool.parameters, { task: "missing mode" }), false);
	assert.equal(Check(subagentTool.parameters, { mode: "other", task: "unknown mode" }), false);
	// Cross-mode extras (e.g. single + tasks) now pass the flattened schema;
	// mode-specific requirements are enforced by the execute() guards instead.
	assert.equal(Check(subagentTool.parameters, { mode: "parallel", tasks: [] }), false);
	assert.equal(Check(subagentTool.parameters, { mode: "chain", chain: [] }), false);
});

test("invalid or incomplete modes reject before any task is spawned", async () => {
	await assert.rejects(run(subagentTool, {}), /mode/i);
	await assert.rejects(run(subagentTool, { agent: "no-such-agent", task: "legacy input" }), /mode/i);
	await assert.rejects(executeSubagent({ mode: "unknown" }), /mode/i);
	await assert.rejects(executeSubagent({ mode: "parallel" }), /non-empty tasks array|at least one task/i);
	await assert.rejects(executeSubagent({ mode: "parallel", tasks: [] }), /non-empty tasks array|at least one task/i);
	await assert.rejects(executeSubagent({ mode: "chain" }), /non-empty chain array|at least one step/i);
	await assert.rejects(executeSubagent({ mode: "chain", chain: [] }), /non-empty chain array|at least one step/i);
});

test("missing tasks and unknown agents reject in every mode before spawning", async () => {
	await assert.rejects(run(subagentTool, { mode: "single", agent: "worker" }), /Missing task/);
	await assert.rejects(run(subagentTool, { mode: "single", agent: "no-such-agent", task: "do it" }), /Unknown agent/);
	await assert.rejects(run(subagentTool, { mode: "parallel", tasks: [{ agent: "no-such-agent", task: "do it" }] }), /Unknown agent/);
	await assert.rejects(run(subagentTool, { mode: "chain", chain: [{ agent: "no-such-agent", task: "do it" }] }), /Unknown agent/);
});

test("whitespace-only tasks reject in every mode before spawning", async () => {
	await assert.rejects(run(subagentTool, { mode: "single", task: "  " }), /Missing task/);
	await assert.rejects(run(subagentTool, { mode: "parallel", tasks: [{ task: "  " }] }), /non-empty task/);
	await assert.rejects(run(subagentTool, { mode: "chain", chain: [{ task: "  " }] }), /non-empty task/);
});

test("parallel arrays above the supported limit reject before any spawn", async () => {
	const tasks = Array.from({ length: 9 }, (_, i) => ({ task: `task ${i}` }));
	await assert.rejects(run(subagentTool, { mode: "parallel", tasks }), /Too many parallel tasks/);
});

test("the tasks description names the ceiling the tool actually enforces", async () => {
	// Ticket #3 direction: wording only. `tasks` declares minItems and no
	// maxItems, so argument validation accepts any batch size; the
	// MAX_PARALLEL_TASKS guard in subagent execute() is the enforcing layer, and
	// the description must name that same ceiling instead of claiming a schema
	// maximum the schema does not declare.
	const tasks = JSON.parse(JSON.stringify(subagentTool.parameters)).properties.tasks;
	assert.equal(tasks.maxItems, undefined, "the schema declares no maximum on tasks, so validation cannot be what rejects a ninth task");
	// Wording-agnostic on purpose: while no maxItems is declared there is no schema
	// maximum to claim, so any use of "max"/"maximum" is a promise the schema
	// does not keep — including a parenthetical that restates the ceiling as one.
	assert.doesNotMatch(tasks.description, /\bmax(?:imum)?\b/i, "no maximum is declared on tasks, so the description must not claim one");

	const named = /at most (\d+) parallel tasks/i.exec(tasks.description);
	assert.ok(named, "the description must name the parallel ceiling a caller actually hits");
	const ceiling = Number(named[1]);

	assert.equal(
		Check(subagentTool.parameters, { mode: "parallel", tasks: Array.from({ length: ceiling }, (_, i) => ({ task: `task ${i}` })) }),
		true,
		"a call at the ceiling is accepted by validation",
	);

	// Above the ceiling, every task string is empty on purpose: if the guard is
	// ever removed, this call still rejects on the per-item empty-task check
	// instead of spawning nine children, so the mutation is observable without
	// starting any process.
	const above = Array.from({ length: ceiling + 1 }, () => ({ task: "" }));
	const rejection = await run(subagentTool, { mode: "parallel", tasks: above }).then(() => null, (error) => error);
	assert.ok(rejection instanceof Error, "a call above the ceiling must reject");
	assert.match(rejection.message, /Too many parallel tasks/, "the rejection is the tool's own parallel-limit guard");
	assert.match(rejection.message, new RegExp(`Max is ${ceiling}\\b`), "the guard states the same ceiling the description names");
	assert.equal(
		Check(subagentTool.parameters, { mode: "parallel", tasks: above }),
		true,
		"validation still accepts above the ceiling, so the rejection comes from the tool and not from the schema",
	);
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
