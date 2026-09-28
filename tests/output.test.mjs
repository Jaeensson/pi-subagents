import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { boundOutput, readOutputArtifact, writeOutputArtifact, DEFAULT_OUTPUT_CAP_BYTES, MAX_OUTPUT_LINES } from "../output.ts";
import { previewLine, formatStatusReport } from "../core.ts";
import { emptyUsage, jobs, clearRegistry, setJobsRoot, setParentSessionId } from "../runtime.ts";
import { writeManifest } from "../store.ts";
import { collectResultText, taskResultText } from "../jobs.ts";

test("aggregate output is bounded by bytes and lines, including its path notice", () => {
	const source = Array.from({ length: 5000 }, (_, i) => `😀${i}`).join("\n");
	const bounded = boundOutput(source, { maxBytes: DEFAULT_OUTPUT_CAP_BYTES, maxLines: MAX_OUTPUT_LINES, artifactPath: "/private/full-output.txt" });
	assert.ok(Buffer.byteLength(bounded) <= DEFAULT_OUTPUT_CAP_BYTES);
	assert.ok(bounded.split("\n").length <= MAX_OUTPUT_LINES);
	assert.match(bounded, /Full output: \/private\/full-output\.txt/);
});

test("output artifact is readable and private under durable sidecars directory", () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "subagent-output-test-"));
	try {
		const taskDir = path.join(root, "job", "tasks");
		const artifact = writeOutputArtifact("😀 full output\nline two", { taskId: "task-1", tasksDir: taskDir });
		assert.equal(readFileSync(artifact.path, "utf8"), "😀 full output\nline two");
		assert.equal(readOutputArtifact(artifact.path), "😀 full output\nline two");
		assert.equal(readOutputArtifact(path.join(taskDir, "missing.txt")), undefined);
		assert.ok(artifact.path.startsWith(taskDir));
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("preview notifications remain one compact line when truncated", () => {
	const preview = previewLine("line one\n" + "😀".repeat(200));
	assert.equal(preview.includes("\n"), false);
	assert.equal(preview.includes("Output truncated"), false);
	assert.ok(preview.endsWith("…"));
});

test("single, chain/parallel-style reports, and multi-job collection share aggregate caps", () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "subagent-output-batch-"));
	try {
		const artifact = writeOutputArtifact("😀".repeat(30000), { taskId: "single", tasksDir: path.join(root, "single", "tasks") });
		const task = {
			id: "single", jobId: "single-job", agent: "worker", agentSource: "test", task: "work", cwd: "/tmp",
			status: "completed", startedAt: 1, exitCode: 0, messages: [{ role: "assistant", content: [{ type: "text", text: "😀".repeat(30000) }] }],
			live: {}, stderr: "", usage: emptyUsage(), outputPath: artifact.path,
		};
		const single = taskResultText(task, "😀".repeat(30000));
		assert.ok(Buffer.byteLength(single) <= DEFAULT_OUTPUT_CAP_BYTES);
		assert.ok(single.includes(artifact.path));
		assert.equal(readFileSync(artifact.path, "utf8"), "😀".repeat(30000));

		const multi = Array.from({ length: 8 }, (_, i) => ({ ...task, id: `task-${i}`, jobId: `job-${i}`, outputPath: artifact.path }));
		const parallelLike = formatStatusReport(multi, { maxOutputBytes: DEFAULT_OUTPUT_CAP_BYTES });
		assert.ok(Buffer.byteLength(parallelLike) <= DEFAULT_OUTPUT_CAP_BYTES);
		assert.ok(parallelLike.split("\n").length <= MAX_OUTPUT_LINES);

		clearRegistry();
		for (let i = 0; i < 4; i++) jobs.set(`job-${i}`, { id: `job-${i}`, mode: "parallel", status: "completed", finished: true, tasks: [multi[i]], chainRunnerDone: true, pendingSpawns: 0 });
		const collected = collectResultText(["job-0", "job-1", "job-2", "job-3"]);
		assert.ok(Buffer.byteLength(collected.text) <= DEFAULT_OUTPUT_CAP_BYTES);
		assert.ok(collected.text.split("\n").length <= MAX_OUTPUT_LINES);
	} finally { clearRegistry(); rmSync(root, { recursive: true, force: true }); }
});

test("collection after reload reads persisted rows and returns the artifact path", async () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "subagent-output-persisted-"));
	clearRegistry();
	setJobsRoot(root);
	setParentSessionId("parent-output");
	try {
		const tasksDir = path.join(root, "parent-output", "persisted-job", "tasks");
		const artifact = writeOutputArtifact("full persisted output", { taskId: "persisted-task", tasksDir });
		await writeManifest(root, "parent-output", {
			version: 1, jobId: "persisted-job", parentSessionId: "parent-output", mode: "single",
			createdAt: 1, updatedAt: 1, notifyOnComplete: false, status: "completed",
			tasks: [{ taskId: "persisted-task", agent: "worker", task: "work", cwd: "/tmp", status: "completed", exitCode: 0,
				usage: { ...emptyUsage() }, startedAt: 1, finishedAt: 2, outputPath: artifact.path, outputBytes: artifact.bytes }],
		});
		const collected = collectResultText(["persisted-job"]);
		assert.ok(collected.text.includes(artifact.path));
		assert.equal(readFileSync(artifact.path, "utf8"), "full persisted output");
	} finally {
		clearRegistry(); setJobsRoot(undefined); setParentSessionId(undefined); rmSync(root, { recursive: true, force: true });
	}
});

test("running status includes partial assistant text and usage, but no thinking", () => {
	const report = formatStatusReport([{
		id: "task", agent: "worker", status: "running", task: "work", exitCode: -1,
		messages: [{ role: "assistant", content: [{ type: "thinking", text: "secret thought" }, { type: "text", text: "visible partial" }], usage: { output: 12 } }],
		usage: { ...emptyUsage(), output: 12 }, outputPath: undefined,
	}]);
	assert.match(report, /visible partial/);
	assert.match(report, /↓12/);
	assert.doesNotMatch(report, /secret thought/);
});
