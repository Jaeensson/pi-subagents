import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { removeTempRoot } from "./support/temp-root.mjs";

const raceError = (code = "ENOTEMPTY") => Object.assign(new Error(`${code}: directory not empty`), { code });
const noWait = { retryDelayMs: 0 };

test("a teardown that loses the removal race retries and then succeeds", () => {
	let calls = 0;
	removeTempRoot("/tmp/unused-root", {
		rm: () => {
			calls++;
			if (calls < 3) throw raceError();
		},
		...noWait,
	});
	assert.equal(calls, 3, "the removal retried while the race persisted and stopped once it succeeded");
});

test("a busy tree is retried like an empty-directory race", () => {
	let calls = 0;
	removeTempRoot("/tmp/unused-root", {
		rm: () => {
			calls++;
			if (calls < 2) throw raceError("EBUSY");
		},
		...noWait,
	});
	assert.equal(calls, 2, "EBUSY is a transient race too, so it is retried");
});

test("a non-race removal error is rethrown on the first attempt", () => {
	let calls = 0;
	assert.throws(
		() =>
			removeTempRoot("/tmp/unused-root", {
				rm: () => {
					calls++;
					throw raceError("EACCES");
				},
				...noWait,
			}),
		(error) => error.code === "EACCES",
		"a broken teardown stays visible instead of being retried away",
	);
	assert.equal(calls, 1, "a non-race error is not retried");
});

test("a teardown that keeps losing the race stops at the bound and rethrows", () => {
	let calls = 0;
	assert.throws(
		() =>
			removeTempRoot("/tmp/unused-root", {
				rm: () => {
					calls++;
					throw raceError();
				},
				...noWait,
			}),
		(error) => error.code === "ENOTEMPTY",
		"a cleanup that can never succeed fails loudly instead of retrying forever",
	);
	assert.equal(calls, 10, "the default bound is ten attempts");
});

test("the retries wait between attempts, with the default delay", () => {
	const sleeps = [];
	let calls = 0;
	assert.throws(
		() =>
			removeTempRoot("/tmp/unused-root", {
				rm: () => {
					calls++;
					throw raceError();
				},
				sleep: (ms) => sleeps.push(ms),
			}),
		(error) => error.code === "ENOTEMPTY",
	);
	assert.equal(calls, 10, "ten attempts");
	assert.deepEqual(sleeps, Array(9).fill(25), "nine waits of the default 25 ms, none after the last attempt");
});

test("a nonsense attempt count still removes the tree once and reports a real error", () => {
	for (const attempts of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "3"]) {
		let calls = 0;
		assert.throws(
			() =>
				removeTempRoot("/tmp/unused-root", {
					rm: () => {
						calls++;
						throw raceError();
					},
					attempts,
					...noWait,
				}),
			(error) => error?.code === "ENOTEMPTY",
			`attempts: ${String(attempts)} still reports the failure it saw`,
		);
		assert.equal(calls, 1, `attempts: ${String(attempts)} still attempts the removal once`);
	}
});

test("a real retry waits before its second attempt", () => {
	// No injected sleep here: the default clock must actually pass, so a no-op
	// sleep cannot survive this test.
	const started = Date.now();
	let calls = 0;
	removeTempRoot("/tmp/unused-root", {
		rm: () => {
			calls++;
			if (calls < 2) throw raceError();
		},
	});
	const elapsed = Date.now() - started;
	assert.equal(calls, 2, "it retried once");
	assert.ok(elapsed >= 15, `the retry waited for the default delay (waited ${elapsed}ms)`);
});

test("removing a real temp root takes the whole tree with it", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-temp-root-test-"));
	fs.mkdirSync(path.join(root, "parent-session", "job", "tasks", "task-1"), { recursive: true });
	fs.writeFileSync(path.join(root, "parent-session", "job", "manifest.json"), "{}");
	removeTempRoot(root);
	assert.equal(fs.existsSync(root), false, "the root is gone");
});

test("every suite that enters the durable-store path removes its temp roots through the helper", () => {
	// A suite enters the store path when it sets a jobs root (writes manifests
	// itself) or imports the extension entry (and so can start the tasks that
	// write them). A raw removal there can lose the race described in the helper,
	// so those suites must use removeTempRoot — this keeps the sweep from drifting
	// back one call site at a time.
	const guard = fileURLToPath(import.meta.url);
	const testsDir = path.dirname(guard);
	const helper = path.join(testsDir, "support", "temp-root.mjs");
	const entersStorePath = (source) => source.includes("setJobsRoot(") || /from\s+"\.\.\/index\.ts"|import\(\s*"\.\.\/index\.ts"\s*\)/.test(source);
	const rawRemoval = /\brmSync\s*\(|\.promises\.rm\s*\(|\bfs\.rm\s*\(|\brm\s*\(/;
	const offenders = [];
	let swept = 0;
	for (const file of fs.readdirSync(testsDir, { recursive: true, encoding: "utf8" })) {
		if (!file.endsWith(".mjs")) continue;
		const full = path.join(testsDir, file);
		if (full === helper || full === guard) continue;
		const source = fs.readFileSync(full, "utf8");
		if (!entersStorePath(source)) continue;
		swept++;
		if (rawRemoval.test(source)) offenders.push(file);
	}
	assert.deepEqual(offenders, [], "suites that enter the durable-store path must remove temp roots with removeTempRoot");
	assert.ok(swept >= 7, `the sweep looked at every store-entering suite (found ${swept})`);
	assert.match(
		fs.readFileSync(helper, "utf8"),
		/const TRANSIENT_RACE_ERRORS = new Set\(\["ENOTEMPTY", "EBUSY"\]\)/,
		"the helper itself defines which removal errors are retried",
	);
});
