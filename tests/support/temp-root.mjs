import * as fs from "node:fs";

/**
 * Remove a test suite's temporary root directory.
 *
 * A suite that spawns tasks writes their manifests through the durable store, and
 * its teardown can begin with those transactions still pending. Measured at the
 * teardown of `fresh parallel dispatch records all eight durable tasks before
 * starting at most four children` (12 runs, 12 identical): all eight tasks are
 * `finalizing`, eight store transactions are queued behind `manifestQueues`
 * (store.ts) — one started but not yet inside `writeJsonAtomic`, seven waiting for
 * it — and zero writes are inside `writeJsonAtomic`.
 *
 * They are queued, not in flight, because nothing awaits them. `waitForTask`
 * returns on the status `finalizeTask` sets at process.ts:308, before that
 * function's persist at :337 (runtime.ts:352 returns as soon as `isDone()`), and
 * the writers themselves are unawaited `void`ed calls: process.ts:278
 * (`cancelQueuedTask`), :522 (the `launch()` path inside `spawnTask`), :628 and
 * :632 (the close and error handlers) and :636 (the spawn catch). :643 is the
 * non-void call in `spawnTask`'s outer catch. jobs.ts:220 (`flushManifestTask`)
 * fires a `void updateManifest` too, but it has no call sites on this tree.
 *
 * A queued transaction is harmless until it runs. When one runs as the teardown
 * is walking, its `writeJsonAtomic` rename can put an entry back into a directory
 * the walk has already emptied, and the walk ends in ENOTEMPTY — the failure CI
 * reported at `fresh-parallel`.
 *
 * Node's own `maxRetries`/`retryDelay` do not recover from that. On Node 22.19
 * (the leg that failed; Node 26 delegates `rmSync` to the native `binding.rmSync`)
 * `_rmdirSync` in `lib/internal/fs/rimraf.js` re-reads a directory once after
 * ENOTEMPTY, removes what it read, and then retries only the terminal `rmdirSync`.
 * An entry that lands between that re-read and the retry is never read again, and
 * the retries keep rejecting the same non-empty directory. Re-running the whole
 * removal re-reads the tree and takes the stray entry with it.
 *
 * Only race-shaped filesystem errors are retried; anything else is rethrown at
 * once, and the whole removal is bounded so a teardown that can never succeed
 * still fails loudly.
 *
 * Excluded suites: `mux-extension.test.mjs` does spawn children whose close
 * handlers call `void finalizeTask`, but it cannot race — every child close is
 * followed by an awaited `waitForJob`, and shutdown marks tasks interrupted
 * durably before reaping, so `finalizeTask` returns at its status guard
 * (process.ts:304) and no transaction is pending at its teardown. Every other
 * suite that removes a temp root never calls `setJobsRoot`, so no durable write
 * exists for it to race.
 */

const TRANSIENT_RACE_ERRORS = new Set(["ENOTEMPTY", "EBUSY"]);
const DEFAULT_ATTEMPTS = 10;
const DEFAULT_RETRY_DELAY_MS = 25;

/** Block for `ms` without spinning the CPU; test teardowns are synchronous. */
function sleepSync(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function removeTempRoot(dir, { rm = fs.rmSync, sleep = sleepSync, attempts = DEFAULT_ATTEMPTS, retryDelayMs = DEFAULT_RETRY_DELAY_MS } = {}) {
	// A teardown must always attempt at least one removal, however the caller
	// spells the bound; otherwise there is no error to report.
	const tries = Number.isFinite(attempts) && attempts >= 1 ? Math.floor(attempts) : 1;
	let lastError;
	for (let attempt = 1; attempt <= tries; attempt++) {
		try {
			rm(dir, { recursive: true, force: true });
			return;
		} catch (error) {
			if (!TRANSIENT_RACE_ERRORS.has(error?.code)) throw error;
			lastError = error;
			if (attempt < tries && retryDelayMs > 0) sleep(retryDelayMs);
		}
	}
	throw lastError;
}
