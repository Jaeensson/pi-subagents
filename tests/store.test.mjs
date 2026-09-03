/**
 * Unit tests for store.ts — the durable job store (pure helpers + tmpdir fs).
 * Runs with: node --test tests/store.test.mjs
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, writeFileSync, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	matchSessionFile, isJobExpired, readManifest, writeManifest, updateManifest,
	upsertManifestTask, toManifestTask, listJobManifests, resolveSessionFile,
	isResumableJob, resumePlan, mergeJobListings, manifestPath,
} from "../store.ts";

let root;
beforeEach(() => { root = mkdtempSync(path.join(os.tmpdir(), "pi-subagent-store-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const PSID = "ps-1";
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };

function baseManifest(over = {}) {
	return {
		version: 1, jobId: "job-1", parentSessionId: PSID, mode: "single",
		createdAt: 1, updatedAt: 1, notifyOnComplete: true, status: "running",
		chainTotal: undefined, chain: undefined, errorMessage: undefined,
		tasks: [], ...over,
	};
}
function mt(over = {}) {
	return {
		taskId: "t1", name: "feat-1", agent: "worker", task: "T", cwd: "/p",
		status: "running", model: undefined, tier: undefined, step: undefined, sessionFile: undefined,
		exitCode: -1, stopReason: undefined, errorMessage: undefined,
		usage, finalOutput: undefined, startedAt: 1, finishedAt: undefined,
		...over,
	};
}

test("matchSessionFile finds <ts>_<taskId>.jsonl", () => {
	const entries = ["20260826_101112_abcd-1234.jsonl", "20260826_101200_efgh-5678.jsonl"];
	assert.equal(matchSessionFile(entries, "efgh-5678"), "20260826_101200_efgh-5678.jsonl");
	assert.equal(matchSessionFile(entries, "nope"), undefined);
	// id must match after the underscore, not as a substring of another id
	assert.equal(matchSessionFile(["1_abcd-1234-extra.jsonl"], "abcd-1234"), undefined);
});

test("isJobExpired honors the age boundary and retention 0 disables GC", () => {
	const DAY = 24 * 60 * 60 * 1000;
	assert.equal(isJobExpired(0, 8 * DAY, 7), true);
	assert.equal(isJobExpired(0, 7 * DAY, 7), false); // boundary: exactly 7d is kept
	assert.equal(isJobExpired(0, 800 * DAY, 0), false); // 0 = never delete
});

test("writeManifest/readManifest round-trips atomically (no tmp leftovers)", async () => {
	await writeManifest(root, PSID, baseManifest());
	const raw = JSON.parse(readFileSync(manifestPath(root, PSID, "job-1"), "utf-8"));
	assert.equal(raw.version, 1);
	assert.equal(readManifest(root, PSID, "job-1").jobId, "job-1");
	assert.deepEqual(readdirSync(path.join(root, PSID, "job-1")).sort(), ["manifest.json", "tasks"]); // tasks/ pre-created
	assert.deepEqual(readdirSync(path.join(root, PSID, "job-1")).filter((f) => f.endsWith(".tmp")), []);
});

test("updateManifest mutates and stamps updatedAt; missing manifest is a no-op", async () => {
	await writeManifest(root, PSID, baseManifest());
	await updateManifest(root, PSID, "job-1", (m) => { m.status = "interrupted"; });
	assert.equal(readManifest(root, PSID, "job-1").status, "interrupted");
	assert.ok(readManifest(root, PSID, "job-1").updatedAt > 1);
	await updateManifest(root, PSID, "nope", () => { throw new Error("should not run"); });
});

test("upsertManifestTask inserts once and replaces by taskId", () => {
	const m = baseManifest();
	upsertManifestTask(m, mt({ taskId: "t1" }));
	upsertManifestTask(m, mt({ taskId: "t2", step: 2 }));
	upsertManifestTask(m, mt({ taskId: "t1", status: "completed", finalOutput: "done" }));
	assert.equal(m.tasks.length, 2);
	assert.equal(m.tasks.find((t) => t.taskId === "t1").status, "completed");
});

test("toManifestTask maps registry shape and caps finalOutput", () => {
	const t = toManifestTask({
		id: "t1", name: "feat-1", agent: "worker", task: "T", cwd: "/p", status: "completed",
		model: "prov/m", tier: "fast", step: 3, usage, exitCode: 0, stopReason: "end",
		messages: [{ role: "assistant", content: [{ type: "text", text: "out" }] }],
		startedAt: 5, finishedAt: 9, sessionFile: "/s/1_t1.jsonl",
	});
	assert.equal(t.finalOutput, "out");
	assert.equal(t.name, "feat-1");
	assert.equal(t.sessionFile, "/s/1_t1.jsonl");
	assert.equal(t.tier, "fast");
});

test("listJobManifests scans two levels and skips junk", async () => {
	await writeManifest(root, PSID, baseManifest());
	await writeManifest(root, "ps-2", baseManifest({ jobId: "job-2", parentSessionId: "ps-2" }));
	writeFileSync(path.join(root, "stray.json"), "{}");
	const found = listJobManifests(root);
	assert.deepEqual(found.map((f) => f.jobId).sort(), ["job-1", "job-2"]);
});

test("resolveSessionFile globs the tasks dir", async () => {
	const tasksDir = path.join(root, PSID, "job-1", "tasks");
	await writeManifest(root, PSID, baseManifest()); // pre-creates tasks/
	writeFileSync(path.join(tasksDir, "20260826_120000_t1.jsonl"), "");
	assert.equal(resolveSessionFile(tasksDir, "t1"), path.join(tasksDir, "20260826_120000_t1.jsonl"));
	assert.equal(resolveSessionFile(tasksDir, "gone"), undefined);
});

function finishedJob(tasks, over = {}) {
	return baseManifest({ status: "interrupted", tasks, ...over });
}

test("isResumableJob: running/interrupted/aborted yes, failed/completed no, failed task blocks", () => {
	assert.equal(isResumableJob(finishedJob([mt({ status: "paused" })])), true);
	assert.equal(isResumableJob(finishedJob([mt({ status: "completed" })], {
		mode: "chain", chainTotal: 2, chain: [{ task: "a" }, { task: "b" }],
	})), true); // chain has fresh steps left
	assert.equal(isResumableJob(baseManifest({ status: "failed", tasks: [mt({ status: "failed" })] })), false);
	assert.equal(isResumableJob(baseManifest({ status: "completed", tasks: [mt({ status: "completed" })] })), false);
	assert.equal(isResumableJob(finishedJob([mt({ status: "completed" })])), false); // single, nothing to do
});

test("resumePlan single: respawns resumable tasks", () => {
	const plan = resumePlan(finishedJob([
		mt({ taskId: "t0", status: "completed", finalOutput: "earlier" }),
		mt({ taskId: "t1", status: "interrupted" }),
		mt({ taskId: "t2", status: "paused" }),
	]));
	assert.deepEqual(plan.respawnTasks.map((t) => t.taskId), ["t1", "t2"]);
	assert.equal(plan.freshChainSteps.length, 0);
});

test("resumePlan chain mid-step: respawns the current step, fresh steps after it, previousOutput from last completed", () => {
	const plan = resumePlan(finishedJob([
		mt({ taskId: "s1", step: 1, status: "completed", finalOutput: "STEP-ONE-OUT" }),
		mt({ taskId: "s2", step: 2, status: "aborted" }),
	], { mode: "chain", chainTotal: 3, chain: [{ task: "one" }, { task: "two {previous}" }, { task: "three" }] }));
	assert.deepEqual(plan.respawnTasks.map((t) => t.taskId), ["s2"]);
	assert.equal(plan.freshStartStep, 3);
	assert.deepEqual(plan.freshChainSteps, [{ task: "three" }]);
	assert.equal(plan.previousOutput, "STEP-ONE-OUT");
});

test("resumePlan chain between steps: no respawn, fresh from next step", () => {
	const plan = resumePlan(finishedJob([
		mt({ taskId: "s1", step: 1, status: "completed", finalOutput: "ONE" }),
	], { mode: "chain", chainTotal: 2, chain: [{ task: "one" }, { task: "two" }] }));
	assert.deepEqual(plan.respawnTasks, []);
	assert.equal(plan.freshStartStep, 2);
	assert.deepEqual(plan.freshChainSteps, [{ task: "two" }]);
	assert.equal(plan.previousOutput, "ONE");
});

test("resumePlan returns undefined for non-resumable jobs", () => {
	assert.equal(resumePlan(baseManifest({ status: "completed", tasks: [mt({ status: "completed" })] })), undefined);
	assert.equal(resumePlan(baseManifest({ status: "failed", tasks: [mt({ status: "failed" })] })), undefined);
});

test("mergeJobListings dedupes by id with registry winning", () => {
	const merged = mergeJobListings(
		[{ id: "job-1", source: "registry" }, { id: "job-3", source: "registry" }],
		[{ id: "job-1", source: "disk" }, { id: "job-2", source: "disk" }],
	);
	assert.deepEqual(merged.map((j) => `${j.id}:${j.source}`), ["job-1:registry", "job-3:registry", "job-2:disk"]);
});
