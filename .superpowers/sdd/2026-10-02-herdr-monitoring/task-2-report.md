# Task 2: Isolated additive runtime observations

## Implementation

- Added `subscribeRuntimeObservations` with independent synchronous exception and asynchronous rejection handling. Subscriptions remain owner-managed and are not removed by `clearRegistry`.
- `notifyStatusChanged` retains the legacy status hook and also publishes a status observation. Finalization and unlaunched settlement publish again after persistence completes and `finalizing` clears, before task waiters are released.
- Added current-generation trace observations after accepted JSON event processing.
- `checkJobComplete` snapshots and freezes the scalar `JobCompletion` payload, emits one job-finished observation after completion, and guards the legacy job-finished hook so its failure cannot block delivery. Mid-chain checks do not publish completion.

## TDD evidence

- **RED:** `node --test tests/runtime.test.mjs tests/process.test.mjs` — failed at module loading because `runtime.ts` did not yet export `subscribeRuntimeObservations`; existing process tests passed (20 passed, 1 test module failed).
- **GREEN:** `node --test tests/runtime.test.mjs tests/process.test.mjs` — 32 passed, 0 failed.
- Focused regression run: `node --test tests/runtime.test.mjs tests/process.test.mjs tests/jobs.test.mjs tests/ui-interactions.test.mjs` — 45 passed, 0 failed.
- Final focused run: `node --test tests/runtime.test.mjs tests/process.test.mjs` — 32 passed, 0 failed.
- Final full suite: `npm test` — 280 passed, 0 failed.
- Final typecheck: `npm run typecheck` — passed (`tsc --noEmit`).
- `git diff --check` — passed.

Tests cover synchronous observer exceptions, async rejection handling, legacy UI/job-finished hook compatibility, waiter completion, immutable/exactly-once job completion, unsubscribe, chain gaps, child trace generation, dispatch/finalization status, and queued pause/abort settlement.

## Changed files

- `runtime.ts`
- `process.ts`
- `tests/runtime.test.mjs`
- `tests/process.test.mjs`
- `.superpowers/sdd/2026-10-02-herdr-monitoring/task-2-report.md`

## Concerns

None identified. No Herdr commands or external sessions were used.
