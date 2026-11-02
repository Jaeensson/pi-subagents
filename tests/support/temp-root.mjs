import * as fs from "node:fs";

/**
 * Remove a test suite's temporary root directory.
 *
 * A suite that spawns tasks writes their manifest through the durable store, and
 * the store's last write for a task can still be landing when the teardown runs:
 * the child's close handler runs `void finalizeTask(...)` (process.ts:628-643) and
 * `setTaskStatus` runs `void settleUnlaunchedTask(...)` (process.ts:278), so their
 * awaited `persistTaskSnapshot` transactions have no caller to await them, and
 * `manifestQueues` in store.ts has no drain. `fs.rmSync` walks the tree while such
 * a transaction's `writeJsonAtomic` rename puts an entry back, so the walk can end
 * in ENOTEMPTY and the test fails on its cleanup instead of on its subject.
 * (jobs.ts exports `flushManifestTask`, which fires a `void updateManifest`, but it
 * has no call sites on this tree, so it is not the writer behind this race.)
 *
 * Node's own `maxRetries`/`retryDelay` cannot recover from that: those options
 * retry only the final `rmdirSync` of a directory already walked, so an entry
 * that landed after the walk is never removed (node's rimraf re-reads a
 * directory only once, before its retries start). Re-running the whole removal
 * walks the tree again and takes the stray entry with it.
 *
 * Only race-shaped filesystem errors are retried; anything else is rethrown at
 * once, and the whole removal is bounded so a teardown that can never succeed
 * still fails loudly.
 */

const TRANSIENT_RACE_ERRORS = new Set(["ENOTEMPTY", "EBUSY"]);
const DEFAULT_ATTEMPTS = 10;
const DEFAULT_RETRY_DELAY_MS = 25;

/** Block for `ms` without spinning the CPU; test teardowns are synchronous. */
function sleepSync(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function removeTempRoot(dir, { rm = fs.rmSync, attempts = DEFAULT_ATTEMPTS, retryDelayMs = DEFAULT_RETRY_DELAY_MS } = {}) {
	let lastError;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			rm(dir, { recursive: true, force: true });
			return;
		} catch (error) {
			if (!TRANSIENT_RACE_ERRORS.has(error?.code)) throw error;
			lastError = error;
			if (attempt < attempts && retryDelayMs > 0) sleepSync(retryDelayMs);
		}
	}
	throw lastError;
}
