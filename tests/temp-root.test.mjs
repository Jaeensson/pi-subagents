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
	let calls = 0;
	for (const attempts of [0, -1, Number.NaN]) {
		calls = 0;
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
			`attempts: ${attempts} still reports the failure it saw`,
		);
		assert.equal(calls, 1, `attempts: ${attempts} still attempts the removal once`);
	}
});

test("removing a real temp root takes the whole tree with it", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-temp-root-test-"));
	fs.mkdirSync(path.join(root, "parent-session", "job", "tasks", "task-1"), { recursive: true });
	fs.writeFileSync(path.join(root, "parent-session", "job", "manifest.json"), "{}");
	removeTempRoot(root);
	assert.equal(fs.existsSync(root), false, "the root is gone");
});

test("every suite that writes through the durable store removes its temp roots through the helper", () => {
	// A suite that sets a jobs root writes through the durable store, whose
	// transactions can still be queued when its teardown runs. A raw removal there
	// can lose that race, so those suites must use removeTempRoot — this keeps the
	// conversion from drifting back one call site at a time.
	const testsDir = path.dirname(fileURLToPath(import.meta.url));
	const helper = path.join(testsDir, "support", "temp-root.mjs");
	const rawRemoval = /\brmSync\s*\(|\.promises\.rm\s*\(|\bfs\.rm\s*\(|\brm\s*\(/;
	const offenders = [];
	for (const file of fs.readdirSync(testsDir, { recursive: true, encoding: "utf8" })) {
		if (!file.endsWith(".mjs")) continue;
		const full = path.join(testsDir, file);
		if (full === helper) continue;
		const source = fs.readFileSync(full, "utf8");
		if (!source.includes("setJobsRoot(")) continue;
		if (rawRemoval.test(source)) offenders.push(file);
	}
	assert.deepEqual(offenders, [], "suites that write through the durable store must remove temp roots with removeTempRoot");
	assert.equal(fs.readFileSync(helper, "utf8").includes("const TRANSIENT_RACE_ERRORS"), true, "the helper is the one place that holds the retry policy");
});
