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
 * function's persist at :337 (runtime.ts:353 returns as soon as `isDone()`), and
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
 * ENOTEMPTY, removes what it read, and then calls only the terminal `rmdirSync`.
 * `rmSync` passes `maxRetries` 0, so that is a single attempt, not a loop of
 * retries; an entry that lands between the re-read and that attempt is never
 * read again. Re-running the whole removal re-reads the tree and takes the stray
 * entry with it.
 *
 * Only race-shaped filesystem errors are retried; anything else is rethrown at
 * once, and the whole removal is bounded so a teardown that can never succeed
 * still fails loudly.
 *
 * Every suite that enters the durable-store path — it calls `setJobsRoot(`, or it
 * imports the extension entry (`../index.ts`) and so can start the tasks that
 * write manifests — removes its temp roots through this helper, and a test pins
 * that sweep. Suites outside that path have no durable write to race.
 */

const TRANSIENT_RACE_ERRORS = new Set(["ENOTEMPTY", "EBUSY"]);
const DEFAULT_ATTEMPTS = 10;
const DEFAULT_RETRY_DELAY_MS = 25;

/** Block for `ms` without spinning the CPU; test teardowns are synchronous. */
function sleepSync(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function removeTempRoot(dir, { rm = fs.rmSync, sleep = sleepSync, attempts = DEFAULT_ATTEMPTS, retryDelayMs = DEFAULT_RETRY_DELAY_MS } = {}) {
	// Only a finite number of at least one keeps its value; `Infinity`, strings and
	// `NaN` mean one attempt, so a teardown always either removes the tree or
	// throws the error it saw.
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
