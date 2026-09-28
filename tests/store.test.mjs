/**
 * Unit tests for store.ts — the durable job store (pure helpers + tmpdir fs).
 * Runs with: node --test tests/store.test.mjs
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { mkdtempSync, rmSync, readdirSync, writeFileSync, readFileSync, statSync, mkdirSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
	jobDir, reconcileManifest, isManifestOwnerLive, claimManifest, deleteExpiredJob, matchSessionFile, isJobExpired,
	readManifest, writeManifest, updateManifest, upsertManifestTask, toManifestTask,
	listJobManifests, resolveSessionFile, isResumableJob, isResumableJobView, resumePlan,
	mergeJobListings, manifestPath,
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
function taskFor(taskId) {
	return { ...mt({ taskId }), usage: { ...usage } };
}
function runNode(code, args) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["-e", code, ...args], { stdio: "inherit" });
		child.once("error", reject);
		child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`child exited ${code ?? signal}`)));
	});
}

test("matchSessionFile finds <ts>_<taskId>.jsonl", () => {
	const entries = ["20260826_101112_abcd-1234.jsonl", "20260826_101200_efgh-5678.jsonl"];
	assert.equal(matchSessionFile(entries, "efgh-5678"), "20260826_101200_efgh-5678.jsonl");
	assert.equal(matchSessionFile(entries, "nope"), undefined);
	assert.equal(matchSessionFile(["1_abcd-1234-extra.jsonl"], "abcd-1234"), undefined);
});

test("isJobExpired honors the age boundary and retention 0 disables GC", () => {
	const DAY = 24 * 60 * 60 * 1000;
	assert.equal(isJobExpired(0, 8 * DAY, 7), true);
	assert.equal(isJobExpired(0, 7 * DAY, 7), false);
	assert.equal(isJobExpired(0, 800 * DAY, 0), false);
});

test("output artifact metadata validates and survives manifest round-trip", async () => {
	const tasksDir = path.join(root, PSID, "job-1", "tasks");
	const outputPath = path.join(tasksDir, "t1-output.txt");
	const task = toManifestTask({
		...mt({ status: "completed", exitCode: 0 }), id: "t1", messages: [], startedAt: 1, finishedAt: 2,
		usage, outputPath, outputBytes: 123,
	});
	await writeManifest(root, PSID, baseManifest({ status: "completed", tasks: [task] }));
	assert.equal(readManifest(root, PSID, "job-1").tasks[0].outputPath, outputPath);
	assert.equal(readManifest(root, PSID, "job-1").tasks[0].outputBytes, 123);
	assert.equal((await import("../store.ts")).validateManifest(baseManifest({ tasks: [{ ...task, outputPath: path.join(root, "outside.txt") }] }), { parentSessionId: PSID, jobId: "job-1", tasksDir }), false);
});

test("writeManifest/readManifest round-trips atomically with restrictive modes and no temp leftovers", async () => {
	await writeManifest(root, PSID, baseManifest());
	const file = manifestPath(root, PSID, "job-1");
	const raw = JSON.parse(readFileSync(file, "utf-8"));
	assert.equal(raw.version, 1);
	assert.equal(readManifest(root, PSID, "job-1").jobId, "job-1");
	assert.equal(statSync(file).mode & 0o777, 0o600);
	assert.deepEqual(readdirSync(path.join(root, PSID, "job-1")).sort(), ["manifest.json", "tasks"]);
	assert.deepEqual(readdirSync(path.join(root, PSID, "job-1")).filter((f) => f.endsWith(".tmp")), []);
});

test("updateManifest mutates and stamps updatedAt; missing manifest is a no-op", async () => {
	await writeManifest(root, PSID, baseManifest());
	await updateManifest(root, PSID, "job-1", (m) => { m.status = "interrupted"; });
	assert.equal(readManifest(root, PSID, "job-1").status, "interrupted");
	assert.ok(readManifest(root, PSID, "job-1").updatedAt > 1);
	await updateManifest(root, PSID, "nope", () => { throw new Error("should not run"); });
});

test("initial manifest creation queues before a delayed first lock acquisition", async () => {
	const originalOpen = fs.promises.open;
	let delayed = false;
	fs.promises.open = async function (file, ...args) {
		if (!delayed && String(file).endsWith("manifest.json.lock")) {
			delayed = true;
			await new Promise((resolve) => setTimeout(resolve, 80));
		}
		return originalOpen.call(this, file, ...args);
	};
	try {
		const creating = writeManifest(root, PSID, baseManifest());
		const updating = updateManifest(root, PSID, "job-1", (m) => { m.errorMessage = "must survive"; });
		await Promise.all([creating, updating]);
		assert.equal(delayed, true);
		assert.equal(readManifest(root, PSID, "job-1").errorMessage, "must survive");
	} finally {
		fs.promises.open = originalOpen;
	}
});

test("a rejected manifest transaction does not poison later queued transactions", async () => {
	await writeManifest(root, PSID, baseManifest());
	await assert.rejects(updateManifest(root, PSID, "job-1", (m) => { m.status = "invalid"; }), /invalid subagent manifest/);
	await updateManifest(root, PSID, "job-1", (m) => { m.errorMessage = "recovered"; });
	assert.equal(readManifest(root, PSID, "job-1").errorMessage, "recovered");
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

test("listJobManifests scans two levels and skips junk, corrupt data, and traversal", async () => {
	await writeManifest(root, PSID, baseManifest());
	await writeManifest(root, "ps-2", baseManifest({ jobId: "job-2", parentSessionId: "ps-2" }));
	writeFileSync(path.join(root, "stray.json"), "{}");
	writeFileSync(path.join(root, PSID, "broken"), "not a directory");
	const malformedDir = path.join(root, PSID, "malformed");
	mkdirSync(malformedDir);
	mkdirSync(path.join(malformedDir, "tasks"));
	writeFileSync(path.join(malformedDir, "manifest.json"), JSON.stringify({ version: 1, jobId: "malformed", parentSessionId: PSID, tasks: [{}] }));
	assert.deepEqual(listJobManifests(root).map((f) => f.jobId).sort(), ["job-1", "job-2"]);
	assert.throws(() => jobDir(root, "../outside", "job"));
	assert.throws(() => jobDir(root, PSID, "../outside"));
	assert.equal(readManifest(root, "../outside", "job-1"), undefined);
});

test("resolveSessionFile globs the tasks dir", async () => {
	const tasksDir = path.join(root, PSID, "job-1", "tasks");
	await writeManifest(root, PSID, baseManifest());
	writeFileSync(path.join(tasksDir, "20260826_120000_t1.jsonl"), "");
	assert.equal(resolveSessionFile(tasksDir, "t1"), path.join(tasksDir, "20260826_120000_t1.jsonl"));
	assert.equal(resolveSessionFile(tasksDir, "gone"), undefined);
});

function finishedJob(tasks, over = {}) { return baseManifest({ status: "interrupted", tasks, ...over }); }

test("isResumableJob: statuses, failures, terminal jobs, and incomplete chains", () => {
	assert.equal(isResumableJob(finishedJob([mt({ status: "paused" })])), true);
	assert.equal(isResumableJob(finishedJob([mt({ status: "completed" })], {
		mode: "chain", chainTotal: 2, chain: [{ task: "a" }, { task: "b" }],
	})), true);
	assert.equal(isResumableJob(baseManifest({ status: "failed", tasks: [mt({ status: "failed" })] })), false);
	assert.equal(isResumableJob(baseManifest({ status: "completed", tasks: [mt({ status: "completed" })] })), false);
	assert.equal(isResumableJob(finishedJob([mt({ status: "completed" })])), false);
});

test("aborted single job with aborted task is resumable", () => {
	assert.equal(isResumableJob(baseManifest({ status: "aborted", tasks: [mt({ status: "aborted", stopReason: "aborted", exitCode: 143 })] })), true);
});

test("isResumableJobView mirrors persisted-job rules", () => {
	assert.equal(isResumableJobView({ status: "aborted", mode: "single", tasks: [{ status: "aborted" }] }), true);
	assert.equal(isResumableJobView({ status: "failed", mode: "single", tasks: [{ status: "aborted" }] }), false);
	assert.equal(isResumableJobView({ status: "interrupted", mode: "parallel", tasks: [{ status: "failed" }, { status: "aborted" }] }), false);
	assert.equal(isResumableJobView({ status: "running", mode: "parallel", tasks: [{ status: "paused" }] }), true);
	assert.equal(isResumableJobView({ status: "running", mode: "chain", chain: [], chainTotal: 3, tasks: [{ status: "completed", step: 1 }] }), true);
	assert.equal(isResumableJobView({ status: "running", mode: "chain", chain: [], chainTotal: 3, tasks: [{ status: "completed", step: 3 }] }), false);
	const m = baseManifest({ status: "aborted", tasks: [mt({ status: "aborted" })] });
	assert.equal(isResumableJob(m), isResumableJobView(m));
});

test("resumePlan single respawns resumable tasks", () => {
	const plan = resumePlan(finishedJob([
		mt({ taskId: "t0", status: "completed", finalOutput: "earlier" }),
		mt({ taskId: "t1", status: "interrupted" }), mt({ taskId: "t2", status: "paused" }),
	]));
	assert.deepEqual(plan.respawnTasks.map((t) => t.taskId), ["t1", "t2"]);
	assert.equal(plan.freshChainSteps.length, 0);
});

test("resumePlan chain mid-step and between steps", () => {
	const mid = resumePlan(finishedJob([
		mt({ taskId: "s1", step: 1, status: "completed", finalOutput: "STEP-ONE-OUT" }),
		mt({ taskId: "s2", step: 2, status: "aborted" }),
	], { mode: "chain", chainTotal: 3, chain: [{ task: "one" }, { task: "two {previous}" }, { task: "three" }] }));
	assert.deepEqual(mid.respawnTasks.map((t) => t.taskId), ["s2"]);
	assert.equal(mid.freshStartStep, 3);
	assert.deepEqual(mid.freshChainSteps, [{ task: "three" }]);
	assert.equal(mid.previousOutput, "STEP-ONE-OUT");
	const between = resumePlan(finishedJob([mt({ taskId: "s1", step: 1, status: "completed", finalOutput: "ONE" })], {
		mode: "chain", chainTotal: 2, chain: [{ task: "one" }, { task: "two" }],
	}));
	assert.deepEqual(between.respawnTasks, []);
	assert.equal(between.freshStartStep, 2);
	assert.deepEqual(between.freshChainSteps, [{ task: "two" }]);
	assert.equal(between.previousOutput, "ONE");
});

test("resumePlan is undefined for non-resumable jobs", () => {
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

test("recovery interrupts stale running tasks and discovers transcript by task ID", async () => {
	const m = baseManifest({ owner: { pid: 2147483000, host: os.hostname() }, tasks: [mt({ taskId: "recover-me" })] });
	await writeManifest(root, PSID, m);
	const transcript = path.join(root, PSID, "job-1", "tasks", "123_recover-me.jsonl");
	writeFileSync(transcript, "");
	const recovered = await reconcileManifest(root, PSID, "job-1");
	assert.equal(recovered.status, "interrupted");
	assert.equal(recovered.tasks[0].status, "interrupted");
	assert.equal(recovered.tasks[0].sessionFile, transcript);
});

test("recovery and GC ownership checks leave live local and remote owners untouched", async () => {
	assert.equal(isManifestOwnerLive({ pid: process.pid, host: os.hostname() }), true);
	assert.equal(isManifestOwnerLive({ pid: 2147483000, host: os.hostname() }), false);
	assert.equal(isManifestOwnerLive({ pid: 1, host: "other-host" }), true);
	await writeManifest(root, PSID, baseManifest({ owner: { pid: process.pid, host: os.hostname() }, tasks: [mt()] }));
	const recovered = await reconcileManifest(root, PSID, "job-1");
	assert.equal(recovered.status, "running");
	assert.equal(recovered.tasks[0].status, "running");
	assert.equal((await claimManifest(root, PSID, "job-1")).owner.pid, process.pid);
	await writeManifest(root, PSID, baseManifest({ owner: { pid: 1, host: "other-host" } }));
	assert.equal(await claimManifest(root, PSID, "job-1"), undefined);
});

test("GC rechecks owner and expiry under the manifest lock across parent-session buckets", async () => {
	const live = baseManifest({ parentSessionId: "old-live", updatedAt: 1, owner: { pid: process.pid, host: os.hostname() } });
	const expired = baseManifest({ jobId: "old-dead-job", parentSessionId: "old-dead", updatedAt: 1, owner: { pid: 2147483000, host: os.hostname() } });
	await writeManifest(root, live.parentSessionId, live);
	await writeManifest(root, expired.parentSessionId, expired);
	assert.equal(await deleteExpiredJob(root, live.parentSessionId, live.jobId, 100 * 24 * 60 * 60 * 1000, 1), false);
	assert.equal(fsExists(path.join(root, live.parentSessionId, live.jobId)), true);
	assert.equal(await deleteExpiredJob(root, expired.parentSessionId, expired.jobId, 100 * 24 * 60 * 60 * 1000, 1), true);
	assert.equal(fsExists(path.join(root, expired.parentSessionId, expired.jobId)), false);
});

function fsExists(file) { try { statSync(file); return true; } catch { return false; } }

test("real concurrent processes perform whole-manifest transactions without lost updates", async () => {
	await writeManifest(root, PSID, baseManifest());
	const storeUrl = pathToFileURL(path.resolve("store.ts")).href;
	const code = `import { updateManifest } from ${JSON.stringify(storeUrl)};\nconst [root, psid, id, taskId] = process.argv.slice(1);\nawait updateManifest(root, psid, id, m => m.tasks.push({ taskId, agent: "worker", task: taskId, cwd: "/p", status: "running", exitCode: -1, startedAt: 2, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 } }));`;
	await Promise.all(Array.from({ length: 12 }, (_, i) => runNode(code, [root, PSID, "job-1", `parallel-${i}`])));
	assert.deepEqual(readManifest(root, PSID, "job-1").tasks.map((t) => t.taskId).sort(),
		Array.from({ length: 12 }, (_, i) => `parallel-${i}`).sort());
});
