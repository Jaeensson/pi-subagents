# Task 1 report — safe settings IO and independent Herdr options

## Implementation
- Added shared synchronous settings JSON read/update helpers with object-root validation, best-effort read semantics, unique sibling temporary files (`wx`, mode `0600`), atomic rename, and failed-write cleanup.
- Added independent Herdr option normalization/read/write APIs. Writes update only the two preference values and preserve unknown root, `subagent`, and `herdr` keys.
- Refactored `writeModelTiers` onto shared IO while retaining its public signature, type re-export, removal behavior, and tier/default/retention reads.
- Added tests for normalization, independent preservation, malformed/missing settings, failed-write temp cleanup, and existing model-tier behavior.

## Changed files
- `settings.ts`
- `herdr-settings.ts`
- `jobs.ts`
- `tests/settings.test.mjs`
- `tests/herdr-settings.test.mjs`

## TDD and validation evidence
- RED: `node --test tests/settings.test.mjs tests/herdr-settings.test.mjs` — failed as expected before implementation with `ERR_MODULE_NOT_FOUND` for `herdr-settings.ts` and `settings.ts`.
- GREEN/focused: `node --test tests/settings.test.mjs tests/herdr-settings.test.mjs tests/model-context.test.mjs tests/ui-interactions.test.mjs` — 13 passed, 0 failed.
- Final `npm test` — 276 passed, 0 failed.
- Final `npm run typecheck` — passed (`tsc --noEmit`).
- `git diff --check` — passed.

## Self-review
Reviewed the `jobs.ts` refactor and settings helpers: model-tier update/removal semantics are preserved; shared mutations remain synchronous; malformed/non-object/missing inputs fail without replacing the source; temp cleanup is attempted after write/rename failure. The new APIs introduce no Herdr runtime integration or external side effects.

## Concerns
No known concerns. Full test count is six higher than the supplied baseline (270); the added suites contribute six tests.

## Review follow-up — failed-write cleanup coverage
- Added a controlled `renameSync` failure in `tests/settings.test.mjs`, after the real temp file has been created.
- The test verifies rename was reached exactly once, the error is returned, the original settings remain unchanged, and the directory contains no temp-file debris.
- Validation: `node --test tests/settings.test.mjs tests/herdr-settings.test.mjs` — 7 passed, 0 failed.
