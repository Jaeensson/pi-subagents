# Task 3 report: bounded snapshots and pane-pool decisions

## Changed files
- `herdr-core.ts` — shared Herdr context/protocol/pane/slot contracts, constants, task attempt/count helpers, bounded snapshot projection/encoding, and pure slot selection.
- `herdr-viewer-render.mjs` — standalone snapshot validation, terminal-control sanitization, grapheme-aware rendering.
- `herdr-viewer-render.d.mts` — runtime-matched renderer declarations.
- `tests/herdr-core.test.mjs` — core interfaces, count behavior, task-attempt identity, caps, prompt exclusion, immutability, pending segments, and pool policy.
- `tests/herdr-viewer-render.test.mjs` — sanitizer, malformed protocol, and narrow/wide Unicode rendering.

## API decisions
- `attemptKey` formats identity as `taskId:processGeneration`; missing generation defaults to `0` for compatibility with the optional runtime field.
- `summarizeTasks` treats `setupPending` and queued dispatch as queued, including setup work whose task status is already `running`.
- Slot selection creates at the lowest-index empty slot, otherwise reuses the oldest paused ready slot before other non-running ready slots. Reserved, unavailable, and executing slots cannot be selected.
- Invalid/unsafe snapshot sequence values throw `RangeError`; snapshot projection clips oldest segments first and flags truncation. Snapshot payloads contain display metadata and live segments only, never the original task prompt.
- Viewer rendering owns no terminal control sequences; CJK/emoji graphemes are accounted as double-width and combining marks are kept with their grapheme.

## Validation evidence
- TDD RED: `node --test tests/herdr-core.test.mjs tests/herdr-viewer-render.test.mjs` initially failed on missing modules.
- Focused GREEN: `node --test tests/herdr-core.test.mjs tests/herdr-viewer-render.test.mjs` passed.
- Full suite: `npm test` — 286 tests passed.
- Typecheck: `npm run typecheck` — passed.
- `git diff --check` — passed before commit.

## Concerns
- Display cell-width handling is a deliberate lightweight Unicode approximation (grapheme segmentation plus common wide/CJK and emoji ranges), not a complete terminal-specific `wcwidth` implementation.
- No runtime producer/viewer integration was introduced, per task scope.
