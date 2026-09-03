# Durable Subagent Jobs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Subagent work survives parent-session death: children write durable pi sessions, jobs persist as manifests bound to the parent session, and pause/resume continues interrupted tasks from their own transcripts.

**Architecture:** Pi-native child sessions (`--session-dir`/`--session-id` per child, `--session <file>` to resume) plus a thin per-job `manifest.json` flushed only at lifecycle boundaries. A new `store.ts` owns all persistence (pure helpers + thin fs). Pause = graceful SIGTERM with a `pauseRequested` flag → tasks end `paused`; resume re-spawns resumable tasks on their session file with a continuation prompt. Only `completed` is terminal.

**Tech Stack:** TypeScript (erasable syntax in tested modules), `node --test` with Node type stripping, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-26-durable-subagent-jobs-design.md` — the plan argues from the spec; executors read both.

## Global Constraints

- `core.ts` and `store.ts` must stay free of pi-package imports and use only erasable TypeScript (no enums, no parameter properties) so `node --test` can type-strip them.
- Tests import ONLY `core.ts`, `store.ts`, `live.ts`, `runtime.ts` — never `jobs.ts`/`process.ts`/`tools/*` (those import pi packages).
- Dependency topological order: `core → store → runtime → process → jobs → tools`; earlier modules never import later ones. `watch-render.ts`/`watch.ts` untouched.
- All disk writes are best-effort try/catch: an unwritable store degrades to in-memory behavior and never breaks spawning.
- Write-ordering invariant: manifest first, child second — a task entry is flushed before its child spawns.
- Every task ends with `npm test` AND `npm run typecheck` green, then a commit.
- Statuses: task = `running | completed | failed | aborted | paused | interrupted`; job = `running | completed | failed | aborted | interrupted`. Resumable task statuses: `paused`, `interrupted`, `aborted`. Resumable job statuses: `running`, `interrupted`, `aborted` (never `failed`/`completed`).
- Store root: `~/.pi/agent/subagent-jobs/<parentSessionId>/<jobId>/{manifest.json, tasks/}`. Child session files: `<tasksDir>/<ts>_<taskId>.jsonl` (pi's naming).

---

### Task 1: Spike — verify pi session flags

**Files:**
- None created. Output: confirmation (or adjustment) recorded in this plan's PR description / commit message of Task 2.

**Interfaces:**
- Produces: confidence that (a) `--session-dir X --session-id Y` creates `X/<timestamp>_Y.jsonl`, (b) `--session <file> -p "…"` appends to that session in JSON print mode.

- [ ] **Step 1: Create-then-inspect**

```bash
mkdir -p /tmp/pi-sess-spike && rm -f /tmp/pi-sess-spike/*.jsonl
pi --mode json -p --no-extensions --no-skills --no-prompt-templates \
  --session-dir /tmp/pi-sess-spike --session-id 11111111-2222-3333-4444-555555555555 \
  "Reply with exactly: SPIKE-ONE" 2>/dev/null | tail -1
ls /tmp/pi-sess-spike
```

Expected: a file matching `*_11111111-2222-3333-4444-555555555555.jsonl` exists. Note the exact filename pattern.

- [ ] **Step 2: Resume-append-and-inspect**

```bash
SESSION_FILE=$(ls /tmp/pi-sess-spike/*_11111111*.jsonl)
pi --mode json -p --no-extensions --no-skills --no-prompt-templates \
  --session "$SESSION_FILE" \
  "What exact text did you reply with in this session? Answer with just that text." 2>/dev/null | tail -1
grep -c '"type":"message_end"' "$SESSION_FILE"
```

Expected: the reply mentions `SPIKE-ONE` (context was restored from the session file), and the session file now contains ≥ 3 `message_end` entries (2 assistant turns + tool/other events may vary).

- [ ] **Step 3: Record findings**

If behavior matches, proceed. If the file lands elsewhere or `--session` refuses the path, STOP and report — the store's `resolveSessionFile` glob and resume flag usage must be adjusted before Task 3/6 are built on them.

---

### Task 2: `core.ts` pure helpers (naming, continuation, statuses, session flags)

**Files:**
- Modify: `core.ts`
- Test: `tests/core.test.mjs`

**Interfaces:**
- Produces (used by Tasks 3–7):
  - `slugifyName(input: string, maxLen?: number): string | undefined` — lowercase `[a-z0-9-]`, ≤ `maxLen` (default 32), `undefined` when empty.
  - `deriveTaskName(name: string | undefined, task: string, taskId: string): string | undefined` — explicit slug, else task-slug + 4-char id suffix.
  - `continuationPrompt(task: string): string`
  - `RESUMABLE_STATUSES: readonly string[]`, `isResumableStatus(status: string | undefined): boolean`
  - `isFailedState(state: { exitCode: number; stopReason?: string; status?: string }): boolean` — gains optional `status`; `paused`/`interrupted` are not failed.
  - `statusIcon(status: string): string` — `running ⏳ · completed ✓ · paused ⏸ · interrupted ⚠ · else ✗`
  - `buildChildArgs(options)` — gains `sessionDir?`, `sessionId?`, `resumeSessionFile?`; session flags replace `--no-session` when present.
  - `formatStatusReport` task header includes `name` when present; `formatCompletionNotification` task rows gain optional `name` (`[agent/name]`).

- [ ] **Step 1: Write the failing tests**

Append to `tests/core.test.mjs` (add `slugifyName`, `deriveTaskName`, `continuationPrompt`, `isResumableStatus`, `statusIcon` to the import list at the top):

```js
test("slugifyName lowercases, strips invalid chars, caps length", () => {
	assert.equal(slugifyName("Feature 1 Implementation!"), "feature-1-implementation");
	assert.equal(slugifyName("  --Weird___Name--  "), "weird-name");
	assert.equal(slugifyName("x".repeat(50)).length, 32);
	assert.equal(slugifyName("x".repeat(50), 8).length, 8);
	assert.equal(slugifyName("!!! --- !!!"), undefined);
	assert.equal(slugifyName(""), undefined);
});

test("deriveTaskName prefers the explicit name and falls back to task slug + id suffix", () => {
	assert.equal(deriveTaskName("My Task!", "whatever", "abcd-1234"), "my-task");
	const fallback = deriveTaskName(undefined, "Fix the auth loop in middleware", "3f2a7b9c-1234");
	assert.equal(fallback, "fix-the-auth-loop-in-middleware-3f2a");
	assert.equal(deriveTaskName(undefined, "!!!", "3f2a7b9c"), "3f2a");
	assert.equal(deriveTaskName(undefined, "!!!", "----"), undefined);
});

test("continuationPrompt embeds the original task", () => {
	const p = continuationPrompt("Do the thing");
	assert.match(p, /^CONTINUATION:/);
	assert.match(p, /transcript has been restored/);
	assert.match(p, /Original task: Do the thing$/);
});

test("resumable statuses are exactly paused, interrupted, aborted", () => {
	assert.deepEqual([...RESUMABLE_STATUSES], ["paused", "interrupted", "aborted"]);
	assert.equal(isResumableStatus("paused"), true);
	assert.equal(isResumableStatus("interrupted"), true);
	assert.equal(isResumableStatus("aborted"), true);
	assert.equal(isResumableStatus("completed"), false);
	assert.equal(isResumableStatus("running"), false);
	assert.equal(isResumableStatus("failed"), false);
	assert.equal(isResumableStatus(undefined), false);
});

test("isFailedState treats paused and interrupted as not failed; still fails aborted without status", () => {
	assert.equal(isFailedState({ exitCode: 1, stopReason: "aborted", status: "paused" }), false);
	assert.equal(isFailedState({ exitCode: 1, stopReason: "aborted", status: "interrupted" }), false);
	assert.equal(isFailedState({ exitCode: 1, stopReason: "aborted" }), true);
	assert.equal(isFailedState({ exitCode: 0, status: "completed" }), false);
	assert.equal(isFailedState({ exitCode: 1, stopReason: "error", status: "failed" }), true);
});

test("statusIcon maps each status", () => {
	assert.equal(statusIcon("running"), "⏳");
	assert.equal(statusIcon("completed"), "✓");
	assert.equal(statusIcon("paused"), "⏸");
	assert.equal(statusIcon("interrupted"), "⚠");
	assert.equal(statusIcon("failed"), "✗");
	assert.equal(statusIcon("aborted"), "✗");
});
```

Also modify the existing `buildChildArgs` tests: update the "builds base args" test to keep asserting `--no-session` (unchanged when no session options), and add:

```js
test("buildChildArgs emits session-dir/id for fresh durable tasks and drops --no-session", () => {
	const args = buildChildArgs({
		task: "T",
		sessionDir: "/store/j1/tasks",
		sessionId: "tid-1",
	});
	assert.ok(args.includes("--session-dir"));
	assert.ok(args.includes("/store/j1/tasks"));
	assert.ok(args.includes("--session-id"));
	assert.ok(args.includes("tid-1"));
	assert.ok(!args.includes("--no-session"));
	assert.equal(args.indexOf("--session-dir"), 2); // right after --mode json -p
});

test("buildChildArgs resumes via --session file", () => {
	const args = buildChildArgs({
		task: "T",
		resumeSessionFile: "/store/j1/tasks/12_tid-1.jsonl",
	});
	assert.ok(args.includes("--session"));
	assert.ok(args.includes("/store/j1/tasks/12_tid-1.jsonl"));
	assert.ok(!args.includes("--no-session"));
	assert.ok(!args.includes("--session-id"));
});
```

And a status-report naming/icon test (uses the existing `formatStatusReport` import):

```js
test("formatStatusReport shows name and paused/interrupted icons", () => {
	const mk = (over) => ({
		id: "t1", agent: "worker", name: "feat-1", status: "running", task: "T",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		messages: [], exitCode: -1, ...over,
	});
	const text = formatStatusReport([mk({ status: "paused" }), mk({ id: "t2", name: undefined, status: "interrupted" })]);
	assert.match(text, /\[worker\/feat-1\].*⏸/s);
	assert.match(text, /\[worker\].*⚠/s);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/core.test.mjs`
Expected: FAIL — `slugifyName` is not exported / new assertions fail.

- [ ] **Step 3: Implement in `core.ts`**

Add after `isFailedState` / near the existing status helpers, and modify `buildChildArgs`, `formatStatusReport`, `formatCompletionNotification` as shown:

```ts
// ── Named sessions & resumability ────────────────────────────────────────────

/** Resumable task statuses: only `completed` (and `failed`) are not resumable. */
export const RESUMABLE_STATUSES: readonly string[] = ["paused", "interrupted", "aborted"];

export function isResumableStatus(status: string | undefined): boolean {
	return status !== undefined && RESUMABLE_STATUSES.includes(status);
}

/** Lowercase `[a-z0-9-]`, ≤ maxLen; undefined when nothing survives. */
export function slugifyName(input: string, maxLen: number = 32): string | undefined {
	const slug = input
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, maxLen)
		.replace(/-+$/g, "");
	return slug || undefined;
}

/** Explicit name slug, else task-slug + 4-char id suffix; undefined when nothing survives. */
export function deriveTaskName(name: string | undefined, task: string, taskId: string): string | undefined {
	const explicit = slugifyName(name ?? "");
	if (explicit) return explicit;
	const suffix = taskId.replace(/[^a-z0-9]/gi, "").slice(0, 4).toLowerCase();
	return suffix ? slugifyName(`${task.slice(0, 40)}-${suffix}`) ?? suffix : undefined;
}

export function continuationPrompt(task: string): string {
	return `CONTINUATION: Your previous run of this task was interrupted; your session transcript has been restored. Continue where you left off and complete the task.\n\nOriginal task: ${task}`;
}

export function statusIcon(status: string): string {
	if (status === "running") return "⏳";
	if (status === "completed") return "✓";
	if (status === "paused") return "⏸";
	if (status === "interrupted") return "⚠";
	return "✗";
}
```

Change `isFailedState`:

```ts
export function isFailedState(state: { exitCode: number; stopReason?: string; status?: string }): boolean {
	if (state.status === "paused" || state.status === "interrupted") return false;
	return state.exitCode !== 0 || state.stopReason === "error" || state.stopReason === "aborted";
}
```

In `buildChildArgs`, replace the head of the args array:

```ts
	const args = ["--mode", "json", "-p"];
	// Durable session selection: resume an existing transcript, create a named
	// one in the store, or stay ephemeral (legacy/tests).
	if (options.resumeSessionFile) {
		args.push("--session", options.resumeSessionFile);
	} else if (options.sessionDir && options.sessionId) {
		args.push("--session-dir", options.sessionDir, "--session-id", options.sessionId);
	} else {
		args.push("--no-session");
	}
	args.push("--no-extensions", "--no-skills", "--no-prompt-templates");
```

(keep the rest of the function unchanged; add `sessionDir?: string; sessionId?: string; resumeSessionFile?: string;` to its options type).

In `formatStatusReport`, change the icon line and the header line:

```ts
		const icon = statusIcon(t.status);
		const lines = [
			`### [${t.agent}${t.name ? `/${t.name}` : ""}] ${icon} ${t.status} — id: ${t.id}`,
			`Task: ${t.task}`,
		];
```

(add `name?: string` to that function's task param type).

In `formatCompletionNotification`, change the task param type to include `name?: string` and use a shared label:

```ts
export function formatCompletionNotification(
	tasks: Array<{
		agent: string;
		name?: string;
		status: "completed" | "failed" | "aborted" | "paused" | "interrupted";
		output: string;
		errorMessage?: string;
	}>,
	taskIds: string[],
): string {
	const label = (t: { agent: string; name?: string }) => `[${t.agent}${t.name ? `/${t.name}` : ""}]`;
	const lines = tasks.map((t) => {
		const icon = t.status === "completed" ? "✓" : "✗";
		if (t.status === "completed") {
			const preview = previewLine(t.output || "(no output)");
			return `- ${icon} ${label(t)} ${preview}`;
		}
		const reason = previewLine(t.errorMessage || `(no error message; status: ${t.status})`);
		return `- ${icon} ${label(t)} ${t.status}: ${reason}`;
	});
	// ...footer unchanged
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/core.test.mjs && npm run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add core.ts tests/core.test.mjs
git commit -m "feat(core): task names, continuation prompts, resumable statuses, session flags"
```

---

### Task 3: `store.ts` — durable job store

**Files:**
- Create: `store.ts`
- Test: `tests/store.test.mjs`

**Interfaces:**
- Consumes: `slugifyName`-free pure core helpers `getFinalOutput`, `truncateOutput`, `isResumableStatus` from `core.ts` (type-only plus functions).
- Produces (used by Tasks 4–7):
  - `MANIFEST_VERSION = 1`; `ManifestTaskStatus`, `ManifestJobStatus`, `ManifestTask`, `ManifestV1`
  - `jobDir(root, psid, jobId)`, `manifestPath(root, psid, jobId)`, `taskSessionDir(root, psid, jobId)`
  - `matchSessionFile(entries: string[], taskId: string): string | undefined`
  - `isJobExpired(updatedAtMs, nowMs, retentionDays): boolean`
  - `writeJsonAtomic(filePath, value): Promise<void>`
  - `readManifest(root, psid, jobId): ManifestV1 | undefined`
  - `writeManifest(root, psid, manifest): Promise<void>` (mkdir -p + atomic)
  - `updateManifest(root, psid, jobId, mutate): Promise<void>` (read-modify-write, stamps `updatedAt`)
  - `upsertManifestTask(m: ManifestV1, task: ManifestTask): void`
  - `toManifestTask(input): ManifestTask` (structural input: registry-task shape + `finalOutput`)
  - `listJobManifests(root): Array<{ root, parentSessionId, jobId, manifest, dir, mtimeMs }>`
  - `resolveSessionFile(tasksDir, taskId): string | undefined`
  - `deletePath(dir): Promise<void>`
  - `pruneEmptyBuckets(root): Promise<void>`
  - `isResumableJob(m: ManifestV1): boolean`
  - `resumePlan(m: ManifestV1): ResumePlan | undefined` — `{ respawnTasks, freshChainSteps, freshStartStep, previousOutput }`
  - `mergeJobListings(registry: ListingRow[], persisted: ListingRow[]): ListingRow[]` (dedupe by id, registry wins)

- [ ] **Step 1: Write the failing tests**

Create `tests/store.test.mjs`:

```js
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
		status: "running", model: undefined, step: undefined, sessionFile: undefined,
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
	assert.equal(readdirSync(path.join(root, PSID, "job-1")).join(","), "manifest.json,tasks"); // tasks/ pre-created
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
		model: "prov/m", step: 3, usage, exitCode: 0, stopReason: "end",
		messages: [{ role: "assistant", content: [{ type: "text", text: "out" }] }],
		startedAt: 5, finishedAt: 9, sessionFile: "/s/1_t1.jsonl",
	});
	assert.equal(t.finalOutput, "out");
	assert.equal(t.name, "feat-1");
	assert.equal(t.sessionFile, "/s/1_t1.jsonl");
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
	writeManifest(root, PSID, baseManifest()); // pre-creates tasks/
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/store.test.mjs`
Expected: FAIL — cannot find module `../store.ts`.

- [ ] **Step 3: Create `store.ts`**

```ts
/**
 * store.ts — Durable job store for subagent tasks.
 *
 * Owns the on-disk layout ~/<agentDir>/subagent-jobs/<parentSessionId>/<jobId>/
 * ({manifest.json, tasks/}) and every pure helper around it: path derivation,
 * manifest schema (version 1), atomic writes, session-file globbing, GC
 * planning, resumability analysis, and registry∪disk listing merge.
 *
 * No pi-package imports: fully unit-testable with `node --test`. All fs
 * operations are best-effort at the call sites that can't throw (see
 * jobs.ts/process.ts wrappers); the raw functions here throw so tests can
 * assert on real behavior.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getFinalOutput, isResumableStatus, truncateOutput } from "./core.ts";

export const MANIFEST_VERSION = 1;
/** Cap for `finalOutput` stored in manifests (mirrors the tool-output cap). */
const FINAL_OUTPUT_CAP_BYTES = 50 * 1024;

// ── Schema ───────────────────────────────────────────────────────────────────

export type ManifestJobStatus = "running" | "completed" | "failed" | "aborted" | "interrupted";
export type ManifestTaskStatus = "running" | "completed" | "failed" | "aborted" | "paused" | "interrupted";

export interface ManifestTask {
	taskId: string;
	name?: string;
	agent: string;
	task: string;
	cwd: string;
	status: ManifestTaskStatus;
	model?: string;
	/** Tier as originally requested (used to re-resolve when no model was recorded). */
	tier?: string;
	step?: number;
	sessionFile?: string;
	exitCode: number;
	stopReason?: string;
	errorMessage?: string;
	usage: {
		input: number; output: number; cacheRead: number; cacheWrite: number;
		cost: number; contextTokens: number; turns: number;
	};
	finalOutput?: string;
	startedAt: number;
	finishedAt?: number;
}

export interface ManifestV1 {
	version: number;
	jobId: string;
	parentSessionId: string;
	mode: "single" | "parallel" | "chain";
	createdAt: number;
	updatedAt: number;
	notifyOnComplete: boolean;
	status: ManifestJobStatus;
	errorMessage?: string;
	chainTotal?: number;
	chain?: Array<{ agent?: string; task: string; cwd?: string; tier?: string; name?: string }>;
	tasks: ManifestTask[];
}

// ── Path derivation (pure) ───────────────────────────────────────────────────

export function jobDir(root: string, parentSessionId: string, jobId: string): string {
	return path.join(root, parentSessionId, jobId);
}
export function manifestPath(root: string, parentSessionId: string, jobId: string): string {
	return path.join(jobDir(root, parentSessionId, jobId), "manifest.json");
}
export function taskSessionDir(root: string, parentSessionId: string, jobId: string): string {
	return path.join(jobDir(root, parentSessionId, jobId), "tasks");
}

// ── Session file resolution ──────────────────────────────────────────────────

/** Find `<ts>_<taskId>.jsonl` in a directory listing (exact id after the underscore). */
export function matchSessionFile(entries: string[], taskId: string): string | undefined {
	const suffix = `_${taskId}.jsonl`;
	return entries.find((e) => e.endsWith(suffix));
}

export function resolveSessionFile(tasksDir: string, taskId: string): string | undefined {
	try {
		const hit = matchSessionFile(fs.readdirSync(tasksDir), taskId);
		return hit ? path.join(tasksDir, hit) : undefined;
	} catch {
		return undefined;
	}
}

// ── GC planning (pure) ───────────────────────────────────────────────────────

export function isJobExpired(updatedAtMs: number, nowMs: number, retentionDays: number): boolean {
	if (!(retentionDays > 0)) return false;
	return nowMs - updatedAtMs > retentionDays * 24 * 60 * 60 * 1000;
}

// ── Manifest I/O ─────────────────────────────────────────────────────────────

export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
	const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	await fs.promises.writeFile(tmp, JSON.stringify(value, null, "\t"), "utf-8");
	await fs.promises.rename(tmp, filePath);
}

function ensureDirs(root: string, parentSessionId: string, jobId: string): void {
	fs.mkdirSync(taskSessionDir(root, parentSessionId, jobId), { recursive: true });
}

export async function writeManifest(root: string, parentSessionId: string, manifest: ManifestV1): Promise<void> {
	ensureDirs(root, parentSessionId, manifest.jobId);
	await writeJsonAtomic(manifestPath(root, parentSessionId, manifest.jobId), manifest);
}

export function readManifest(root: string, parentSessionId: string, jobId: string): ManifestV1 | undefined {
	try {
		const parsed = JSON.parse(fs.readFileSync(manifestPath(root, parentSessionId, jobId), "utf-8"));
		return parsed && typeof parsed === "object" && parsed.version === MANIFEST_VERSION ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/** Read-modify-write a manifest; stamps `updatedAt`. No-op when the manifest is missing. */
export async function updateManifest(
	root: string,
	parentSessionId: string,
	jobId: string,
	mutate: (m: ManifestV1) => void,
): Promise<void> {
	const m = readManifest(root, parentSessionId, jobId);
	if (!m) return;
	mutate(m);
	m.updatedAt = Date.now();
	await writeManifest(root, parentSessionId, m);
}

/** Insert-or-replace a task entry by taskId (in place). */
export function upsertManifestTask(m: ManifestV1, task: ManifestTask): void {
	const i = m.tasks.findIndex((t) => t.taskId === task.taskId);
	if (i >= 0) m.tasks[i] = task;
	else m.tasks.push(task);
}

/** Map a registry-shaped task (structural subset) to a manifest entry. */
export function toManifestTask(input: {
	id: string; name?: string; agent: string; task: string; cwd: string;
	status: ManifestTaskStatus; model?: string; tier?: string; step?: number; sessionFile?: string;
	exitCode: number; stopReason?: string; errorMessage?: string;
	usage: ManifestTask["usage"];
	messages: Array<{ role: string; content: Array<{ type: string; text?: string }> }>;
	startedAt: number; finishedAt?: number;
}): ManifestTask {
	const raw = getFinalOutput(input.messages);
	return {
		taskId: input.id,
		name: input.name,
		agent: input.agent,
		task: input.task,
		cwd: input.cwd,
		status: input.status,
		model: input.model,
		tier: input.tier,
		step: input.step,
		sessionFile: input.sessionFile,
		exitCode: input.exitCode,
		stopReason: input.stopReason,
		errorMessage: input.errorMessage,
		usage: input.usage,
		finalOutput: raw ? truncateOutput(raw, FINAL_OUTPUT_CAP_BYTES) : undefined,
		startedAt: input.startedAt,
		finishedAt: input.finishedAt,
	};
}

export interface ListedJob {
	root: string;
	parentSessionId: string;
	jobId: string;
	manifest: ManifestV1;
	dir: string;
	mtimeMs: number;
}

/** Two-level scan of the store; unreadable dirs are skipped silently. */
export function listJobManifests(root: string): ListedJob[] {
	const out: ListedJob[] = [];
	let buckets: string[];
	try {
		buckets = fs.readdirSync(root);
	} catch {
		return out;
	}
	for (const psid of buckets) {
		let jobIds: string[];
		try {
			jobIds = fs.readdirSync(path.join(root, psid));
		} catch {
			continue;
		}
		for (const jobId of jobIds) {
			try {
				const dir = jobDir(root, psid, jobId);
				const m = readManifest(root, psid, jobId);
				if (!m) continue;
				out.push({ root, parentSessionId: psid, jobId, manifest: m, dir, mtimeMs: fs.statSync(dir).mtimeMs });
			} catch {
				continue;
			}
		}
	}
	return out;
}

export async function deletePath(dir: string): Promise<void> {
	await fs.promises.rm(dir, { recursive: true, force: true });
}

/** Remove parent-session buckets that contain no job dirs anymore. */
export async function pruneEmptyBuckets(root: string): Promise<void> {
	let buckets: string[];
	try {
		buckets = fs.readdirSync(root);
	} catch {
		return;
	}
	for (const b of buckets) {
		try {
			const p = path.join(root, b);
			if (fs.readdirSync(p).length === 0) await fs.promises.rmdir(p);
		} catch {
			/* ignore */
		}
	}
}

// ── Resumability (pure) ──────────────────────────────────────────────────────

const RESUMABLE_JOB_STATUSES: readonly string[] = ["running", "interrupted", "aborted"];

/**
 * A job is resumable when it is non-terminal, no task has failed, and there is
 * work left: a resumable task, or (chain mode) unstarted steps beyond the last
 * completed one.
 */
export function isResumableJob(m: ManifestV1): boolean {
	if (!RESUMABLE_JOB_STATUSES.includes(m.status)) return false;
	if (m.tasks.some((t) => t.status === "failed")) return false;
	if (m.tasks.some((t) => isResumableStatus(t.status))) return true;
	if (m.mode === "chain" && m.chain && m.chainTotal) {
		const highestCompleted = Math.max(0, ...m.tasks.filter((t) => t.status === "completed" && t.step).map((t) => t.step ?? 0));
		return highestCompleted < m.chainTotal;
	}
	return false;
}

export interface ResumePlan {
	/** Tasks to re-spawn on their existing session files. */
	respawnTasks: ManifestTask[];
	/** Chain steps to run fresh (never started). */
	freshChainSteps: NonNullable<ManifestV1["chain"]>;
	/** 1-based step number of the first fresh chain step. */
	freshStartStep: number;
	/** finalOutput of the highest completed chain step (for `{previous}`). */
	previousOutput: string;
}

/**
 * Compute what a resume needs to do. Chain semantics: the lowest incomplete
 * step either resumes via its session (resumable status) or starts fresh; all
 * steps after it that never started run fresh; `{previous}` comes from the
 * highest completed step's finalOutput.
 */
export function resumePlan(m: ManifestV1): ResumePlan | undefined {
	if (!isResumableJob(m)) return undefined;
	const respawnTasks = m.tasks.filter((t) => isResumableStatus(t.status));
	const highestCompleted = Math.max(0, ...m.tasks.filter((t) => t.status === "completed" && t.step).map((t) => t.step ?? 0));
	const previousOutput = m.tasks
		.filter((t) => t.status === "completed" && t.step === highestCompleted)
		.map((t) => t.finalOutput ?? "")[0] ?? "";
	if (m.mode !== "chain" || !m.chain) {
		return { respawnTasks, freshChainSteps: [], freshStartStep: 0, previousOutput };
	}
	const incomplete = m.tasks
		.filter((t) => t.status !== "completed")
		.map((t) => t.step ?? highestCompleted + 1);
	const firstIncomplete = incomplete.length > 0 ? Math.min(...incomplete) : highestCompleted + 1;
	const firstTaskAt = m.tasks.find((t) => (t.step ?? 0) === firstIncomplete);
	const freshStartStep = firstTaskAt && isResumableStatus(firstTaskAt.status) ? firstIncomplete + 1 : firstIncomplete;
	return {
		respawnTasks,
		freshChainSteps: m.chain.slice(freshStartStep - 1),
		freshStartStep,
		previousOutput,
	};
}

// ── Listing merge (pure) ─────────────────────────────────────────────────────

export interface ListingRow {
	id: string;
	[key: string]: unknown;
}

/** Registry rows win over disk rows; both are kept otherwise. */
export function mergeJobListings<T extends ListingRow>(registry: T[], persisted: T[]): T[] {
	const registryIds = new Set(registry.map((r) => r.id));
	return [...registry, ...persisted.filter((r) => !registryIds.has(r.id))];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/store.test.mjs && npm run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add store.ts tests/store.test.mjs
git commit -m "feat(store): durable job store — manifests, session globbing, GC, resume plans"
```

---

### Task 4: `runtime.ts` — statuses, naming fields, paused jobs stay open, session holders

**Files:**
- Modify: `runtime.ts`
- Test: `tests/runtime.test.mjs`

**Interfaces:**
- Produces (used by Tasks 5–7):
  - `TaskStatus` includes `"paused" | "interrupted"`.
  - `Task` gains `name?`, `pauseRequested?`, `sessionDir?`, `sessionFile?`, `finishedAt?`; `Job` gains `parentSessionId?`; `TaskInfo` gains `name?`, `finishedAt?`.
  - `checkJobComplete`: paused tasks keep the job open.
  - `setParentSessionId(id)`, `getParentSessionId()`, `setJobsRoot(root)`, `getJobsRoot()` — session-scoped persistence holders set by `index.ts` (Task 7).

- [ ] **Step 1: Write the failing test**

Append to `tests/runtime.test.mjs`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/runtime.test.mjs`
Expected: FAIL — `job.finished` is `true` on the first check.

- [ ] **Step 3: Implement in `runtime.ts`**

```ts
export type TaskStatus = "running" | "completed" | "failed" | "aborted" | "paused" | "interrupted";
```

In `Task`, after `step?: number;`:

```ts
	/** Human-readable session name (slug); shown in the widget and reports. */
	name?: string;
	/** Set by subagent_pause: the next finalize marks the task `paused`. */
	pauseRequested?: boolean;
	/** Child session dir/file when running with a durable session. */
	sessionDir?: string;
	sessionFile?: string;
	finishedAt?: number;
```

In `Job`, after `pendingSpawns: number;`:

```ts
	/** Parent session bucket this job persists under (undefined = legacy in-memory only). */
	parentSessionId?: string;
```

In `TaskInfo`, add `name?: string;` and `finishedAt?: number;` and pass both through in `toTaskInfo`.

In `checkJobComplete`'s non-chain branch:

```ts
		if (job.pendingSpawns > 0) return;
		if (job.tasks.length === 0 || job.tasks.some((t) => t.status === "running" || t.status === "paused")) return;
```

Add the persistence holders next to the registry maps:

```ts
// ── Session-scoped persistence holders (set by index.ts at session_start) ────

let parentSessionId: string | undefined;
let jobsRoot: string | undefined;

export function setParentSessionId(id: string | undefined): void {
	parentSessionId = id;
}
export function getParentSessionId(): string | undefined {
	return parentSessionId;
}
export function setJobsRoot(root: string | undefined): void {
	jobsRoot = root;
}
export function getJobsRoot(): string | undefined {
	return jobsRoot;
}
```

(`clearRegistry` unchanged — manifest flushes happen in the shutdown sweep before it.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/runtime.test.mjs && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add runtime.ts tests/runtime.test.mjs
git commit -m "feat(runtime): paused/interrupted statuses, task names, persistence holders"
```

---

### Task 5: Spawn-path integration — `process.ts` + `jobs.ts` persist and resume-spawn

**Files:**
- Modify: `process.ts`
- Modify: `jobs.ts`

**Interfaces:**
- Consumes: store API from Task 3; runtime holders from Task 4; core helpers from Task 2.
- Produces (used by Tasks 6–7):
  - `getDefaultJobsRoot(): string` — `path.join(getAgentDir(), "subagent-jobs")` (jobs.ts).
  - `createJob(mode, notifyOnComplete, emit?, chainTotal?, persist?: { parentSessionId: string; chain?: Array<{agent?, task, cwd?, tier?, name?}> })` — stores `parentSessionId` on the job and writes the initial manifest (fire-and-forget).
  - `spawnTask(agent, taskText, cwd, jobId, options)` — options gain `name?: string` and `resume?: { sessionFile?: string; originalTask: string }`; durable sessions when the job has a `parentSessionId`; manifest entry flushed before spawn.
  - `pauseJobTasks(job: Job): Task[]` — flags + SIGTERM; finalize marks `paused`.
  - `markInterruptedSweep(): Promise<void>` — for `session_shutdown`: non-terminal tasks → `interrupted` + manifest flush (children killed afterwards by index.ts; their finalize no-ops on non-running tasks).

- [ ] **Step 1: `jobs.ts` — default root, retention setting, createJob persistence**

Add to the `readSettingsFile` return handling (after `tierConfig`):

```ts
	const rawRetention = subagent && typeof subagent === "object" && !Array.isArray(subagent)
		? (subagent as Record<string, unknown>).jobRetentionDays
		: undefined;
```

return it as `jobRetentionDays: typeof rawRetention === "number" && Number.isFinite(rawRetention) && rawRetention >= 0 ? Math.floor(rawRetention) : undefined` and widen the function's return type to include it. Export a `readJobRetentionDays(): number` helper (`?? 7` default, exported for index.ts).

Add the default root + a typed re-export of manifest helpers used by tools:

```ts
export function getDefaultJobsRoot(): string {
	return path.join(getAgentDir(), "subagent-jobs");
}
```

Change `createJob`:

```ts
export function createJob(
	mode: JobMode,
	notifyOnComplete: boolean,
	emit?: (content: string, details: ToolDetails) => void,
	chainTotal?: number,
	persist?: { parentSessionId: string; chain?: Array<{ agent?: string; task: string; cwd?: string; tier?: string; name?: string }> },
): Job {
	const job: Job = {
		id: randomUUID(),
		mode,
		status: "running",
		tasks: [],
		chainTotal,
		notifyOnComplete,
		notified: false,
		finished: false,
		chainRunnerDone: false,
		pendingSpawns: 0,
		emit,
		parentSessionId: persist?.parentSessionId,
	};
	jobs.set(job.id, job);
	if (persist) {
		// Write-ordering invariant: manifest exists before any child spawns.
		void writeManifest(getJobsRoot() ?? getDefaultJobsRoot(), persist.parentSessionId, {
			version: MANIFEST_VERSION,
			jobId: job.id,
			parentSessionId: persist.parentSessionId,
			mode,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			notifyOnComplete,
			status: "running",
			chainTotal,
			chain: persist.chain,
			tasks: [],
		});
	}
	return job;
}
```

(Add imports: `getDefaultJobsRoot` is local; from store: `MANIFEST_VERSION, writeManifest, updateManifest, upsertManifestTask, toManifestTask, readManifest, resolveSessionFile, resumePlan, isResumableStatus, type ManifestTask`.)

- [ ] **Step 2: `process.ts` — durable spawn, pause-aware finalize, flushes**

In `spawnTask`, extend the options type with `name?: string`, `modelOverride?: string`, and `resume?: { sessionFile?: string; originalTask: string }`. Change the model resolution head to honor the override (a resumed task is pinned to its recorded model):

```ts
	const resolution = resolveModel({
		callTier: options.modelOverride ? undefined : options.tier,
		agentTier: options.modelOverride ? undefined : agent.tier,
		tierConfig: options.modelCtx.tierConfig,
		defaultModel: options.modelCtx.defaultModel,
		catalog: options.modelCtx.catalog,
	});
	const effectiveModel = options.modelOverride ?? resolution.model;
	const contextWindow = resolveContextWindow(effectiveModel ?? options.modelCtx.defaultModel, options.modelCtx.catalog);
```

(use `model: effectiveModel` on the task object and in `buildChildArgs`; keep `tierUsed`/`tierNote` from `resolution` — they are undefined when an override pins the model.)

After the existing `const job = jobs.get(jobId); if (job) job.pendingSpawns++; incRunningCount(); updateStatusWidget();` lines, add:

```ts
	const root = getJobsRoot();
	const psid = job?.parentSessionId;
	const sessionDir = root && psid ? taskSessionDir(root, psid, jobId) : undefined;
	if (sessionDir) {
		task.sessionDir = sessionDir;
		task.name = deriveTaskName(options.name, taskText, task.id);
		// Manifest first, child second (write-ordering invariant).
		void updateManifest(root!, psid!, jobId, (m) => {
			upsertManifestTask(m, toManifestTask(task));
		});
	}
```

Note: `toManifestTask` accepts the task's structural shape; at spawn time `finalOutput` is undefined and `exitCode` is the initial `-1`. Resume tasks pass their manifest name via `options.name` — names from the manifest are already slugs, so `deriveTaskName` round-trips them unchanged.

In the spawn body, change `buildChildArgs` + finalize wiring:

```ts
		const effectiveTask = options.resume ? continuationPrompt(options.resume.originalTask) : taskText;
		const args = buildChildArgs({
			model: effectiveModel,
			tools: agent.tools,
			extensions: agent.extensions,
			systemPromptFile,
			task: effectiveTask,
			sessionDir,
			sessionId: task.id,
			resumeSessionFile: options.resume?.sessionFile,
		});
```

In `finalizeTask`, before `task.status = ...`:

```ts
	task.finishedAt = Date.now();
	const pauseIntended = task.pauseRequested === true;
```

and change the status line to:

```ts
	task.status = pauseIntended
		? "paused"
		: code === 0 && sr !== "error" && sr !== "aborted"
			? "completed"
			: sr === "aborted" ? "aborted" : "failed";
```

At the end of `finalizeTask` (after `checkJobComplete(job)`), resolve + flush the durable record. `finalizeTask` is a standalone function, so it re-derives the store location from the registry:

```ts
	const root = getJobsRoot();
	const psid = jobs.get(task.jobId)?.parentSessionId;
	if (root && psid) {
		if (!task.sessionFile && task.sessionDir) task.sessionFile = resolveSessionFile(task.sessionDir, task.id);
		void updateManifest(root, psid, task.jobId, (m) => {
			upsertManifestTask(m, toManifestTask(task));
		});
	}
```

(The model flush needs no extra hook: the child's first `message_end` sets `task.model` in the stdout handler, and the finalize flush above records it — no per-event flush.)

Add pause + shutdown sweep functions at the end of `process.ts`:

```ts
/** Graceful pause: flag + SIGTERM; finalize marks affected tasks `paused`. */
export function pauseJobTasks(job: Job): Task[] {
	const affected = job.tasks.filter((t) => t.status === "running");
	for (const t of affected) {
		t.pauseRequested = true;
		killTask(t);
	}
	return affected;
}

/**
 * Shutdown sweep: mark every non-terminal task `interrupted` and flush its
 * manifest entry, then the job as `interrupted`. Called by index.ts BEFORE the
 * kill sweep — finalizeTask's `status !== "running"` guard makes the later
 * child-exit events no-ops, so the interrupted record survives.
 */
export async function markInterruptedSweep(): Promise<void> {
	const root = getJobsRoot();
	for (const t of tasks.values()) {
		if (t.status !== "running" && t.status !== "paused") continue;
		if (t.status === "running") {
			t.status = "interrupted";
			t.finishedAt = Date.now();
		}
		if (!root || !t.jobId) continue;
		const psid = jobs.get(t.jobId)?.parentSessionId;
		if (!psid) continue;
		if (!t.sessionFile && t.sessionDir) t.sessionFile = resolveSessionFile(t.sessionDir, t.id);
		try {
			await updateManifest(root, psid, t.jobId, (m) => {
				upsertManifestTask(m, toManifestTask(t));
				m.status = "interrupted";
			});
		} catch {
			/* best-effort */
		}
	}
}
```

(`toManifestTask` on a `paused` task keeps its status — the `continue` above skips `paused` tasks' status change but still flushes their manifest entry so `sessionFile`/`finalOutput` are current; keep the loop body as written: paused tasks are flushed without a status change.)

- [ ] **Step 3: `jobs.ts` — chain resume entry point**

Refactor `runChain` into a reusable loop:

```ts
export function runChain(
	job: Job,
	chain: Array<{ agent?: string; task: string; cwd?: string; tier?: string; name?: string }>,
	agents: AgentSummary[],
	defaultCwd: string,
	modelCtx: ModelContext,
	signal?: AbortSignal,
) {
	void runChainFrom(job, chain, 0, "", agents, defaultCwd, modelCtx, signal);
}

/** Chain runner core: starts at `startIndex` (0-based) with `initialPrevious` for `{previous}`. */
export function runChainFrom(
	job: Job,
	chain: Array<{ agent?: string; task: string; cwd?: string; tier?: string; name?: string }>,
	startIndex: number,
	initialPrevious: string,
	agents: AgentSummary[],
	defaultCwd: string,
	modelCtx: ModelContext,
	signal?: AbortSignal,
) {
	void (async () => {
		let previousOutput = initialPrevious;
		for (let i = startIndex; i < chain.length; i++) {
			const step = chain[i];
			const agent = resolveAgent(step.agent, agents);
			if (!agent) {
				job.status = "failed";
				job.errorMessage = `Chain stopped at step ${i + 1}: unknown agent "${step.agent}". Available agents: ${formatAgentList(agents).text}.`;
				break;
			}
			const task = await spawnTask(agent, step.task.replace(/\{previous\}/g, previousOutput), step.cwd ?? defaultCwd, job.id, {
				step: i + 1,
				tier: step.tier,
				name: step.name,
				modelCtx,
			});
			const completed = await waitForTask(task.id, { signal });
			if (!completed && signal?.aborted) {
				killTask(task);
				await waitForTask(task.id, {});
				job.status = "aborted";
				job.errorMessage = `Chain aborted at step ${i + 1} (${step.agent})`;
				break;
			}
			if (isFailedState(task)) {
				job.status = "failed";
				job.errorMessage = `Chain stopped at step ${i + 1} (${step.agent}): ${getResultOutput(task)}`;
				break;
			}
			previousOutput = getFinalOutput(task.messages);
		}
		if (job.status === "running") job.status = "completed";
		job.chainRunnerDone = true;
		checkJobComplete(job);
	})();
}
```

(the body is the existing runner with `startIndex`/`initialPrevious` and `name: step.name` added; `runChain` keeps its exact signature so `tools/subagent.ts` is unchanged.)

Also add `job.status = "interrupted"` support: in `finalizeTask`/`checkJobComplete` no change needed — manifest job status is flushed by the sweep; the in-memory job is torn down anyway.

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm test`
Expected: both green (no new unit tests — process/jobs import pi packages; behavior is covered by Tasks 2–4 tests plus the integration in Task 6).

- [ ] **Step 5: Commit**

```bash
git add process.ts jobs.ts
git commit -m "feat(spawn): durable child sessions, manifest flushes, pause-aware finalize, chain resume core"
```

---

### Task 6: Tools — `subagent_pause`, `subagent_resume`, naming on `subagent`, status merge

**Files:**
- Create: `tools/subagent-pause.ts`
- Create: `tools/subagent-resume.ts`
- Modify: `tools/subagent.ts`
- Modify: `tools/subagent-status.ts`
- Modify: `jobs.ts` (resumeJob, pauseJob, listing builders)

**Interfaces:**
- Consumes: everything from Tasks 2–5.
- Produces: registered tools `subagent_pause` (`{ jobId }`), `subagent_resume` (`{ jobId?, wait?, notifyOnComplete? }`); `subagent` gains `name` params; `subagent_status.jobIds` becomes optional and merges disk jobs.

- [ ] **Step 1: `jobs.ts` — pauseJob, resumeJob, listing builder**

Add to `jobs.ts`:

```ts
// ── Pause & resume ───────────────────────────────────────────────────────────

export function pauseJob(jobId: string): { job: Job; paused: Task[] } | undefined {
	const job = jobs.get(jobId);
	if (!job) return undefined;
	return { job, paused: pauseJobTasks(job) };
}

export interface ResumeInit {
	agents: AgentSummary[];
	defaultCwd: string;
	modelCtx: ModelContext;
	wait: boolean;
	notifyOnComplete: boolean;
	emit?: (content: string, details: ToolDetails) => void;
	signal?: AbortSignal;
}

/**
 * Rebuild a persisted job into the live registry and re-spawn its resumable
 * tasks (on their session files) plus any fresh chain steps. Returns the live
 * job plus advisory notes, or an error string.
 */
export async function resumeJob(jobId: string, init: ResumeInit): Promise<{ job?: Job; notes?: string[]; error?: string }> {
	const root = getJobsRoot();
	const psid = getParentSessionId();
	if (!root || !psid) return { error: "No durable job store for this session." };
	const manifest = readManifest(root, psid, jobId);
	if (!manifest) return { error: `No persisted job "${jobId}" for this session (jobs are bound to the session that spawned them).` };
	if (jobs.has(jobId)) return { error: `Job ${jobId} is already active in this session.` };
	const plan = resumePlan(manifest);
	if (!plan) return { error: `Job ${jobId} is not resumable (status: ${manifest.status}).` };

	// Rebuild the registry job. Completed tasks come back with their manifest
	// finalOutput as a synthetic assistant message so every existing render
	// path (getFinalOutput, task lists, usage) works unchanged.
	const job: Job = {
		id: manifest.jobId,
		mode: manifest.mode,
		status: "running",
		tasks: [],
		chainTotal: manifest.chainTotal,
		notifyOnComplete: init.notifyOnComplete,
		notified: false,
		finished: false,
		chainRunnerDone: false,
		pendingSpawns: 0,
		emit: init.emit,
		parentSessionId: psid,
	};
	for (const t of manifest.tasks) {
		if (t.status === "completed") {
			job.tasks.push({
				id: t.taskId, jobId: job.id, agent: t.agent, agentSource: "manifest",
				task: t.task, cwd: t.cwd, status: "completed", startedAt: t.startedAt,
				finishedAt: t.finishedAt, exitCode: 0, name: t.name,
				messages: t.finalOutput ? [{ role: "assistant", content: [{ type: "text", text: t.finalOutput }] }] : [],
				live: emptyLiveTrace(), stderr: "", usage: { ...emptyUsage(), ...t.usage },
				model: t.model, step: t.step, sessionFile: t.sessionFile,
			});
		}
	}
	jobs.set(job.id, job);

	// Flush the manifest back to running before spawning (write-ordering).
	void updateManifest(root, psid, job.id, (m) => {
		m.status = "running";
		m.notifyOnComplete = init.notifyOnComplete;
	});

	const notes: string[] = [];
	// Spawn one resumable task on its session transcript. Shared by the
	// fire-and-forget path (single/chain) and the rate-limited path (parallel).
	const respawn = (t: (typeof plan.respawnTasks)[number]) => {
		const agent = resolveAgent(t.agent, init.agents);
		if (!agent) {
			notes.push(`agent "${t.agent}" no longer defined; task ${t.name ?? t.taskId} runs on the default agent`);
		}
		const sessionFile = t.sessionFile;
		if (!sessionFile) {
			notes.push(`session file missing for task ${t.name ?? t.taskId}; re-running from scratch`);
		}
		return spawnTask(agent ?? resolveAgent(undefined, init.agents)!, t.task, t.cwd, job.id, {
			step: t.step,
			tier: t.model ? undefined : t.tier,
			modelOverride: t.model,
			name: t.name,
			modelCtx: init.modelCtx,
			resume: sessionFile ? { sessionFile, originalTask: t.task } : undefined,
		});
	};

	if (manifest.mode === "parallel" && plan.respawnTasks.length > 1) {
		// Parallel: spawn + wait inside the same concurrency limit as fresh runs.
		const drained = mapWithConcurrencyLimit(plan.respawnTasks, MAX_CONCURRENCY, async (t) => {
			await respawn(t);
			await waitForTask(t.taskId, { signal: init.signal });
		});
		if (init.wait) await drained;
		else void drained.catch(() => {});
	} else {
		for (const t of plan.respawnTasks) void respawn(t);
	}

	if (manifest.mode === "chain") {
		// The respawned current step must finish before fresh steps run.
		const current = plan.respawnTasks[0];
		if (current) {
			void (async () => {
				await waitForTask(current.taskId, { signal: init.signal });
				runChainFrom(job, manifest.chain ?? [], plan.freshStartStep - 1, plan.previousOutput, init.agents, init.defaultCwd, init.modelCtx, init.signal);
			})();
		} else {
			runChainFrom(job, manifest.chain ?? [], plan.freshStartStep - 1, plan.previousOutput, init.agents, init.defaultCwd, init.modelCtx, init.signal);
		}
	}

	return { job, notes: notes.length ? notes : undefined };
}
```

Add `export const MAX_CONCURRENCY = 4;` at the top of `jobs.ts` (moved from `tools/subagent.ts`, which now imports it) and imports: from runtime `emptyLiveTrace, emptyUsage, getParentSessionId, getJobsRoot, waitForTask`; from store `readManifest, resumePlan, updateManifest`; add `pauseJobTasks` to the existing `./process.ts` import.

Add the listing builder:

```ts
export interface JobListing {
	id: string;
	mode: JobMode | "collect";
	jobStatus: string;
	createdAt: number;
	updatedAt: number;
	resumable: boolean;
	tasks: Array<{ taskId: string; name?: string; agent: string; status: string; step?: number }>;
	source: "registry" | "disk";
}

/** Registry jobs + persisted jobs for the current parent session, deduped. */
export function listJobsForCurrentSession(): JobListing[] {
	const root = getJobsRoot();
	const psid = getParentSessionId();
	const registry: JobListing[] = [...jobs.values()].map((j) => ({
		id: j.id, mode: j.mode, jobStatus: j.finished ? j.status : "running",
		createdAt: Math.min(...j.tasks.map((t) => t.startedAt), Date.now()),
		updatedAt: Date.now(),
		resumable: j.tasks.some((t) => isResumableStatus(t.status)),
		tasks: j.tasks.map((t) => ({ taskId: t.id, name: t.name, agent: t.agent, status: t.status, step: t.step })),
		source: "registry" as const,
	}));
	const persisted: JobListing[] = root && psid
		? listJobManifests(root)
			.filter((e) => e.parentSessionId === psid)
			.map((e) => ({
				id: e.jobId, mode: e.manifest.mode, jobStatus: e.manifest.status,
				createdAt: e.manifest.createdAt, updatedAt: e.manifest.updatedAt,
				resumable: isResumableJob(e.manifest),
				tasks: e.manifest.tasks.map((t) => ({ taskId: t.taskId, name: t.name, agent: t.agent, status: t.status, step: t.step })),
				source: "disk" as const,
			}))
		: [];
	return mergeJobListings(registry, persisted);
}

export function formatJobListings(list: JobListing[]): string {
	if (list.length === 0) return "(no subagent jobs for this session)";
	return list
		.map((j) => {
			const done = j.tasks.filter((t) => t.status === "completed").length;
			const names = j.tasks.map((t) => `${t.agent}${t.name ? `/${t.name}` : ""}(${t.status})`).join(", ") || "(no tasks)";
			return `- ${j.id} [${j.mode}] ${j.jobStatus} ${done}/${j.tasks.length} done${j.resumable ? " · resumable" : ""} · ${names} · source: ${j.source}`;
		})
		.join("\n");
}
```

- [ ] **Step 2: `tools/subagent-pause.ts` (new)**

```ts
/**
 * tools/subagent-pause.ts — The `subagent_pause` tool.
 *
 * Gracefully interrupts a running job: running tasks are flagged and
 * SIGTERM'd; they finalize as `paused` with their session files intact.
 * Resume later with subagent_resume. Paused jobs hold subagent_wait callers
 * until they time out — resume to let them proceed.
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { displayAgentName } from "../core.ts";
import { pauseJob } from "../jobs.ts";
import type { ToolDetails } from "../runtime.ts";

const subagentPauseParams = Type.Object({
	jobId: Type.String({ description: "Job id returned by subagent (wait: false)" }),
});

export const subagentPauseTool = defineTool<typeof subagentPauseParams, ToolDetails>({
	name: "subagent_pause",
	label: "Subagent Pause",
	description:
		"Gracefully pause a running background subagent job: running tasks are interrupted, their session transcripts are finalized to disk, and they can be resumed later with subagent_resume. Paused jobs hold subagent_wait callers until they time out.",
	promptSnippet: "Gracefully pause a running background subagent job (resume later with subagent_resume)",
	parameters: subagentPauseParams,

	async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
		const found = pauseJob(params.jobId);
		if (!found) {
			return {
				content: [{ type: "text", text: `Unknown job id (not found in this session): ${params.jobId}` }],
				details: { mode: "collect", jobIds: [params.jobId], tasks: [] },
				isError: true,
			};
		}
		const lines = found.paused.length
			? found.paused.map((t) => `- ⏸ [${displayAgentName(t.agent)}${t.name ? `/${t.name}` : ""}] ${t.id}`)
			: ["(no running tasks — nothing to pause)"];
		return {
			content: [{
				type: "text",
				text: [
					`Paused ${found.paused.length} task(s) in job ${params.jobId}.`,
					...lines,
					"",
					`Resume with subagent_resume { jobId: "${params.jobId}" }.`,
				].join("\n"),
			}],
			details: { mode: "collect", jobIds: [params.jobId], tasks: found.job.tasks.map((t) => ({
				id: t.id, agent: t.agent, agentSource: t.agentSource, task: t.task, status: t.status,
				exitCode: t.exitCode, step: t.step, messages: t.messages, usage: t.usage, name: t.name,
			})) },
		};
	},

	renderCall(args, theme, _context) {
		return new Text(
			theme.fg("toolTitle", theme.bold("subagent_pause ")) + theme.fg("accent", String(args.jobId ?? "")),
			0, 0,
		);
	},
});
```

- [ ] **Step 3: `tools/subagent-resume.ts` (new)**

```ts
/**
 * tools/subagent-resume.ts — The `subagent_resume` tool.
 *
 * {} lists persisted + live jobs for this parent session; { jobId } resumes an
 * interrupted/paused/aborted job: resumable tasks re-spawn on their session
 * transcripts, chain jobs continue from the lowest incomplete step.
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	buildModelContext, collectResultText, formatJobListings, listJobsForCurrentSession,
	resumeJob, waitForJobOrKill,
} from "../jobs.ts";
import { discoverUserAgents } from "../agents.ts";
import { getParentSessionId, type ToolDetails } from "../runtime.ts";

const subagentResumeParams = Type.Object({
	jobId: Type.Optional(Type.String({ description: "Omit to list persisted jobs for this session; provide to resume that job." })),
	wait: Type.Optional(Type.Boolean({ description: "true (default): block until the resumed job finishes. false: resume in background.", default: true })),
	notifyOnComplete: Type.Optional(Type.Boolean({ description: "Deliver a completion summary when the resumed batch finishes. Default: true.", default: true })),
});

export const subagentResumeTool = defineTool<typeof subagentResumeParams, ToolDetails>({
	name: "subagent_resume",
	label: "Subagent Resume",
	description:
		"Resume interrupted or paused subagent jobs from a previous run of THIS session (jobs are bound to the session that spawned them). Omit jobId to list persisted jobs; provide jobId to continue where the tasks left off (chain jobs continue from the lowest incomplete step).",
	promptSnippet: "List or resume interrupted/paused subagent jobs bound to this session",
	parameters: subagentResumeParams,

	async execute(_toolCallId, params, signal, onUpdate, ctx) {
		if (params.jobId === undefined) {
			const text = [
				`Subagent jobs for session ${getParentSessionId() ?? "(unknown)"}:`,
				formatJobListings(listJobsForCurrentSession()),
			].join("\n");
			return { content: [{ type: "text", text }], details: { mode: "collect", jobIds: [], tasks: [] } };
		}

		const agents = discoverUserAgents();
		const modelCtx = buildModelContext(ctx);
		const wait = params.wait ?? true;
		const notifyOnComplete = params.notifyOnComplete ?? true;
		const emit = onUpdate
			? (content: string, details: ToolDetails) => onUpdate({ content: [{ type: "text", text: content }], details })
			: undefined;
		const { job, notes, error } = await resumeJob(params.jobId, {
			agents,
			defaultCwd: ctx.cwd,
			modelCtx,
			wait,
			notifyOnComplete,
			emit,
			signal: wait ? signal : undefined,
		});
		if (error || !job) {
			return {
				content: [{ type: "text", text: error ?? "Resume failed." }],
				details: { mode: "collect", jobIds: [params.jobId], tasks: [] },
				isError: true,
			};
		}
		const note = notes?.length ? `\n\nNotes:\n- ${notes.join("\n- ")}` : "";
		if (!wait) {
			return {
				content: [{ type: "text", text: `Resumed job ${job.id} in the background.${note}\n\nThey will run in the background while you continue working. Collect with subagent_wait (jobId: ${job.id}).` }],
				details: { mode: job.mode, jobIds: [job.id], tasks: [] },
			};
		}
		const completed = await waitForJobOrKill(job.id, signal);
		const { text } = collectResultText([job.id]);
		return {
			content: [{ type: "text", text: completed ? `${text}${note}` : `Resume of job ${job.id}: ${job.status}: ${job.errorMessage || "(aborted)"}` }],
			details: { mode: "collect", jobIds: [job.id], tasks: job.tasks.map((t) => ({
				id: t.id, agent: t.agent, agentSource: t.agentSource, task: t.task, status: t.status,
				exitCode: t.exitCode, step: t.step, messages: t.messages, usage: t.usage, name: t.name,
			})) },
			isError: !completed,
		};
	},

	renderCall(args, theme, _context) {
		const what = args.jobId ? `resume ${args.jobId}` : "(list persisted jobs)";
		return new Text(theme.fg("toolTitle", theme.bold("subagent_resume ")) + theme.fg("accent", what), 0, 0);
	},
});
```

- [ ] **Step 4: `tools/subagent.ts` — `name` params + persistence wiring**

Add to the schema: `name: Type.Optional(Type.String({ description: "Short human-readable name for this subagent session (single mode), e.g. \"feature1-implementation\". Shown in the status widget. Defaults to a slug of the task." }))` on the top-level params, and `name: Type.Optional(Type.String({ description: "Short session name for this task (shown in the status widget)." }))` inside `TaskItem` and `ChainItem`.

Wire through: `createJob(..., persist)` calls become (all three modes):

```ts
			const persist = getParentSessionId() && getJobsRoot()
				? { parentSessionId: getParentSessionId()!, chain: hasChain ? params.chain : undefined }
				: undefined;
			const job = createJob("chain", shouldNotify(wait, notifyOnComplete), emit, params.chain!.length, persist);
```

(analogously for `"parallel"` and `"single"` with `persist` computed once before the mode branches, `chain` only set for chain mode). Import `getParentSessionId, getJobsRoot` from `../runtime.ts`, and `MAX_CONCURRENCY` from `../jobs.ts` — delete the local `const MAX_CONCURRENCY = 4;` from this file.

Every `spawnTask(...)` call gains `name:` — single: `name: params.name`; parallel/chain: `name: t.name` / `name: c.name`.

Replace the three per-status icon ternaries in `renderResult` (collect, chain, and parallel/ single branches) with the shared helper — e.g. in the collect branch:

```ts
			const icon = statusIcon(t.status) === "✓" ? theme.fg("success", "✓")
				: statusIcon(t.status) === "⏳" ? theme.fg("warning", "⏳")
				: statusIcon(t.status) === "⏸" ? theme.fg("warning", "⏸")
				: statusIcon(t.status) === "⚠" ? theme.fg("warning", "⚠")
				: theme.fg("error", "✗");
```

(and the analogous chain/parallel/single lines; import `statusIcon` from `../core.ts`.)

- [ ] **Step 5: `tools/subagent-status.ts` — optional jobIds + disk merge**

Change the schema: `jobIds: Type.Optional(Type.Array(Type.String({ description: "Job ids to check. Omit to list all jobs (live + persisted for this session)." })))`.

Change `execute`:

```ts
	async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
		if (!params.jobIds || params.jobIds.length === 0) {
			return {
				content: [{ type: "text", text: formatJobListings(listJobsForCurrentSession()) }],
				details: { mode: "collect" as const, jobIds: [], tasks: [] },
			};
		}
		const tasksList = params.jobIds.flatMap((id) => jobs.get(id)?.tasks ?? []);
		const unknown = params.jobIds.filter((id) => !jobs.has(id) && !hasPersistedJob(id));
		// Persisted (crashed) jobs are not in the registry; render their manifest
		// tasks so status works for interrupted jobs too.
		const persistedTasks = params.jobIds.filter((id) => !jobs.has(id) && hasPersistedJob(id))
			.flatMap((id) => persistedTaskInfos(id));
		const parts: string[] = [];
		if (tasksList.length > 0) parts.push(formatStatusReport(tasksList, { maxOutputBytes: 2000 }));
		if (persistedTasks.length > 0) parts.push(formatStatusReport(persistedTasks, { maxOutputBytes: 2000 }));
		if (unknown.length > 0) parts.push(`Unknown job id(s) (not found in this session): ${unknown.join(", ")}`);
		return {
			content: [{ type: "text", text: parts.join("\n\n---\n\n") || "(no tasks)" }],
			details: { mode: "collect" as const, jobIds: params.jobIds, tasks: [...tasksList.map(toTaskInfo), ...persistedTasks] },
		};
	},
```

Add two helpers to `jobs.ts` (imported here alongside `formatJobListings`):

```ts
export function hasPersistedJob(jobId: string): boolean {
	const root = getJobsRoot();
	const psid = getParentSessionId();
	return Boolean(root && psid && readManifest(root, psid, jobId));
}

/** Map a persisted job's manifest tasks to TaskInfo-shaped rows for status rendering. */
export function persistedTaskInfos(jobId: string): TaskInfo[] {
	const root = getJobsRoot();
	const psid = getParentSessionId();
	const m = root && psid ? readManifest(root, psid, jobId) : undefined;
	if (!m) return [];
	return m.tasks.map((t) => ({
		id: t.taskId, agent: t.agent, agentSource: "manifest", task: t.task,
		status: t.status, exitCode: t.exitCode, step: t.step, name: t.name,
		messages: t.finalOutput ? [{ role: "assistant", content: [{ type: "text", text: t.finalOutput }] }] : [],
		usage: { ...emptyUsage(), ...t.usage }, model: t.model,
		stopReason: t.stopReason, errorMessage: t.errorMessage, finishedAt: t.finishedAt,
	}));
}
```

Update the tool `description` to mention: "Omit jobIds to list all jobs for this session, including interrupted jobs from a previous run of it."

- [ ] **Step 6: Verify**

Run: `npm run typecheck && npm test`
Expected: green. Manual smoke (no commit yet): `/reload` in pi, spawn `subagent {agent:"scout", task:"say hi", wait:false, name:"smoke-1"}` — widget shows `Scout smoke-1`; `subagent_pause {jobId}` pauses it; `subagent_resume {jobId}` continues it.

- [ ] **Step 7: Commit**

```bash
git add jobs.ts tools/subagent.ts tools/subagent-status.ts tools/subagent-pause.ts tools/subagent-resume.ts
git commit -m "feat(tools): subagent_pause + subagent_resume, task names, persisted-job status merge"
```

---

### Task 7: `index.ts` — surfacing, GC, shutdown sweep, registration; widget naming; interrupted-jobs card

**Files:**
- Modify: `index.ts`
- Modify: `tui.ts`

**Interfaces:**
- Consumes: store GC + listings (Task 3), `markInterruptedSweep` (Task 5), `readJobRetentionDays` (Task 5), runtime holders (Task 4).
- Produces: message type `subagent-jobs-interrupted` renderer; session-scoped store wiring; tools registered.

- [ ] **Step 1: `tui.ts` — widget names + interrupted-jobs card**

In `runningTaskLines`, replace the per-task line builder:

```ts
		const name = t.name ? theme.fg("accent", ` ${t.name}`) : "";
		lines.push(`  ${theme.fg("warning", "▸")} ${theme.fg("accent", t.agent)}${name}${modelText}${theme.fg("dim", ` ${elapsed}`)}${step}  ${lastActivity(t, theme)}`);
```

Add the interrupted-jobs renderer (next to `registerCompletionRenderer`):

```ts
// ── Interrupted-jobs card ────────────────────────────────────────────────────
//
// Injected (no turn trigger) on session_start when this session's store bucket
// holds non-terminal jobs from a previous run:
//
//   ⏸ 2 interrupted subagent job(s) from a previous run of this session
//   - <jobId> [chain] interrupted 1/3 done · resumable
//   Resume with subagent_resume { jobId: "…" } — or omit jobId to list all.

export const INTERRUPTED_MESSAGE_TYPE = "subagent-jobs-interrupted";

export function registerInterruptedRenderer(pi: ExtensionAPI): void {
	pi.registerMessageRenderer(INTERRUPTED_MESSAGE_TYPE, (message, { outputPad }, theme) => {
		const content = typeof message.content === "string" ? message.content : "";
		const box = new Box(outputPad, 1, (line) => theme.bg("customMessageBg", line));
		box.addChild(new Text(theme.fg("warning", "⏸ Interrupted subagent jobs found"), 0, 0));
		box.addChild(new Text(content, 0, 0));
		return box;
	});
}
```

- [ ] **Step 2: `index.ts` — wire it all**

At the top, add imports: from `./store.ts` — `isJobExpired, deletePath, pruneEmptyBuckets, listJobManifests, isResumableJob`; from `./runtime.ts` — `setParentSessionId, setJobsRoot, getParentSessionId`; from `./jobs.ts` — `getDefaultJobsRoot, readJobRetentionDays, listJobsForCurrentSession, formatJobListings`; from `./process.ts` — `markInterruptedSweep`; from `./tui.ts` — `registerInterruptedRenderer, INTERRUPTED_MESSAGE_TYPE`; plus the two new tools (`subagentPauseTool`, `subagentResumeTool`).

In the default export:

```ts
	registerCompletionRenderer(pi);
	registerInterruptedRenderer(pi);
```

Replace the `session_start` handler (note: only `startup`/`resume` surface interrupted jobs — never `new`; all reasons still bind the store and run GC):

```ts
	pi.on("session_start", async (event, ctx) => {
		// Session-scoped persistence: bucket + GC + surfacing for THIS session.
		const psid = ctx.sessionManager?.getSessionId?.();
		setParentSessionId(psid);
		const root = getDefaultJobsRoot();
		setJobsRoot(root);
		if (psid) {
			try {
				const retention = readJobRetentionDays();
				const entries = listJobManifests(root).filter((e) => e.parentSessionId === psid);
				const now = Date.now();
				for (const e of entries) {
					if (isJobExpired(e.manifest.updatedAt, now, retention)) await deletePath(e.dir);
				}
				await pruneEmptyBuckets(root);
				// Surface only when THIS session resumes; a brand-new session gets a
				// fresh id and must never see another session's jobs (spec).
				if (event.reason === "startup" || event.reason === "resume") {
					const remaining = listJobManifests(root).filter(
						(e) => e.parentSessionId === psid && isResumableJob(e.manifest),
					);
					if (remaining.length > 0) {
						api.sendMessage(
							{
								customType: INTERRUPTED_MESSAGE_TYPE,
								content: formatJobListings(listJobsForCurrentSession()),
								display: true,
							},
							{ triggerTurn: false },
						);
					}
				}
			} catch {
				/* store problems never block startup */
			}
		}
		if (!ctx.hasUI) return;
		setUi(ctx.ui);
		ctx.ui.onTerminalInput((data) => handleWatchInput(data));
	});
```

(Verify the `sendMessage` options type in `@earendil-works/pi-coding-agent` typings; the requirement is: custom message, `display: true`, NO turn trigger — it must sit in context until the user's next prompt.)

Replace the `session_shutdown` handler's sweep section:

```ts
	pi.on("session_shutdown", async () => {
		// Drop UI references first so task-close callbacks during teardown no-op.
		setUi(undefined);
		disposeWidget();
		disposeWatch();
		await markInterruptedSweep();
		for (const t of listRunningTasks()) killTask(t);
		clearRegistry();
	});
```

Register the new tools:

```ts
	pi.registerTool(subagentPauseTool);
	pi.registerTool(subagentResumeTool);
```

- [ ] **Step 3: Verify**

Run: `npm run typecheck && npm test`
Expected: green.

Manual end-to-end (documented in the commit body):
1. `pi` → spawn a background chain of 2 sleep-ish tasks → `/exit` while running.
2. `pi -c` → interrupted-jobs card appears; `subagent_resume {jobId}` continues from the transcript (`subagent_status` shows step 1 completed, step 2 resumed).
3. Brand-new `pi` in the same directory → no card (different session id).

- [ ] **Step 4: Commit**

```bash
git add index.ts tui.ts
git commit -m "feat(session): surface interrupted jobs on resume, retention GC, durable shutdown sweep"
```

---

### Task 8: Docs — README + AGENTS.md

**Files:**
- Modify: `README.md`
- Modify: `AGENTS.md`

- [ ] **Step 1: Update `AGENTS.md`**

Module layout list gains:

```markdown
  - `store.ts` — durable job store: manifest schema, atomic writes, session-file
    globbing, GC planning, resume plans (pure; no pi imports; tested)
```

(depending graph line becomes: `live → runtime → process → jobs → tools` plus `core → store → runtime`; `store` may be imported by process/jobs/tools/index.)

Commands section unchanged. Key conventions gain:

```markdown
- Subagent children run durable pi sessions under
  `~/.pi/agent/subagent-jobs/<parentSessionId>/<jobId>/`; jobs are bound to the
  parent session. Pause (`subagent_pause`) = graceful interrupt; resume
  (`subagent_resume`) continues from the child's own transcript. Only
  `completed` is terminal. Retention: `subagent.jobRetentionDays` in
  settings.json (default 7; 0 = keep forever).
```

Replace the "Subagent children run `pi --mode json -p --no-session ...`" line with:

```markdown
- Subagent children run `pi --mode json -p --session-dir <tasksDir> --session-id
  <taskId>` (resumes use `--session <file>` + a continuation prompt), still with
  `--no-extensions --no-skills --no-prompt-templates`.
```

- [ ] **Step 2: Update `README.md`**

In the tool list add `subagent_pause` and `subagent_resume` with one-line descriptions matching their `description` strings; document the `name` parameter on `subagent`; add a "Durability & resume" section: store location, session binding, what survives crashes, retention setting, and the manual recovery command (`pi -c` → interrupt card → `subagent_resume`).

- [ ] **Step 3: Verify + commit**

Run: `npm test && npm run typecheck`
Expected: green.

```bash
git add README.md AGENTS.md
git commit -m "docs: durable jobs, pause/resume tools, task names, retention setting"
```
