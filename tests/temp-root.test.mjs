import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { removeTempRoot } from "./support/temp-root.mjs";

const raceError = (code = "ENOTEMPTY") => Object.assign(new Error(`${code}: directory not empty`), { code });

test("removing a temp root retries only a transient race and gives up after a bounded number of attempts", () => {
	// A removal that hits the race twice, then succeeds: the tree is gone and the
	// retries stopped as soon as the walk was clean.
	let racingCalls = 0;
	removeTempRoot("/tmp/unused-root", {
		rm: () => {
			racingCalls++;
			if (racingCalls < 3) throw raceError();
		},
		retryDelayMs: 0,
	});
	assert.equal(racingCalls, 3, "the removal retried while the race persisted and stopped once it succeeded");

	// EBUSY is the other transient race the filesystem reports for a teardown.
	let busyCalls = 0;
	removeTempRoot("/tmp/unused-root", {
		rm: () => {
			busyCalls++;
			if (busyCalls < 2) throw raceError("EBUSY");
		},
		retryDelayMs: 0,
	});
	assert.equal(busyCalls, 2, "a busy tree is retried too");

	// A teardown that can never succeed must not be swallowed: it stops at the
	// bound and rethrows the race error.
	let boundedCalls = 0;
	assert.throws(
		() =>
			removeTempRoot("/tmp/unused-root", {
				rm: () => {
					boundedCalls++;
					throw raceError();
				},
				retryDelayMs: 0,
			}),
		(error) => error.code === "ENOTEMPTY",
		"a teardown that keeps racing fails loudly instead of retrying forever",
	);
	assert.equal(boundedCalls, 10, "the default bound is ten attempts");

	// Anything that is not a race is rethrown at once: a broken teardown stays visible.
	let failedCalls = 0;
	assert.throws(
		() =>
			removeTempRoot("/tmp/unused-root", {
				rm: () => {
					failedCalls++;
					throw raceError("EACCES");
				},
				retryDelayMs: 0,
			}),
		(error) => error.code === "EACCES",
		"a non-race error is not retried",
	);
	assert.equal(failedCalls, 1, "a non-race error is rethrown on the first attempt");
});

test("removing a real temp root takes the whole tree with it", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-temp-root-test-"));
	fs.mkdirSync(path.join(root, "parent-session", "job", "tasks", "task-1"), { recursive: true });
	fs.writeFileSync(path.join(root, "parent-session", "job", "manifest.json"), "{}");
	removeTempRoot(root);
	assert.equal(fs.existsSync(root), false, "the root is gone");
});
